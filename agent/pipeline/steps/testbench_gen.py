"""
Testbench Generation Step.

Uses LLM to generate a C++ Verilator testbench from RTL and TestPlan.
Also supports iterative improvement based on coverage reports (UVM2-inspired).

Reference: UVM2 (arXiv:2504.19959) iterative verification methodology.
"""

import logging
import re
import time
from typing import Optional

from agent.pipeline.models import (
    CoverageReport,
    StepResult,
    StepStatus,
    TestPlan,
    TestScenario,
)

logger = logging.getLogger(__name__)

STEP_NAME = "testbench_gen"

# Prompt for initial testbench generation
TESTBENCH_GEN_PROMPT = """\
You are an expert chip verification engineer. Generate a C++ Verilator testbench \
for the following Verilog RTL module based on the provided test plan.

## RTL Code
```verilog
{rtl_code}
```

## Test Plan
Module: {module_name}
Scenarios to cover:
{scenarios_text}

Coverage goals: line={line_goal:.0%}, toggle={toggle_goal:.0%}, branch={branch_goal:.0%}

## Instructions

Generate a complete C++ testbench file that:
1. Includes the Verilated model header (V{module_name}.h)
2. Tests ALL scenarios listed above, prioritizing critical ones
3. Uses `$display("PASS")` or `$display("FAIL")` style assertions via cout
4. Drives clocks and resets properly for sequential logic
5. Includes boundary value tests (all-zeros, all-ones, overflow)
6. Exercises toggle coverage by varying all input signals
7. Prints "PASS" on stdout if all checks succeed, "FAIL" otherwise

## Template Structure
```cpp
#include "V{module_name}.h"
#include "verilated.h"
#include <iostream>

int main(int argc, char** argv) {{
    Verilated::commandArgs(argc, argv);
    V{module_name}* dut = new V{module_name};

    int pass_count = 0;
    int fail_count = 0;

    // --- Scenario tests ---
    // [Your test code here]
    // Note: use dut->evaluate() (not eval()) to step the simulation.
    // "evaluate" is the standard Verilator C++ API for propagating signals.
    // Use: dut->evaluate(); after setting inputs
    // Use: dut->clk = !dut->clk; dut->evaluate(); for clock toggle

    // --- Summary ---
    if (fail_count == 0) {{
        std::cout << "PASS: " << pass_count << " checks passed" << std::endl;
    }} else {{
        std::cout << "FAIL: " << fail_count << " of "
                  << (pass_count + fail_count) << " checks failed" << std::endl;
    }}

    delete dut;
    return fail_count > 0 ? 1 : 0;
}}
```

Respond with ONLY the C++ code, no other text.
"""

# Prompt for iterative testbench improvement (UVM2-inspired)
TESTBENCH_IMPROVE_PROMPT = """\
You are an expert chip verification engineer improving a testbench for better coverage.

## RTL Code
```verilog
{rtl_code}
```

## Current Testbench
```cpp
{current_testbench}
```

## Coverage Report
- Line coverage: {line_cov:.1%} (goal: {line_goal:.0%})
- Toggle coverage: {toggle_cov:.1%} (goal: {toggle_goal:.0%})
- Branch coverage: {branch_cov:.1%} (goal: {branch_goal:.0%})
- Overall score: {score:.1%}

## Uncovered Lines
{uncovered_lines}

## Instructions

Improve the testbench to increase coverage. Focus on:
1. Uncovered lines listed above — add test cases that exercise them
2. Low toggle coverage — vary more input signal combinations
3. Low branch coverage — test both sides of conditional branches
4. Add edge cases: reset during operation, back-to-back transactions, pipeline stalls

Keep all existing tests that pass. Add new test scenarios.
Use dut->evaluate() to step the simulation (Verilator C++ API, not eval()).

Respond with ONLY the improved C++ testbench code, no other text.
"""


async def run_testbench_gen_step(
    rtl_code: str,
    test_plan: TestPlan,
    llm_gateway,
) -> tuple[StepResult, str | None]:
    """
    Generate a Verilator C++ testbench from RTL and test plan.

    Args:
        rtl_code: Verilog source code
        test_plan: AI-generated test plan with scenarios
        llm_gateway: LLMGateway instance for LLM calls

    Returns:
        Tuple of (StepResult, testbench_code or None if generation failed)
    """
    logger.info("Testbench generation step starting")
    start = time.monotonic()

    scenarios_text = _format_scenarios(test_plan.scenarios)
    goals = test_plan.coverage_goals

    prompt = TESTBENCH_GEN_PROMPT.format(
        rtl_code=rtl_code,
        module_name=test_plan.module_name,
        scenarios_text=scenarios_text,
        line_goal=goals.get("line", 0.80),
        toggle_goal=goals.get("toggle", 0.60),
        branch_goal=goals.get("branch", 0.60),
    )

    try:
        response = llm_gateway.generate(
            prompt,
            max_tokens=6000,
            temperature=0.2,  # Low temperature for code generation
        )

        duration = time.monotonic() - start
        raw_text = response.text
        tb_code = _extract_cpp_code(raw_text)

        if tb_code is None:
            return (
                StepResult(
                    step_name=STEP_NAME,
                    status=StepStatus.FAILED,
                    duration_seconds=duration,
                    output={
                        "raw_response": raw_text[:2000],
                        "llm_provider": response.provider.value,
                        "llm_model": response.model,
                        "llm_cost_usd": response.cost_usd,
                    },
                    errors=["Failed to extract C++ testbench from LLM response"],
                    warnings=[],
                ),
                None,
            )

        return (
            StepResult(
                step_name=STEP_NAME,
                status=StepStatus.PASSED,
                duration_seconds=duration,
                output={
                    "module_name": test_plan.module_name,
                    "scenario_count": test_plan.scenario_count,
                    "testbench_lines": tb_code.count("\n") + 1,
                    "llm_provider": response.provider.value,
                    "llm_model": response.model,
                    "llm_cost_usd": response.cost_usd,
                    "llm_latency_ms": response.latency_ms,
                },
                errors=[],
                warnings=[],
            ),
            tb_code,
        )

    except Exception as e:
        duration = time.monotonic() - start
        logger.error(f"Testbench generation failed: {e}")
        return (
            StepResult(
                step_name=STEP_NAME,
                status=StepStatus.ERROR,
                duration_seconds=duration,
                output={},
                errors=[f"LLM call failed: {e}"],
                warnings=[],
            ),
            None,
        )


