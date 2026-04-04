# Copyright (c) 2026 XylonStudio
# Licensed under the MIT License
# See LICENSE in the project root for license information

"""
LLM Provider Interface for Phase B.

Abstraction layer for LLM backends (OpenAI, Anthropic, vLLM, Ollama).
Supports test plan generation, testbench generation, and testbench improvement.
"""

import logging
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agent.pipeline.models import CoverageReport, TestPlan

logger = logging.getLogger(__name__)


# ==================== Abstract Base Class ====================


class LLMProvider(ABC):
    """
    Abstract interface for LLM-powered verification tasks.

    Implementations support different LLM backends while maintaining
    a consistent interface for test plan generation, testbench generation,
    and testbench improvement.
    """

    def __init__(self, endpoint: str, timeout: int = 30):
        """
        Initialize LLM provider.

        Args:
            endpoint: LLM server endpoint (e.g., "http://localhost:8000")
            timeout: Request timeout in seconds
        """
        self.endpoint = endpoint
        self.timeout = timeout
        logger.info(f"LLMProvider initialized: {self.__class__.__name__} @ {endpoint}")

    @abstractmethod
    async def generate_test_plan(
        self,
        rtl_code: str,
        lint_result: dict | None = None
    ) -> "TestPlan":
        """
        Generate structured test plan from RTL code.

        Analyzes RTL module interface, port directions, and behavior to create
        a comprehensive test plan with scenarios, edge cases, and coverage goals.

        Args:
            rtl_code: Verilog RTL source code
            lint_result: Optional lint analysis result for context

        Returns:
            Structured TestPlan with scenarios, edge cases, and coverage goals

        Raises:
            LLMProviderError: If plan generation fails
        """
        pass

    @abstractmethod
    async def generate_testbench(
        self,
        rtl_code: str,
        test_plan: "TestPlan"
    ) -> str:
        """
        Generate SystemVerilog testbench from test plan.

        Creates executable testbench code that implements the scenarios
        and edge cases specified in the test plan.

        Args:
            rtl_code: Verilog RTL source code
            test_plan: Test plan with scenarios and edge cases

        Returns:
            SystemVerilog testbench code (as string)

        Raises:
            LLMProviderError: If testbench generation fails
        """
        pass

    @abstractmethod
    async def improve_testbench(
        self,
        rtl_code: str,
        testbench: str,
        coverage: "CoverageReport",  # type: ignore
        iteration: int
    ) -> str:
        """
        Improve testbench to increase coverage.

        Analyzes coverage gaps and generates additional test cases targeting
        uncovered paths, then merges with existing testbench.

        Args:
            rtl_code: Verilog RTL source code
            testbench: Current testbench code
            coverage: Current coverage metrics
            iteration: Current iteration number (for logging/context)

        Returns:
            Improved SystemVerilog testbench code

        Raises:
            LLMProviderError: If improvement fails
        """
        pass


# ==================== Exceptions ====================


class LLMProviderError(Exception):
    """Base exception for LLM provider errors."""

    pass


class LLMGenerationError(LLMProviderError):
    """Raised when LLM generation (test plan, testbench, improvement) fails."""

    pass


class LLMTimeoutError(LLMProviderError):
    """Raised when LLM request times out."""

    pass


class LLMValidationError(LLMProviderError):
    """Raised when generated code fails validation (syntax, structure)."""

    pass


# ==================== Response Model ====================


class LLMProviderType:
    """LLM provider type enum-like for response metadata."""
    def __init__(self, value: str):
        self.value = value


class LLMResponse:
    """Standard response from LLM generate() call."""
    def __init__(self, text: str, provider: str, model: str, cost_usd: float = 0.0, latency_ms: float = 0.0):
        self.text = text
        self.provider = LLMProviderType(provider)
        self.model = model
        self.cost_usd = cost_usd
        self.latency_ms = latency_ms


# ==================== Concrete Implementations ====================


