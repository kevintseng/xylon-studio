"""Tests for LLM-driven pipeline steps (Phase B)."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from typing import Optional

from agent.pipeline.models import (
    StepStatus,
    TestPlan,
    TestScenario,
    CoverageReport,
    PipelineConfig,
)
from agent.pipeline.steps.test_plan import run_test_plan_step
from agent.pipeline.steps.testbench_gen import run_testbench_gen_step
from agent.pipeline.steps.improve import improve_testbench_step
from agent.pipeline.runner import run_pipeline
from agent.core.llm_provider import LLMProvider, LLMGenerationError


# ==================== Test Data & Fixtures ====================

SIMPLE_ADDER_RTL = """
module adder_8bit(
    input [7:0] a,
    input [7:0] b,
    output [8:0] sum
);
    assign sum = a + b;
endmodule
"""

SIMPLE_TESTBENCH = """
module tb_adder_8bit;
    reg [7:0] a, b;
    wire [8:0] sum;

    adder_8bit dut(.a(a), .b(b), .sum(sum));

    initial begin
        a = 8'd0; b = 8'd0;
        #10;
        a = 8'd100; b = 8'd50;
        #10;
        $display("PASS");
        $finish;
    end
endmodule
"""

EXPECTED_TEST_PLAN = TestPlan(
    module_name="adder_8bit",
    port_analysis={
        "inputs": ["a[7:0]", "b[7:0]"],
        "outputs": ["sum[8:0]"],
        "clocks": [],
        "resets": [],
    },
    scenarios=[
        TestScenario(
            name="reset_to_zero",
            description="Test reset to all zeros",
            category="functional",
            priority="high",
            coverage_targets=["line:all", "toggle:a", "toggle:b"],
        ),
        TestScenario(
            name="overflow",
            description="Test addition overflow",
            category="edge_case",
            priority="high",
            coverage_targets=["branch:sum_overflow"],
        ),
    ],
    coverage_goals={"line": 0.95, "toggle": 0.90, "branch": 0.85},
)

EXPECTED_TESTBENCH = (
    '#include "Vadder_8bit.h"\n'
    '#include "verilated.h"\n'
    '#include "verilated_cov.h"\n'
    '#include <iostream>\n'
    '\n'
    'int main(int argc, char** argv) {\n'
    '    Verilated::commandArgs(argc, argv);\n'
    '    Vadder_8bit* dut = new Vadder_8bit;\n'
    '\n'
    '    int pass_count = 0;\n'
    '    int fail_count = 0;\n'
    '\n'
    '    // Test: reset to zero\n'
    '    dut->a = 0;\n'
    '    dut->b = 0;\n'
    '    dut->eval();\n'
    '    if (dut->sum == 0) {\n'
    '        pass_count++;\n'
    '    } else {\n'
    '        fail_count++;\n'
    '    }\n'
    '\n'
    '    // Test: overflow\n'
    '    dut->a = 255;\n'
    '    dut->b = 1;\n'
    '    dut->eval();\n'
    '    if (dut->sum == 256) {\n'
    '        pass_count++;\n'
    '    } else {\n'
    '        fail_count++;\n'
    '    }\n'
    '\n'
    '    if (fail_count == 0) {\n'
    '        std::cout << "PASS: " << pass_count << " checks passed" << std::endl;\n'
    '    } else {\n'
    '        std::cout << "FAIL: " << fail_count << " of " << (pass_count + fail_count) << " checks failed" << std::endl;\n'
    '    }\n'
    '\n'
    '    delete dut;\n'
    '    VerilatedCov::write("coverage.dat");\n'
    '    return fail_count > 0 ? 1 : 0;\n'
    '}\n'
)


@pytest.fixture
def mock_llm() -> AsyncMock:
    """Create a mock LLM gateway."""
    llm = AsyncMock()

    # Configure the generate() method to return a response-like object
    mock_response = MagicMock()
    mock_response.text = ""
    mock_response.provider.value = "deepseek"
    mock_response.model = "deepseek-coder-v2"
    mock_response.cost_usd = 0.001
    mock_response.latency_ms = 1500

    llm.generate = AsyncMock(return_value=mock_response)
    return llm


@pytest.fixture
def mock_lint_result():
    """Create a mock lint step result."""
    result = MagicMock()
    result.status = StepStatus.PASSED
    result.output = {"warnings": []}
    return result


@pytest.fixture
def coverage_low():
    """Create a coverage report below target."""
    return CoverageReport(
        line_coverage=0.65,
        toggle_coverage=0.60,
        branch_coverage=0.55,
        score=0.60,
        uncovered_lines=["line:45", "line:47", "line:50"],
    )


@pytest.fixture
def coverage_high():
    """Create a coverage report above target."""
    return CoverageReport(
        line_coverage=0.92,
        toggle_coverage=0.88,
        branch_coverage=0.85,
        score=0.88,
        uncovered_lines=[],
    )


# ==================== Unit Tests ====================

@pytest.mark.asyncio
async def test_generate_test_plan_success(mock_llm, mock_lint_result):
    """Test successful test plan generation."""
    # Configure mock to return response with parsed test plan JSON
    import json

    mock_response = MagicMock()
    mock_response.text = json.dumps({
        "module_name": "adder_8bit",
        "port_analysis": {"inputs": ["a[7:0]", "b[7:0]"], "outputs": ["sum[8:0]"], "clocks": [], "resets": []},
        "scenarios": [
            {"name": "basic_add", "description": "Add two numbers", "category": "functional", "priority": "high", "coverage_targets": []},
            {"name": "overflow", "description": "Test overflow", "category": "edge_case", "priority": "high", "coverage_targets": []},
        ],
        "coverage_goals": {"line": 0.85, "toggle": 0.80, "branch": 0.75},
    })
    mock_response.provider.value = "deepseek"
    mock_response.model = "deepseek-coder-v2"
    mock_response.cost_usd = 0.001
    mock_response.latency_ms = 1500

    mock_llm.generate = AsyncMock(return_value=mock_response)

    step_result, test_plan = await run_test_plan_step(
        rtl_code=SIMPLE_ADDER_RTL,
        llm_gateway=mock_llm,
        lint_warnings=mock_lint_result.output.get("warnings", []),
    )

    assert step_result.status == StepStatus.PASSED
    assert step_result.step_name == "test_plan"
    assert test_plan is not None
    assert test_plan.module_name == "adder_8bit"
    assert len(test_plan.scenarios) >= 2
    assert test_plan.coverage_goals["line"] >= 0.8


@pytest.mark.asyncio
async def test_generate_test_plan_llm_failure(mock_llm, mock_lint_result):
    """Test test plan generation with LLM failure."""
    mock_llm.generate = AsyncMock(side_effect=Exception("LLM timeout"))

    step_result, test_plan = await run_test_plan_step(
        rtl_code=SIMPLE_ADDER_RTL,
        llm_gateway=mock_llm,
        lint_warnings=mock_lint_result.output.get("warnings", []),
    )

    assert step_result.status == StepStatus.ERROR
    assert "LLM timeout" in step_result.errors[0]
    assert test_plan is None


@pytest.mark.asyncio
async def test_generate_testbench_success(mock_llm):
    """Test successful testbench generation."""
    mock_response = MagicMock()
    mock_response.text = EXPECTED_TESTBENCH
    mock_response.provider.value = "deepseek"
    mock_response.model = "deepseek-coder-v2"
    mock_response.cost_usd = 0.002
    mock_response.latency_ms = 2000

    mock_llm.generate = AsyncMock(return_value=mock_response)

    step_result, testbench = await run_testbench_gen_step(
        rtl_code=SIMPLE_ADDER_RTL,
        test_plan=EXPECTED_TEST_PLAN,
        llm_gateway=mock_llm,
    )

    assert step_result.status == StepStatus.PASSED
    assert step_result.step_name == "testbench_gen"
    assert testbench is not None
    assert "adder_8bit" in testbench or "cpp" in testbench.lower()


@pytest.mark.asyncio
async def test_generate_testbench_llm_failure(mock_llm):
    """Test testbench generation with LLM failure."""
    mock_llm.generate = AsyncMock(side_effect=Exception("Token limit exceeded"))

    step_result, testbench = await run_testbench_gen_step(
        rtl_code=SIMPLE_ADDER_RTL,
        test_plan=EXPECTED_TEST_PLAN,
        llm_gateway=mock_llm,
    )

    assert step_result.status == StepStatus.ERROR
    assert "Token limit exceeded" in step_result.errors[0]
    assert testbench is None


@pytest.mark.asyncio
async def test_improve_testbench_generates_improvements(mock_llm, coverage_low):
    """Test testbench improvement with coverage below target."""
    # LLM returns a COMPLETE improved testbench (not a fragment)
    improved_code = EXPECTED_TESTBENCH.rstrip() + "\n// Extra edge case test\n"
    # Wrap in a code block as the LLM would
    improve_response = MagicMock()
    improve_response.text = "```cpp\n" + improved_code + "\n```"
    improve_response.provider = MagicMock(value="deepseek")
    improve_response.model = "deepseek-coder-v2"
    improve_response.cost_usd = 0.001
    improve_response.latency_ms = 1000
    mock_llm.generate = AsyncMock(return_value=improve_response)

    step_result, improved_tb = await improve_testbench_step(
        rtl_code=SIMPLE_ADDER_RTL,
        testbench=EXPECTED_TESTBENCH,
        coverage=coverage_low,
        target_coverage=0.85,
        module_name="adder_8bit",
        llm=mock_llm,
        iteration=1,
    )

    assert step_result.status == StepStatus.PASSED
    assert step_result.step_name == "improve"
    assert improved_tb is not None
    assert "#include" in improved_tb
    assert "int main" in improved_tb


@pytest.mark.asyncio
async def test_improve_testbench_llm_failure(mock_llm, coverage_low):
    """Test testbench improvement with LLM failure."""
    mock_llm.generate = AsyncMock(side_effect=LLMGenerationError(
        "Model unavailable"
    ))

    with pytest.raises(RuntimeError, match="Failed to improve testbench"):
        await improve_testbench_step(
            rtl_code=SIMPLE_ADDER_RTL,
            testbench=EXPECTED_TESTBENCH,
            coverage=coverage_low,
            target_coverage=0.85,
            module_name="adder_8bit",
            llm=mock_llm,
            iteration=1,
        )


# ==================== Integration Tests ====================

@pytest.mark.asyncio
async def test_full_pipeline_phase_b_single_iteration(mock_llm, monkeypatch):
    """Test full Phase B pipeline that meets coverage target in first iteration."""
    import json

    # Setup mock_llm.generate to return test plan JSON on first call,
    # then C++ testbench on second call (matching what the step functions expect)
    test_plan_response = MagicMock()
    test_plan_response.text = json.dumps({
        "module_name": "adder_8bit",
        "port_analysis": {"inputs": ["a[7:0]", "b[7:0]"], "outputs": ["sum[8:0]"], "clocks": [], "resets": []},
        "scenarios": [
            {"name": "basic_add", "description": "Add two numbers", "category": "functional", "priority": "high", "coverage_targets": []},
        ],
        "coverage_goals": {"line": 0.85, "toggle": 0.80, "branch": 0.75},
    })
    test_plan_response.provider = MagicMock(value="deepseek")
    test_plan_response.model = "deepseek-coder-v2"
    test_plan_response.cost_usd = 0.001
    test_plan_response.latency_ms = 1500

    testbench_response = MagicMock()
    testbench_response.text = EXPECTED_TESTBENCH
    testbench_response.provider = MagicMock(value="deepseek")
    testbench_response.model = "deepseek-coder-v2"
    testbench_response.cost_usd = 0.002
    testbench_response.latency_ms = 2000

    mock_llm.generate = AsyncMock(side_effect=[test_plan_response, testbench_response])

    # Mock simulation/coverage to return high coverage on first iteration
    async def mock_run_simulate_step(rtl_file, tb_file, sandbox, timeout=None):
        from agent.pipeline.models import StepResult
        result = StepResult(
            step_name="simulate",
            status=StepStatus.PASSED,
            duration_seconds=2.0,
        )
        return result

    async def mock_run_coverage_step(rtl_file, tb_file, sandbox, timeout=None):
        from agent.pipeline.models import StepResult
        coverage = CoverageReport(
            line_coverage=0.92,
            toggle_coverage=0.88,
            branch_coverage=0.85,
            score=0.88,
            uncovered_lines=[],
        )
        result = StepResult(
            step_name="coverage",
            status=StepStatus.PASSED,
            duration_seconds=3.0,
            output={"coverage_score": 0.88},
        )
        return result, coverage

    async def mock_run_lint_step(rtl_file, sandbox):
        from agent.pipeline.models import StepResult
        return StepResult(
            step_name="lint",
            status=StepStatus.PASSED,
            duration_seconds=1.0,
            output={"warnings": []},
        )

    # Patch the step functions
    monkeypatch.setattr(
        "agent.pipeline.runner.run_lint_step",
        mock_run_lint_step,
    )
    monkeypatch.setattr(
        "agent.pipeline.runner.run_simulate_step",
        mock_run_simulate_step,
    )
    monkeypatch.setattr(
        "agent.pipeline.runner.run_coverage_step",
        mock_run_coverage_step,
    )

    config = PipelineConfig(
        coverage_target=0.85,
        max_iterations=3,
        llm_provider={"type": "vllm", "endpoint": "http://localhost:8000"},
        generate_testbench=True,
        generate_test_plan=True,
    )

    result = await run_pipeline(
        rtl_code=SIMPLE_ADDER_RTL,
        testbench_code=None,
        config=config,
        llm_provider=mock_llm,
    )

    assert result.success
    assert result.iterations_used == 1
    assert result.final_coverage is not None
    assert result.final_coverage.score >= 0.85


@pytest.mark.asyncio
async def test_full_pipeline_phase_b_max_iterations(mock_llm, monkeypatch):
    """Test Phase B pipeline that hits max iterations without meeting target."""
    import json

    # Setup mock_llm.generate to return test plan JSON then C++ testbench
    test_plan_response = MagicMock()
    test_plan_response.text = json.dumps({
        "module_name": "adder_8bit",
        "port_analysis": {"inputs": ["a[7:0]", "b[7:0]"], "outputs": ["sum[8:0]"], "clocks": [], "resets": []},
        "scenarios": [
            {"name": "basic_add", "description": "Add two numbers", "category": "functional", "priority": "high", "coverage_targets": []},
        ],
        "coverage_goals": {"line": 0.85, "toggle": 0.80, "branch": 0.75},
    })
    test_plan_response.provider = MagicMock(value="deepseek")
    test_plan_response.model = "deepseek-coder-v2"
    test_plan_response.cost_usd = 0.001
    test_plan_response.latency_ms = 1500

    testbench_response = MagicMock()
    testbench_response.text = EXPECTED_TESTBENCH
    testbench_response.provider = MagicMock(value="deepseek")
    testbench_response.model = "deepseek-coder-v2"
    testbench_response.cost_usd = 0.002
    testbench_response.latency_ms = 2000

    improve_response = MagicMock()
    improve_response.text = "// improved test cases\ndut->a = 128; dut->b = 128; dut->evaluate();"
    improve_response.provider = MagicMock(value="deepseek")
    improve_response.model = "deepseek-coder-v2"
    improve_response.cost_usd = 0.001
    improve_response.latency_ms = 800

    # test_plan + testbench + improve (iter 1) + improve (iter 2)
    mock_llm.generate = AsyncMock(side_effect=[
        test_plan_response, testbench_response, improve_response, improve_response,
    ])

    iteration_coverages = [0.60, 0.70, 0.75]  # Below target throughout
    iteration_idx = [0]

    async def mock_run_coverage_step(rtl_file, tb_file, sandbox, timeout=None):
        from agent.pipeline.models import StepResult
        coverage_score = iteration_coverages[min(iteration_idx[0], len(iteration_coverages) - 1)]
        iteration_idx[0] += 1

        coverage = CoverageReport(
            line_coverage=coverage_score * 0.95,
            toggle_coverage=coverage_score * 0.90,
            branch_coverage=coverage_score * 0.85,
            score=coverage_score,
            uncovered_lines=["line:10", "line:20"],
        )
        result = StepResult(
            step_name="coverage",
            status=StepStatus.PASSED,
            duration_seconds=3.0,
        )
        return result, coverage

    async def mock_run_lint_step(rtl_file, sandbox):
        from agent.pipeline.models import StepResult
        return StepResult(
            step_name="lint",
            status=StepStatus.PASSED,
            duration_seconds=1.0,
            output={"warnings": []},
        )

    async def mock_run_simulate_step(rtl_file, tb_file, sandbox, timeout=None):
        from agent.pipeline.models import StepResult
        return StepResult(
            step_name="simulate",
            status=StepStatus.PASSED,
            duration_seconds=2.0,
        )

    monkeypatch.setattr(
        "agent.pipeline.runner.run_lint_step",
        mock_run_lint_step,
    )
    monkeypatch.setattr(
        "agent.pipeline.runner.run_simulate_step",
        mock_run_simulate_step,
    )
    monkeypatch.setattr(
        "agent.pipeline.runner.run_coverage_step",
        mock_run_coverage_step,
    )

    config = PipelineConfig(
        coverage_target=0.85,
        max_iterations=3,
        llm_provider={"type": "vllm", "endpoint": "http://localhost:8000"},
        generate_testbench=True,
        generate_test_plan=True,
    )

    result = await run_pipeline(
        rtl_code=SIMPLE_ADDER_RTL,
        testbench_code=None,
        config=config,
        llm_provider=mock_llm,
    )

    # Should complete but with warning about not meeting target
    assert result.iterations_used == 3  # Max iterations
    assert result.final_coverage is not None
    assert result.final_coverage.score < 0.85  # Below target


@pytest.mark.asyncio
async def test_pipeline_phase_a_with_user_testbench(monkeypatch):
    """Test Phase A pipeline (user-provided testbench)."""
    async def mock_run_coverage_step(rtl_file, tb_file, sandbox, timeout=None):
        from agent.pipeline.models import StepResult
        coverage = CoverageReport(
            line_coverage=0.90,
            toggle_coverage=0.87,
            branch_coverage=0.82,
            score=0.86,
            uncovered_lines=[],
        )
        result = StepResult(
            step_name="coverage",
            status=StepStatus.PASSED,
            duration_seconds=3.0,
        )
        return result, coverage

    async def mock_run_lint_step(rtl_file, sandbox):
        from agent.pipeline.models import StepResult
        return StepResult(
            step_name="lint",
            status=StepStatus.PASSED,
            duration_seconds=1.0,
            output={"warnings": []},
        )

    async def mock_run_simulate_step(rtl_file, tb_file, sandbox, timeout=None):
        from agent.pipeline.models import StepResult
        return StepResult(
            step_name="simulate",
            status=StepStatus.PASSED,
            duration_seconds=2.0,
        )

    monkeypatch.setattr(
        "agent.pipeline.runner.run_lint_step",
        mock_run_lint_step,
    )
    monkeypatch.setattr(
        "agent.pipeline.runner.run_simulate_step",
        mock_run_simulate_step,
    )
    monkeypatch.setattr(
        "agent.pipeline.runner.run_coverage_step",
        mock_run_coverage_step,
    )

    config = PipelineConfig(
        coverage_target=0.80,
        max_iterations=1,
        generate_testbench=False,
        generate_test_plan=False,
    )

    result = await run_pipeline(
        rtl_code=SIMPLE_ADDER_RTL,
        testbench_code=SIMPLE_TESTBENCH,
        config=config,
    )

    assert result.success
    assert result.iterations_used == 1
    assert result.final_coverage is not None
    assert result.final_coverage.score >= 0.80


# ==================== Edge Case Tests ====================

@pytest.mark.asyncio
async def test_llm_provider_not_configured_phase_b_fails():
    """Test that Phase B without LLM provider configuration fails gracefully."""
    # PipelineConfig.__post_init__ validates that llm_provider is required
    # when generate_testbench or generate_test_plan is enabled.
    # This should raise ValueError at construction time.
    with pytest.raises(ValueError, match="llm_provider"):
        PipelineConfig(
            coverage_target=0.85,
            max_iterations=3,
            llm_provider=None,  # No LLM config
            generate_testbench=True,  # But Phase B enabled
            generate_test_plan=True,
        )


@pytest.mark.asyncio
async def test_simulation_failure_stops_pipeline(monkeypatch):
    """Test that simulation failure stops the iteration loop."""
    async def mock_run_simulate_step(rtl_file, tb_file, sandbox, timeout=None):
        from agent.pipeline.models import StepResult
        return StepResult(
            step_name="simulate",
            status=StepStatus.FAILED,
            duration_seconds=2.0,
            errors=["Simulation crashed"],
        )

    async def mock_run_lint_step(rtl_file, sandbox):
        from agent.pipeline.models import StepResult
        return StepResult(
            step_name="lint",
            status=StepStatus.PASSED,
            duration_seconds=1.0,
            output={"warnings": []},
        )

    monkeypatch.setattr(
        "agent.pipeline.runner.run_lint_step",
        mock_run_lint_step,
    )
    monkeypatch.setattr(
        "agent.pipeline.runner.run_simulate_step",
        mock_run_simulate_step,
    )

    config = PipelineConfig(
        coverage_target=0.85,
        max_iterations=3,
        generate_testbench=False,
    )

    result = await run_pipeline(
        rtl_code=SIMPLE_ADDER_RTL,
        testbench_code=SIMPLE_TESTBENCH,
        config=config,
    )

    assert not result.success
    assert result.iterations_used == 1  # Only ran one simulation before failure


# ==================== Performance Tests ====================

@pytest.mark.slow
@pytest.mark.asyncio
async def test_large_rtl_code_handling(mock_llm):
    """Test pipeline with large RTL code (stress test)."""
    import json

    # Generate large RTL code (1000 lines)
    large_rtl = SIMPLE_ADDER_RTL + "\n// " + "\n// ".join([f"Line {i}" for i in range(1000)])

    # Override mock_llm.generate to return valid JSON test plan
    mock_response = MagicMock()
    mock_response.text = json.dumps({
        "module_name": "adder_8bit",
        "port_analysis": {"inputs": ["a[7:0]", "b[7:0]"], "outputs": ["sum[8:0]"], "clocks": [], "resets": []},
        "scenarios": [
            {"name": "basic_add", "description": "Add two numbers", "category": "functional", "priority": "high", "coverage_targets": []},
        ],
        "coverage_goals": {"line": 0.85, "toggle": 0.80, "branch": 0.75},
    })
    mock_response.provider.value = "deepseek"
    mock_response.model = "deepseek-coder-v2"
    mock_response.cost_usd = 0.001
    mock_response.latency_ms = 1500
    mock_llm.generate = AsyncMock(return_value=mock_response)

    # Should handle large code without crashing
    step_result, test_plan = await run_test_plan_step(
        rtl_code=large_rtl,
        llm_gateway=mock_llm,
        lint_warnings=[],
    )

    assert step_result.status == StepStatus.PASSED
    assert test_plan is not None
    assert test_plan.module_name == "adder_8bit"
