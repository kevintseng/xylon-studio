"""Pipeline API routes."""

import asyncio
import contextlib
import json
import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from agent.api import LOCAL_WEB_ORIGINS
from agent.pipeline.limits import (
    MAX_PIPELINE_WS_MESSAGE_BYTES,
    MAX_SOURCE_BYTES,
    validate_source_text,
)
from agent.pipeline.models import PipelineConfig, PipelineResult, StepResult
from agent.pipeline.runner import run_pipeline

logger = logging.getLogger(__name__)

router = APIRouter(tags=["pipeline"])
_LOCAL_PIPELINE_SLOT = asyncio.Lock()


async def _run_pipeline_in_local_slot(**kwargs):
    """Serialize heavy EDA work inside the supported single-worker local API."""
    async with _LOCAL_PIPELINE_SLOT:
        return await run_pipeline(**kwargs)


class PipelineRequest(BaseModel):
    """Request model for pipeline execution."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "example": {
                "rtl_code": "module adder_8bit(...); endmodule",
                "testbench_code": "#include <iostream>\nint main() { /* self-check */ }",
                "coverage_target": 0.85,
                "simulation_timeout": 300,
            }
        },
    )

    rtl_code: str = Field(
        ...,
        min_length=1,
        max_length=MAX_SOURCE_BYTES,
        description="Verilog RTL code",
    )
    testbench_code: str | None = Field(
        None,
        max_length=MAX_SOURCE_BYTES,
        description="Optional independent C++ self-checking testbench code",
    )
    coverage_target: float = Field(
        0.8,
        gt=0.0,
        le=1.0,
        description="Target coverage (greater than 0.0, up to 1.0)",
    )
    simulation_timeout: int = Field(
        300,
        ge=1,
        le=3600,
        description="Simulation timeout in seconds",
    )
    lint_enabled: bool = Field(True, description="Run Verilator lint step")
    synthesis_enabled: bool = Field(False, description="Run Yosys synthesis report after verification")

    @field_validator("rtl_code")
    @classmethod
    def require_nonblank_rtl(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("rtl_code must contain Verilog source")
        return value

    @field_validator("rtl_code", "testbench_code")
    @classmethod
    def enforce_source_byte_budget(cls, value: str | None, info):
        validate_source_text(info.field_name, value)
        return value


class PipelineResponse(BaseModel):
    """Canonical pipeline result shared with WebSocket and persistence."""

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "pipeline_id": "550e8400-e29b-41d4-a716-446655440000",
                "steps": [],
                "final_coverage": None,
                "iterations_used": 0,
                "total_duration_seconds": 0.3,
                "success": True,
                "mode": "provided_testbench",
                "outcome": "verified",
                "artifacts": None,
                "timestamp": "2026-08-13T00:00:00",
            }
        },
    )

    pipeline_id: str
    steps: list[dict]
    final_coverage: dict | None = None
    iterations_used: int
    total_duration_seconds: float
    success: bool
    mode: str
    outcome: str
    artifacts: dict | None = None
    timestamp: str

@router.post("/pipeline/run", response_model=PipelineResponse)
async def run_pipeline_endpoint(request: PipelineRequest) -> PipelineResponse:
    """
    Execute verification pipeline.

    A supplied C++ self-checking testbench selects ``provided_testbench`` mode.
    Without one, the outcome is lint-only and never verified.

    Args:
        request: Pipeline request with RTL code and optional C++ testbench

    Returns:
        Canonical pipeline result with evidence and mode-specific metadata

    Raises:
        HTTPException: If execution fails
    """
    logger.info(f"Pipeline request: rtl_lines={len(request.rtl_code.splitlines())}")

    try:
        # Create config from request
        config = PipelineConfig(
            coverage_target=request.coverage_target,
            simulation_timeout=request.simulation_timeout,
            lint_enabled=request.lint_enabled,
            synthesis_enabled=request.synthesis_enabled,
            resource_check_enabled=True,
        )

        # Run pipeline
        result: PipelineResult = await _run_pipeline_in_local_slot(
            rtl_code=request.rtl_code,
            testbench_code=request.testbench_code,
            config=config,
        )

        logger.info(
            f"Pipeline completed: pipeline_id={result.pipeline_id}, "
            f"success={result.success}, duration={result.total_duration_seconds:.2f}s"
        )

        return PipelineResponse(**result.to_dict())

    except Exception as e:
        logger.exception("Pipeline execution failed")
        raise HTTPException(
            status_code=500,
            detail="Pipeline execution failed",
        ) from e


def _step_to_dict(step: StepResult) -> dict:
    """Convert StepResult to JSON-serializable dict."""
    return step.to_dict()


@router.websocket("/pipeline/ws")
async def pipeline_websocket(ws: WebSocket):
    """
    WebSocket endpoint for real-time pipeline execution.

    Client sends a JSON message with pipeline config on connect.
    Server streams step_complete events as each step finishes,
    then sends pipeline_complete with the final result.
    """
    origin = ws.headers.get("origin")
    if origin is not None and origin not in LOCAL_WEB_ORIGINS:
        await ws.close(code=1008, reason="WebSocket origin is not allowed")
        return

    await ws.accept()
    logger.info("Pipeline WebSocket connected")
    cancellation_event = asyncio.Event()
    watch_task: asyncio.Task | None = None
    connection_open = True

    try:
        # Receive pipeline config from client
        raw = await ws.receive_text()
        if len(raw.encode("utf-8")) > MAX_PIPELINE_WS_MESSAGE_BYTES:
            await ws.send_json({
                "type": "error",
                "message": "Pipeline request body is too large",
            })
            await ws.close(code=1009, reason="Pipeline request body is too large")
            return
        data = json.loads(raw)
        if not isinstance(data, dict):
            await ws.send_json({
                "type": "error",
                "message": "Invalid pipeline request: expected a JSON object",
            })
            await ws.close()
            return

        allowed_fields = {
            "rtl_code",
            "testbench_code",
            "coverage_target",
            "simulation_timeout",
            "lint_enabled",
            "synthesis_enabled",
        }
        unsupported_fields = sorted(set(data) - allowed_fields)
        if unsupported_fields:
            await ws.send_json({
                "type": "error",
                "message": "Unsupported pipeline fields: "
                + ", ".join(unsupported_fields),
            })
            await ws.close()
            return

        try:
            request = PipelineRequest.model_validate(data)
        except ValidationError as exc:
            problems = []
            for error in exc.errors(include_url=False, include_context=False):
                location = ".".join(str(part) for part in error["loc"])
                problems.append(f"{location}: {error['msg']}")
            await ws.send_json({
                "type": "error",
                "message": "Invalid pipeline request: " + "; ".join(problems),
            })
            await ws.close()
            return

        config = PipelineConfig(
            coverage_target=request.coverage_target,
            simulation_timeout=request.simulation_timeout,
            lint_enabled=request.lint_enabled,
            synthesis_enabled=request.synthesis_enabled,
            resource_check_enabled=True,
        )

        async def watch_client_messages():
            nonlocal connection_open
            try:
                while True:
                    message = json.loads(await ws.receive_text())
                    if message.get("type") == "cancel":
                        cancellation_event.set()
                        return
            except (WebSocketDisconnect, RuntimeError):
                connection_open = False
                cancellation_event.set()
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "message": "Invalid JSON"})

        async def send_event(payload: dict) -> bool:
            nonlocal connection_open
            if not connection_open:
                return False
            try:
                await ws.send_json(payload)
                return True
            except (WebSocketDisconnect, RuntimeError):
                connection_open = False
                cancellation_event.set()
                return False

        watch_task = asyncio.create_task(watch_client_messages())

        # Callback to stream step events
        async def on_step_started(step_name: str):
            await send_event({
                "type": "step_started",
                "step_name": step_name,
            })

        async def on_step_complete(step: StepResult):
            await send_event({
                "type": "step_complete",
                "step": _step_to_dict(step),
            })

        # Run pipeline with streaming
        result = await _run_pipeline_in_local_slot(
            rtl_code=request.rtl_code,
            testbench_code=request.testbench_code,
            config=config,
            on_step_complete=on_step_complete,
            on_step_started=on_step_started,
            cancellation_event=cancellation_event,
        )

        await send_event({
            "type": "pipeline_complete",
            "result": result.to_dict(),
        })

    except WebSocketDisconnect:
        logger.info("Pipeline WebSocket disconnected")
    except json.JSONDecodeError:
        await ws.send_json({"type": "error", "message": "Invalid JSON"})
    except Exception:
        logger.exception("Pipeline WebSocket error")
        try:
            await ws.send_json({
                "type": "error",
                "message": "Pipeline execution failed",
            })
        except Exception:
            pass
    finally:
        if watch_task is not None:
            watch_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watch_task
        try:
            await ws.close()
        except Exception:
            pass