class VLLMProvider(LLMProvider):
    """vLLM backend implementation."""

    def __init__(self, endpoint: str, model: str = "deepseek-coder", timeout: int = 30):
        """
        Initialize vLLM provider.

        Args:
            endpoint: vLLM server endpoint (e.g., "http://localhost:8000")
            model: Model name (default: deepseek-coder for XylonStudio)
            timeout: Request timeout in seconds
        """
        super().__init__(endpoint, timeout)
        self.model = model

        try:
            import httpx
            self.client = httpx.AsyncClient(timeout=timeout)
        except ImportError as e:
            raise ImportError("Please install: pip install httpx") from e

    async def generate_test_plan(
        self,
        rtl_code: str,
        lint_result: dict | None = None
    ) -> "TestPlan":
        """Generate test plan from RTL using vLLM."""
        from agent.pipeline.models import TestPlan, TestScenario

        # Build prompt
        lint_context = ""
        if lint_result and isinstance(lint_result, dict):
            warnings = lint_result.get("warnings", [])
            if warnings:
                lint_context = "## Lint Warnings\n"
                for w in warnings[:10]:
                    lint_context += f"- {w}\n"

        prompt = f"""You are an expert chip verification engineer. Analyze the following Verilog RTL module and produce a structured verification test plan.

## RTL Code
```verilog
{rtl_code}
```

{lint_context}

Produce a JSON object with this exact structure:
{{
  "module_name": "name of the module",
  "port_analysis": {{"inputs": [...], "outputs": [...], "clocks": ["clk"], "resets": ["rst_n"]}},
  "scenarios": [{{"name": "...", "description": "...", "category": "functional", "priority": "high", "coverage_targets": ["..."]}}],
  "coverage_goals": {{"line": 0.95, "toggle": 0.90, "branch": 0.85}}
}}

Only output the JSON, no markdown formatting."""

        try:
            response = await self.client.post(
                f"{self.endpoint}/v1/completions",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "max_tokens": 4000,
                    "temperature": 0.3,
                }
            )
            response.raise_for_status()
            data = response.json()
            text = data["choices"][0]["text"]

            # Parse JSON response
            import json
            import re

            # Extract JSON from response
            json_match = re.search(r'\{.*\}', text, re.DOTALL)
            if not json_match:
                raise LLMGenerationError("No JSON found in response")

            plan_data = json.loads(json_match.group())

            # Build TestPlan
            scenarios = [
                TestScenario(
                    name=s.get("name", ""),
                    description=s.get("description", ""),
                    category=s.get("category", "functional"),
                    priority=s.get("priority", "medium"),
                    coverage_targets=s.get("coverage_targets", [])
                )
                for s in plan_data.get("scenarios", [])
            ]

            return TestPlan(
                module_name=plan_data.get("module_name", "unknown"),
                port_analysis=plan_data.get("port_analysis", {}),
                scenarios=scenarios or [TestScenario(
                    name="default_test",
                    description="Default test scenario",
                    category="functional",
                    priority="medium"
                )],
                coverage_goals=plan_data.get("coverage_goals", {
                    "line": 0.80,
                    "toggle": 0.75,
                    "branch": 0.70
                }),
                raw_llm_output=text
            )

        except Exception as e:
            logger.error(f"Test plan generation failed: {e}")
            raise LLMGenerationError(f"Failed to generate test plan: {e}") from e

    async def generate_testbench(
        self,
        rtl_code: str,
        test_plan: "TestPlan"
    ) -> str:
        """Generate SystemVerilog testbench from test plan using vLLM."""

        # Format scenarios for prompt
        scenarios_text = "\n".join([
            f"- {s.name}: {s.description} (priority: {s.priority})"
            for s in test_plan.scenarios
        ])

        prompt = f"""You are an expert chip verification engineer. Generate a C++ Verilator testbench for the following Verilog RTL module based on the provided test plan.

## RTL Code
```verilog
{rtl_code}
```

## Test Plan
Module: {test_plan.module_name}
Scenarios to cover:
{scenarios_text}

Coverage goals: line={test_plan.coverage_goals.get('line', 0.8):.0%}, toggle={test_plan.coverage_goals.get('toggle', 0.75):.0%}, branch={test_plan.coverage_goals.get('branch', 0.7):.0%}

## Instructions

Generate a complete C++ testbench file that:
1. Includes the Verilated model header (V{test_plan.module_name}.h)
2. Tests ALL scenarios listed above
3. Uses $display("PASS") or $display("FAIL") style assertions
4. Drives clocks and resets properly
5. Includes coverage directives for simulation

Only output the C++ code, no markdown formatting."""

        try:
            response = await self.client.post(
                f"{self.endpoint}/v1/completions",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "max_tokens": 8000,
                    "temperature": 0.3,
                }
            )
            response.raise_for_status()
            data = response.json()
            return data["choices"][0]["text"]

        except Exception as e:
            logger.error(f"Testbench generation failed: {e}")
            raise LLMGenerationError(f"Failed to generate testbench: {e}") from e

    async def improve_testbench(
        self,
        rtl_code: str,
        testbench: str,
        coverage: "CoverageReport",  # type: ignore
        iteration: int
    ) -> str:
        """Improve testbench to increase coverage using vLLM."""

        # Build uncovered areas summary
        uncovered = []
        if coverage.line_coverage < 1.0:
            uncovered.append(f"- {(1.0 - coverage.line_coverage):.1%} of lines uncovered")
            if coverage.uncovered_lines:
                uncovered.append(f"  Uncovered lines: {', '.join(coverage.uncovered_lines[:5])}")
        if coverage.toggle_coverage < 1.0:
            uncovered.append(f"- {(1.0 - coverage.toggle_coverage):.1%} of toggles uncovered")
        if coverage.branch_coverage < 1.0:
            uncovered.append(f"- {(1.0 - coverage.branch_coverage):.1%} of branches uncovered")

        uncovered_text = "\n".join(uncovered) if uncovered else "All coverage metrics met"

        prompt = f"""You are an expert chip verification engineer. The testbench for this module achieved {coverage.score:.1%} coverage, below the target of 80%.

## Uncovered Areas
{uncovered_text}

## Current Testbench
```cpp
{testbench[:3000]}
```

## RTL Code
```verilog
{rtl_code[:3000]}
```

Generate ADDITIONAL test cases to append to the existing testbench. These should target the uncovered areas listed above.

Requirements:
1. Only provide NEW test cases - this will be inserted into the existing testbench
2. Follow the same style and structure as existing test cases
3. Target specific uncovered signals and branches
4. Include clear comments explaining what each new test targets

Output ONLY the new test code to be appended, no markdown formatting."""

        try:
            response = await self.client.post(
                f"{self.endpoint}/v1/completions",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "max_tokens": 4000,
                    "temperature": 0.3,
                }
            )
            response.raise_for_status()
            data = response.json()
            new_cases = data["choices"][0]["text"]

            # Append new test cases to existing testbench
            return testbench + "\n\n// Iteration " + str(iteration) + " improvements:\n" + new_cases

        except Exception as e:
            logger.error(f"Testbench improvement failed: {e}")
            raise LLMGenerationError(f"Failed to improve testbench: {e}") from e


