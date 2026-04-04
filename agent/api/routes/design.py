"""
Design Dragon API Routes.

Endpoints for RTL generation from natural language specifications.
"""

import logging
import os
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from agent.dragons import DesignDragon, DesignDragonError
from agent.models import DesignSpec, RTLCode

logger = logging.getLogger(__name__)

router = APIRouter()

# LLM endpoint from environment
LLM_ENDPOINT = os.getenv('LLM_ENDPOINT', 'http://localhost:8000')


class DesignRequest(BaseModel):
    """Request model for RTL generation."""
    description: str = Field(..., min_length=10, max_length=5000,
                            description="Natural language description")
    target_freq: str = Field(..., description="Target frequency (e.g., '2 GHz')")
    module_name: str | None = Field(None, description="Desired module name")
    max_area: str | None = Field(None, description="Maximum area constraint")
    max_power: str | None = Field(None, description="Maximum power constraint")

    class Config:
        json_schema_extra = {
            "example": {
                "description": "16-bit barrel shifter with 2-stage pipeline",
                "target_freq": "2 GHz",
                "module_name": "barrel_shifter_16bit",
                "max_area": "10000 um²",
                "max_power": "15 mW"
            }
        }


class DesignResponse(BaseModel):
    """Response model for RTL generation."""
    module_name: str
    file_path: str
    code: str
    lines_of_code: int
    quality_score: float
    lint_warnings: list[str]
    estimated_area: float | None = None
    estimated_power: float | None = None
    generated_at: datetime

    @classmethod
    def from_rtl(cls, rtl: RTLCode):
        """Create response from RTLCode model."""
        return cls(
            module_name=rtl.module_name,
            file_path=rtl.file_path,
            code=rtl.code,
            lines_of_code=rtl.lines_of_code,
            quality_score=rtl.quality_score,
            lint_warnings=rtl.lint_warnings,
            estimated_area=rtl.estimated_area,
            estimated_power=rtl.estimated_power,
            generated_at=rtl.generated_at
        )


@router.post("/design/generate", response_model=DesignResponse)
async def generate_rtl(request: DesignRequest, background_tasks: BackgroundTasks):
    """
    Generate Verilog RTL from natural language specification.

    Process:
    1. Validate input specification
    2. Generate RTL using Design Dragon
    3. Lint check with Verilator
    4. Return synthesizable RTL code

    Returns:
        DesignResponse with RTL code and metadata
    """
    logger.info(f"Generating RTL: {request.description[:50]}...")

    try:
        # Create DesignSpec
        spec = DesignSpec(
            description=request.description,
            target_freq=request.target_freq,
            module_name=request.module_name,
            max_area=request.max_area,
            max_power=request.max_power
        )

        # Initialize Design Dragon
        dragon = DesignDragon(llm_endpoint=LLM_ENDPOINT)

        # Generate RTL
        rtl = dragon.breathe_rtl(spec)

        # Get metrics
        metrics = dragon.get_metrics()
        logger.info(
            f"RTL generated: {rtl.module_name}, "
            f"quality={rtl.quality_score:.2f}, "
            f"duration={metrics.duration_seconds:.1f}s"
        )

        # Return response
        return DesignResponse.from_rtl(rtl)

    except DesignDragonError as e:
        logger.error(f"Design generation failed: {e}")
        raise HTTPException(
            status_code=400,
            detail=f"RTL generation failed: {str(e)}"
        ) from e
    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {str(e)}"
        ) from e


@router.get("/design/health")
async def design_health():
    """Health check for Design Dragon service."""
    try:
        # Simple health check
        DesignDragon(llm_endpoint=LLM_ENDPOINT)
        return {
            "status": "healthy",
            "service": "design-dragon",
            "llm_endpoint": LLM_ENDPOINT
        }
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Service unhealthy: {str(e)}"
        ) from e
