"""Coverage pipeline step."""

import asyncio
import logging
import re

from agent.pipeline.models import CoverageReport, FailureKind, StepResult, StepStatus
from agent.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)


def _parse_coverage_metrics(raw_output: str) -> CoverageReport:
    """
    Parse only coverage metrics explicitly reported by Verilator.

    ``verilator_coverage --annotate`` reports an aggregate total but does not
    identify that total as line, toggle, or branch coverage. Those dimensions
    therefore remain unavailable until type-specific evidence is collected.

    Returns:
        CoverageReport with nullable dimensions and metric provenance.
    """
    line_coverage = None
    toggle_coverage = None
    branch_coverage = None
    score = None
    metric_sources = {}

    summary_pattern = re.compile(
        r"^\s*(line|toggle|branch|expr|fsm_state|fsm_arc)\s*:\s*"
        r"[\d.]+%\s*\(\s*(\d+)\s*/\s*(\d+)\s*\)",
        re.MULTILINE,
    )
    total_covered = 0
    total_points = 0
    for metric, covered_text, total_text in summary_pattern.findall(raw_output):
        covered = int(covered_text)
        total = int(total_text)
        if total == 0:
            continue

        value = covered / total
        total_covered += covered
        total_points += total
        if metric == "line":
            line_coverage = value
            metric_sources["line_coverage"] = "verilator_summary"
        elif metric == "toggle":
            toggle_coverage = value
            metric_sources["toggle_coverage"] = "verilator_summary"
        elif metric == "branch":
            branch_coverage = value
            metric_sources["branch_coverage"] = "verilator_summary"

    if total_points > 0:
        score = total_covered / total_points
        metric_sources["score"] = "computed_verilator_point_counts"

    return CoverageReport(
        line_coverage=line_coverage,
        toggle_coverage=toggle_coverage,
        branch_coverage=branch_coverage,
        score=score,
        raw_output=raw_output,
        metric_sources=metric_sources,
    )


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
    simulation_result: dict | None = None,
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
    if sandbox is None and simulation_result is None:
        sandbox = SandboxManager()

    logger.info(f"[COV] Starting coverage analysis: RTL={rtl_file}, TB={tb_file}")

    try:
        if simulation_result is None:
            with open(rtl_file, encoding='utf-8') as f:
                rtl_code = f.read()
            with open(tb_file, encoding='utf-8') as f:
                tb_code = f.read()

            # Standalone coverage remains available for callers without a
            # coverage-enabled simulation result to reuse.
            result = await asyncio.to_thread(
                sandbox.run_verilator_sim_string,
                rtl_code,
                tb_code,
                timeout=timeout,
                coverage=True,
            )
            duration_seconds = result.get('duration_seconds', 0)
        else:
            result = simulation_result
            duration_seconds = 0.0

        sim_success = result.get('success', False)

        if not sim_success:
            logger.error("[COV] Simulation failed, no coverage data")
            raw_failure_kind = result.get('failure_kind')
            failure_kind = (
                FailureKind(raw_failure_kind)
                if raw_failure_kind
                else FailureKind.CONFIGURATION
            )
            step_result = StepResult(
                step_name="coverage",
                status=StepStatus.FAILED,
                duration_seconds=duration_seconds,
                output={},
                errors=["Simulation failed before coverage collection"],
                failure_kind=failure_kind,
                recovery_code=(
                    "repair_toolchain"
                    if failure_kind == FailureKind.INFRASTRUCTURE
                    else "correct_testbench"
                ),
            )
            empty_report = CoverageReport(
                line_coverage=None,
                toggle_coverage=None,
                branch_coverage=None,
                score=None,
            )
            return step_result, empty_report

        # Parse coverage data
        coverage_data = result.get('coverage_data') or {}
        raw_output = coverage_data.get('raw_report', '')
        report = _parse_coverage_metrics(raw_output)
        coverage_available = coverage_data.get('success', False) and report.score is not None
        status = StepStatus.PASSED if coverage_available else StepStatus.FAILED
        failure_kind = None
        recovery_code = None
        if not coverage_available:
            raw_failure_kind = coverage_data.get('failure_kind')
            failure_kind = (
                FailureKind(raw_failure_kind)
                if raw_failure_kind
                else FailureKind.INCONCLUSIVE
            )
            recovery_code = (
                "repair_toolchain"
                if failure_kind == FailureKind.INFRASTRUCTURE
                else "collect_coverage_evidence"
            )
        errors = [] if coverage_available else [
            coverage_data.get('error')
            or coverage_data.get('summary')
            or "Coverage metrics unavailable"
        ]

        step_result = StepResult(
            step_name="coverage",
            status=status,
            duration_seconds=duration_seconds,
            output={
                'line_coverage': report.line_coverage,
                'toggle_coverage': report.toggle_coverage,
                'branch_coverage': report.branch_coverage,
                'score': report.score,
                'metric_sources': dict(report.metric_sources),
                'summary': coverage_data.get('summary', ''),
            },
            errors=errors,
            failure_kind=failure_kind,
            recovery_code=recovery_code,
        )

        if report.score is not None:
            logger.info(
                f"[COV] Coverage aggregate={report.score*100:.1f}% "
                f"source={report.metric_sources.get('score')}"
            )
        else:
            logger.warning("[COV] Coverage metrics unavailable")

        return step_result, report

    except Exception as e:
        logger.error(f"[COV] ❌ ERROR: {e}")
        step_result = StepResult(
            step_name="coverage",
            status=StepStatus.ERROR,
            duration_seconds=0,
            output={},
            errors=[str(e)],
            failure_kind=FailureKind.INFRASTRUCTURE,
            recovery_code="repair_toolchain",
        )
        empty_report = CoverageReport(
            line_coverage=None,
            toggle_coverage=None,
            branch_coverage=None,
            score=None,
        )
        return step_result, empty_report
