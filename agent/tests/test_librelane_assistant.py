import asyncio

import pytest
from fastapi.testclient import TestClient

from agent.api.main import app
from agent.api.routes import assistant as assistant_routes
from agent.assistants.librelane import (
    LibreLaneSemanticTools,
    _system_prompt,
    run_librelane_assistant,
)
from agent.assistants.providers import ProviderConfig, ProviderError


class FakeProvider:
    def __init__(self, response: dict):
        self.response = response

    async def complete_json(self, *, system_prompt: str, user_message: str) -> dict:
        assert "xylon-librelane-intent/v1" in system_prompt
        assert "Never emit tool names" in system_prompt
        assert user_message
        return self.response


def _intent(name: str, *, supported: bool = True) -> dict:
    return {
        "schema_version": "xylon-librelane-intent/v1",
        "supported": supported,
        "intent": name,
        "normalized_goal": "Inspect the current LibreLane project evidence.",
        "needs": ["project_run"] if supported else [],
    }


def _tools(calls: list[str]) -> LibreLaneSemanticTools:
    async def status(run_id: str) -> dict:
        calls.append(f"status:{run_id}")
        return {"run_id": run_id, "state": "succeeded", "next_action": "Review native metrics."}

    async def baseline(run_id: str, approved: bool) -> dict:
        calls.append(f"baseline:{run_id}:{approved}")
        if approved:
            return {"run_id": run_id, "state": "proposal_ready", "proposal": {"proposal_id": "b" * 64}}
        return {"run_id": run_id, "state": "prepared", "next_action": "Approve the prepared baseline."}

    async def repair(run_id: str, approved: bool, proposal_id: str | None) -> dict:
        calls.append(f"repair:{run_id}:{approved}:{proposal_id}")
        if approved:
            return {"run_id": run_id, "state": "comparison_ready", "next_action": "Review comparison."}
        return {"run_id": run_id, "state": "proposal_ready", "next_action": "Review proposal."}

    async def comparison(run_id: str) -> dict:
        calls.append(f"comparison:{run_id}")
        return {"run_id": run_id, "state": "comparison_ready", "next_action": "Review comparison."}

    async def selected_execute(run_id: str, approved: bool) -> dict:
        calls.append(f"selected:{run_id}:{approved}")
        return {"run_id": run_id, "state": "baseline_kept", "next_action": "Review selected rerun."}

    return LibreLaneSemanticTools(
        status=status,
        baseline=baseline,
        repair=repair,
        comparison=comparison,
        selected_execute=selected_execute,
    )


def test_librelane_prompt_keeps_contract_ahead_of_reference_skill():
    _, prompt = _system_prompt("en")

    contract_marker = "You are Xylon's LibreLane project assistant"
    reference_marker = "Reference timing skill (guidance only; do not copy its schema):"
    reminder_marker = "Re-apply the LibreLane JSON contract above."

    assert prompt.index(contract_marker) < prompt.index(reference_marker)
    assert prompt.index(reminder_marker) > prompt.index(reference_marker)
    assert "schema_version MUST be xylon-librelane-intent/v1" in prompt


def test_librelane_assistant_inspection_uses_canonical_run_and_safe_egress():
    calls: list[str] = []
    result = asyncio.run(
        run_librelane_assistant(
            provider=FakeProvider(_intent("inspect_project")),
            message="請檢查目前的 LibreLane 時序證據",
            locale="zh-TW",
            run_id="run_12345678",
            approved=False,
            proposal_id=None,
            tools=_tools(calls),
        )
    )

    assert calls == ["status:run_12345678"]
    assert result["state"] == "project_status_ready"
    assert result["observed"]["run_id"] == "run_12345678"
    assert "rtl" in result["egress"]["excluded"]
    assert "timing_metrics" in result["egress"]["excluded"]


def test_librelane_assistant_requires_approval_before_selected_execution():
    calls: list[str] = []
    without_approval = asyncio.run(
        run_librelane_assistant(
            provider=FakeProvider(_intent("rerun_selected")),
            message="重新跑目前選定的設定",
            locale="zh-TW",
            run_id="run_12345678",
            approved=False,
            proposal_id=None,
            tools=_tools(calls),
        )
    )
    assert calls == ["status:run_12345678"]
    assert without_approval["state"] == "awaiting_human_approval"

    with_approval = asyncio.run(
        run_librelane_assistant(
            provider=FakeProvider(_intent("rerun_selected")),
            message="重新跑目前選定的設定",
            locale="zh-TW",
            run_id="run_12345678",
            approved=True,
            proposal_id=None,
            tools=_tools(calls),
        )
    )
    assert calls[-1] == "selected:run_12345678:True"
    assert with_approval["observed"]["state"] == "baseline_kept"


