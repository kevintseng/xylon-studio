"""Tests for Phase B pipeline features.

Tests cover:
- Test plan generation (test_plan.py)
- Testbench generation and improvement (testbench_gen.py)
- Synthesis step (synthesis.py)
- Coverage-driven iteration loop (runner.py)
- WebSocket progress streaming (pipeline route)
"""

import json
from dataclasses import dataclass
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent.pipeline.models import (
    CoverageReport,
    PipelineConfig,
    StepStatus,
    TestPlan,
    TestScenario,
)
from agent.pipeline.runner import run_pipeline
from agent.pipeline.steps.synthesis import (
    _parse_yosys_stats,
    _synthesis_warnings,
    run_synthesis_step,
)
from agent.pipeline.steps.test_plan import (
    _parse_test_plan_response,
    run_test_plan_step,
)
from agent.pipeline.steps.testbench_gen import (
    _extract_cpp_code,
    _format_scenarios,
    _looks_like_cpp,
    run_testbench_gen_step,
    run_testbench_improve_step,
)

# ── Fixtures ──


@dataclass
class MockLLMResponse:
    """Mock LLM response object."""
    text: str
    provider: MagicMock = None
    model: str = "mock-model"
    cost_usd: float = 0.001
    latency_ms: int = 500

    def __post_init__(self):
        if self.provider is None:
            self.provider = MagicMock()
            self.provider.value = "mock"


@pytest.fixture
def mock_llm_gateway():
    """Create a mock LLM gateway with async generate()."""
    gateway = MagicMock()
    gateway.generate = AsyncMock()
    return gateway


@pytest.fixture
def sample_test_plan():
    """Create a sample TestPlan for testing."""
    return TestPlan(
        module_name="adder_8bit",
        port_analysis={
            "inputs": [
                {"name": "a", "width": 8, "description": "First operand"},
                {"name": "b", "width": 8, "description": "Second operand"},
            ],
            "outputs": [
                {"name": "sum", "width": 9, "description": "Sum output"},
            ],
            "clocks": [],
            "resets": [],
        },
        scenarios=[
            TestScenario(
                name="basic_addition",
                description="Test basic addition of two numbers",
                category="functional",
                priority="critical",
                coverage_targets=["sum output"],
            ),
            TestScenario(
                name="overflow",
                description="Test overflow when both inputs are max",
                category="boundary",
                priority="high",
                coverage_targets=["carry bit"],
            ),
            TestScenario(
                name="zero_inputs",
                description="Test with both inputs zero",
                category="edge_case",
                priority="medium",
                coverage_targets=["zero path"],
            ),
        ],
        coverage_goals={"line": 0.85, "toggle": 0.70, "branch": 0.75},
    )


@pytest.fixture
def sample_coverage_report():
    """Create a sample CoverageReport."""
    return CoverageReport(
        line_coverage=0.65,
        toggle_coverage=0.50,
        branch_coverage=0.45,
        score=0.55,
        uncovered_lines=["design.v:10", "design.v:15", "design.v:22"],
        raw_output="",
    )


@pytest.fixture
def mock_sandbox():
    """Create a mock SandboxManager."""
    sandbox = MagicMock()
    sandbox.verilator_container = "xylon-verilator"
    sandbox.yosys_container = "xylon-yosys"
    return sandbox


# ── Test Plan Generation Tests ──


VALID_TEST_PLAN_JSON = json.dumps({
    "module_name": "counter_4bit",
    "port_analysis": {
        "inputs": [{"name": "clk", "width": 1, "description": "Clock"}],
        "outputs": [{"name": "count", "width": 4, "description": "Counter value"}],
        "clocks": ["clk"],
        "resets": ["rst_n"],
    },
    "scenarios": [
        {
            "name": "count_up",
            "description": "Verify counter increments on each clock",
            "category": "functional",
            "priority": "critical",
            "coverage_targets": ["count output"],
        },
        {
            "name": "reset_behavior",
            "description": "Verify counter resets to 0",
            "category": "reset",
            "priority": "critical",
            "coverage_targets": ["reset path"],
        },
    ],
    "coverage_goals": {"line": 0.90, "toggle": 0.80, "branch": 0.75},
})


