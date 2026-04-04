"""Lint pipeline step."""

import asyncio
import logging

from agent.pipeline.models import StepResult, StepStatus
from agent.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)


async def run_lint_step(
    rtl_file: str,
    sandbox: SandboxManager | None = None,
) -> StepResult:
    """
    Run Verilator lint check on RTL file.

    Args:
        rtl_file: Path to .v file
        sandbox: SandboxManager instance (creates new if None)

    Returns:
        StepResult with lint results
    """
    if sandbox is None:
        sandbox = SandboxManager()

    logger.info(f"[LINT] Starting lint check: {rtl_file}")

    try:
        # Read RTL file and use lint_verilog_string which handles
        # copying into the Docker container
        with open(rtl_file, encoding='utf-8') as f:
            rtl_code = f.read()

        result = await asyncio.to_thread(
            sandbox.lint_verilog_string,
            rtl_code
        )

        # Parse warnings vs errors
        warnings = result.get('warnings', [])
        errors = result.get('errors', [])

        status = StepStatus.PASSED if not errors else StepStatus.FAILED

        step_result = StepResult(
            step_name="lint",
            status=status,
            duration_seconds=result.get('duration_seconds', 0),
            output={
                'warnings_count': len(warnings),
                'errors_count': len(errors),
                'stdout': result.get('stdout', ''),
                'stderr': result.get('stderr', ''),
            },
            warnings=warnings,
            errors=errors,
        )

        if status == StepStatus.PASSED:
            logger.info(f"[LINT] ✅ PASSED ({len(warnings)} warnings)")
        else:
            logger.error(f"[LINT] ❌ FAILED ({len(errors)} errors)")

        return step_result

    except Exception as e:
        logger.error(f"[LINT] ❌ ERROR: {e}")
        return StepResult(
            step_name="lint",
            status=StepStatus.ERROR,
            duration_seconds=0,
            output={},
            errors=[str(e)],
        )


async def run_lint_step_from_string(
    rtl_code: str,
    sandbox: SandboxManager | None = None,
) -> StepResult:
    """
    Run Verilator lint check directly from a Verilog source string.

    Args:
        rtl_code: Verilog source code
        sandbox: SandboxManager instance (creates new if None)

    Returns:
        StepResult with lint results
    """
    if sandbox is None:
        sandbox = SandboxManager()

    logger.info("[LINT] Starting lint check from string")

    try:
        result = await asyncio.to_thread(sandbox.lint_verilog_string, rtl_code)

        warnings = result.get('warnings', [])
        errors = result.get('errors', [])
        status = StepStatus.PASSED if not errors else StepStatus.FAILED

        return StepResult(
            step_name="lint",
            status=status,
            duration_seconds=result.get('duration_seconds', 0),
            output={
                'warnings_count': len(warnings),
                'errors_count': len(errors),
                'stdout': result.get('stdout', ''),
                'stderr': result.get('stderr', ''),
            },
            warnings=warnings,
            errors=errors,
        )

    except Exception as e:
        logger.error(f"[LINT] ❌ ERROR: {e}")
        return StepResult(
            step_name="lint",
            status=StepStatus.ERROR,
            duration_seconds=0,
            output={},
            errors=[str(e)],
        )