def test_librelane_assistant_baseline_requires_approval_before_execute():
    calls: list[str] = []
    waiting = asyncio.run(
        run_librelane_assistant(
            provider=FakeProvider(_intent("run_baseline")),
            message="開始跑 baseline",
            locale="zh-TW",
            run_id="run_12345678",
            approved=False,
            proposal_id=None,
            tools=_tools(calls),
        )
    )

    assert calls == ["baseline:run_12345678:False"]
    assert waiting["state"] == "awaiting_human_approval"
    assert waiting["observed"]["state"] == "prepared"


def test_librelane_assistant_baseline_with_approval_returns_bounded_proposal():
    calls: list[str] = []
    result = asyncio.run(
        run_librelane_assistant(
            provider=FakeProvider(_intent("run_baseline")),
            message="批准並執行 baseline",
            locale="zh-TW",
            run_id="run_12345678",
            approved=True,
            proposal_id=None,
            tools=_tools(calls),
        )
    )

    assert calls == ["baseline:run_12345678:True"]
    assert result["state"] == "repair_proposal_ready"
    assert result["observed"]["proposal"]["proposal_id"] == "b" * 64
    assert result["human_handoff"]["required"] is True


def test_librelane_assistant_leaves_repair_selection_to_deterministic_runtime():
    calls: list[str] = []
    proposal = asyncio.run(
        run_librelane_assistant(
            provider=FakeProvider(_intent("propose_repair")),
            message="請依照量測證據提出一個改善",
            locale="zh-TW",
            run_id="run_12345678",
            approved=False,
            proposal_id=None,
            tools=_tools(calls),
        )
    )
    assert calls == ["repair:run_12345678:False:None"]
    assert proposal["state"] == "repair_proposal_ready"

    comparison = asyncio.run(
        run_librelane_assistant(
            provider=FakeProvider(_intent("propose_repair")),
            message="批准這個改善並執行",
            locale="zh-TW",
            run_id="run_12345678",
            approved=True,
            proposal_id="b" * 64,
            tools=_tools(calls),
        )
    )
    assert calls[-1] == f"repair:run_12345678:True:{'b' * 64}"
    assert comparison["state"] == "comparison_ready"
    assert comparison["observed"]["state"] == "comparison_ready"


def test_public_librelane_readback_is_compact_and_excludes_unneeded_metrics():
    public = assistant_routes._public_librelane_run({
        "run_id": "run_12345678",
        "state": "comparison_ready",
        "next_action": "Review comparison.",
        "comparison": {
            "schema_version": "xylon-librelane-comparison/v1",
            "setup_wns": {"baseline": -1.0, "candidate": -0.5, "delta": 0.5, "improved": True, "timing_met": False},
            "setup_tns": {"baseline": -2.0, "candidate": -1.0, "delta": 1.0, "improved": True, "timing_met": False},
            "baseline_metrics": {"timing__setup__wns": -1.0, "timing__setup__tns": -2.0, "design__core__area": 1234},
            "candidate_metrics": {"timing__setup__wns": -0.5, "timing__setup__tns": -1.0, "power__total": 4},
        },
    })
    assert public["comparison"]["setup_tns"] == {
        "baseline": -2.0, "candidate": -1.0, "delta": 1.0, "improved": True, "timing_met": False,
    }
    assert public["comparison"]["baseline_metrics"] == {"timing__setup__wns": -1.0, "timing__setup__tns": -2.0}
    assert "design__core__area" not in public["comparison"]["baseline_metrics"]
    assert "power__total" not in public["comparison"]["candidate_metrics"]