class OllamaProvider(LLMProvider):
    """Ollama backend implementation with generate() interface for pipeline steps."""

    def __init__(self, endpoint: str, model: str = "qwen2.5-coder:32b", timeout: int = 120):
        super().__init__(endpoint, timeout)
        self.model = model

        try:
            import httpx
            self.client = httpx.AsyncClient(timeout=timeout)
        except ImportError as e:
            raise ImportError("Please install: pip install httpx") from e

    async def generate(self, prompt: str, max_tokens: int = 4000, temperature: float = 0.3) -> LLMResponse:
        """Generate text using Ollama API. Used by pipeline step functions."""
        import time
        start = time.monotonic()

        try:
            response = await self.client.post(
                f"{self.endpoint}/api/generate",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "num_predict": max_tokens,
                        "temperature": temperature,
                    },
                }
            )
            response.raise_for_status()
            data = response.json()
            text = data.get("response", "")
            latency = (time.monotonic() - start) * 1000

            return LLMResponse(
                text=text,
                provider="ollama",
                model=self.model,
                cost_usd=0.0,
                latency_ms=latency,
            )

        except Exception as e:
            logger.error(f"Ollama generate failed: {e}")
            raise LLMGenerationError(f"Ollama generation failed: {e}") from e

    async def generate_test_plan(self, rtl_code: str, lint_result: dict | None = None) -> "TestPlan":
        raise NotImplementedError("Use generate() via pipeline steps instead")

    async def generate_testbench(self, rtl_code: str, test_plan: "TestPlan") -> str:
        raise NotImplementedError("Use generate() via pipeline steps instead")

    async def improve_testbench(self, rtl_code: str, testbench: str, coverage: "CoverageReport", iteration: int) -> str:
        raise NotImplementedError("Use generate() via pipeline steps instead")


def create_llm_provider(config: dict) -> LLMProvider:
    """
    Factory function to create LLM provider from configuration.

    Args:
        config: Configuration dict with keys: type, endpoint, model, timeout, api_key

    Returns:
        LLMProvider instance

    Raises:
        ValueError: If configuration is invalid or provider type not supported
    """
    llm_type = config.get("type", "vllm").lower()
    endpoint = config.get("endpoint", "http://localhost:8000")
    model = config.get("model", "deepseek-coder")
    timeout = config.get("timeout", 30)

    if llm_type == "vllm":
        return VLLMProvider(endpoint=endpoint, model=model, timeout=timeout)

    elif llm_type == "ollama":
        return OllamaProvider(endpoint=endpoint, model=model, timeout=timeout)

    elif llm_type == "openai":
        raise NotImplementedError("OpenAI provider not yet implemented")

    elif llm_type == "anthropic":
        raise NotImplementedError("Anthropic provider not yet implemented")

    else:
        raise ValueError(f"Unsupported LLM type: {llm_type}")
