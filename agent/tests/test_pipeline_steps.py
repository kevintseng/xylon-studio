"""Tests for pipeline step implementations."""

from unittest.mock import MagicMock

import pytest

from agent.pipeline.models import StepStatus
from agent.pipeline.steps.coverage import (
    _compute_coverage_score,
    _parse_coverage_metrics,
    run_coverage_step,
)
from agent.pipeline.steps.lint import run_lint_step, run_lint_step_from_string
from agent.pipeline.steps.simulate import _extract_test_result, run_simulate_step

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
async def test_lint_step_from_string(mock_sandbox):
    mock_sandbox.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.3,
    }

    result = await run_lint_step_from_string("module foo; endmodule", mock_sandbox)

    assert result.status == StepStatus.PASSED
    mock_sandbox.lint_verilog_string.assert_called_once_with("module foo; endmodule")


@pytest.mark.asyncio
async def test_lint_step_handles_exception(mock_sandbox, rtl_file):
    mock_sandbox.lint_verilog_string.side_effect = Exception("Docker not running")

    result = await run_lint_step(rtl_file, mock_sandbox)

    assert result.status == StepStatus.ERROR
    assert "Docker not running" in result.errors[0]


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


def test_extract_test_result_pass():
    assert _extract_test_result("ALL TESTS PASSED") is True
    assert _extract_test_result("result: PASS") is True


def test_extract_test_result_fail():
    assert _extract_test_result("FAIL: assertion at line 10") is False
    assert _extract_test_result("result: FAIL") is False


def test_extract_test_result_non_empty_output_defaults_to_pass():
    # Non-empty output without PASS/FAIL markers defaults to True
    # (caller validates via other means)
    assert _extract_test_result("Simulation finished at time 1000") is True


def test_extract_test_result_empty_output_defaults_to_pass():
    # Empty output = unknown, treated as pass per current convention
    assert _extract_test_result("") is True


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
            "raw_report": "Total coverage (85/100) 85.00%",
            "summary": "",
        },
        "duration_seconds": 3.0,
    }

    step_result, report = await run_coverage_step(rtl_file, tb_file, mock_sandbox)

    assert step_result.status == StepStatus.PASSED
    assert report is not None
    assert report.line_coverage == pytest.approx(0.85)
    assert report.score > 0


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
    # Coverage step returns empty CoverageReport (not None) on sim failure
    assert report is not None
    assert report.score == 0.0


def test_parse_coverage_metrics_total():
    text = "Total coverage (85/100) 85.00%"
    line, toggle, branch = _parse_coverage_metrics(text)
    assert line == pytest.approx(0.85)
    assert toggle == pytest.approx(0.85)
    assert branch == pytest.approx(0.85)


def test_parse_coverage_metrics_from_annotations():
    text = """
%000000 design.v:10 uncovered
%000001 design.v:11 hit
%000005 design.v:12 hit
%000000 design.v:13 uncovered
"""
    line, _, _ = _parse_coverage_metrics(text)
    # 2 out of 4 annotated lines covered
    assert line == pytest.approx(0.5)


def test_parse_coverage_metrics_empty():
    line, toggle, branch = _parse_coverage_metrics("no coverage info here")
    assert line == 0.0
    assert toggle == 0.0
    assert branch == 0.0


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