@pytest.mark.asyncio
async def test_test_plan_step_success(mock_llm_gateway):
    """Test plan generation returns valid TestPlan on success."""
    mock_llm_gateway.generate.return_value = MockLLMResponse(text=VALID_TEST_PLAN_JSON)

    result, plan = await run_test_plan_step("module counter; endmodule", mock_llm_gateway)

    assert result.status == StepStatus.PASSED
    assert plan is not None
    assert plan.module_name == "counter_4bit"
    assert plan.scenario_count == 2
    assert len(plan.critical_scenarios()) == 2


@pytest.mark.asyncio
async def test_test_plan_step_invalid_json(mock_llm_gateway):
    """Test plan step fails gracefully on invalid JSON."""
    mock_llm_gateway.generate.return_value = MockLLMResponse(text="not valid json {{{")

    result, plan = await run_test_plan_step("module foo; endmodule", mock_llm_gateway)

    assert result.status == StepStatus.FAILED
    assert plan is None
    assert "Failed to parse" in result.errors[0]


@pytest.mark.asyncio
async def test_test_plan_step_llm_error(mock_llm_gateway):
    """Test plan step returns ERROR on LLM failure."""
    mock_llm_gateway.generate.side_effect = Exception("API timeout")

    result, plan = await run_test_plan_step("module foo; endmodule", mock_llm_gateway)

    assert result.status == StepStatus.ERROR
    assert plan is None
    assert "API timeout" in result.errors[0]


def test_parse_test_plan_response_valid():
    """Parse valid JSON response."""
    plan = _parse_test_plan_response(VALID_TEST_PLAN_JSON)
    assert plan is not None
    assert plan.module_name == "counter_4bit"
    assert len(plan.scenarios) == 2


def test_parse_test_plan_response_markdown_wrapped():
    """Parse JSON wrapped in markdown code block."""
    wrapped = f"```json\n{VALID_TEST_PLAN_JSON}\n```"
    plan = _parse_test_plan_response(wrapped)
    assert plan is not None
    assert plan.module_name == "counter_4bit"


def test_parse_test_plan_response_trailing_commas():
    """Parse JSON with trailing commas (common LLM mistake)."""
    json_with_commas = '{"module_name": "foo", "scenarios": [{"name": "test1", "description": "d", "category": "functional", "priority": "high",}],}'
    plan = _parse_test_plan_response(json_with_commas)
    assert plan is not None
    assert plan.module_name == "foo"


def test_parse_test_plan_response_missing_fields():
    """Return None for JSON missing required fields."""
    plan = _parse_test_plan_response('{"only_field": "value"}')
    assert plan is None


def test_parse_test_plan_response_garbage():
    """Return None for completely invalid input."""
    plan = _parse_test_plan_response("Hello, I am an AI assistant!")
    assert plan is None


@pytest.mark.asyncio
async def test_test_plan_with_lint_warnings(mock_llm_gateway):
    """Lint warnings should be included in prompt context."""
    mock_llm_gateway.generate.return_value = MockLLMResponse(text=VALID_TEST_PLAN_JSON)

    result, plan = await run_test_plan_step(
        "module foo; endmodule",
        mock_llm_gateway,
        lint_warnings=["%Warning: UNUSED signal 'a'"],
    )

    assert result.status == StepStatus.PASSED
    # Verify lint context was included in prompt
    call_args = mock_llm_gateway.generate.call_args
    prompt = call_args[0][0]
    assert "UNUSED" in prompt


# ── Testbench Generation Tests ──


VALID_CPP_TESTBENCH = """\
#include "Vadder_8bit.h"
#include "verilated.h"
#include <iostream>

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    Vadder_8bit* dut = new Vadder_8bit;

    int pass_count = 0;
    int fail_count = 0;

    // Test basic addition
    dut->a = 10;
    dut->b = 20;
    dut->evaluate();
    if (dut->sum == 30) { pass_count++; } else { fail_count++; }

    if (fail_count == 0) {
        std::cout << "PASS: " << pass_count << " checks passed" << std::endl;
    } else {
        std::cout << "FAIL: " << fail_count << " failed" << std::endl;
    }

    delete dut;
    return fail_count > 0 ? 1 : 0;
}
"""


