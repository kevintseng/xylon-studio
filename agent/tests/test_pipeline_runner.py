"""Tests for pipeline runner."""

import pytest
from unittest.mock import MagicMock, patch, AsyncMock

from agent.pipeline.models import PipelineConfig, StepStatus
from agent.pipeline.runner import run_pipeline


SIMPLE_RTL = """\
module adder_8bit (
    input  [7:0] a,
    input  [7:0] b,
    output [8:0] sum
);
    assign sum = a + b;
endmodule
"""

SIMPLE_TB = """\
#include "Vadder_8bit.h"
#include "verilated.h"
#include <iostream>

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    Vadder_8bit* top = new Vadder_8bit;

    top->a = 10;
    top->b = 20;
    top->evaluate();

    if (top->sum == 30) {
        std::cout << "PASS" << std::endl;
    } else {
        std::cout << "FAIL" << std::endl;
    }

    delete top;
    return 0;
}
"""


@pytest.fixture
def mock_sandbox_manager():
    """Mock SandboxManager for pipeline tests."""
    with patch("agent.pipeline.runner.SandboxManager") as MockCls:
        sandbox = MockCls.return_value
        sandbox.verilator_container = "xylon-verilator"
        yield sandbox


@pytest.fixture
def mock_container_ops():
    """Mock Docker container operations (copy, mkdir, rm)."""
    with patch("agent.pipeline.runner._copy_to_container"):
        with patch("agent.pipeline.runner.subprocess"):
            yield


@pytest.mark.asyncio
async def test_pipeline_lint_only(mock_sandbox_manager, mock_container_ops):
    """Pipeline with no testbench should run lint and skip simulation."""
    with patch("agent.pipeline.steps.lint.SandboxManager"):
        mock_sandbox_manager.lint_verilog_string.return_value = {
            "success": True,
            "warnings": [],
            "errors": [],
            "stdout": "",
            "stderr": "",
            "duration_seconds": 0.5,
        }

        result = await run_pipeline(SIMPLE_RTL)

    assert result.success is True
    assert len(result.steps) == 2  # lint + skipped simulate
    assert result.get_step("lint").status == StepStatus.PASSED
    assert result.get_step("simulate").status == StepStatus.SKIPPED


@pytest.mark.asyncio
async def test_pipeline_lint_failure_stops(mock_sandbox_manager, mock_container_ops):
    """Pipeline should stop early if lint fails with errors."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": False,
        "warnings": [],
        "errors": ["%Error: syntax error"],
        "stdout": "",
        "stderr": "%Error: syntax error",
        "duration_seconds": 0.2,
    }

    result = await run_pipeline(SIMPLE_RTL)

    assert result.success is False
    assert len(result.steps) == 1  # only lint, no simulate
    assert result.get_step("lint").status == StepStatus.FAILED


@pytest.mark.asyncio
async def test_pipeline_full_run(mock_sandbox_manager, mock_container_ops):
    """Pipeline with testbench should run lint, simulate, and coverage."""
    # Lint passes
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.3,
    }

    # Simulate passes (called twice: once for simulate, once for coverage)
    mock_sandbox_manager.run_verilator_sim.side_effect = [
        # First call: simulate step (coverage=False)
        {
            "success": True,
            "stdout": "PASS\n",
            "stderr": "",
            "vcd_file": None,
            "coverage_data": None,
            "duration_seconds": 1.0,
        },
        # Second call: coverage step (coverage=True)
        {
            "success": True,
            "stdout": "PASS\n",
            "stderr": "",
            "vcd_file": None,
            "coverage_data": {
                "success": True,
                "raw_report": "Lines covered: 90.0%\nToggle coverage: 80.0%\nBranch coverage: 70.0%",
                "summary": "",
            },
            "duration_seconds": 1.5,
        },
    ]

    result = await run_pipeline(SIMPLE_RTL, testbench_code=SIMPLE_TB)

    assert result.success is True
    assert len(result.steps) == 3  # lint + simulate + coverage
    assert result.get_step("lint").status == StepStatus.PASSED
    assert result.get_step("simulate").status == StepStatus.PASSED
    assert result.get_step("coverage").status == StepStatus.PASSED
    assert result.final_coverage is not None
    assert result.final_coverage.line_coverage == pytest.approx(0.90)


@pytest.mark.asyncio
async def test_pipeline_sim_failure_skips_coverage(mock_sandbox_manager, mock_container_ops):
    """If simulation fails, coverage should not run."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.3,
    }

    mock_sandbox_manager.run_verilator_sim.return_value = {
        "success": False,
        "stdout": "",
        "stderr": "Build error",
        "vcd_file": None,
        "coverage_data": None,
        "duration_seconds": 0.5,
    }

    result = await run_pipeline(SIMPLE_RTL, testbench_code=SIMPLE_TB)

    assert result.success is False
    assert len(result.steps) == 2  # lint + failed simulate, no coverage
    assert result.final_coverage is None


@pytest.mark.asyncio
async def test_pipeline_lint_disabled(mock_sandbox_manager, mock_container_ops):
    """Pipeline with lint_enabled=False should skip lint."""
    mock_sandbox_manager.run_verilator_sim.side_effect = [
        {
            "success": True,
            "stdout": "PASS\n",
            "stderr": "",
            "vcd_file": None,
            "coverage_data": None,
            "duration_seconds": 1.0,
        },
        {
            "success": True,
            "stdout": "PASS\n",
            "stderr": "",
            "vcd_file": None,
            "coverage_data": {
                "success": True,
                "raw_report": "Lines covered: 95.0%",
                "summary": "",
            },
            "duration_seconds": 1.5,
        },
    ]

    config = PipelineConfig(lint_enabled=False)
    result = await run_pipeline(SIMPLE_RTL, testbench_code=SIMPLE_TB, config=config)

    assert result.success is True
    assert result.get_step("lint") is None  # lint was not run


@pytest.mark.asyncio
async def test_pipeline_result_to_dict(mock_sandbox_manager, mock_container_ops):
    """Pipeline result should serialize to dict correctly."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True, "warnings": [], "errors": [],
        "stdout": "", "stderr": "", "duration_seconds": 0.1,
    }

    result = await run_pipeline(SIMPLE_RTL)
    d = result.to_dict()

    assert "pipeline_id" in d
    assert d["pipeline_id"].startswith("pipe-")
    assert isinstance(d["steps"], list)
    assert isinstance(d["total_duration_seconds"], float)
