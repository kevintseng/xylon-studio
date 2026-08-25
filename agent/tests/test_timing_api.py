"""Contract tests for the user-facing timing journey API."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from agent import local_app
from agent.api.main import app
from agent.api.routes import pipeline as pipeline_routes
from agent.api.routes import timing as timing_routes


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

    async def fake_bridge(command: str, payload: dict) -> dict:
        calls.append((command, payload))
        phases = {
            "analyze": "diagnosis_ready",
            "propose": "proposal_ready",
            "confirm": "confirmed",
            "execute": "comparison_ready",
        }
        return _state(phases[command])

    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", fake_bridge)
    monkeypatch.setattr(timing_routes, "_run_heavy_timing", fake_bridge)
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
        proposal = client.post(f"/api/timing/runs/{run_id}/proposal")
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
        })

    assert analyze.status_code == 200
    assert proposal.json()["phase"] == "proposal_ready"
    assert confirmation.json()["phase"] == "confirmed"
    assert candidate.json()["phase"] == "comparison_ready"
    assert [command for command, _payload in calls] == ["analyze", "propose", "confirm", "execute"]


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
        "requested_cpus": 1,
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
    assert response.json()["requested_cpus"] is None
    assert response.json()["blockers"] == [
        "OpenROAD CPU budget must be an integer from 1 to 4",
    ]


def test_heavy_timing_route_rechecks_admission_before_the_bridge(monkeypatch):
    bridge = AsyncMock()
    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", bridge)
    monkeypatch.setattr(
        timing_routes,
        "collect_resource_snapshot",
        lambda _repo_root: local_app.ResourceSnapshot(
            logical_cpus=12,
            load_one_minute=2.0,
            memory_free_percent=60,
            disk_free_bytes=40 * 1024**3,
            memory_available_bytes=4 * 1024**3,
        ),
    )

    with TestClient(app) as client:
        response = client.post("/api/timing/runs", json={
            "run_id": "a" * 32,
            "rtl": "module demo(input wire clk); endmodule",
            "sdc": "create_clock -name core -period 1.2 [get_ports {clk}]",
            "top_module": "demo",
            "platform": "sky130hd",
        })

    assert response.status_code == 503
    assert response.json()["detail"]["error"] == "ResourceAdmissionBlocked"
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

    async def fake_bridge(_command: str, _payload: dict):
        return await observed_result("timing")

    with (
        patch("agent.api.routes.pipeline.run_pipeline", new=fake_pipeline),
        patch("agent.api.routes.timing._invoke_timing_bridge", new=fake_bridge),
        patch("agent.api.routes.timing._require_timing_admission", new=AsyncMock()),
    ):
        results = await asyncio.gather(
            pipeline_routes._run_pipeline_in_local_slot(rtl_code="demo"),
            timing_routes._run_heavy_timing("analyze", {}),
        )

    assert results == ["pipeline", "timing"]
    return peak_active_runs


def test_pipeline_and_timing_share_one_heavy_local_eda_slot():
    assert asyncio.run(_measure_peak_shared_eda_work()) == 1