@pytest.mark.asyncio
async def test_testbench_gen_step_success(mock_llm_gateway, sample_test_plan):
    """Testbench generation returns valid C++ code on success."""
    mock_llm_gateway.generate.return_value = MockLLMResponse(text=VALID_CPP_TESTBENCH)

    result, tb_code = await run_testbench_gen_step(
        "module adder_8bit; endmodule",
        sample_test_plan,
        mock_llm_gateway,
    )

    assert result.status == StepStatus.PASSED
    assert tb_code is not None
    assert "#include" in tb_code
    assert "int main" in tb_code
    assert result.output["testbench_lines"] > 10


@pytest.mark.asyncio
async def test_testbench_gen_step_no_code(mock_llm_gateway, sample_test_plan):
    """Testbench generation fails if LLM returns non-code."""
    mock_llm_gateway.generate.return_value = MockLLMResponse(
        text="I cannot generate a testbench for this module."
    )

    result, tb_code = await run_testbench_gen_step(
        "module adder_8bit; endmodule",
        sample_test_plan,
        mock_llm_gateway,
    )

    assert result.status == StepStatus.FAILED
    assert tb_code is None


@pytest.mark.asyncio
async def test_testbench_gen_step_llm_error(mock_llm_gateway, sample_test_plan):
    """Testbench generation returns ERROR on LLM failure."""
    mock_llm_gateway.generate.side_effect = RuntimeError("Out of tokens")

    result, tb_code = await run_testbench_gen_step(
        "module adder_8bit; endmodule",
        sample_test_plan,
        mock_llm_gateway,
    )

    assert result.status == StepStatus.ERROR
    assert tb_code is None


@pytest.mark.asyncio
async def test_testbench_improve_step_success(mock_llm_gateway, sample_coverage_report):
    """Testbench improvement returns improved C++ code."""
    improved_tb = VALID_CPP_TESTBENCH.replace("// Test basic addition", "// Improved tests")
    mock_llm_gateway.generate.return_value = MockLLMResponse(text=improved_tb)

    result, code = await run_testbench_improve_step(
        "module adder_8bit; endmodule",
        VALID_CPP_TESTBENCH,
        sample_coverage_report,
        {"line": 0.85, "toggle": 0.70, "branch": 0.75},
        mock_llm_gateway,
    )

    assert result.status == StepStatus.PASSED
    assert code is not None
    assert result.output["coverage_before"] == 0.55


def test_extract_cpp_code_from_markdown():
    """Extract C++ from markdown code block."""
    wrapped = f"```cpp\n{VALID_CPP_TESTBENCH}\n```"
    code = _extract_cpp_code(wrapped)
    assert code is not None
    assert "#include" in code


def test_extract_cpp_code_raw():
    """Extract C++ from raw text."""
    code = _extract_cpp_code(VALID_CPP_TESTBENCH)
    assert code is not None


def test_extract_cpp_code_not_cpp():
    """Return None for non-C++ text."""
    code = _extract_cpp_code("This is just a comment about testbenches.")
    assert code is None


def test_looks_like_cpp():
    """Check C++ detection heuristic."""
    assert _looks_like_cpp(VALID_CPP_TESTBENCH) is True
    assert _looks_like_cpp("hello world") is False
    assert _looks_like_cpp("#include <stdio.h>") is False  # Too short


def test_format_scenarios(sample_test_plan):
    """Format scenarios for prompt."""
    text = _format_scenarios(sample_test_plan.scenarios)
    assert "CRITICAL" in text
    assert "basic_addition" in text
    assert "overflow" in text
    assert "zero_inputs" in text


# ── Synthesis Step Tests ──


YOSYS_STAT_OUTPUT = """
=== counter ===

   Number of wires:                 15
   Number of wire bits:             42
   Number of memories:               0
   Number of memory bits:            0
   Number of cells:                 12
     $_AND_                          3
     $_NOT_                          2
     $_OR_                           4
     $_XOR_                          3
"""


