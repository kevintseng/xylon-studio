"""Integration tests for pipeline."""


import pytest

from agent.pipeline.models import PipelineOutcome, RunMode, StepStatus
from agent.pipeline.runner import PipelineConfig, run_pipeline

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

# Exhaustive self-checking C++ testbench (Verilator requires a C++ harness)
SIMPLE_TB = """
#include "Vadder_8bit.h"
#include "verilated.h"
#include "verilated_cov.h"
#include <cstdio>

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    Vadder_8bit* dut = new Vadder_8bit;

    for (int a = 0; a < 256; ++a) {
        for (int b = 0; b < 256; ++b) {
            dut->a = a;
            dut->b = b;
            dut->eval();
            if (dut->sum != a + b) {
                printf("FAIL: a=%d b=%d sum=%d\\n", a, b, (int)dut->sum);
                VerilatedCov::write("coverage.dat");
                delete dut;
                return 1;
            }
        }
    }

    printf("PASS: exhaustively checked 65536 input pairs\\n");
    delete dut;
    VerilatedCov::write("coverage.dat");
    return 0;
}
"""


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pipeline_lint_only():
    """Test pipeline with lint only (no testbench)."""
    config = PipelineConfig(lint_enabled=True, runtime_check_enabled=True)

    result = await run_pipeline(
        rtl_code=SIMPLE_ADDER_RTL,
        testbench_code=None,
        config=config,
    )

    assert result.pipeline_id is not None
    assert [step.step_name for step in result.steps] == [
        'runtime', 'lint', 'artifacts'
    ]
    assert result.steps[0].output['verified'] is True
    assert result.steps[1].status == StepStatus.PASSED
    assert result.mode == RunMode.LINT_ONLY
    assert result.outcome == PipelineOutcome.LINT_ONLY
    assert result.success is False
    assert result.final_coverage is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pipeline_lint_fail():
    """Test pipeline with syntactically invalid RTL."""
    invalid_rtl = "module broken ( input x, invalid syntax"
    config = PipelineConfig(lint_enabled=True, runtime_check_enabled=True)

    result = await run_pipeline(
        rtl_code=invalid_rtl,
        testbench_code=None,
        config=config,
    )

    steps = {step.step_name: step for step in result.steps}
    assert steps['runtime'].status == StepStatus.PASSED
    assert steps['lint'].status == StepStatus.FAILED
    assert steps['artifacts'].status == StepStatus.PASSED
    assert result.success is False


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.slow
async def test_pipeline_full_flow():
    """Full pipeline: lint -> simulate -> coverage."""
    config = PipelineConfig(
        lint_enabled=True,
        simulation_timeout=300,
        coverage_target=0.8,
        runtime_check_enabled=True,
    )

    result = await run_pipeline(
        rtl_code=SIMPLE_ADDER_RTL,
        testbench_code=SIMPLE_TB,
        config=config,
    )

    # Check result structure
    assert result.pipeline_id is not None
    assert result.success is True
    assert result.outcome == PipelineOutcome.VERIFIED
    assert [step.step_name for step in result.steps] == [
        'runtime', 'lint', 'simulate', 'coverage', 'artifacts'
    ]

    steps = {step.step_name: step for step in result.steps}

    assert steps['runtime'].status == StepStatus.PASSED
    assert steps['lint'].status == StepStatus.PASSED
    assert steps['simulate'].status == StepStatus.PASSED
    assert steps['simulate'].output['test_passed'] is True

    assert steps['coverage'].status == StepStatus.PASSED
    assert steps['artifacts'].status == StepStatus.PASSED

    # Check coverage data
    assert result.final_coverage is not None
    assert result.final_coverage.line_coverage is None
    assert result.final_coverage.toggle_coverage >= 0.8
    assert result.final_coverage.branch_coverage is None
    assert result.final_coverage.score >= 0.8
    assert result.final_coverage.metric_sources == {
        "toggle_coverage": "verilator_summary",
        "score": "computed_verilator_point_counts",
    }
