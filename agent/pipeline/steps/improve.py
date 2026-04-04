# Copyright (c) 2026 XylonStudio
# Licensed under the MIT License
# See LICENSE in the project root for license information

"""
Testbench Improvement Step (Phase B).

Iteratively improves testbench to increase coverage based on coverage reports.
"""

import logging
import re
import time
from typing import Optional

from agent.pipeline.models import StepResult, StepStatus, CoverageReport
from agent.core.llm_provider import LLMProviderError

logger = logging.getLogger(__name__)


IMPROVEMENT_PROMPT = """\
You are an expert chip verification engineer. The testbench for {module_name} \
achieved {current_coverage:.1%} coverage, below the target of {target_coverage:.1%}.

## Current Coverage Analysis
- Line coverage: {line_coverage:.1%} (target: {line_target:.1%})
- Toggle coverage: {toggle_coverage:.1%} (target: {toggle_target:.1%})
- Branch coverage: {branch_coverage:.1%} (target: {branch_target:.1%})

## Uncovered Areas
{uncovered_areas}

## Current Testbench
```verilog
{current_testbench}
```

## RTL Code
```verilog
{rtl_code}
```

## Task

Generate a COMPLETE improved C++ testbench that includes ALL existing tests \
plus NEW test cases targeting the uncovered areas listed above.

Requirements:
1. Keep ALL existing test cases that pass. FIX any failing test assertions.
2. ADD new test cases targeting uncovered signals and branches
3. Output must be a complete, compilable C++ file with #include, main(), and VerilatedCov::write("coverage.dat")
4. TIMING RULES (critical for correctness):
   - Sequential logic: registers update on RISING clock edge only
   - Use tick() helper: dut->clk=1; dut->eval(); dut->clk=0; dut->eval();
   - Check outputs AFTER tick(), not before
   - Reset: set rst_n=0, call tick(), THEN check outputs
   - DO NOT check register outputs before a clock edge
5. Include clear comments explaining what each new test targets
6. Print "PASS" or "FAIL" summary at the end

Output ONLY the complete C++ testbench code, wrapped in a code block.
"""


async def improve_testbench_step(
    rtl_code: str,
    testbench: str,
    coverage: CoverageReport,
    target_coverage: float,
    module_name: str,
    llm,
    iteration: int
) -> tuple[StepResult, str]:
    """
    Improve testbench to increase coverage.

    Analyzes coverage gaps and generates additional test cases targeting
    uncovered paths, then merges with existing testbench.

    Args:
        rtl_code: Verilog RTL source code
        testbench: Current testbench code
        coverage: Current coverage metrics
        target_coverage: Target coverage score
        module_name: Name of module being tested
        llm: LLM provider instance
        iteration: Current iteration number

    Returns:
        Tuple of (StepResult, improved testbench code)

    Raises:
        RuntimeError: If improvement fails
    """
    logger.info(
        f"Iteration {iteration}: Improving testbench "
        f"(current={coverage.score:.1%}, target={target_coverage:.1%})"
    )
    start_time = time.time()

    try:
        # Build uncovered areas summary from coverage report
        uncovered_summary = _summarize_uncovered_areas(coverage)

        # Build improvement prompt
        prompt = IMPROVEMENT_PROMPT.format(
            module_name=module_name,
            current_coverage=coverage.score,
            target_coverage=target_coverage,
            line_coverage=coverage.line_coverage,
            line_target=target_coverage * 0.95,  # Allow slight relaxation
            toggle_coverage=coverage.toggle_coverage,
            toggle_target=target_coverage * 0.85,
            branch_coverage=coverage.branch_coverage,
            branch_target=target_coverage * 0.85,
            uncovered_areas=uncovered_summary,
            current_testbench=testbench[:3000],  # Limit context
            rtl_code=rtl_code[:3000],
        )

        # Call LLM to generate improvements using generic generate() interface
        response = await llm.generate(
            prompt,
            max_tokens=4000,
            temperature=0.3,
        )

        # Extract the complete improved testbench from LLM response
        improved_tb = _extract_code_block(response.text)

        # Validate it looks like a complete C++ file
        if '#include' not in improved_tb or 'int main' not in improved_tb:
            # LLM returned a fragment, not a complete file — fall back to original
            improved_tb = testbench

        duration = time.time() - start_time
        logger.info(f"Testbench improvement generated: duration={duration:.2f}s")

        # Create step result
        step_result = StepResult(
            step_name="improve",
            status=StepStatus.PASSED,
            duration_seconds=duration,
            output={
                "iteration": iteration,
                "previous_score": coverage.score,
                "tb_lines": len(improved_tb.split('\n')),
                "llm_provider": response.provider.value,
                "llm_model": response.model,
                "llm_latency_ms": response.latency_ms,
            },
        )

        return step_result, improved_tb

    except LLMProviderError as e:
        duration = time.time() - start_time
        logger.error(f"Testbench improvement failed: {e}")

        step_result = StepResult(
            step_name="improve",
            status=StepStatus.FAILED,
            duration_seconds=duration,
            errors=[str(e)],
        )

        raise RuntimeError(f"Failed to improve testbench: {e}") from e

    except Exception as e:
        duration = time.time() - start_time
        logger.error(f"Unexpected error in testbench improvement: {e}")

        step_result = StepResult(
            step_name="improve",
            status=StepStatus.ERROR,
            duration_seconds=duration,
            errors=[str(e)],
        )

        raise RuntimeError(f"Testbench improvement error: {e}") from e


def _summarize_uncovered_areas(coverage: CoverageReport) -> str:
    """
    Create a human-readable summary of uncovered areas from coverage report.

    Args:
        coverage: Coverage metrics

    Returns:
        Summary string for LLM prompt
    """
    summary_lines = []

    # Add line coverage gaps
    if coverage.line_coverage < 1.0:
        summary_lines.append(
            f"- {(1.0 - coverage.line_coverage):.1%} of lines uncovered"
        )
        if coverage.uncovered_lines:
            summary_lines.append(f"  Uncovered lines: {', '.join(coverage.uncovered_lines[:5])}")
            if len(coverage.uncovered_lines) > 5:
                summary_lines.append(f"  ... and {len(coverage.uncovered_lines) - 5} more lines")

    # Add toggle coverage gaps
    if coverage.toggle_coverage < 1.0:
        summary_lines.append(
            f"- {(1.0 - coverage.toggle_coverage):.1%} of toggle transitions uncovered"
        )

    # Add branch coverage gaps
    if coverage.branch_coverage < 1.0:
        summary_lines.append(
            f"- {(1.0 - coverage.branch_coverage):.1%} of branches uncovered"
        )

    if not summary_lines:
        summary_lines.append("All coverage metrics met!")

    return "\n".join(summary_lines)


def _extract_code_block(raw_text: str) -> str:
    """Extract code from markdown code block, or return raw text."""
    match = re.search(r"```(?:cpp|c\+\+|verilog|systemverilog|sv)?\s*\n(.*?)```", raw_text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return raw_text.strip()
