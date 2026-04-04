"""
Verification Dragon API Routes.

Endpoints for testbench generation and RTL verification.
"""

import logging
import os
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from agent.dragons import VerificationDragon, VerificationDragonError
from agent.models import RTLCode, TestReport

logger = logging.getLogger(__name__)

router = APIRouter()

# LLM endpoint from environment
LLM_ENDPOINT = os.getenv('LLM_ENDPOINT', 'http://localhost:8000')


class VerificationRequest(BaseModel):
    """Request model for verification."""
    module_name: str = Field(..., description="Module name")
    code: str = Field(..., min_length=1, description="Verilog RTL code")
    file_path: str | None = Field(None, description="Original file path")

    class Config:
        json_schema_extra = {
            "example": {
                "module_name": "adder_8bit",
                "code": "module adder_8bit(input [7:0] a, input [7:0] b, output [8:0] sum); assign sum = a + b; endmodule",
                "file_path": "/tmp/adder_8bit.v"
            }
        }


class VerificationResponse(BaseModel):
    """Response model for verification."""
    testbench_file_path: str
    test_cases_passed: int
    test_cases_failed: int
    code_coverage: float
    waveform_file_path: str | None = None
    errors: list[str]
    generated_at: datetime

    @classmethod
    def from_report(cls, report: TestReport):
        """Create response from TestReport model."""
        return cls(
            testbench_file_path=report.testbench_file_path,
            test_cases_passed=report.test_cases_passed,
            test_cases_failed=report.test_cases_failed,
            code_coverage=report.code_coverage,
            waveform_file_path=report.waveform_file_path,
            errors=report.errors,
            generated_at=report.generated_at
        )


@router.post("/verification/verify", response_model=VerificationResponse)
async def verify_rtl(request: VerificationRequest, background_tasks: BackgroundTasks):
    """
    Generate testbench and verify RTL code.

    Process:
    1. Analyze RTL module interface
    2. Generate testbench using LLM
    3. Run Verilator simulation
    4. Collect coverage and test results

    Returns:
        VerificationResponse with test results and coverage
    """
    logger.info(f"Verifying RTL: {request.module_name}...")

    try:
        # Create RTLCode from request
        rtl = RTLCode(
            module_name=request.module_name,
            file_path=request.file_path or f"/tmp/{request.module_name}.v",
            code=request.code,
            lines_of_code=len(request.code.split('\n')),
            quality_score=1.0,  # Assume pre-validated
            lint_warnings=[]
        )

        # Initialize Verification Dragon
        dragon = VerificationDragon(llm_endpoint=LLM_ENDPOINT)

        # Run verification
        report = dragon.verify(rtl)

        # Get metrics
        metrics = dragon.get_metrics()
        logger.info(
            f"Verification complete: {report.test_cases_passed} passed, "
            f"{report.test_cases_failed} failed, "
            f"coverage={report.code_coverage * 100:.1f}%, "
            f"duration={metrics.duration_seconds:.1f}s"
        )

        # Return response
        return VerificationResponse.from_report(report)

    except VerificationDragonError as e:
        logger.error(f"Verification failed: {e}")
        raise HTTPException(
            status_code=400,
            detail=f"Verification failed: {str(e)}"
        ) from e
    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {str(e)}"
        ) from e


@router.get("/verification/health")
async def verification_health():
    """Health check for Verification Dragon service."""
    try:
        # Simple health check
        VerificationDragon(llm_endpoint=LLM_ENDPOINT)
        return {
            "status": "healthy",
            "service": "verification-dragon",
            "llm_endpoint": LLM_ENDPOINT
        }
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Service unhealthy: {str(e)}"
        ) from e
