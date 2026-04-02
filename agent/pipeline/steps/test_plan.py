"""
Test Plan Generation Step.

Uses LLM to analyze RTL and produce a structured verification plan.
This is the highest-ROI LLM step: AI error tolerance is high (it's a
document, not executable code), and educational value is maximum
(teaches "what to test", not just "how to write code").

Inspired by UVM2 (arXiv:2504.19959) iterative verification methodology.
"""

import json
import logging
import re
import time
from typing import Optional

from agent.pipeline.models import StepResult, StepStatus, TestPlan, TestScenario

logger = logging.getLogger(__name__)

STEP_NAME = "test_plan"

# Prompt template for test plan generation
# Structured to extract: ports, functional scenarios, edge cases, coverage goals
TEST_PLAN_PROMPT = """\
You are an expert chip verification engineer. Analyze the following Verilog RTL module \
and produce a structured verification test plan.

## RTL Code
```verilog
{rtl_code}
```

{lint_context}

## Instructions

Produce a JSON object with this exact structure:
```json
{{
  "module_name": "name of the module",
  "port_analysis": {{
    "inputs": [{{"name": "...", "width": N, "description": "..."}}],
    "outputs": [{{"name": "...", "width": N, "description": "..."}}],
    "clocks": ["clk"],
    "resets": ["rst_n"]
  }},
  "scenarios": [
    {{
      "name": "short descriptive name",
      "description": "what this test checks and why",
      "category": "functional|edge_case|boundary|reset|protocol",
      "priority": "critical|high|medium|low",
      "coverage_targets": ["which signals/branches this covers"]
    }}
  ],
  "coverage_goals": {{
    "line": 0.85,
    "toggle": 0.70,
    "branch": 0.75
  }}
}}
```

## Guidelines
- List scenarios in priority order (critical first)
- Include at least: normal operation, all-zeros, all-ones, overflow/underflow, reset behavior
- For sequential logic: test clock edge behavior, pipeline stages, back-to-back operations
- For combinational logic: test all input combinations for small widths, boundary values for large widths
- Be specific about what each scenario verifies
- Coverage goals should be realistic for the module complexity

Respond with ONLY the JSON object, no other text.
"""


async def run_test_plan_step(
    rtl_code: str,
    llm_gateway,
    lint_warnings: Optional[list[str]] = None,
) -> tuple[StepResult, TestPlan | None]:
    """
    Generate a verification test plan from RTL using LLM.

    Args:
        rtl_code: Verilog source code
        llm_gateway: LLMGateway instance for LLM calls
        lint_warnings: Optional lint warnings to provide context

    Returns:
        Tuple of (StepResult, TestPlan or None if generation failed)
    """
    logger.info("Test plan generation step starting")
    start = time.monotonic()

    # Build lint context for prompt
    lint_context = ""
    if lint_warnings:
        lint_context = "## Lint Warnings (from Verilator)\n"
        for w in lint_warnings[:10]:  # Cap at 10 warnings
            lint_context += f"- {w}\n"
        lint_context += "\nConsider these warnings when designing test scenarios.\n"

    prompt = TEST_PLAN_PROMPT.format(
        rtl_code=rtl_code,
        lint_context=lint_context,
    )

    try:
        response = llm_gateway.generate(
            prompt,
            max_tokens=4000,
            temperature=0.3,  # Low temperature for structured output
        )

        duration = time.monotonic() - start
        raw_text = response.text

        # Parse the JSON response
        test_plan = _parse_test_plan_response(raw_text)

        if test_plan is None:
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
                    errors=["Failed to parse LLM response as valid test plan JSON"],
                    warnings=[],
                ),
                None,
            )

        test_plan.raw_llm_output = raw_text

        return (
            StepResult(
                step_name=STEP_NAME,
                status=StepStatus.PASSED,
                duration_seconds=duration,
                output={
                    "module_name": test_plan.module_name,
                    "scenario_count": test_plan.scenario_count,
                    "critical_count": len(test_plan.critical_scenarios()),
                    "coverage_goals": test_plan.coverage_goals,
                    "llm_provider": response.provider.value,
                    "llm_model": response.model,
                    "llm_cost_usd": response.cost_usd,
                    "llm_latency_ms": response.latency_ms,
                },
                errors=[],
                warnings=[],
            ),
            test_plan,
        )

    except Exception as e:
        duration = time.monotonic() - start
        logger.error(f"Test plan generation failed: {e}")
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


def _parse_test_plan_response(raw_text: str) -> TestPlan | None:
    """
    Parse LLM response into a TestPlan object.

    Handles common LLM output quirks:
    - JSON wrapped in markdown code blocks
    - Trailing commas
    - Extra text before/after JSON
    """
    # Try to extract JSON from markdown code block
    json_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", raw_text, re.DOTALL)
    json_str = json_match.group(1) if json_match else raw_text.strip()

    # If no code block, try to find JSON object directly
    if not json_match:
        brace_match = re.search(r"\{.*\}", json_str, re.DOTALL)
        if brace_match:
            json_str = brace_match.group(0)

    # Remove trailing commas before closing brackets (common LLM mistake)
    json_str = re.sub(r",\s*([}\]])", r"\1", json_str)

    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as e:
        logger.warning(f"Failed to parse test plan JSON: {e}")
        return None

    # Validate required fields
    if "module_name" not in data or "scenarios" not in data:
        logger.warning("Test plan JSON missing required fields (module_name, scenarios)")
        return None

    # Parse scenarios
    scenarios = []
    for s in data.get("scenarios", []):
        scenarios.append(TestScenario(
            name=s.get("name", "unnamed"),
            description=s.get("description", ""),
            category=s.get("category", "functional"),
            priority=s.get("priority", "medium"),
            coverage_targets=s.get("coverage_targets", []),
        ))

    return TestPlan(
        module_name=data.get("module_name", "unknown"),
        port_analysis=data.get("port_analysis", {}),
        scenarios=scenarios,
        coverage_goals=data.get("coverage_goals", {
            "line": 0.80, "toggle": 0.60, "branch": 0.60,
        }),
    )
