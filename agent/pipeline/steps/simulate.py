"""Simulate pipeline step."""

import asyncio
import logging
import re

from agent.pipeline.models import FailureKind, StepResult, StepStatus
from agent.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)


def _extract_test_result(stdout: str) -> bool:
    """
    Extract pass/fail from testbench output.

    An explicit failure marker always wins.  In the current harness contract,
    successful self-checking testbenches must print an explicit PASS marker;
    arbitrary or empty simulator output is inconclusive.
    """
    # Check for explicit FAIL string
    if re.search(r'\bFAIL(?:ED|URE)?\b', stdout, re.IGNORECASE):
        return False

    # Check for explicit PASS string only after ruling out any failure.
    if re.search(r'\bPASS(?:ED)?\b', stdout, re.IGNORECASE):
        return True

    return False


async def run_simulate_step(
    rtl_file: str,
    tb_file: str,
    sandbox: SandboxManager | None = None,
    timeout: int = 300,
) -> StepResult:
    """Run simulation and return only the public canonical step result."""
    step_result, _ = await run_simulate_step_with_evidence(
        rtl_file,
        tb_file,
        sandbox,
        timeout,
    )
    return step_result


async def run_simulate_step_with_evidence(
    rtl_file: str,
    tb_file: str,
    sandbox: SandboxManager | None = None,
    timeout: int = 300,
) -> tuple[StepResult, dict | None]:
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
        failure_kind = None
        recovery_code = None
        if status == StepStatus.FAILED:
            raw_failure_kind = result.get('failure_kind')
            if raw_failure_kind:
                failure_kind = FailureKind(raw_failure_kind)
                recovery_code = "repair_toolchain"
            elif re.search(r'\bFAIL(?:ED|URE)?\b', result.get('stdout', ''), re.IGNORECASE):
                failure_kind = FailureKind.VERIFICATION
                recovery_code = "inspect_failing_check"
            elif sim_success:
                failure_kind = FailureKind.INCONCLUSIVE
                recovery_code = "add_explicit_result_marker"
            else:
                failure_kind = FailureKind.CONFIGURATION
                recovery_code = "correct_testbench"

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
            failure_kind=failure_kind,
            recovery_code=recovery_code,
        )

        if status == StepStatus.PASSED:
            logger.info("[SIM] ✅ PASSED")
        else:
            logger.error("[SIM] ❌ FAILED")

        return step_result, result

    except Exception as e:
        logger.error(f"[SIM] ❌ ERROR: {e}")
        return (
            StepResult(
                step_name="simulate",
                status=StepStatus.ERROR,
                duration_seconds=0,
                output={},
                errors=[str(e)],
                failure_kind=FailureKind.INFRASTRUCTURE,
                recovery_code="repair_toolchain",
            ),
            None,
        )
