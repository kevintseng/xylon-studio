"""Tests for pipeline step implementations."""

from unittest.mock import MagicMock

import pytest

from agent.pipeline.models import FailureKind, StepStatus
from agent.pipeline.steps.coverage import (
    _compute_coverage_score,
    _parse_coverage_metrics,
    run_coverage_step,
)
from agent.pipeline.steps.lint import run_lint_step
from agent.pipeline.steps.simulate import _extract_test_result, run_simulate_step
from agent.pipeline.steps.synthesis import (
    MAX_SYNTHESIS_REPORT_BYTES,
    run_synthesis_step,
)

# ── Lint Step Tests ──


@pytest.fixture
def mock_sandbox():
    """Create a mock SandboxManager."""
    sandbox = MagicMock()
    sandbox.verilator_container = "xylon-verilator"
    return sandbox


@pytest.fixture
def rtl_file(tmp_path):
    """Real temp RTL file — lint/simulate/coverage read it via open()."""
    f = tmp_path / "adder.v"
    f.write_text("module adder; endmodule\n")
    return str(f)


@pytest.fixture
def tb_file(tmp_path):
    """Real temp testbench file."""
    f = tmp_path / "tb_adder.sv"
    f.write_text("module tb_adder; endmodule\n")
    return str(f)


@pytest.mark.asyncio
async def test_lint_step_passes(mock_sandbox, rtl_file):
    mock_sandbox.lint_verilog_string.return_value = {
        "success": True,
        "warnings": ["%Warning: unused signal"],
        "errors": [],
        "stdout": "",
        "stderr": "%Warning: unused signal",
        "duration_seconds": 0.5,
    }

    result = await run_lint_step(rtl_file, mock_sandbox)

    assert result.status == StepStatus.PASSED
    assert result.step_name == "lint"
    assert len(result.warnings) == 1
    assert len(result.errors) == 0


@pytest.mark.asyncio
async def test_lint_step_fails_on_error(mock_sandbox, rtl_file):
    mock_sandbox.lint_verilog_string.return_value = {
        "success": False,
        "warnings": [],
        "errors": ["%Error: syntax error at line 5"],
        "stdout": "",
        "stderr": "%Error: syntax error at line 5",
        "duration_seconds": 0.2,
    }

    result = await run_lint_step(rtl_file, mock_sandbox)

    assert result.status == StepStatus.FAILED
    assert len(result.errors) == 1


@pytest.mark.asyncio
async def test_lint_step_handles_exception(mock_sandbox, rtl_file):
    mock_sandbox.lint_verilog_string.side_effect = OSError("Docker not running")

    result = await run_lint_step(rtl_file, mock_sandbox)

    assert result.status == StepStatus.ERROR
    assert "Docker not running" in result.errors[0]
    assert result.failure_kind == FailureKind.INFRASTRUCTURE
    assert result.recovery_code == "repair_toolchain"


# ── Simulate Step Tests ──


@pytest.mark.asyncio
async def test_simulate_step_passes(mock_sandbox, rtl_file, tb_file):
    mock_sandbox.run_verilator_sim_string.return_value = {
        "success": True,
        "stdout": "ALL TESTS PASSED\n",
        "stderr": "",
        "vcd_file": "adder.vcd",
        "coverage_data": None,
        "duration_seconds": 2.0,
    }

    result = await run_simulate_step(rtl_file, tb_file, mock_sandbox)

    assert result.status == StepStatus.PASSED
    assert result.output["test_passed"] is True
    mock_sandbox.run_verilator_sim_string.assert_called_once()


@pytest.mark.asyncio
async def test_simulate_step_fails_on_test_failure(mock_sandbox, rtl_file, tb_file):
    mock_sandbox.run_verilator_sim_string.return_value = {
        "success": True,
        "stdout": "FAIL: expected 255, got 0\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": None,
        "duration_seconds": 1.5,
    }

    result = await run_simulate_step(rtl_file, tb_file, mock_sandbox)

    assert result.status == StepStatus.FAILED
    assert result.output["test_passed"] is False


@pytest.mark.asyncio
async def test_simulate_step_fails_on_build_error(mock_sandbox, rtl_file, tb_file):
    mock_sandbox.run_verilator_sim_string.return_value = {
        "success": False,
        "stdout": "",
        "stderr": "Error: compilation failed",
        "vcd_file": None,
        "coverage_data": None,
        "duration_seconds": 0.5,
    }

    result = await run_simulate_step(rtl_file, tb_file, mock_sandbox)

    assert result.status == StepStatus.FAILED


