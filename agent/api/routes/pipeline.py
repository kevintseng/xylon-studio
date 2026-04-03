"""
Pipeline API Routes.

POST /api/pipeline/run — Execute verification pipeline (REST).
WS   /api/pipeline/ws  — Execute pipeline with real-time step streaming (WebSocket).
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from agent.pipeline.models import PipelineConfig, StepResult
from agent.pipeline.runner import run_pipeline

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pipeline")


class PipelineRequest(BaseModel):
    """Request body for pipeline execution."""

    rtl_code: str = Field(
        ...,
        description="Verilog RTL source code",
        min_length=1,
        max_length=500_000,
    )
    testbench_code: Optional[str] = Field(
        None,
        description="Testbench source code (optional — if None and llm_provider set, auto-generated)",
        max_length=500_000,
    )
    coverage_target: float = Field(
        0.8,
        ge=0.0, le=1.0,
        description="Target coverage score (0.0-1.0)",
    )
    max_iterations: int = Field(
        5,
        ge=1, le=20,
        description="Maximum coverage improvement iterations (Phase B)",
    )
    lint_enabled: bool = Field(
        True,
        description="Whether to run the lint step",
    )
    synthesis_enabled: bool = Field(
        False,
        description="Whether to run Yosys synthesis report",
    )
    simulation_timeout: int = Field(
        300,
        ge=10, le=3600,
        description="Simulation timeout in seconds",
    )
    llm_provider: Optional[str] = Field(
        None,
        description="LLM provider for Phase B auto-generation (e.g. 'ollama', 'claude'). None = Phase A only.",
    )
    mode: str = Field(
        "professional",
        pattern="^(education|professional)$",
        description="Pipeline mode: 'education' (pauses with explanations) or 'professional' (runs automatically)",
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "rtl_code": "module adder(input [7:0] a, b, output [8:0] sum);\n  assign sum = a + b;\nendmodule",
                "testbench_code": None,
                "coverage_target": 0.8,
                "lint_enabled": True,
                "synthesis_enabled": False,
                "simulation_timeout": 300,
                "llm_provider": None,
                "mode": "professional",
            }
        }
    }


class PipelineResponse(BaseModel):
    """Response body for pipeline execution."""

    pipeline_id: str
    success: bool
    total_duration_seconds: float
    iterations_used: int
    steps: list
    final_coverage: Optional[dict] = None


def _create_llm_gateway(provider_name: str | None):
    """Create an LLMGateway from a provider name string, or return None."""
    if not provider_name:
        return None
    try:
        from agent.core.llm_gateway import LLMGateway, LLMProvider, OllamaBackend, VLLMBackend, ClaudeBackend

        provider_map = {
            "ollama": (LLMProvider.OLLAMA, OllamaBackend),
            "vllm": (LLMProvider.VLLM, VLLMBackend),
            "claude": (LLMProvider.CLAUDE, ClaudeBackend),
        }

        if provider_name not in provider_map:
            logger.warning(f"Unknown LLM provider: {provider_name}")
            return None

        provider_enum, backend_cls = provider_map[provider_name]
        backend = backend_cls()
        return LLMGateway(
            primary_provider=provider_enum,
            backends={provider_enum: backend},
        )
    except Exception as e:
        logger.error(f"Failed to initialize LLM gateway '{provider_name}': {e}")
        return None


@router.post("/run", response_model=PipelineResponse)
async def run_pipeline_endpoint(request: PipelineRequest) -> PipelineResponse:
    """
    Execute verification pipeline on RTL code.

    Phase A (no llm_provider): lint -> simulate -> coverage
    Phase B (with llm_provider): lint -> test_plan -> testbench_gen -> simulate -> coverage -> iterate
    """
    logger.info(
        f"Pipeline request: {len(request.rtl_code)} chars RTL, "
        f"testbench={'yes' if request.testbench_code else 'no'}, "
        f"llm={'yes' if request.llm_provider else 'no'}"
    )

    config = PipelineConfig(
        coverage_target=request.coverage_target,
        max_iterations=request.max_iterations,
        lint_enabled=request.lint_enabled,
        synthesis_enabled=request.synthesis_enabled,
        simulation_timeout=request.simulation_timeout,
        llm_provider=request.llm_provider,
        mode=request.mode,
    )

    # Phase B: resolve LLM gateway if provider specified
    llm_gateway = _create_llm_gateway(request.llm_provider)

    try:
        result = await run_pipeline(
            rtl_code=request.rtl_code,
            testbench_code=request.testbench_code,
            config=config,
            llm_gateway=llm_gateway,
        )

        result_dict = result.to_dict()

        return PipelineResponse(
            pipeline_id=result.pipeline_id,
            success=result.success,
            total_duration_seconds=result.total_duration_seconds,
            iterations_used=result.iterations_used,
            steps=result_dict["steps"],
            final_coverage=result_dict.get("final_coverage"),
        )

    except Exception as e:
        logger.error(f"Pipeline endpoint error: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Pipeline execution failed: {e}",
        )


@router.websocket("/ws")
async def pipeline_websocket(websocket: WebSocket):
    """
    WebSocket endpoint for real-time pipeline progress streaming.

    Client sends a JSON message with the pipeline request:
    {
        "rtl_code": "...",
        "testbench_code": "...",  // optional
        "coverage_target": 0.8,
        "lint_enabled": true,
        "simulation_timeout": 300
    }

    Server streams step results as JSON messages:
    {
        "type": "step_complete",
        "pipeline_id": "pipe-abc123",
        "step_index": 1,
        "total_steps": 3,
        "step": {
            "step_name": "lint",
            "status": "passed",
            "duration_seconds": 0.5,
            ...
        }
    }

    Final message:
    {
        "type": "pipeline_complete",
        "result": { ... full PipelineResult ... }
    }
    """
    await websocket.accept()

    try:
        # Receive pipeline request
        data = await websocket.receive_json()

        # Validate input using the same Pydantic model as REST
        try:
            req = PipelineRequest(**data)
        except Exception as e:
            await websocket.send_json({
                "type": "error",
                "message": f"Invalid request: {e}",
            })
            await websocket.close()
            return

        config = PipelineConfig(
            coverage_target=req.coverage_target,
            max_iterations=req.max_iterations,
            lint_enabled=req.lint_enabled,
            synthesis_enabled=req.synthesis_enabled,
            simulation_timeout=req.simulation_timeout,
            llm_provider=req.llm_provider,
            mode=req.mode,
        )

        llm_gateway = _create_llm_gateway(req.llm_provider)

        # Define step callback that streams to WebSocket
        async def on_step(
            pipeline_id: str,
            step_result: StepResult,
            step_index: int,
            total_steps: int,
        ):
            await websocket.send_json({
                "type": "step_complete",
                "pipeline_id": pipeline_id,
                "step_index": step_index,
                "total_steps": total_steps,
                "step": {
                    "step_name": step_result.step_name,
                    "status": step_result.status.value,
                    "duration_seconds": step_result.duration_seconds,
                    "output": step_result.output,
                    "errors": step_result.errors,
                    "warnings": step_result.warnings,
                },
            })

        # Run pipeline with streaming callback
        result = await run_pipeline(
            rtl_code=req.rtl_code,
            testbench_code=req.testbench_code,
            config=config,
            on_step_complete=on_step,
            llm_gateway=llm_gateway,
        )

        # Send final result
        await websocket.send_json({
            "type": "pipeline_complete",
            "result": result.to_dict(),
        })

    except WebSocketDisconnect:
        logger.info("Pipeline WebSocket client disconnected")
    except Exception as e:
        logger.error(f"Pipeline WebSocket error: {e}", exc_info=True)
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e),
            })
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