def test_librelane_assistant_route_executes_saved_repair_proposal_when_approved(monkeypatch):
    proposal_id = "a" * 64
    captured: dict[str, object] = {}

    async def fake_repair_execution(run_id: str, request) -> dict:
        captured["run_id"] = run_id
        captured["approved"] = request.approved
        captured["proposal_id"] = request.proposal_id
        return {
            "run_id": run_id,
            "state": "comparison_ready",
            "comparison": {
                "schema_version": "xylon-librelane-comparison/v1",
                "setup_wns": {"baseline": -0.2, "candidate": -0.1, "delta": 0.1, "improved": True, "timing_met": False},
                "setup_tns": {"baseline": -1.0, "candidate": -0.6, "delta": 0.4, "improved": True, "timing_met": False},
                "baseline_metrics": {"timing__setup__wns": -0.2, "timing__setup__tns": -1.0},
                "candidate_metrics": {"timing__setup__wns": -0.1, "timing__setup__tns": -0.6},
            },
            "proposal": {"proposal_id": proposal_id},
            "next_action": "Review comparison.",
        }

    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "_load_librelane_run",
        lambda run_id: (None, {"run_id": run_id, "proposal": {"proposal_id": proposal_id}}),
    )
    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "post_librelane_repair_execution",
        fake_repair_execution,
    )

    result = asyncio.run(assistant_routes._librelane_repair("run_12345678", True, proposal_id))

    assert captured == {
        "run_id": "run_12345678",
        "approved": True,
        "proposal_id": proposal_id,
    }
    assert result["state"] == "comparison_ready"
    assert result["comparison"]["baseline_metrics"] == {
        "timing__setup__wns": -0.2,
        "timing__setup__tns": -1.0,
    }


def test_librelane_assistant_route_baseline_without_approval_only_reads_saved_run(monkeypatch):
    payload = {"run_id": "run_12345678", "state": "prepared", "next_action": "Approve the prepared baseline."}

    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "_load_librelane_run",
        lambda run_id: (None, payload | {"run_id": run_id}),
    )

    result = asyncio.run(assistant_routes._librelane_baseline("run_12345678", False))

    assert result["state"] == "prepared"
    assert result["next_action"] == "Approve the prepared baseline."


def test_librelane_assistant_route_baseline_with_negative_wns_creates_one_saved_proposal(monkeypatch):
    run_root = object()
    payload = {"run_id": "run_12345678", "state": "prepared"}
    captured: list[str] = []

    async def fake_execute(run_id: str, request) -> dict:
        captured.append(f"execute:{run_id}:{request.approved}")
        payload["state"] = "succeeded"
        return {"run_id": run_id}

    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "post_librelane_project_execution",
        fake_execute,
    )
    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "_load_librelane_run",
        lambda run_id: (run_root, payload | {"run_id": run_id}),
    )
    monkeypatch.setattr(assistant_routes.openroad_routes, "_librelane_setup_wns", lambda current: -0.2)
    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "_create_librelane_proposal",
        lambda current_root, current_payload: captured.append("proposal") or {"proposal_id": "c" * 64},
    )

    result = asyncio.run(assistant_routes._librelane_baseline("run_12345678", True))

    assert captured == ["execute:run_12345678:True", "proposal"]
    assert result["proposal"]["proposal_id"] == "c" * 64


def test_librelane_assistant_route_baseline_with_clean_timing_returns_measured_result(monkeypatch):
    payload = {"run_id": "run_12345678", "state": "prepared", "next_action": "Review native metrics."}
    captured: list[str] = []

    async def fake_execute(run_id: str, request) -> dict:
        captured.append(f"execute:{run_id}:{request.approved}")
        payload["state"] = "succeeded"
        return {"run_id": run_id}

    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "post_librelane_project_execution",
        fake_execute,
    )
    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "_load_librelane_run",
        lambda run_id: (None, payload | {"run_id": run_id}),
    )
    monkeypatch.setattr(assistant_routes.openroad_routes, "_librelane_setup_wns", lambda current: 0.0)
    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "_create_librelane_proposal",
        lambda *_args, **_kwargs: pytest.fail("clean timing must not create a proposal"),
    )

    result = asyncio.run(assistant_routes._librelane_baseline("run_12345678", True))

    assert captured == ["execute:run_12345678:True"]
    assert "proposal" not in result
    assert result["state"] == "succeeded"


def test_librelane_assistant_route_does_not_repeat_completed_baseline(monkeypatch):
    payload = {"run_id": "run_12345678", "state": "succeeded"}

    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "_load_librelane_run",
        lambda run_id: (None, payload | {"run_id": run_id}),
    )
    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "post_librelane_project_execution",
        lambda *_args, **_kwargs: pytest.fail("completed baseline must not run again"),
    )

    result = asyncio.run(assistant_routes._librelane_baseline("run_12345678", True))

    assert result["state"] == "succeeded"


def test_librelane_assistant_unsupported_request_does_not_call_tools():
    calls: list[str] = []
    result = asyncio.run(
        run_librelane_assistant(
            provider=FakeProvider(_intent("unsupported", supported=False)),
            message="幫我寄一封信",
            locale="zh-TW",
            run_id="run_12345678",
            approved=True,
            proposal_id=None,
            tools=_tools(calls),
        )
    )
    assert result["state"] == "unsupported"
    assert calls == []


def test_librelane_assistant_rejects_contradictory_model_intent():
    with pytest.raises(ProviderError, match="contradictory"):
        asyncio.run(
            run_librelane_assistant(
                provider=FakeProvider(_intent("unsupported", supported=True)),
                message="請檢查",
                locale="en",
                run_id=None,
                approved=False,
                proposal_id=None,
                tools=_tools([]),
            )
        )


def test_librelane_assistant_route_uses_versioned_contract(monkeypatch):
    calls: list[str] = []

    class RouteProvider(FakeProvider):
        def __init__(self, _config: ProviderConfig):
            super().__init__(_intent("inspect_project"))

    monkeypatch.setattr(assistant_routes, "OpenAICompatibleProvider", RouteProvider)
    monkeypatch.setattr(assistant_routes, "LIBRELANE_TOOLS", _tools(calls))
    with TestClient(app) as client:
        response = client.post(
            "/api/assistant/librelane",
            json={
                "schema_version": "xylon-librelane-assistant-request/v1",
                "message": "請檢查目前的 LibreLane 時序證據",
                "locale": "zh-TW",
                "provider": {
                    "protocol": "openai-compatible",
                    "base_url": "http://127.0.0.1:11434/v1",
                    "model": "local-model",
                },
                "project_run_id": "run_12345678",
            },
        )
    assert response.status_code == 200
    assert response.json()["schema_version"] == "xylon-librelane-assistant/v1"
    assert calls == ["status:run_12345678"]


def test_librelane_assistant_route_returns_422_when_saved_repair_proposal_is_missing(monkeypatch):
    class RouteProvider(FakeProvider):
        def __init__(self, _config: ProviderConfig):
            super().__init__(_intent("propose_repair"))

    async def failing_repair(_run_id: str, approved: bool, proposal_id: str | None) -> dict:
        assert approved is True
        assert proposal_id == "b" * 64
        raise ValueError("the saved LibreLane repair proposal is unavailable")

    baseline_tools = _tools([])
    monkeypatch.setattr(assistant_routes, "OpenAICompatibleProvider", RouteProvider)
    monkeypatch.setattr(
        assistant_routes,
        "LIBRELANE_TOOLS",
        LibreLaneSemanticTools(
            status=baseline_tools.status,
            baseline=baseline_tools.baseline,
            repair=failing_repair,
            comparison=baseline_tools.comparison,
            selected_execute=baseline_tools.selected_execute,
        ),
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/assistant/librelane",
            json={
                "schema_version": "xylon-librelane-assistant-request/v1",
                "message": "批准這個改善並執行",
                "locale": "zh-TW",
                "provider": {
                    "protocol": "openai-compatible",
                    "base_url": "http://127.0.0.1:11434/v1",
                    "model": "local-model",
                },
                "project_run_id": "run_12345678",
                "approved": True,
                "proposal_id": "b" * 64,
            },
        )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "LibreLaneAgentStateInvalid"


def test_librelane_assistant_route_rejects_missing_proposal_id_before_repair(monkeypatch):
    class RouteProvider(FakeProvider):
        def __init__(self, _config: ProviderConfig):
            super().__init__(_intent("propose_repair"))

    monkeypatch.setattr(assistant_routes, "OpenAICompatibleProvider", RouteProvider)
    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "_load_librelane_run",
        lambda run_id: (None, {"run_id": run_id, "proposal": {"proposal_id": "a" * 64}}),
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/assistant/librelane",
            json={
                "schema_version": "xylon-librelane-assistant-request/v1",
                "message": "批准這個改善並執行",
                "locale": "zh-TW",
                "provider": {
                    "protocol": "openai-compatible",
                    "base_url": "http://127.0.0.1:11434/v1",
                    "model": "local-model",
                },
                "project_run_id": "run_12345678",
                "approved": True,
            },
        )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "LibreLaneAgentStateInvalid"


def test_librelane_assistant_route_rejects_mismatched_proposal_id_before_repair(monkeypatch):
    monkeypatch.setattr(
        assistant_routes.openroad_routes,
        "_load_librelane_run",
        lambda run_id: (None, {"run_id": run_id, "proposal": {"proposal_id": "a" * 64}}),
    )

    with pytest.raises(ValueError, match="does not match"):
        asyncio.run(assistant_routes._librelane_repair("run_12345678", True, "b" * 64))
