"""Tests for pipeline step implementations."""

import pytest
from unittest.mock import MagicMock, patch

from agent.pipeline.models import StepStatus
from agent.pipeline.steps.lint import run_lint_step, run_lint_step_from_string
from agent.pipeline.steps.simulate import run_simulate_step, _parse_test_result
from agent.pipeline.steps.coverage import (
    run_coverage_step,
    _extract_coverage_pct,
    _extract_uncovered_lines,
    _parse_coverage_data,
)


# ── Lint Step Tests ──


@pytest.fixture
def mock_sandbox():
    """Create a mock SandboxManager."""
    sandbox = MagicMock()
    sandbox.verilator_container = "xylon-verilator"
    return sandbox


@pytest.mark.asyncio
async def test_lint_step_passes(mock_sandbox):
    mock_sandbox.lint_verilog.return_value = {
        "success": True,
        "warnings": ["%Warning: unused signal"],
        "errors": [],
        "stdout": "",
        "stderr": "%Warning: unused signal",
        "duration_seconds": 0.5,
    }

    result = await run_lint_step("/designs/adder.v", mock_sandbox)

    assert result.status == StepStatus.PASSED
    assert result.step_name == "lint"
    assert len(result.warnings) == 1
    assert len(result.errors) == 0


@pytest.mark.asyncio
async def test_lint_step_fails_on_error(mock_sandbox):
    mock_sandbox.lint_verilog.return_value = {
        "success": False,
        "warnings": [],
        "errors": ["%Error: syntax error at line 5"],
        "stdout": "",
        "stderr": "%Error: syntax error at line 5",
        "duration_seconds": 0.2,
    }

    result = await run_lint_step("/designs/bad.v", mock_sandbox)

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
async def test_lint_step_handles_exception(mock_sandbox):
    mock_sandbox.lint_verilog.side_effect = Exception("Docker not running")

    result = await run_lint_step("/designs/adder.v", mock_sandbox)

    assert result.status == StepStatus.ERROR
    assert "Docker not running" in result.errors[0]


# ── Simulate Step Tests ──


@pytest.mark.asyncio
async def test_simulate_step_passes(mock_sandbox):
    mock_sandbox.run_verilator_sim.return_value = {
        "success": True,
        "stdout": "ALL TESTS PASSED\n",
        "stderr": "",
        "vcd_file": "adder.vcd",
        "coverage_data": None,
        "duration_seconds": 2.0,
    }

    result = await run_simulate_step(
        "/designs/adder.v", "/designs/tb_adder.sv", mock_sandbox
    )

    assert result.status == StepStatus.PASSED
    assert result.output["test_passed"] is True
    mock_sandbox.run_verilator_sim.assert_called_once_with(
        "/designs/adder.v", "/designs/tb_adder.sv",
        timeout=300, coverage=False,
    )


@pytest.mark.asyncio
async def test_simulate_step_fails_on_test_failure(mock_sandbox):
    mock_sandbox.run_verilator_sim.return_value = {
        "success": True,
        "stdout": "FAIL: expected 255, got 0\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": None,
        "duration_seconds": 1.5,
    }

    result = await run_simulate_step(
        "/designs/adder.v", "/designs/tb_adder.sv", mock_sandbox
    )

    assert result.status == StepStatus.FAILED
    assert result.output["test_passed"] is False


@pytest.mark.asyncio
async def test_simulate_step_fails_on_build_error(mock_sandbox):
    mock_sandbox.run_verilator_sim.return_value = {
        "success": False,
        "stdout": "",
        "stderr": "Error: compilation failed",
        "vcd_file": None,
        "coverage_data": None,
        "duration_seconds": 0.5,
    }

    result = await run_simulate_step(
        "/designs/adder.v", "/designs/tb_adder.sv", mock_sandbox
    )

    assert result.status == StepStatus.FAILED


def test_parse_test_result_pass():
    assert _parse_test_result("ALL TESTS PASSED") is True
    assert _parse_test_result("Test complete, pass") is True


def test_parse_test_result_fail():
    assert _parse_test_result("FAIL: assertion at line 10") is False
    assert _parse_test_result("ERROR: mismatch") is False


def test_parse_test_result_indeterminate():
    assert _parse_test_result("Simulation finished at time 1000") is None
    assert _parse_test_result("") is None


# ── Coverage Step Tests ──


@pytest.mark.asyncio
async def test_coverage_step_passes(mock_sandbox):
    mock_sandbox.run_verilator_sim.return_value = {
        "success": True,
        "stdout": "PASS\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": {
            "success": True,
            "raw_report": "Lines covered: 85.0%\nToggle coverage: 70.0%\nBranch coverage: 60.0%",
            "summary": "",
        },
        "duration_seconds": 3.0,
    }

    step_result, report = await run_coverage_step(
        "/designs/adder.v", "/designs/tb_adder.sv", mock_sandbox
    )

    assert step_result.status == StepStatus.PASSED
    assert report is not None
    assert report.line_coverage == pytest.approx(0.85)
    assert report.toggle_coverage == pytest.approx(0.70)
    assert report.branch_coverage == pytest.approx(0.60)
    assert report.score > 0


@pytest.mark.asyncio
async def test_coverage_step_sim_failure(mock_sandbox):
    mock_sandbox.run_verilator_sim.return_value = {
        "success": False,
        "stdout": "",
        "stderr": "Build failed",
        "vcd_file": None,
        "coverage_data": None,
        "duration_seconds": 0.5,
    }

    step_result, report = await run_coverage_step(
        "/designs/adder.v", "/designs/tb_adder.sv", mock_sandbox
    )

    assert step_result.status == StepStatus.FAILED
    assert report is None


def test_extract_coverage_pct_line():
    text = "Lines covered: 85.2%"
    assert _extract_coverage_pct(text, "line") == pytest.approx(0.852)


def test_extract_coverage_pct_toggle():
    text = "Toggle coverage: 72.1%"
    assert _extract_coverage_pct(text, "toggle") == pytest.approx(0.721)


def test_extract_coverage_pct_branch():
    text = "Branch coverage: 60.0%"
    assert _extract_coverage_pct(text, "branch") == pytest.approx(0.60)


def test_extract_coverage_pct_not_found():
    assert _extract_coverage_pct("no coverage info here", "line") == 0.0


def test_extract_uncovered_lines():
    text = "%000000 design.v:10\n%000000 design.v:15\n%000005 design.v:20"
    lines = _extract_uncovered_lines(text)
    assert "design.v:10" in lines
    assert "design.v:15" in lines
    assert len(lines) == 2  # line 20 has hits, not uncovered


def test_parse_coverage_data_none():
    report = _parse_coverage_data(None)
    assert report is not None
    assert report.score == 0.0


def test_parse_coverage_data_failed():
    report = _parse_coverage_data({"success": False, "raw_report": ""})
    assert report.score == 0.0
