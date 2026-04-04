"""
Debug Assistant Step.

When simulation fails, uses LLM to explain the error in plain language
and suggest fixes. Educational value is the primary goal.
"""

import logging
import time

from agent.pipeline.models import StepResult, StepStatus

logger = logging.getLogger(__name__)

DEBUG_PROMPT = """\
You are an expert chip verification engineer helping a student debug a Verilator \
simulation failure.

## RTL Code
```verilog
{rtl_code}
```

## Testbench (C++)
```cpp
{testbench_code}
```

## Simulation Output
```
stdout: {sim_stdout}
stderr: {sim_stderr}
```

## Task

Explain the simulation failure in plain language that a student learning chip \
verification would understand. Structure your response as JSON:

```json
{{
  "error_type": "compilation|runtime|assertion|timeout",
  "summary": "one sentence explaining what went wrong",
  "root_cause": "detailed explanation of why this happened",
  "fix_suggestions": [
    "specific suggestion 1",
    "specific suggestion 2"
  ],
  "learning_point": "what the student should learn from this error"
}}
```

Respond with ONLY the JSON object.
"""


async def run_debug_assist_step(
    rtl_code: str,
    testbench_code: str,
    sim_stdout: str,
    sim_stderr: str,
    llm,
) -> StepResult:
    """
    Analyze simulation failure and provide educational debug assistance.

    Args:
        rtl_code: Verilog RTL source code
        testbench_code: C++ testbench code
        sim_stdout: Simulation stdout output
        sim_stderr: Simulation stderr output
        llm: LLM provider with generate() method

    Returns:
        StepResult with debug analysis in output
    """
    logger.info("[DEBUG] Analyzing simulation failure...")
    start = time.monotonic()

    prompt = DEBUG_PROMPT.format(
        rtl_code=rtl_code[:3000],
        testbench_code=testbench_code[:3000],
        sim_stdout=sim_stdout[:2000],
        sim_stderr=sim_stderr[:2000],
    )

    try:
        response = await llm.generate(
            prompt,
            max_tokens=2000,
            temperature=0.3,
        )

        duration = time.monotonic() - start
        raw_text = response.text

        # Try to parse JSON from response
        import json
        import re

        json_match = re.search(r'\{.*\}', raw_text, re.DOTALL)
        debug_info = {}
        if json_match:
            try:
                debug_info = json.loads(json_match.group())
            except json.JSONDecodeError:
                debug_info = {"summary": raw_text[:500]}
        else:
            debug_info = {"summary": raw_text[:500]}

        logger.info(f"[DEBUG] Analysis complete: {debug_info.get('error_type', 'unknown')}")

        return StepResult(
            step_name="debug",
            status=StepStatus.PASSED,
            duration_seconds=duration,
            output={
                "error_type": debug_info.get("error_type", "unknown"),
                "summary": debug_info.get("summary", ""),
                "root_cause": debug_info.get("root_cause", ""),
                "fix_suggestions": debug_info.get("fix_suggestions", []),
                "learning_point": debug_info.get("learning_point", ""),
                "llm_provider": response.provider.value,
                "llm_model": response.model,
            },
        )

    except Exception as e:
        duration = time.monotonic() - start
        logger.error(f"[DEBUG] Analysis failed: {e}")
        return StepResult(
            step_name="debug",
            status=StepStatus.ERROR,
            duration_seconds=duration,
            output={},
            errors=[f"Debug analysis failed: {e}"],
        )
