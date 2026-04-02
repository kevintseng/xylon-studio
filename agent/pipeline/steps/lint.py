"""
Lint Step.

Runs Verilator --lint-only on RTL code to check for
syntax errors and common coding issues.
"""

import logging
import time

from agent.pipeline.models import StepResult, StepStatus
from agent.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)

STEP_NAME = "lint"


async def run_lint_step(
    rtl_file: str,
    sandbox: SandboxManager,
) -> StepResult:
    """
    Run Verilator lint on a Verilog file.

    Args:
        rtl_file: Path to .v file (inside container or local path for string variant)
        sandbox: SandboxManager instance

    Returns:
        StepResult with lint output, warnings, and errors
    """
    logger.info(f"Lint step: {rtl_file}")
    start = time.monotonic()

    try:
        result = sandbox.lint_verilog(rtl_file)
        duration = time.monotonic() - start

        errors = result.get("errors", [])
        warnings = result.get("warnings", [])

        # Lint passes if no errors (warnings are acceptable)
        has_errors = len(errors) > 0 and not result.get("success", False)

        return StepResult(
            step_name=STEP_NAME,
            status=StepStatus.FAILED if has_errors else StepStatus.PASSED,
            duration_seconds=duration,
            output={
                "stdout": result.get("stdout", ""),
                "stderr": result.get("stderr", ""),
                "error_count": len(errors),
                "warning_count": len(warnings),
            },
            errors=errors,
            warnings=warnings,
        )

    except Exception as e:
        duration = time.monotonic() - start
        logger.error(f"Lint step error: {e}")
        return StepResult(
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            duration_seconds=duration,
            output={},
            errors=[str(e)],
            warnings=[],
        )


async def run_lint_step_from_string(
    verilog_code: str,
    sandbox: SandboxManager,
) -> StepResult:
    """
    Run Verilator lint on Verilog code provided as a string.

    Convenience wrapper that uses SandboxManager.lint_verilog_string().

    Args:
        verilog_code: Verilog source code
        sandbox: SandboxManager instance

    Returns:
        StepResult with lint output
    """
    logger.info("Lint step (from string)")
    start = time.monotonic()

    try:
        result = sandbox.lint_verilog_string(verilog_code)
        duration = time.monotonic() - start

        errors = result.get("errors", [])
        warnings = result.get("warnings", [])
        has_errors = len(errors) > 0 and not result.get("success", False)

        return StepResult(
            step_name=STEP_NAME,
            status=StepStatus.FAILED if has_errors else StepStatus.PASSED,
            duration_seconds=duration,
            output={
                "stdout": result.get("stdout", ""),
                "stderr": result.get("stderr", ""),
                "error_count": len(errors),
                "warning_count": len(warnings),
            },
            errors=errors,
            warnings=warnings,
        )

    except Exception as e:
        duration = time.monotonic() - start
        logger.error(f"Lint step (string) error: {e}")
        return StepResult(
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            duration_seconds=duration,
            output={},
            errors=[str(e)],
            warnings=[],
        )
