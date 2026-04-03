"""
Coverage Step.

Runs Verilator simulation with --coverage enabled,
then parses the coverage.dat output into a CoverageReport.
"""

import asyncio
import logging
import re
import time

from agent.pipeline.models import StepResult, StepStatus, CoverageReport
from agent.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)

STEP_NAME = "coverage"


async def run_coverage_step(
    rtl_file: str,
    tb_file: str,
    sandbox: SandboxManager,
    timeout: int = 300,
) -> tuple[StepResult, CoverageReport | None]:
    """
    Run Verilator simulation with coverage collection.

    Args:
        rtl_file: Path to RTL .v file
        tb_file: Path to testbench .sv/.cpp file
        sandbox: SandboxManager instance
        timeout: Simulation timeout in seconds

    Returns:
        Tuple of (StepResult, CoverageReport or None if collection failed)
    """
    logger.info(f"Coverage step: RTL={rtl_file}, TB={tb_file}")
    start = time.monotonic()

    try:
        result = await asyncio.to_thread(
            sandbox.run_verilator_sim,
            rtl_file, tb_file, timeout=timeout, coverage=True,
        )
        duration = time.monotonic() - start

        sim_success = result.get("success", False)
        coverage_data = result.get("coverage_data")

        if not sim_success:
            return (
                StepResult(
                    step_name=STEP_NAME,
                    status=StepStatus.FAILED,
                    duration_seconds=duration,
                    output={
                        "stdout": result.get("stdout", ""),
                        "stderr": result.get("stderr", ""),
                    },
                    errors=["Simulation with coverage failed"],
                    warnings=[],
                ),
                None,
            )

        # Parse coverage data into CoverageReport
        report = _parse_coverage_data(coverage_data)

        # Simulation succeeded but coverage data unavailable
        cov_errors = []
        if report is None:
            cov_errors.append("Coverage data unavailable after successful simulation")

        return (
            StepResult(
                step_name=STEP_NAME,
                status=StepStatus.PASSED if report else StepStatus.FAILED,
                duration_seconds=duration,
                output={
                    "stdout": result.get("stdout", ""),
                    "stderr": result.get("stderr", ""),
                    "coverage_score": report.score if report else 0.0,
                    "line_coverage": report.line_coverage if report else 0.0,
                    "toggle_coverage": report.toggle_coverage if report else 0.0,
                    "branch_coverage": report.branch_coverage if report else 0.0,
                },
                errors=cov_errors,
                warnings=_coverage_warnings(report),
            ),
            report,
        )

    except Exception as e:
        duration = time.monotonic() - start
        logger.error(f"Coverage step error: {e}")
        return (
            StepResult(
                step_name=STEP_NAME,
                status=StepStatus.ERROR,
                duration_seconds=duration,
                output={},
                errors=[str(e)],
                warnings=[],
            ),
            None,
        )


def _parse_coverage_data(coverage_data: dict | None) -> CoverageReport | None:
    """
    Parse coverage data from SandboxManager into a CoverageReport.

    Verilator coverage output includes line, toggle, and branch metrics.
    We parse the raw report text for percentage values.

    Args:
        coverage_data: Dict from SandboxManager._collect_coverage_data()

    Returns:
        CoverageReport or None if parsing fails
    """
    if not coverage_data or not coverage_data.get("success"):
        logger.warning("No coverage data available")
        return None

    raw_report = coverage_data.get("raw_report", "")
    summary = coverage_data.get("summary", "")
    combined = raw_report + "\n" + summary

    line_cov = _extract_coverage_pct(combined, "line")
    toggle_cov = _extract_coverage_pct(combined, "toggle")
    branch_cov = _extract_coverage_pct(combined, "branch")

    score = CoverageReport.compute_score(line_cov, toggle_cov, branch_cov)

    uncovered = _extract_uncovered_lines(summary)

    return CoverageReport(
        line_coverage=line_cov,
        toggle_coverage=toggle_cov,
        branch_coverage=branch_cov,
        score=score,
        uncovered_lines=uncovered,
        raw_output=combined,
    )


def _extract_coverage_pct(text: str, coverage_type: str) -> float:
    """
    Extract coverage percentage from verilator_coverage output.

    Looks for patterns like:
    - "Lines covered: 85.2%"
    - "Toggle coverage: 72.1%"
    - "Branch coverage: 60.0%"

    Args:
        text: Raw coverage output text
        coverage_type: "line", "toggle", or "branch"

    Returns:
        Coverage ratio (0.0-1.0), defaults to 0.0 if not found
    """
    patterns = [
        rf"{coverage_type}s?\s+covered\s*[:=]\s*([\d.]+)\s*%",
        rf"{coverage_type}\s+coverage\s*[:=]\s*([\d.]+)\s*%",
        rf"([\d.]+)\s*%\s+{coverage_type}",
    ]

    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            try:
                return float(match.group(1)) / 100.0
            except ValueError:
                continue

    return 0.0


def _extract_uncovered_lines(text: str) -> list[str]:
    """
    Extract uncovered line references from annotated coverage output.

    Looks for lines marked with %000000 (zero hit count) in
    verilator_coverage --annotate output.

    Returns:
        List of "filename:line_number" strings
    """
    uncovered = []
    # Pattern: verilator_coverage annotate marks uncovered as %000000
    for match in re.finditer(
        r"(%\s*0+)\s+(\S+\.v):(\d+)", text, re.IGNORECASE
    ):
        filename = match.group(2)
        line_num = match.group(3)
        uncovered.append(f"{filename}:{line_num}")

    return uncovered


def _coverage_warnings(report: CoverageReport | None) -> list[str]:
    """Generate warnings based on coverage thresholds."""
    if not report:
        return ["Coverage data unavailable"]

    warnings = []
    if report.line_coverage < 0.5:
        warnings.append(
            f"Low line coverage: {report.line_coverage:.1%}"
        )
    if report.toggle_coverage < 0.3:
        warnings.append(
            f"Low toggle coverage: {report.toggle_coverage:.1%}"
        )
    if report.branch_coverage < 0.4:
        warnings.append(
            f"Low branch coverage: {report.branch_coverage:.1%}"
        )
    return warnings