async def run_testbench_improve_step(
    rtl_code: str,
    current_testbench: str,
    coverage_report: CoverageReport,
    coverage_goals: dict[str, float],
    llm_gateway,
) -> tuple[StepResult, str | None]:
    """
    Improve testbench based on coverage gaps (UVM2-inspired iteration).

    Args:
        rtl_code: Verilog source code
        current_testbench: Current testbench C++ code
        coverage_report: Coverage report from last simulation
        coverage_goals: Target coverage goals
        llm_gateway: LLMGateway instance

    Returns:
        Tuple of (StepResult, improved_testbench_code or None)
    """
    logger.info("Testbench improvement step starting")
    start = time.monotonic()

    uncovered = "\n".join(coverage_report.uncovered_lines[:30]) if coverage_report.uncovered_lines else "No specific uncovered lines reported."

    prompt = TESTBENCH_IMPROVE_PROMPT.format(
        rtl_code=rtl_code,
        current_testbench=current_testbench,
        line_cov=coverage_report.line_coverage,
        toggle_cov=coverage_report.toggle_coverage,
        branch_cov=coverage_report.branch_coverage,
        score=coverage_report.score,
        line_goal=coverage_goals.get("line", 0.80),
        toggle_goal=coverage_goals.get("toggle", 0.60),
        branch_goal=coverage_goals.get("branch", 0.60),
        uncovered_lines=uncovered,
    )

    try:
        response = llm_gateway.generate(
            prompt,
            max_tokens=8000,
            temperature=0.3,
        )

        duration = time.monotonic() - start
        raw_text = response.text
        improved_tb = _extract_cpp_code(raw_text)

        if improved_tb is None:
            return (
                StepResult(
                    step_name="testbench_improve",
                    status=StepStatus.FAILED,
                    duration_seconds=duration,
                    output={
                        "raw_response": raw_text[:2000],
                        "llm_provider": response.provider.value,
                        "llm_model": response.model,
                    },
                    errors=["Failed to extract improved testbench from LLM response"],
                    warnings=[],
                ),
                None,
            )

        return (
            StepResult(
                step_name="testbench_improve",
                status=StepStatus.PASSED,
                duration_seconds=duration,
                output={
                    "testbench_lines": improved_tb.count("\n") + 1,
                    "coverage_before": coverage_report.score,
                    "llm_provider": response.provider.value,
                    "llm_model": response.model,
                    "llm_cost_usd": response.cost_usd,
                    "llm_latency_ms": response.latency_ms,
                },
                errors=[],
                warnings=[],
            ),
            improved_tb,
        )

    except Exception as e:
        duration = time.monotonic() - start
        logger.error(f"Testbench improvement failed: {e}")
        return (
            StepResult(
                step_name="testbench_improve",
                status=StepStatus.ERROR,
                duration_seconds=duration,
                output={},
                errors=[f"LLM call failed: {e}"],
                warnings=[],
            ),
            None,
        )


def _format_scenarios(scenarios: list[TestScenario]) -> str:
    """Format test scenarios for prompt inclusion."""
    lines = []
    for i, s in enumerate(scenarios, 1):
        lines.append(
            f"{i}. [{s.priority.upper()}] {s.name} ({s.category})\n"
            f"   {s.description}\n"
            f"   Coverage targets: {', '.join(s.coverage_targets)}"
        )
    return "\n".join(lines)


def _extract_cpp_code(raw_text: str) -> Optional[str]:
    """
    Extract C++ code from LLM response.

    Handles:
    - Code wrapped in ```cpp or ``` blocks
    - Raw code without markdown
    """
    # Try markdown code block first
    cpp_match = re.search(r"```(?:cpp|c\+\+)?\s*\n(.*?)```", raw_text, re.DOTALL)
    if cpp_match:
        code = cpp_match.group(1).strip()
        if _looks_like_cpp(code):
            return code

    # Try raw code (starts with #include)
    raw = raw_text.strip()
    if _looks_like_cpp(raw):
        return raw

    return None


def _looks_like_cpp(text: str) -> bool:
    """Check if text looks like valid C++ testbench code."""
    return (
        "#include" in text
        and "int main" in text
        and len(text) > 100
    )