@pytest.mark.asyncio
async def test_simulate_step_classifies_sandbox_exception_as_infrastructure(
    mock_sandbox,
    rtl_file,
    tb_file,
):
    mock_sandbox.run_verilator_sim_string.side_effect = OSError(
        "docker transport failed"
    )

    result = await run_simulate_step(rtl_file, tb_file, mock_sandbox)

    assert result.status == StepStatus.ERROR
    assert result.failure_kind == FailureKind.INFRASTRUCTURE
    assert result.recovery_code == "repair_toolchain"


def test_extract_test_result_pass():
    assert _extract_test_result("ALL TESTS PASSED") is True
    assert _extract_test_result("result: PASS") is True


def test_extract_test_result_fail():
    assert _extract_test_result("FAIL: assertion at line 10") is False
    assert _extract_test_result("result: FAIL") is False
    assert _extract_test_result("PASS: 9 checks\nFAIL: 1 check") is False


@pytest.mark.asyncio
async def test_simulation_failure_has_verification_recovery_metadata(
    mock_sandbox,
    rtl_file,
    tb_file,
):
    mock_sandbox.run_verilator_sim_string.return_value = {
        "success": True,
        "stdout": "FAIL: output mismatch\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": None,
        "duration_seconds": 0.2,
    }

    result = await run_simulate_step(rtl_file, tb_file, mock_sandbox)

    assert result.status == StepStatus.FAILED
    assert result.failure_kind == FailureKind.VERIFICATION
    assert result.recovery_code == "inspect_failing_check"


def test_extract_test_result_non_empty_output_is_inconclusive():
    """Arbitrary simulator output is not evidence that checks passed."""
    assert _extract_test_result("Simulation finished at time 1000") is False


def test_extract_test_result_empty_output_is_inconclusive():
    """A zero-exit simulation with no self-check result must not pass."""
    assert _extract_test_result("") is False


# ── Synthesis Step Tests ──


@pytest.mark.asyncio
async def test_synthesis_reports_structural_cells_without_timing_claim(
    mock_sandbox,
    rtl_file,
):
    mock_sandbox.synthesize_verilog_string.return_value = {
        "success": True,
        "stdout": (
            "=== adder ===\n"
            "   3 wires\n"
            "   12 wire bits\n"
            "   0 memories\n"
            "   0 memory bits\n"
            "   2 cells\n"
            "   1 $_AND_\n"
            "   1 $_XOR_\n"
        ),
        "stderr": "",
        "duration_seconds": 0.2,
    }

    result = await run_synthesis_step(rtl_file, mock_sandbox)

    assert result.status == StepStatus.PASSED
    assert result.output["cell_count"] == 2
    assert "gate_count" not in result.output
    assert "critical_path" not in result.output
    assert result.output["report"] == (
        "=== adder ===\n"
        "   3 wires\n"
        "   12 wire bits\n"
        "   0 memories\n"
        "   0 memory bits\n"
        "   2 cells\n"
        "   1 $_AND_\n"
        "   1 $_XOR_\n"
    )


@pytest.mark.asyncio
async def test_synthesis_report_is_bounded_and_keeps_final_yosys_statistics(
    mock_sandbox,
    rtl_file,
):
    mock_sandbox.synthesize_verilog_string.return_value = {
        "success": True,
        "stdout": "x" * MAX_SYNTHESIS_REPORT_BYTES + "\n1 cells\n1 $_AND_\n",
        "stderr": "",
        "duration_seconds": 0.2,
    }

    result = await run_synthesis_step(rtl_file, mock_sandbox)

    report = result.output["report"]
    assert len(report.encode("utf-8")) <= MAX_SYNTHESIS_REPORT_BYTES
    assert report.startswith(
        "[SYNTHESIS REPORT TRUNCATED; SHOWING FINAL OUTPUT]\n"
    )
    assert report.endswith("\n1 cells\n1 $_AND_\n")


# ── Coverage Step Tests ──


@pytest.mark.asyncio
async def test_coverage_step_passes(mock_sandbox, rtl_file, tb_file):
    mock_sandbox.run_verilator_sim_string.return_value = {
        "success": True,
        "stdout": "PASS\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": {
            "success": True,
            "raw_report": "Coverage Summary:\n  toggle : 85.0% (85/100)",
            "summary": "",
        },
        "duration_seconds": 3.0,
    }

    step_result, report = await run_coverage_step(rtl_file, tb_file, mock_sandbox)

    assert step_result.status == StepStatus.PASSED
    assert report.line_coverage is None
    assert report.toggle_coverage == pytest.approx(0.85)
    assert report.branch_coverage is None
    assert report.score == pytest.approx(0.85)
    assert report.metric_sources == {
        "toggle_coverage": "verilator_summary",
        "score": "computed_verilator_point_counts",
    }
    assert step_result.output["line_coverage"] is None
    assert step_result.output["score"] == pytest.approx(0.85)
    assert step_result.output["metric_sources"] == {
        "toggle_coverage": "verilator_summary",
        "score": "computed_verilator_point_counts",
    }


