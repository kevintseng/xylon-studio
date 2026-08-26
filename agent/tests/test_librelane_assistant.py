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


def _intent(name: str, *, supported: bool = True, strategy: str | None = None) -> dict:
    return {
        "schema_version": "xylon-librelane-intent/v1",
        "supported": supported,
        "intent": name,
        "normalized_goal": "Inspect the current LibreLane project evidence.",
        "needs": ["project_run"] if supported else [],
        "repair_strategy": strategy,
    }


def _tools(calls: list[str]) -> LibreLaneSemanticTools:
    async def status(run_id: str) -> dict:
        calls.append(f"status:{run_id}")
        return {"run_id": run_id, "state": "succeeded", "next_action": "Review native metrics."}

    async def propose(run_id: str, strategy: str) -> dict:
        calls.append(f"propose:{run_id}:{strategy}")
        return {"run_id": run_id, "state": "proposal_ready", "next_action": "Review proposal."}

    async def comparison(run_id: str) -> dict:
        calls.append(f"comparison:{run_id}")
        return {"run_id": run_id, "state": "comparison_ready", "next_action": "Review comparison."}

    async def selected_execute(run_id: str, approved: bool) -> dict:
        calls.append(f"selected:{run_id}:{approved}")
        return {"run_id": run_id, "state": "baseline_kept", "next_action": "Review selected rerun."}

    return LibreLaneSemanticTools(status=status, propose=propose, comparison=comparison, selected_execute=selected_execute)


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
            tools=_tools(calls),
        )
    )
    assert calls[-1] == "selected:run_12345678:True"
    assert with_approval["observed"]["state"] == "baseline_kept"


def test_librelane_assistant_passes_only_allowlisted_repair_strategy():
    calls: list[str] = []
    result = asyncio.run(
        run_librelane_assistant(
            provider=FakeProvider(_intent("propose_repair", strategy="cts")),
            message="請提出 CTS timing repair",
            locale="zh-TW",
            run_id="run_12345678",
            approved=False,
            tools=_tools(calls),
        )
    )
    assert calls == ["propose:run_12345678:cts"]
    assert result["state"] == "repair_proposal_ready"


def test_public_librelane_readback_is_compact_and_excludes_unneeded_metrics():
    public = assistant_routes._public_librelane_run({
        "run_id": "run_12345678",
        "state": "comparison_ready",
        "next_action": "Review comparison.",
        "comparison": {
            "schema_version": "xylon-librelane-comparison/v1",
            "setup_wns": {"baseline": -1.0, "candidate": -0.5, "delta": 0.5, "improved": True, "timing_met": False},
            "baseline_metrics": {"timing__setup__wns": -1.0, "timing__setup__tns": -2.0, "design__core__area": 1234},
            "candidate_metrics": {"timing__setup__wns": -0.5, "timing__setup__tns": -1.0, "power__total": 4},
        },
    })
    assert public["comparison"]["baseline_metrics"] == {"timing__setup__wns": -1.0, "timing__setup__tns": -2.0}
    assert "design__core__area" not in public["comparison"]["baseline_metrics"]
    assert "power__total" not in public["comparison"]["candidate_metrics"]


def test_librelane_assistant_unsupported_request_does_not_call_tools():
    calls: list[str] = []
    result = asyncio.run(
        run_librelane_assistant(
            provider=FakeProvider(_intent("unsupported", supported=False)),
            message="幫我寄一封信",
            locale="zh-TW",
            run_id="run_12345678",
            approved=True,
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
