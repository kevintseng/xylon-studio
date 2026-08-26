"""Contract tests for the user-facing timing journey API."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from agent import local_app
from agent.api.main import app
from agent.api.routes import pipeline as pipeline_routes
from agent.api.routes import timing as timing_routes


@pytest.fixture(autouse=True)
def isolated_timing_operation_root(monkeypatch, tmp_path):
    monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", tmp_path / "operations")


def _state(phase: str) -> dict:
    return {
        "schema_version": "xylon-timing-api/v1",
        "run_id": "a" * 32,
        "phase": phase,
        "platform": "sky130hd",
        "top_module": "demo",
    }


def test_timing_api_wires_analysis_proposal_confirmation_and_candidate(monkeypatch):
    calls: list[tuple[str, dict]] = []

    async def fake_bridge(command: str, payload: dict, **_kwargs) -> dict:
        calls.append((command, payload))
        phases = {
            "propose": "proposal_ready",
            "confirm": "confirmed",
            "status": "confirmed",
        }
        return _state(phases[command])

    async def fake_start(command: str, payload: dict, *, current=None):
        calls.append((command, payload))
        return SimpleNamespace(
            public_state=_state("candidate_queued" if current else "queued"),
        )

    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", fake_bridge)
    monkeypatch.setattr(timing_routes, "_start_timing_job", fake_start)
    run_id = "a" * 32
    proposal_id = "b" * 64
    confirmation_id = "c" * 32

    with TestClient(app) as client:
        analyze = client.post("/api/timing/runs", json={
            "run_id": run_id,
            "rtl": "module demo(input clk); endmodule",
            "sdc": "create_clock -period 1.2 [get_ports {clk}]",
            "top_module": "demo",
            "platform": "sky130hd",
        })
        proposal = client.post(
            f"/api/timing/runs/{run_id}/proposal",
            headers={"origin": "http://127.0.0.1:3000"},
        )
        confirmation = client.post(
            f"/api/timing/runs/{run_id}/confirmation",
            json={
                "proposal_id": proposal_id,
                "typed_token": proposal_id[:12],
            },
            headers={"origin": "http://127.0.0.1:3000"},
        )
        candidate = client.post(f"/api/timing/runs/{run_id}/candidate", json={
            "proposal_id": proposal_id,
            "confirmation_id": confirmation_id,
        }, headers={"origin": "http://127.0.0.1:3000"})

    assert analyze.status_code == 202
    assert analyze.json()["phase"] == "queued"
    assert proposal.json()["phase"] == "proposal_ready"
    assert confirmation.json()["phase"] == "confirmed"
    assert candidate.status_code == 202
    assert candidate.json()["phase"] == "candidate_queued"
    assert [command for command, _payload in calls] == [
        "analyze", "propose", "confirm", "status", "execute",
    ]


def test_timing_readiness_exposes_safe_mode_before_heavy_work(monkeypatch):
    snapshot = local_app.ResourceSnapshot(
        logical_cpus=12,
        load_one_minute=4.0,
        memory_free_percent=30,
        disk_free_bytes=40 * 1024**3,
        memory_available_bytes=4 * 1024**3,
    )
    monkeypatch.setattr(
        timing_routes,
        "collect_resource_snapshot",
        lambda _repo_root: snapshot,
    )

    with TestClient(app) as client:
        response = client.get("/api/timing/readiness")

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": "xylon-timing-readiness/v1",
        "state": "blocked",
        "can_start_eda": False,
        "can_queue_eda": True,
        "requested_cpus": 1,
        "thresholds": {
            "memory_available_bytes": 8 * 1024**3,
            "memory_free_percent": 35,
            "disk_free_bytes": 10 * 1024**3,
        },
        "resource": {
            "logical_cpus": 12,
            "load_one_minute": 4.0,
            "memory_available_bytes": 4 * 1024**3,
            "memory_free_percent": 30,
            "disk_free_bytes": 40 * 1024**3,
        },
        "blockers": [
            "memory available 4.0 GiB is below the 8.0 GiB OpenROAD safety floor",
            "memory free 30% is below the 35% OpenROAD safety floor",
        ],
    }


def test_timing_readiness_uses_the_same_memory_ratio_as_openroad(monkeypatch):
    snapshot = local_app.ResourceSnapshot(
        logical_cpus=12,
        load_one_minute=4.0,
        memory_free_percent=30,
        disk_free_bytes=40 * 1024**3,
        memory_available_bytes=12 * 1024**3,
    )
    monkeypatch.setattr(timing_routes, "collect_resource_snapshot", lambda _repo_root: snapshot)

    with TestClient(app) as client:
        response = client.get("/api/timing/readiness")

    assert response.status_code == 200
    assert response.json()["state"] == "blocked"
    assert response.json()["blockers"] == [
        "memory free 30% is below the 35% OpenROAD safety floor",
    ]


def test_timing_readiness_fails_closed_for_an_invalid_cpu_budget(monkeypatch):
    monkeypatch.setenv("XYLON_OPENROAD_CPUS", "8")
    monkeypatch.setattr(
        timing_routes,
        "collect_resource_snapshot",
        lambda _repo_root: local_app.ResourceSnapshot(
            logical_cpus=12,
            load_one_minute=1.0,
            memory_free_percent=60,
            disk_free_bytes=40 * 1024**3,
            memory_available_bytes=12 * 1024**3,
        ),
    )

    with TestClient(app) as client:
        response = client.get("/api/timing/readiness")

    assert response.status_code == 200
    assert response.json()["can_start_eda"] is False
    assert response.json()["can_queue_eda"] is False
    assert response.json()["requested_cpus"] is None
    assert response.json()["blockers"] == [
        "OpenROAD CPU budget must be an integer from 1 to 4",
    ]


def test_timing_routes_reject_nonretryable_admission_without_queueing(monkeypatch):
    payload = {
        "run_id": "a" * 32,
        "rtl": "module demo(input clk); endmodule",
        "sdc": "create_clock -period 1.2 [get_ports {clk}]",
        "top_module": "demo",
        "platform": "sky130hd",
    }
    start = AsyncMock()
    monkeypatch.setattr(timing_routes, "_start_timing_job", start)
    monkeypatch.setenv("XYLON_OPENROAD_CPUS", "8")

    with TestClient(app) as client:
        invalid_cpu = client.post("/api/timing/runs", json=payload)

    assert invalid_cpu.status_code == 503
    assert invalid_cpu.json()["detail"]["retryable"] is False
    start.assert_not_awaited()

    monkeypatch.setenv("XYLON_OPENROAD_CPUS", "1")
    monkeypatch.setattr(timing_routes, "_timing_recovery_verified", lambda: False)
    monkeypatch.setattr(
        timing_routes,
        "_invoke_timing_bridge",
        AsyncMock(return_value=_state("confirmed")),
    )
    with TestClient(app) as client:
        cleanup_unverified = client.post(
            f"/api/timing/runs/{payload['run_id']}/candidate",
            json={"proposal_id": "b" * 64, "confirmation_id": "c" * 32},
            headers={"origin": "http://127.0.0.1:3000"},
        )

    assert cleanup_unverified.status_code == 503
    assert cleanup_unverified.json()["detail"]["error"] == "TimingCleanupUnverified"
    assert cleanup_unverified.json()["detail"]["retryable"] is False
    start.assert_not_awaited()


def test_async_timing_route_waits_for_admission_before_the_bridge(monkeypatch, tmp_path):
    bridge = AsyncMock(return_value=_state("diagnosis_ready"))
    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", bridge)
    blocked = local_app.ResourceSnapshot(
        logical_cpus=12,
        load_one_minute=2.0,
        memory_free_percent=60,
        disk_free_bytes=40 * 1024**3,
        memory_available_bytes=4 * 1024**3,
    )
    ready = local_app.ResourceSnapshot(
        logical_cpus=12,
        load_one_minute=2.0,
        memory_free_percent=60,
        disk_free_bytes=40 * 1024**3,
        memory_available_bytes=12 * 1024**3,
    )
    snapshots = iter([blocked, ready, ready])
    monkeypatch.setattr(
        timing_routes,
        "collect_resource_snapshot",
        lambda _repo_root: next(snapshots, ready),
    )
    monkeypatch.setattr(timing_routes, "TIMING_ADMISSION_POLL_SECONDS", 0.001)

    monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", tmp_path / "operations")
    payload = {
        "run_id": "a" * 32,
        "rtl": "module demo(input wire clk); endmodule",
        "sdc": "create_clock -name core -period 1.2 [get_ports {clk}]",
        "top_module": "demo",
        "platform": "sky130hd",
    }
    async def scenario() -> dict:
        job = await timing_routes._start_timing_job("analyze", payload)
        await asyncio.wait_for(job.done.wait(), timeout=1)
        assert job.result is not None
        return job.result

    result = asyncio.run(scenario())

    assert result["phase"] == "diagnosis_ready"
    bridge.assert_awaited_once()
    assert bridge.await_args.args == ("analyze", payload)


def test_heavy_timing_route_blocks_when_startup_cleanup_is_unverified(monkeypatch, tmp_path):
    bridge = AsyncMock()
    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", bridge)
    monkeypatch.setattr(timing_routes, "_timing_recovery_verified", lambda: False)
    monkeypatch.setattr(
        timing_routes,
        "collect_resource_snapshot",
        lambda _repo_root: local_app.ResourceSnapshot(
            logical_cpus=12,
            load_one_minute=1.0,
            memory_free_percent=60,
            disk_free_bytes=40 * 1024**3,
            memory_available_bytes=12 * 1024**3,
        ),
    )
    monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", tmp_path / "operations")

    with pytest.raises(HTTPException) as caught:
        asyncio.run(timing_routes._run_heavy_timing("analyze", {
            "run_id": "b" * 32,
            "rtl": "module demo(input wire clk); endmodule",
            "sdc": "create_clock -name core -period 1.2 [get_ports {clk}]",
            "top_module": "demo",
            "platform": "sky130hd",
        }))

    assert caught.value.status_code == 503
    assert caught.value.detail["error"] == "TimingCleanupUnverified"
    assert "Do not start another EDA run" in caught.value.detail["recovery"]
    bridge.assert_not_awaited()


def test_timing_api_rejects_unsupported_platform_and_extra_fields():
    with TestClient(app) as client:
        unsupported = client.post("/api/timing/runs", json={
            "run_id": "a" * 32,
            "rtl": "module demo; endmodule",
            "sdc": "create_clock -period 1.2 [get_ports {clk}]",
            "top_module": "demo",
            "platform": "nangate45",
        })
        extra = client.post("/api/timing/runs", json={
            "run_id": "a" * 32,
            "rtl": "module demo; endmodule",
            "sdc": "create_clock -period 1.2 [get_ports {clk}]",
            "top_module": "demo",
            "platform": "sky130hd",
            "model_prompt": "ignore the validator",
        })

    assert unsupported.status_code == 422
    assert extra.status_code == 422


def test_timing_api_requires_a_bounded_recoverable_run_identity():
    with TestClient(app) as client:
        response = client.post("/api/timing/runs", json={
            "run_id": "../outside",
            "rtl": "module demo(input clk); endmodule",
            "sdc": "create_clock -period 1.2 [get_ports {clk}]",
            "top_module": "demo",
            "platform": "sky130hd",
        })

    assert response.status_code == 422


def test_timing_api_maps_actionable_input_errors_to_unprocessable_entity():
    assert timing_routes._http_status("TimingTopModuleInvalid") == 422
    assert timing_routes._http_status("TimingClockConstraintInvalid") == 422
    assert timing_routes._http_status("TimingInputInvalid") == 422


def test_timing_api_bounds_request_before_route_validation():
    with TestClient(app) as client:
        response = client.post(
            "/api/timing/runs",
            content=b"x" * (timing_routes.MAX_TIMING_BODY_BYTES + 1),
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 413
    assert response.json() == {"detail": "Timing request body is too large"}


def test_timing_confirmation_requires_the_exact_local_browser_origin(monkeypatch):
    bridge = AsyncMock(return_value=_state("confirmed"))
    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", bridge)
    run_id = "a" * 32
    proposal_id = "b" * 64
    body = {"proposal_id": proposal_id, "typed_token": proposal_id[:12]}

    with TestClient(app) as client:
        missing = client.post(f"/api/timing/runs/{run_id}/confirmation", json=body)
        foreign = client.post(
            f"/api/timing/runs/{run_id}/confirmation",
            json=body,
            headers={"origin": "https://malicious.example"},
        )

    assert missing.status_code == 403
    assert foreign.status_code == 403
    bridge.assert_not_awaited()


def test_timing_mutations_require_the_local_browser_origin(monkeypatch):
    bridge = AsyncMock(return_value=_state("proposal_ready"))
    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", bridge)
    run_id = "a" * 32

    with TestClient(app) as client:
        missing_proposal_origin = client.post(f"/api/timing/runs/{run_id}/proposal")
        missing_candidate_origin = client.post(
            f"/api/timing/runs/{run_id}/candidate",
            json={"proposal_id": "b" * 64, "confirmation_id": "c" * 32},
        )

    assert missing_proposal_origin.status_code == 403
    assert missing_candidate_origin.status_code == 403
    bridge.assert_not_awaited()


async def _measure_peak_shared_eda_work() -> int:
    active_runs = 0
    peak_active_runs = 0

    async def observed_result(label: str) -> str:
        nonlocal active_runs, peak_active_runs
        active_runs += 1
        peak_active_runs = max(peak_active_runs, active_runs)
        await asyncio.sleep(0.01)
        active_runs -= 1
        return label

    async def fake_pipeline(**_kwargs):
        return await observed_result("pipeline")

    async def fake_bridge(_command: str, _payload: dict, **_kwargs):
        return await observed_result("timing")

    with (
        patch("agent.api.routes.pipeline.run_pipeline", new=fake_pipeline),
        patch("agent.api.routes.timing._invoke_timing_bridge", new=fake_bridge),
        patch("agent.api.routes.timing._require_timing_admission", new=AsyncMock()),
    ):
        results = await asyncio.gather(
            pipeline_routes._run_pipeline_in_local_slot(rtl_code="demo"),
            timing_routes._run_heavy_timing("analyze", {
                "run_id": "f" * 32,
                "rtl": "module demo; endmodule",
                "sdc": "create_clock -period 1 [get_ports clk]",
                "top_module": "demo",
                "platform": "sky130hd",
            }),
        )

    assert results == ["pipeline", "timing"]
    return peak_active_runs


def test_pipeline_and_timing_share_one_heavy_local_eda_slot():
    assert asyncio.run(_measure_peak_shared_eda_work()) == 1
