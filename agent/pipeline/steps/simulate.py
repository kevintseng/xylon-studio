"""Simulate pipeline step."""

import asyncio
import logging
import re

from agent.pipeline.models import StepResult, StepStatus
from agent.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)


def _extract_test_result(stdout: str) -> bool:
    """
    Extract pass/fail from testbench output.

    Looks for common Verilog testbench patterns:
    - $display("PASS") or similar
    - $finish with return code 0 = pass
    """
    # Check for explicit PASS string
    if re.search(r'\bPASS\b', stdout, re.IGNORECASE):
        return True

    # Check for explicit FAIL string
    if re.search(r'\bFAIL\b', stdout, re.IGNORECASE):
        return False

    # If there's output and no FAIL, assume pass
    if stdout.strip():
        return True

    # No output = unknown, treat as pass (caller will validate)
    return True


async def run_simulate_step(
    rtl_file: str,
    tb_file: str,
    sandbox: SandboxManager | None = None,
    timeout: int = 300,
) -> StepResult:
    """
    Run Verilator simulation with testbench.

    Args:
        rtl_file: Path to RTL .v file
        tb_file: Path to testbench .sv file
        sandbox: SandboxManager instance (creates new if None)
        timeout: Simulation timeout in seconds

    Returns:
        StepResult with simulation output
    """
    if sandbox is None:
        sandbox = SandboxManager()

    logger.info(f"[SIM] Starting simulation: RTL={rtl_file}, TB={tb_file}")

    try:
        with open(rtl_file, encoding='utf-8') as f:
            rtl_code = f.read()
        with open(tb_file, encoding='utf-8') as f:
            tb_code = f.read()

        result = await asyncio.to_thread(
            sandbox.run_verilator_sim_string,
            rtl_code,
            tb_code,
            timeout=timeout,
            coverage=True,  # Always enable so testbenches with verilated_cov.h link
        )

        # Determine pass/fail from stdout content AND exit code
        sim_success = result.get('success', False)
        stdout_passed = _extract_test_result(result.get('stdout', ''))
        test_passed = sim_success and stdout_passed
        status = StepStatus.PASSED if test_passed else StepStatus.FAILED

        step_result = StepResult(
            step_name="simulate",
            status=status,
            duration_seconds=result.get('duration_seconds', 0),
            output={
                'stdout': result.get('stdout', ''),
                'stderr': result.get('stderr', ''),
                'vcd_file': result.get('vcd_file'),
                'test_passed': test_passed,
            },
        )

        if status == StepStatus.PASSED:
            logger.info("[SIM] ✅ PASSED")
        else:
            logger.error("[SIM] ❌ FAILED")

        return step_result

    except Exception as e:
        logger.error(f"[SIM] ❌ ERROR: {e}")
        return StepResult(
            step_name="simulate",
            status=StepStatus.ERROR,
            duration_seconds=0,
            output={},
            errors=[str(e)],
        )
