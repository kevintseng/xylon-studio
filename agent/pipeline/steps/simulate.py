"""
Simulate Step.

Runs Verilator simulation with RTL and testbench,
capturing pass/fail results and waveform output.
"""

import logging
import time

from agent.pipeline.models import StepResult, StepStatus
from agent.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)

STEP_NAME = "simulate"


async def run_simulate_step(
    rtl_file: str,
    tb_file: str,
    sandbox: SandboxManager,
    timeout: int = 300,
) -> StepResult:
    """
    Run Verilator simulation with a testbench.

    Args:
        rtl_file: Path to RTL .v file
        tb_file: Path to testbench .sv/.cpp file
        sandbox: SandboxManager instance
        timeout: Simulation timeout in seconds

    Returns:
        StepResult with simulation output and pass/fail status
    """
    logger.info(f"Simulate step: RTL={rtl_file}, TB={tb_file}")
    start = time.monotonic()

    try:
        result = sandbox.run_verilator_sim(
            rtl_file, tb_file, timeout=timeout, coverage=False,
        )
        duration = time.monotonic() - start

        stdout = result.get("stdout", "")
        stderr = result.get("stderr", "")
        sim_success = result.get("success", False)

        # Parse test results from simulation stdout
        # Convention: testbenches print "PASS" or "FAIL" via $display
        test_passed = _parse_test_result(stdout)

        # Simulation step passes if:
        # 1. Verilator build + execution succeeded
        # 2. No test failures detected in output
        if not sim_success:
            status = StepStatus.FAILED
        elif test_passed is False:
            status = StepStatus.FAILED
        else:
            status = StepStatus.PASSED

        errors = []
        if not sim_success:
            errors.append("Simulation execution failed")
        if test_passed is False:
            errors.append("Test assertions failed (FAIL detected in output)")

        return StepResult(
            step_name=STEP_NAME,
            status=status,
            duration_seconds=duration,
            output={
                "stdout": stdout,
                "stderr": stderr,
                "vcd_file": result.get("vcd_file"),
                "sim_exit_success": sim_success,
                "test_passed": test_passed,
            },
            errors=errors,
            warnings=[],
        )

    except Exception as e:
        duration = time.monotonic() - start
        logger.error(f"Simulate step error: {e}")
        return StepResult(
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            duration_seconds=duration,
            output={},
            errors=[str(e)],
            warnings=[],
        )


def _parse_test_result(stdout: str) -> bool | None:
    """
    Parse test pass/fail from simulation stdout.

    Testbench convention:
    - $display("PASS") or $display("ALL TESTS PASSED") → pass
    - $display("FAIL") or $fatal → fail

    Returns:
        True if passed, False if failed, None if indeterminate
    """
    stdout_upper = stdout.upper()

    # Check for explicit failure indicators first
    fail_indicators = ["FAIL", "$FATAL", "ERROR:", "ASSERTION FAILED"]
    for indicator in fail_indicators:
        if indicator in stdout_upper:
            return False

    # Check for explicit pass indicators
    pass_indicators = ["PASS", "ALL TESTS PASSED", "TEST COMPLETE", "SIMULATION DONE"]
    for indicator in pass_indicators:
        if indicator in stdout_upper:
            return True

    # Indeterminate — simulation ran but no clear pass/fail signal
    return None