@pytest.mark.asyncio
async def test_coverage_step_sim_failure(mock_sandbox, rtl_file, tb_file):
    mock_sandbox.run_verilator_sim_string.return_value = {
        "success": False,
        "stdout": "",
        "stderr": "Build failed",
        "vcd_file": None,
        "coverage_data": None,
        "duration_seconds": 0.5,
    }

    step_result, report = await run_coverage_step(rtl_file, tb_file, mock_sandbox)

    assert step_result.status == StepStatus.FAILED
    assert report.score is None
    assert report.line_coverage is None
    assert report.metric_sources == {}


@pytest.mark.asyncio
async def test_coverage_step_marks_missing_evidence_inconclusive(
    mock_sandbox,
    rtl_file,
    tb_file,
):
    mock_sandbox.run_verilator_sim_string.return_value = {
        "success": True,
        "stdout": "PASS\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": {
            "success": False,
            "raw_report": "",
            "summary": "coverage.dat was not produced",
        },
        "duration_seconds": 0.2,
    }

    step, report = await run_coverage_step(rtl_file, tb_file, mock_sandbox)

    assert report.score is None
    assert step.failure_kind == FailureKind.INCONCLUSIVE
    assert step.recovery_code == "collect_coverage_evidence"


@pytest.mark.asyncio
async def test_coverage_step_preserves_infrastructure_failure(
    mock_sandbox,
    rtl_file,
    tb_file,
):
    mock_sandbox.run_verilator_sim_string.return_value = {
        "success": True,
        "stdout": "PASS\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": {
            "success": False,
            "raw_report": "",
            "summary": "no such container: xylon-verilator",
            "failure_kind": "infrastructure",
        },
        "duration_seconds": 0.2,
    }

    step, report = await run_coverage_step(rtl_file, tb_file, mock_sandbox)

    assert report.score is None
    assert step.failure_kind == FailureKind.INFRASTRUCTURE
    assert step.recovery_code == "repair_toolchain"


def test_parse_coverage_metrics_rejects_legacy_total_format():
    text = "Total coverage (85/100) 85.00%"
    report = _parse_coverage_metrics(text)

    assert report.score is None
    assert report.line_coverage is None
    assert report.toggle_coverage is None
    assert report.branch_coverage is None
    assert report.metric_sources == {}


def test_parse_coverage_metrics_verilator_5050_summary():
    text = """
Coverage Summary:
  line      : 0.0% ( 0/ 0)
  toggle    : 6.0% ( 3/50)
  branch    : 0.0% ( 0/ 0)
  expr      : 0.0% ( 0/ 0)
  fsm_state : 0.0% ( 0/ 0)
  fsm_arc   : 0.0% ( 0/ 0)
"""
    report = _parse_coverage_metrics(text)

    assert report.line_coverage is None
    assert report.toggle_coverage == pytest.approx(0.06)
    assert report.branch_coverage is None
    assert report.score == pytest.approx(0.06)
    assert report.metric_sources == {
        "toggle_coverage": "verilator_summary",
        "score": "computed_verilator_point_counts",
    }


def test_parse_coverage_metrics_does_not_invent_line_coverage_from_annotations():
    text = """
%000000 design.v:10 uncovered
%000001 design.v:11 hit
%000005 design.v:12 hit
%000000 design.v:13 uncovered
"""
    report = _parse_coverage_metrics(text)

    assert report.score is None
    assert report.line_coverage is None
    assert report.metric_sources == {}


def test_parse_coverage_metrics_empty():
    report = _parse_coverage_metrics("no coverage info here")

    assert report.score is None
    assert report.line_coverage is None
    assert report.toggle_coverage is None
    assert report.branch_coverage is None
    assert report.metric_sources == {}


def test_compute_coverage_score_weighted():
    # 40% line + 30% toggle + 30% branch (CoverageReport.DEFAULT_WEIGHTS)
    score = _compute_coverage_score(1.0, 0.0, 0.0)
    assert score == pytest.approx(0.4)

    score = _compute_coverage_score(0.0, 1.0, 0.0)
    assert score == pytest.approx(0.3)

    score = _compute_coverage_score(0.0, 0.0, 1.0)
    assert score == pytest.approx(0.3)

    score = _compute_coverage_score(1.0, 1.0, 1.0)
    assert score == pytest.approx(1.0)