@pytest.fixture
def rtl_file(tmp_path):
    """Create a temp RTL file for synthesis tests."""
    f = tmp_path / "counter.v"
    f.write_text("module counter; endmodule\n")
    return str(f)


@pytest.mark.asyncio
async def test_synthesis_step_passes(mock_sandbox, rtl_file):
    """Synthesis step passes with valid Yosys output."""
    mock_sandbox.synthesize_verilog_string.return_value = {
        "success": True,
        "gate_count": 12,
        "stdout": YOSYS_STAT_OUTPUT,
        "stderr": "",
        "duration_seconds": 2.0,
    }

    result = await run_synthesis_step(rtl_file, mock_sandbox)

    assert result.status == StepStatus.PASSED
    assert result.output["gate_count"] == 12
    assert result.output["wires"] == 15
    assert result.output["wire_bits"] == 42
    assert result.output["cells"]["$_AND_"] == 3
    assert result.output["cells"]["$_OR_"] == 4


@pytest.mark.asyncio
async def test_synthesis_step_fails(mock_sandbox, rtl_file):
    """Synthesis step fails on Yosys error."""
    mock_sandbox.synthesize_verilog_string.return_value = {
        "success": False,
        "gate_count": 0,
        "stdout": "",
        "stderr": "ERROR: syntax error at design.v:5",
        "duration_seconds": 0.5,
    }

    result = await run_synthesis_step(rtl_file, mock_sandbox)

    assert result.status == StepStatus.FAILED
    assert any("ERROR" in e or "error" in e.lower() for e in result.errors)


@pytest.mark.asyncio
async def test_synthesis_step_exception(mock_sandbox, rtl_file):
    """Synthesis step handles exceptions gracefully."""
    mock_sandbox.synthesize_verilog_string.side_effect = Exception("Docker not running")

    result = await run_synthesis_step(rtl_file, mock_sandbox)

    assert result.status == StepStatus.ERROR
    assert "Docker not running" in result.errors[0]


def test_parse_yosys_stats():
    """Parse Yosys stat output."""
    stats = _parse_yosys_stats(YOSYS_STAT_OUTPUT)
    assert stats["wires"] == 15
    assert stats["wire_bits"] == 42
    assert stats["memories"] == 0
    assert stats["cells"]["$_AND_"] == 3
    assert stats["cells"]["$_NOT_"] == 2


def test_parse_yosys_stats_empty():
    """Parse empty Yosys output."""
    stats = _parse_yosys_stats("")
    assert stats["wires"] == 0
    assert len(stats["cells"]) == 0


def test_synthesis_warnings_zero_gates():
    """Warning when gate count is zero."""
    warnings = _synthesis_warnings(0, {"memories": 0})
    assert any("0 gates" in w for w in warnings)


def test_synthesis_warnings_has_memories():
    """Warning when memories are detected."""
    warnings = _synthesis_warnings(100, {"memories": 2, "memory_bits": 1024})
    assert any("memory" in w.lower() for w in warnings)


def test_synthesis_warnings_normal():
    """No warnings for normal synthesis."""
    warnings = _synthesis_warnings(50, {"memories": 0})
    assert len(warnings) == 0


# ── Coverage-Driven Iteration (via Runner) Tests ──


@pytest.fixture
def mock_sandbox_manager():
    """Mock SandboxManager for pipeline tests."""
    with patch("agent.pipeline.runner.SandboxManager") as MockCls:
        sandbox = MockCls.return_value
        sandbox.verilator_container = "xylon-verilator"
        yield sandbox


@pytest.fixture
def mock_container_ops():
    """Mock Docker container operations.

    Runner writes RTL/testbench to tempdir via open(), so we only need
    to ensure the underlying subprocess calls in SandboxManager are mocked.
    SandboxManager itself is already patched by mock_sandbox_manager.
    """
    yield


