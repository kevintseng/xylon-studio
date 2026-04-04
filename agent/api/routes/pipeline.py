"""Pipeline API routes."""

import json
import logging
from dataclasses import asdict
from typing import Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from agent.pipeline.models import PipelineConfig, PipelineResult, StepResult, TestPlan
from agent.pipeline.runner import run_pipeline

logger = logging.getLogger(__name__)

router = APIRouter(tags=["pipeline"])


class PipelineRequest(BaseModel):
    """Request model for pipeline execution."""

    rtl_code: str = Field(..., description="Verilog RTL code")
    testbench_code: Optional[str] = Field(
        None,
        description="Optional testbench code for Phase A (single-pass simulation)",
    )
    coverage_target: float = Field(0.8, description="Target coverage (0.0-1.0)")
    simulation_timeout: int = Field(300, description="Simulation timeout in seconds")
    llm_config: Optional[dict] = Field(
        None,
        description="LLM provider configuration for Phase B (testbench generation). "
                    "If provided, enables test plan generation and testbench generation with iteration. "
                    "Expected keys: type (vllm/openai/anthropic), endpoint, model, timeout, api_key (if required)",
    )

    class Config:
        json_schema_extra = {
            "example": {
                "rtl_code": "module adder_8bit(...); endmodule",
                "testbench_code": "module tb_adder(...); endmodule",
                "coverage_target": 0.85,
                "simulation_timeout": 300,
                "llm_config": {
                    "type": "vllm",
                    "endpoint": "http://localhost:8000",
                    "model": "deepseek-coder",
                    "timeout": 30,
                },
            }
        }


class PipelineResponse(BaseModel):
    """Response model for pipeline execution."""

    pipeline_id: str
    success: bool
    total_duration_seconds: float
    steps_passed: int
    steps_total: int
    coverage_score: Optional[float] = None
    test_plan: Optional[TestPlan] = Field(
        None,
        description="Generated test plan (Phase B only). Present when LLM provider is configured.",
    )
    iterations_used: int = Field(
        1,
        description="Number of coverage-driven iterations completed (Phase B). "
                    "Phase A always uses 1 iteration.",
    )

    class Config:
        json_schema_extra = {
            "example": {
                "pipeline_id": "550e8400-e29b-41d4-a716-446655440000",
                "success": True,
                "total_duration_seconds": 45.3,
                "steps_passed": 3,
                "steps_total": 3,
                "coverage_score": 0.87,
                "test_plan": None,
                "iterations_used": 1,
            }
        }


@router.post("/pipeline/run", response_model=PipelineResponse)
async def run_pipeline_endpoint(request: PipelineRequest) -> PipelineResponse:
    """
    Execute verification pipeline.

    Supports two phases:
    - Phase A (user-provided testbench): lint -> simulate -> coverage (single pass)
    - Phase B (LLM-driven): lint -> test_plan -> testbench -> [simulate -> coverage]* (with iteration)

    Phase A runs when testbench_code is provided and llm_config is not.
    Phase B runs when llm_config is provided, with optional user testbench fallback.

    Args:
        request: Pipeline request with RTL code, optional testbench, and optional LLM config

    Returns:
        Pipeline execution result with coverage score and phase-specific metadata

    Raises:
        HTTPException: If execution fails
    """
    logger.info(f"Pipeline request: rtl_lines={len(request.rtl_code.splitlines())}")

    try:
        # Create config from request
        # Phase B enabled if llm_config provided, Phase A otherwise
        config = PipelineConfig(
            coverage_target=request.coverage_target,
            simulation_timeout=request.simulation_timeout,
            llm_provider=request.llm_config,
            generate_testbench=request.llm_config is not None,
            generate_test_plan=request.llm_config is not None,
        )

        # Run pipeline
        result: PipelineResult = await run_pipeline(
            rtl_code=request.rtl_code,
            testbench_code=request.testbench_code,
            config=config,
        )

        # Count passed steps
        steps_passed = sum(
            1 for step in result.steps
            if step.status.value == "passed"
        )

        # Extract coverage score
        coverage_score = None
        if result.final_coverage:
            coverage_score = result.final_coverage.score

        logger.info(
            f"Pipeline completed: pipeline_id={result.pipeline_id}, "
            f"success={result.success}, duration={result.total_duration_seconds:.2f}s"
        )

        return PipelineResponse(
            pipeline_id=result.pipeline_id,
            success=result.success,
            total_duration_seconds=result.total_duration_seconds,
            steps_passed=steps_passed,
            steps_total=len(result.steps),
            coverage_score=coverage_score,
            test_plan=result.test_plan,
            iterations_used=result.iterations_used,
        )

    except Exception as e:
        logger.error(f"Pipeline execution failed: {e}")
        raise HTTPException(status_code=500, detail=f"Pipeline execution failed: {e}")


def _step_to_dict(step: StepResult) -> dict:
    """Convert StepResult to JSON-serializable dict."""
    return {
        "step_name": step.step_name,
        "status": step.status.value,
        "duration_seconds": step.duration_seconds,
        "output": step.output,
        "errors": step.errors,
        "warnings": step.warnings,
    }


@router.websocket("/pipeline/ws")
async def pipeline_websocket(ws: WebSocket):
    """
    WebSocket endpoint for real-time pipeline execution.

    Client sends a JSON message with pipeline config on connect.
    Server streams step_complete events as each step finishes,
    then sends pipeline_complete with the final result.
    """
    await ws.accept()
    logger.info("Pipeline WebSocket connected")

    try:
        # Receive pipeline config from client
        raw = await ws.receive_text()
        data = json.loads(raw)

        rtl_code = data.get("rtl_code", "")
        testbench_code = data.get("testbench_code")
        coverage_target = data.get("coverage_target", 0.8)
        simulation_timeout = data.get("simulation_timeout", 300)
        llm_config = data.get("llm_provider")

        if not rtl_code.strip():
            await ws.send_json({"type": "error", "message": "rtl_code is required"})
            await ws.close()
            return

        config = PipelineConfig(
            coverage_target=coverage_target,
            simulation_timeout=simulation_timeout,
            llm_provider=llm_config,
            generate_testbench=llm_config is not None,
            generate_test_plan=llm_config is not None,
        )

        # Callback to stream step results
        async def on_step_complete(step: StepResult):
            await ws.send_json({
                "type": "step_complete",
                "step": _step_to_dict(step),
            })

        # Run pipeline with streaming
        result = await run_pipeline(
            rtl_code=rtl_code,
            testbench_code=testbench_code,
            config=config,
            on_step_complete=on_step_complete,
        )

        # Send final result
        coverage_score = None
        if result.final_coverage:
            coverage_score = {
                "line_coverage": result.final_coverage.line_coverage,
                "toggle_coverage": result.final_coverage.toggle_coverage,
                "branch_coverage": result.final_coverage.branch_coverage,
                "score": result.final_coverage.score,
            }

        await ws.send_json({
            "type": "pipeline_complete",
            "result": {
                "pipeline_id": result.pipeline_id,
                "success": result.success,
                "total_duration_seconds": result.total_duration_seconds,
                "iterations_used": result.iterations_used,
                "steps": [_step_to_dict(s) for s in result.steps],
                "final_coverage": coverage_score,
            },
        })

    except WebSocketDisconnect:
        logger.info("Pipeline WebSocket disconnected")
    except json.JSONDecodeError:
        await ws.send_json({"type": "error", "message": "Invalid JSON"})
    except Exception as e:
        logger.error(f"Pipeline WebSocket error: {e}")
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass
