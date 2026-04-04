"""Integration tests for pipeline."""

import pytest
import os

from agent.pipeline.models import StepStatus
from agent.pipeline.runner import run_pipeline, PipelineConfig


# Simple 8-bit adder RTL for testing
SIMPLE_ADDER_RTL = """
module adder_8bit (
    input [7:0] a,
    input [7:0] b,
    output [8:0] sum
);
    assign sum = a + b;
endmodule
"""

# Simple testbench that verifies 1+1=2
SIMPLE_TB = """
module tb_adder();
    reg [7:0] a, b;
    wire [8:0] sum;

    adder_8bit dut (
        .a(a),
        .b(b),
        .sum(sum)
    );

    initial begin
        a = 8'd1;
        b = 8'd1;
        #10;

        if (sum == 9'd2) begin
            $display("PASS");
        end else begin
            $display("FAIL");
        end

        $finish;
    end
endmodule
"""


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pipeline_lint_only():
    """Test pipeline with lint only (no testbench)."""
    config = PipelineConfig(lint_enabled=True)

    result = await run_pipeline(
        rtl_code=SIMPLE_ADDER_RTL,
        testbench_code=None,
        config=config,
    )

    assert result.pipeline_id is not None
    assert len(result.steps) == 1
    assert result.steps[0].step_name == 'lint'
    assert result.steps[0].status == StepStatus.PASSED
    assert result.success is True
    assert result.final_coverage is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pipeline_lint_fail():
    """Test pipeline with syntactically invalid RTL."""
    invalid_rtl = "module broken ( input x, invalid syntax"
    config = PipelineConfig(lint_enabled=True)

    # Note: This requires Docker containers to be running
    # Skip if containers not available
    if not _check_docker_available():
        pytest.skip("Docker containers not available")

    result = await run_pipeline(
        rtl_code=invalid_rtl,
        testbench_code=None,
        config=config,
    )

    assert result.steps[0].status == StepStatus.FAILED
    assert result.success is False


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.slow
async def test_pipeline_full_flow():
    """Full pipeline: lint -> simulate -> coverage."""
    if not _check_docker_available():
        pytest.skip("Docker containers not available")

    config = PipelineConfig(
        lint_enabled=True,
        simulation_timeout=300,
        coverage_target=0.8,
    )

    result = await run_pipeline(
        rtl_code=SIMPLE_ADDER_RTL,
        testbench_code=SIMPLE_TB,
        config=config,
    )

    # Check result structure
    assert result.pipeline_id is not None
    assert result.success is True
    assert len(result.steps) == 3

    # Check lint step
    assert result.steps[0].step_name == 'lint'
    assert result.steps[0].status == StepStatus.PASSED

    # Check simulate step
    assert result.steps[1].step_name == 'simulate'
    assert result.steps[1].status == StepStatus.PASSED
    assert result.steps[1].output['test_passed'] is True

    # Check coverage step
    assert result.steps[2].step_name == 'coverage'
    assert result.steps[2].status == StepStatus.PASSED

    # Check coverage data
    assert result.final_coverage is not None
    assert result.final_coverage.line_coverage >= 0.0
    assert result.final_coverage.toggle_coverage >= 0.0
    assert result.final_coverage.branch_coverage >= 0.0
    assert result.final_coverage.score >= 0.0


def _check_docker_available() -> bool:
    """Check if Docker containers are running."""
    import subprocess

    try:
        subprocess.run(
            ['docker', 'ps', '--filter', 'name=xylon-verilator'],
            capture_output=True,
            timeout=5,
            check=False,
        )
        return True
    except Exception:
        return False