@pytest.mark.asyncio
async def test_pipeline_phase_b_full_flow(mock_sandbox_manager, mock_container_ops):
    """Phase B pipeline: lint -> test_plan -> testbench_gen -> sim -> coverage."""
    # Lint passes
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.3,
    }

    # Simulate passes (for coverage step) — raw_report uses
    # Verilator's "Total coverage (N/M) X.XX%" format
    mock_sandbox_manager.run_verilator_sim_string.return_value = {
        "success": True,
        "stdout": "PASS: 5 checks passed\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": {
            "success": True,
            "raw_report": "Total coverage (90/100) 90.00%",
            "summary": "",
        },
        "duration_seconds": 2.0,
    }

    # Mock LLM gateway for test plan + testbench gen
    mock_gateway = MagicMock()
    mock_gateway.generate = AsyncMock(side_effect=[
        # First call: test plan
        MockLLMResponse(text=VALID_TEST_PLAN_JSON),
        # Second call: testbench gen
        MockLLMResponse(text=VALID_CPP_TESTBENCH),
    ])

    config = PipelineConfig(
        llm_provider={"type": "mock"},
        coverage_target=0.8,
        generate_testbench=True,
        generate_test_plan=True,
    )

    result = await run_pipeline(
        rtl_code="module counter; endmodule",
        testbench_code=None,  # Phase B generates testbench
        config=config,
        llm_provider=mock_gateway,
    )

    assert result.success is True
    assert result.get_step("test_plan") is not None
    assert result.get_step("test_plan").status == StepStatus.PASSED
    assert result.get_step("testbench_gen") is not None
    assert result.get_step("testbench_gen").status == StepStatus.PASSED
    assert result.get_step("simulate") is not None
    assert result.final_coverage is not None


@pytest.mark.asyncio
async def test_pipeline_synthesis_enabled(mock_sandbox_manager, mock_container_ops):
    """Pipeline with synthesis_enabled runs Yosys step."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True, "warnings": [], "errors": [],
        "stdout": "", "stderr": "", "duration_seconds": 0.1,
    }
    mock_sandbox_manager.synthesize_verilog_string.return_value = {
        "success": True,
        "gate_count": 25,
        "stdout": YOSYS_STAT_OUTPUT,
        "stderr": "",
        "duration_seconds": 1.0,
    }

    config = PipelineConfig(synthesis_enabled=True)
    result = await run_pipeline(
        rtl_code="module counter; endmodule",
        config=config,
    )

    assert result.success is True
    synth_step = result.get_step("synthesis")
    assert synth_step is not None
    assert synth_step.status == StepStatus.PASSED
    assert synth_step.output["gate_count"] == 25


@pytest.mark.asyncio
async def test_pipeline_step_callback(mock_sandbox_manager, mock_container_ops):
    """on_step_complete callback fires for each step."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True, "warnings": [], "errors": [],
        "stdout": "", "stderr": "", "duration_seconds": 0.1,
    }

    callback_calls = []

    async def on_step(step_result):
        callback_calls.append({
            "step_name": step_result.step_name,
            "status": step_result.status,
        })

    result = await run_pipeline(
        rtl_code="module foo; endmodule",
        on_step_complete=on_step,
    )

    # Lint runs (no testbench provided → no simulate/coverage steps)
    assert result is not None
    assert len(callback_calls) == 1
    assert callback_calls[0]["step_name"] == "lint"


