"""Contract tests for the pipeline API surfaces."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from agent.api import local_web_origins
from agent.api.main import app, global_exception_handler
from agent.api.routes import pipeline as pipeline_routes
from agent.pipeline.models import (
    CoverageReport,
    FailureKind,
    PipelineOutcome,
    PipelineResult,
    RunMode,
    StepResult,
    StepStatus,
)


def test_local_web_origins_allow_only_the_selected_loopback_port():
    assert local_web_origins(3100) == (
        "http://127.0.0.1:3100",
        "http://localhost:3100",
    )
    with pytest.raises(ValueError, match="between 1 and 65535"):
        local_web_origins(0)


def test_websocket_final_result_uses_canonical_pipeline_contract():
    """WebSocket completion must not maintain a lossy parallel serializer."""
    result = PipelineResult(
        pipeline_id="pipe-contract",
        steps=[],
        final_coverage=CoverageReport(
            line_coverage=None,
            toggle_coverage=None,
            branch_coverage=None,
            score=0.85,
            metric_sources={"score": "computed_verilator_point_counts"},
        ),
        iterations_used=1,
        total_duration_seconds=1.25,
        success=True,
        mode=RunMode.PROVIDED_TESTBENCH,
        outcome=PipelineOutcome.VERIFIED,
    )

    with patch(
        "agent.api.routes.pipeline.run_pipeline",
        new=AsyncMock(return_value=result),
    ) as runner:
        with TestClient(app) as client:
            with client.websocket_connect("/api/pipeline/ws") as websocket:
                websocket.send_json({
                    "rtl_code": "module m; endmodule",
                    "testbench_code": "int main() { return 0; }",
                })
                message = websocket.receive_json()

    assert message["type"] == "pipeline_complete"
    assert message["result"] == result.to_dict()
    assert message["result"]["final_coverage"]["line_coverage"] is None
    assert message["result"]["final_coverage"]["metric_sources"] == {
        "score": "computed_verilator_point_counts"
    }
    assert runner.await_args.kwargs["config"].resource_check_enabled is True


def test_websocket_cancel_message_returns_canonical_cancelled_result():
    """Cancel remains connected long enough to deliver the terminal outcome."""
    async def fake_run_pipeline(**kwargs):
        cancellation_event = kwargs["cancellation_event"]
        await asyncio.wait_for(cancellation_event.wait(), timeout=1.0)
        return PipelineResult(
            pipeline_id="pipe-cancelled",
            steps=[],
            final_coverage=None,
            iterations_used=0,
            total_duration_seconds=0.1,
            success=False,
            mode=RunMode.PROVIDED_TESTBENCH,
            outcome=PipelineOutcome.CANCELLED,
        )

    with patch(
        "agent.api.routes.pipeline.run_pipeline",
        new=fake_run_pipeline,
    ):
        with TestClient(app) as client:
            with client.websocket_connect("/api/pipeline/ws") as websocket:
                websocket.send_json({
                    "rtl_code": "module m; endmodule",
                    "testbench_code": "int main() { return 0; }",
                })
                websocket.send_json({"type": "cancel"})
                message = websocket.receive_json()

    assert message["type"] == "pipeline_complete"
    assert message["result"]["outcome"] == "cancelled"
    assert message["result"]["success"] is False


def test_websocket_live_step_preserves_failure_and_recovery_codes():
    async def fake_run_pipeline(**kwargs):
        step = StepResult(
            step_name="lint",
            status=StepStatus.FAILED,
            duration_seconds=0.1,
            errors=["container is not running"],
            failure_kind=FailureKind.INFRASTRUCTURE,
            recovery_code="repair_toolchain",
        )
        await kwargs["on_step_complete"](step)
        return PipelineResult(
            pipeline_id="pipe-infra",
            steps=[step],
            final_coverage=None,
            iterations_used=0,
            total_duration_seconds=0.1,
            success=False,
            mode=RunMode.LINT_ONLY,
            outcome=PipelineOutcome.INFRASTRUCTURE_ERROR,
        )

    with patch("agent.api.routes.pipeline.run_pipeline", new=fake_run_pipeline):
        with TestClient(app) as client:
            with client.websocket_connect("/api/pipeline/ws") as websocket:
                websocket.send_json({"rtl_code": "module m; endmodule"})
                step_message = websocket.receive_json()
                final_message = websocket.receive_json()

    assert step_message["type"] == "step_complete"
    assert step_message["step"]["failure_kind"] == "infrastructure"
    assert step_message["step"]["recovery_code"] == "repair_toolchain"
    assert final_message["result"]["outcome"] == "infrastructure_error"


def test_rest_run_returns_the_same_canonical_result_contract():
    step = StepResult(
        step_name="lint",
        status=StepStatus.FAILED,
        duration_seconds=0.1,
        errors=["%Error: syntax error"],
        failure_kind=FailureKind.CONFIGURATION,
        recovery_code="correct_rtl",
    )
    result = PipelineResult(
        pipeline_id="pipe-rest",
        steps=[step],
        final_coverage=None,
        iterations_used=0,
        total_duration_seconds=0.1,
        success=False,
        mode=RunMode.LINT_ONLY,
        outcome=PipelineOutcome.CONFIGURATION_ERROR,
    )

    with patch(
        "agent.api.routes.pipeline.run_pipeline",
        new=AsyncMock(return_value=result),
    ) as runner:
        with TestClient(app) as client:
            response = client.post(
                "/api/pipeline/run",
                json={"rtl_code": "module broken("},
            )

    assert response.status_code == 200
    assert response.json() == result.to_dict()
    assert runner.await_args.kwargs["config"].resource_check_enabled is True


def test_removed_dragon_endpoints_are_not_public_api_surfaces():
    with TestClient(app) as client:
        assert client.get("/api/design/health").status_code == 404
        assert client.get("/api/verification/health").status_code == 404


def test_local_readiness_endpoint_returns_runtime_state_resource_metrics_and_policy():
    readiness = {
        "status": "blocked",
        "runtime_healthy": False,
        "resource_blocker_codes": ["memory_low"],
        "resource_blockers": ["memory free 19% is below the 20% safety floor"],
        "snapshot": {
            "logical_cpus": 12,
            "load_one_minute": 5.25,
            "memory_free_percent": 19,
            "memory_free_bytes": 5153960755,
            "memory_total_bytes": 17179869184,
            "disk_free_bytes": 30386876416,
            "disk_total_bytes": 137438953472,
        },
        "policy": {
            "max_heavy_jobs": 1,
            "container_cpu_limit": 2,
            "container_memory_limit_bytes": 4294967296,
            "container_network_access": False,
            "cleanup_scope": "launcher_owned_only",
        },
    }

    with patch(
        "agent.api.routes.local.collect_local_readiness",
        return_value=type("Ready", (), {"to_dict": lambda self: readiness})(),
    ):
        with TestClient(app) as client:
            response = client.get("/api/local/readiness")

    assert response.status_code == 200
    assert response.json() == readiness


def test_rest_rejects_removed_generated_testbench_configuration():
    with TestClient(app) as client:
        response = client.post(
            "/api/pipeline/run",
            json={
                "rtl_code": "module m; endmodule",
                "llm_config": {"type": "ollama", "model": "legacy"},
            },
        )

    assert response.status_code == 422


@pytest.mark.parametrize(
    "payload, field_name",
    [
        ({"rtl_code": "module m; endmodule", "coverage_target": 0.0}, "coverage_target"),
        ({"rtl_code": "module m; endmodule", "coverage_target": 1.01}, "coverage_target"),
        ({"rtl_code": "module m; endmodule", "simulation_timeout": 0}, "simulation_timeout"),
        ({"rtl_code": "   "}, "rtl_code"),
    ],
)
def test_rest_rejects_invalid_pipeline_values_before_starting_eda(payload, field_name):
    runner = AsyncMock()

    with patch("agent.api.routes.pipeline.run_pipeline", new=runner):
        with TestClient(app) as client:
            response = client.post("/api/pipeline/run", json=payload)

    assert response.status_code == 422
    assert field_name in response.text
    runner.assert_not_awaited()


@pytest.mark.parametrize(
    "field_name,payload",
    [
        ("rtl_code", {"rtl_code": "m" * (1024 * 1024 + 1)}),
        (
            "testbench_code",
            {
                "rtl_code": "module m; endmodule",
                "testbench_code": "x" * (1024 * 1024 + 1),
            },
        ),
    ],
)
def test_rest_rejects_oversized_source_before_starting_eda(field_name, payload):
    runner = AsyncMock()

    with patch("agent.api.routes.pipeline.run_pipeline", new=runner):
        with TestClient(app) as client:
            response = client.post("/api/pipeline/run", json=payload)

    assert response.status_code == 422
    assert field_name in response.text
    runner.assert_not_awaited()


def test_rest_rejects_an_oversized_http_body_before_json_parsing():
    with TestClient(app) as client:
        response = client.post(
            "/api/pipeline/run",
            content=b"x" * (2 * 1024 * 1024 + 64 * 1024 + 1),
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 413
    assert response.json() == {"detail": "Pipeline request body is too large"}


def test_websocket_rejects_removed_generated_testbench_configuration():
    runner = AsyncMock()

    with patch("agent.api.routes.pipeline.run_pipeline", new=runner):
        with TestClient(app) as client:
            with client.websocket_connect("/api/pipeline/ws") as websocket:
                websocket.send_json({
                    "rtl_code": "module m; endmodule",
                    "llm_provider": "legacy",
                })
                message = websocket.receive_json()

    assert message == {
        "type": "error",
        "message": "Unsupported pipeline fields: llm_provider",
    }
    runner.assert_not_awaited()


def test_websocket_uses_the_same_bounded_request_validation_as_rest():
    runner = AsyncMock()

    with patch("agent.api.routes.pipeline.run_pipeline", new=runner):
        with TestClient(app) as client:
            with client.websocket_connect("/api/pipeline/ws") as websocket:
                websocket.send_json({
                    "rtl_code": "module m; endmodule",
                    "simulation_timeout": 3601,
                })
                message = websocket.receive_json()

    assert message["type"] == "error"
    assert message["message"].startswith("Invalid pipeline request:")
    assert "simulation_timeout" in message["message"]
    runner.assert_not_awaited()


def test_websocket_rejects_an_oversized_message_before_starting_eda():
    runner = AsyncMock()

    with patch("agent.api.routes.pipeline.run_pipeline", new=runner):
        with TestClient(app) as client:
            with client.websocket_connect("/api/pipeline/ws") as websocket:
                websocket.send_text("x" * (2 * 1024 * 1024 + 64 * 1024 + 1))
                message = websocket.receive_json()

    assert message == {
        "type": "error",
        "message": "Pipeline request body is too large",
    }
    runner.assert_not_awaited()


def test_websocket_does_not_expose_unhandled_exception_details():
    with patch(
        "agent.api.routes.pipeline.run_pipeline",
        new=AsyncMock(side_effect=RuntimeError("secret /private/tool/path")),
    ):
        with TestClient(app) as client:
            with client.websocket_connect("/api/pipeline/ws") as websocket:
                websocket.send_json({"rtl_code": "module m; endmodule"})
                message = websocket.receive_json()

    assert message == {
        "type": "error",
        "message": "Pipeline execution failed",
    }


def test_cors_allows_only_the_local_web_application_without_credentials():
    with TestClient(app) as client:
        response = client.options(
            "/api/pipeline/run",
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Access-Control-Request-Method": "POST",
            },
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"
    assert "access-control-allow-credentials" not in response.headers


def test_websocket_rejects_non_local_browser_origins_before_accepting_work():
    runner = AsyncMock()

    with patch("agent.api.routes.pipeline.run_pipeline", new=runner):
        with TestClient(app) as client:
            with pytest.raises(WebSocketDisconnect) as exc_info:
                with client.websocket_connect(
                    "/api/pipeline/ws",
                    headers={"origin": "https://malicious.example"},
                ):
                    pass

    assert exc_info.value.code == 1008
    runner.assert_not_awaited()


@pytest.mark.asyncio
async def test_unhandled_exception_response_does_not_expose_internal_details():
    response = await global_exception_handler(None, RuntimeError("secret filesystem path"))

    assert response.status_code == 500
    assert json.loads(response.body) == {"error": "Internal server error"}


@pytest.mark.asyncio
async def test_local_api_serializes_pipeline_work_to_one_heavy_run():
    active_runs = 0
    peak_active_runs = 0

    async def fake_run_pipeline(**kwargs):
        nonlocal active_runs, peak_active_runs
        active_runs += 1
        peak_active_runs = max(peak_active_runs, active_runs)
        await asyncio.sleep(0.01)
        active_runs -= 1
        return kwargs["rtl_code"]

    with patch("agent.api.routes.pipeline.run_pipeline", new=fake_run_pipeline):
        results = await asyncio.gather(
            pipeline_routes._run_pipeline_in_local_slot(rtl_code="first"),
            pipeline_routes._run_pipeline_in_local_slot(rtl_code="second"),
        )

    assert results == ["first", "second"]
    assert peak_active_runs == 1
