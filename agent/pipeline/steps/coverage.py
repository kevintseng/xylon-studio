"""Coverage pipeline step."""

import asyncio
import logging
import re

from agent.pipeline.models import CoverageReport, StepResult, StepStatus
from agent.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)


def _parse_coverage_metrics(raw_output: str) -> tuple[float, float, float]:
    """
    Parse coverage metrics from verilator_coverage output.

    Verilator outputs: "Total coverage (N/M) X.XX%" from --annotate stderr.
    Also parses annotated source lines (%NNNNNN) to estimate line coverage.

    Returns: (line_coverage, toggle_coverage, branch_coverage) as floats 0.0-1.0
    """
    total_cov = 0.0

    # Parse "Total coverage (N/M) X.XX%" from verilator_coverage --annotate
    total_match = re.search(r'Total coverage\s+\((\d+)/(\d+)\)\s+([\d.]+)%', raw_output)
    if total_match:
        covered = int(total_match.group(1))
        total = int(total_match.group(2))
        if total > 0:
            total_cov = covered / total

    # Parse annotated lines to estimate line coverage
    # Lines with %000000 are uncovered, %NNNNNN (N>0) are covered
    covered_lines = 0
    total_lines = 0
    for line in raw_output.split('\n'):
        ann_match = re.match(r'^%(\d{6})', line.strip())
        if ann_match:
            total_lines += 1
            if int(ann_match.group(1)) > 0:
                covered_lines += 1

    line_cov = (covered_lines / total_lines) if total_lines > 0 else total_cov

    # Verilator doesn't separate toggle/branch in summary output.
    # Use total coverage as approximation for toggle and branch.
    toggle_cov = total_cov
    branch_cov = total_cov

    return line_cov, toggle_cov, branch_cov


def _compute_coverage_score(
    line_cov: float,
    toggle_cov: float,
    branch_cov: float,
) -> float:
    """
    Compute weighted coverage score.

    Delegates to CoverageReport.compute_score which uses the project-wide
    default weights (line=0.4, toggle=0.3, branch=0.3).
    """
    return CoverageReport.compute_score(line_cov, toggle_cov, branch_cov)


async def run_coverage_step(
    rtl_file: str,
    tb_file: str,
    sandbox: SandboxManager | None = None,
    timeout: int = 300,
) -> tuple[StepResult, CoverageReport]:
    """
    Run Verilator simulation with coverage collection.

    Args:
        rtl_file: Path to RTL .v file
        tb_file: Path to testbench .sv file
        sandbox: SandboxManager instance (creates new if None)
        timeout: Simulation timeout in seconds

    Returns:
        Tuple of (StepResult, CoverageReport)
    """
    if sandbox is None:
        sandbox = SandboxManager()

    logger.info(f"[COV] Starting coverage analysis: RTL={rtl_file}, TB={tb_file}")

    try:
        with open(rtl_file, encoding='utf-8') as f:
            rtl_code = f.read()
        with open(tb_file, encoding='utf-8') as f:
            tb_code = f.read()

        # Run simulation with coverage enabled
        result = await asyncio.to_thread(
            sandbox.run_verilator_sim_string,
            rtl_code,
            tb_code,
            timeout=timeout,
            coverage=True,
        )

        sim_success = result.get('success', False)

        if not sim_success:
            logger.error("[COV] Simulation failed, no coverage data")
            step_result = StepResult(
                step_name="coverage",
                status=StepStatus.FAILED,
                duration_seconds=result.get('duration_seconds', 0),
                output={},
                errors=["Simulation failed before coverage collection"],
            )
            empty_report = CoverageReport(
                line_coverage=0.0,
                toggle_coverage=0.0,
                branch_coverage=0.0,
                score=0.0,
            )
            return step_result, empty_report

        # Parse coverage data
        coverage_data = result.get('coverage_data', {})
        raw_output = coverage_data.get('raw_report', '')

        line_cov, toggle_cov, branch_cov = _parse_coverage_metrics(raw_output)
        score = _compute_coverage_score(line_cov, toggle_cov, branch_cov)

        report = CoverageReport(
            line_coverage=line_cov,
            toggle_coverage=toggle_cov,
            branch_coverage=branch_cov,
            score=score,
            raw_output=raw_output,
        )

        status = StepStatus.PASSED

        step_result = StepResult(
            step_name="coverage",
            status=status,
            duration_seconds=result.get('duration_seconds', 0),
            output={
                'line_coverage': f"{line_cov*100:.1f}%",
                'toggle_coverage': f"{toggle_cov*100:.1f}%",
                'branch_coverage': f"{branch_cov*100:.1f}%",
                'score': f"{score*100:.1f}%",
                'summary': coverage_data.get('summary', ''),
            },
        )

        logger.info(
            f"[COV] ✅ Coverage: line={line_cov*100:.1f}% toggle={toggle_cov*100:.1f}% "
            f"branch={branch_cov*100:.1f}% score={score*100:.1f}%"
        )

        return step_result, report

    except Exception as e:
        logger.error(f"[COV] ❌ ERROR: {e}")
        step_result = StepResult(
            step_name="coverage",
            status=StepStatus.ERROR,
            duration_seconds=0,
            output={},
            errors=[str(e)],
        )
        empty_report = CoverageReport(
            line_coverage=0.0,
            toggle_coverage=0.0,
            branch_coverage=0.0,
            score=0.0,
        )
        return step_result, empty_report