@pytest.mark.asyncio
async def test_pipeline_iteration_loop(mock_sandbox_manager, mock_container_ops):
    """Coverage-driven iteration improves testbench until target met."""
    # Lint passes
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True, "warnings": [], "errors": [],
        "stdout": "", "stderr": "", "duration_seconds": 0.1,
    }

    # Simulation calls: initial sim, initial cov, iter1 sim, iter1 cov
    mock_sandbox_manager.run_verilator_sim_string.side_effect = [
        # Initial simulate (no coverage)
        {
            "success": True, "stdout": "PASS\n", "stderr": "",
            "vcd_file": None, "coverage_data": None, "duration_seconds": 1.0,
        },
        # Initial coverage: below target (60%)
        {
            "success": True, "stdout": "PASS\n", "stderr": "",
            "vcd_file": None,
            "coverage_data": {
                "success": True,
                "raw_report": "Total coverage (60/100) 60.00%",
                "summary": "",
            },
            "duration_seconds": 1.5,
        },
        # Iteration 1 simulate
        {
            "success": True, "stdout": "PASS\n", "stderr": "",
            "vcd_file": None, "coverage_data": None, "duration_seconds": 1.0,
        },
        # Iteration 1 coverage: above target (85%)
        {
            "success": True, "stdout": "PASS\n", "stderr": "",
            "vcd_file": None,
            "coverage_data": {
                "success": True,
                "raw_report": "Total coverage (90/100) 90.00%",
                "summary": "",
            },
            "duration_seconds": 1.5,
        },
    ]

    # LLM: test plan, testbench gen, testbench improve
    mock_gateway = MagicMock()
    mock_gateway.generate = AsyncMock(side_effect=[
        MockLLMResponse(text=VALID_TEST_PLAN_JSON),
        MockLLMResponse(text=VALID_CPP_TESTBENCH),
        MockLLMResponse(text=VALID_CPP_TESTBENCH.replace("// Test basic", "// Improved")),
    ])

    config = PipelineConfig(
        llm_provider={"type": "mock"},
        coverage_target=0.8,
        max_iterations=3,
        generate_testbench=True,
        generate_test_plan=True,
    )

    result = await run_pipeline(
        rtl_code="module counter; endmodule",
        config=config,
        llm_provider=mock_gateway,
    )

    assert result.success is True
    # 2 loop iterations: iter 0 runs baseline sim+coverage (60%, below target);
    # runner improves testbench; iter 1 runs sim+coverage (90%, target met)
    assert result.iterations_used == 2
    assert result.final_coverage is not None
    assert result.final_coverage.score >= 0.8


@pytest.mark.asyncio
async def test_pipeline_iteration_stall_detection(mock_sandbox_manager, mock_container_ops):
    """Iteration loop stops when coverage stalls."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True, "warnings": [], "errors": [],
        "stdout": "", "stderr": "", "duration_seconds": 0.1,
    }

    # Coverage doesn't improve between iterations
    mock_sandbox_manager.run_verilator_sim_string.side_effect = [
        # Initial simulate
        {"success": True, "stdout": "PASS\n", "stderr": "",
         "vcd_file": None, "coverage_data": None, "duration_seconds": 1.0},
        # Initial coverage: 50%
        {"success": True, "stdout": "PASS\n", "stderr": "",
         "vcd_file": None,
         "coverage_data": {"success": True,
                          "raw_report": "Total coverage (50/100) 50.00%",
                          "summary": ""},
         "duration_seconds": 1.5},
        # Iteration 1 sim
        {"success": True, "stdout": "PASS\n", "stderr": "",
         "vcd_file": None, "coverage_data": None, "duration_seconds": 1.0},
        # Iteration 1 coverage: tiny delta (stall)
        {"success": True, "stdout": "PASS\n", "stderr": "",
         "vcd_file": None,
         "coverage_data": {"success": True,
                          "raw_report": "Total coverage (1005/2000) 50.25%",
                          "summary": ""},
         "duration_seconds": 1.5},
    ]

    mock_gateway = MagicMock()
    mock_gateway.generate = AsyncMock(side_effect=[
        MockLLMResponse(text=VALID_TEST_PLAN_JSON),
        MockLLMResponse(text=VALID_CPP_TESTBENCH),
        MockLLMResponse(text=VALID_CPP_TESTBENCH),  # improve attempt
    ])

    config = PipelineConfig(
        llm_provider={"type": "mock"},
        coverage_target=0.9,
        max_iterations=5,
        generate_testbench=True,
        generate_test_plan=True,
    )

    result = await run_pipeline(
        rtl_code="module counter; endmodule",
        config=config,
        llm_provider=mock_gateway,
    )

    # Should stop after 2 loop iterations (baseline + 1 retry) due to stall
    assert result.iterations_used == 2
    stall_step = result.get_step("iteration_stall")
    assert stall_step is not None
    assert "stalled" in stall_step.warnings[0].lower()
