# Copyright (c) 2026 XylonStudio
# Licensed under the MIT License
# See LICENSE in the project root for license information

"""
Pipeline data models.

Defines the data structures for the verification pipeline:
- StepResult: Outcome of a single pipeline step (lint, simulate, coverage)
- CoverageReport: Detailed coverage metrics
- PipelineConfig: Pipeline execution configuration
- PipelineResult: Final pipeline execution summary
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from datetime import datetime


# ==================== Enums ====================


class StepStatus(str, Enum):
    """Pipeline step execution status."""

    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"
    ERROR = "error"


# ==================== Data Classes ====================


@dataclass
class StepResult:
    """
    Result of a single pipeline step execution.

    Attributes:
        step_name: Step identifier ("lint", "simulate", "coverage", "test_plan", "testbench", "improve")
        status: Execution status (passed/failed/skipped/error)
        duration_seconds: Wall-clock execution time
        output: Step-specific output dict (varies by step type)
        errors: List of error messages
        warnings: List of warning messages
        timestamp: UTC timestamp of step execution
    """

    step_name: str
    status: StepStatus
    duration_seconds: float
    output: dict = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())


@dataclass
class TestPlanStepResult(StepResult):
    """
    Result of test plan generation step (Phase B).

    Attributes:
        test_plan: Generated test plan (in output['test_plan'])
        step_name: Always "test_plan"
    """

    def __post_init__(self):
        """Set step name to test_plan."""
        self.step_name = "test_plan"

    def get_test_plan(self) -> Optional["TestPlan"]:
        """Extract TestPlan from output."""
        return self.output.get("test_plan")


@dataclass
class TestbenchStepResult(StepResult):
    """
    Result of testbench generation step (Phase B).

    Attributes:
        testbench: Generated testbench code (in output['testbench'])
        step_name: Always "testbench"
    """

    def __post_init__(self):
        """Set step name to testbench."""
        self.step_name = "testbench"

    def get_testbench(self) -> Optional[str]:
        """Extract testbench code from output."""
        return self.output.get("testbench")


@dataclass
class TestScenario:
    """
    Single test scenario in a test plan (Phase B).

    Attributes:
        name: Short scenario name
        description: What this test checks and why
        category: Type of test (functional, edge_case, boundary, reset, protocol)
        priority: Test priority (critical, high, medium, low)
        coverage_targets: Which signals/branches this scenario targets
    """

    name: str
    description: str
    category: str = "functional"
    priority: str = "medium"
    coverage_targets: list[str] = field(default_factory=list)
    learning_tip: str = ""


@dataclass
class TestPlan:
    """
    Structured test plan from LLM analysis (Phase B).

    Attributes:
        module_name: Name of RTL module being tested
        port_analysis: Analysis of module ports (inputs, outputs, clocks, resets)
        scenarios: List of test scenarios
        coverage_goals: Target coverage by type (line, toggle, branch)
        education_notes: AI-generated educational context for the module
        raw_llm_output: Raw LLM response for debugging
    """

    module_name: str
    port_analysis: dict
    scenarios: list[TestScenario]
    coverage_goals: dict[str, float]
    education_notes: dict = field(default_factory=dict)
    raw_llm_output: str = ""

    def __post_init__(self):
        """Validate test plan structure."""
        if not self.scenarios:
            raise ValueError("TestPlan must have at least one scenario")
        if not self.coverage_goals:
            raise ValueError("TestPlan must specify coverage goals")

        # Validate coverage goal values
        for goal_type, target in self.coverage_goals.items():
            if not (0.0 <= target <= 1.0):
                raise ValueError(
                    f"Coverage goal '{goal_type}' must be in [0.0, 1.0], got {target}"
                )

    @property
    def scenario_count(self) -> int:
        """Return number of scenarios."""
        return len(self.scenarios)

    def critical_scenarios(self) -> list[TestScenario]:
        """Return only critical-priority scenarios."""
        return [s for s in self.scenarios if s.priority == "critical"]


@dataclass
class CoverageReport:
    """
    Coverage metrics from Verilator simulation.

    Attributes:
        line_coverage: Fraction of lines covered (0.0-1.0)
        toggle_coverage: Fraction of toggles covered (0.0-1.0)
        branch_coverage: Fraction of branches covered (0.0-1.0)
        score: Weighted average of coverage types
        uncovered_lines: List of uncovered source lines
        raw_output: Full coverage report from Verilator
    """

    line_coverage: float
    toggle_coverage: float
    branch_coverage: float
    score: float
    uncovered_lines: list[str] = field(default_factory=list)
    raw_output: str = ""

    def __post_init__(self):
        """Validate coverage values are in [0.0, 1.0]."""
        for attr in ["line_coverage", "toggle_coverage", "branch_coverage", "score"]:
            val = getattr(self, attr)
            if not (0.0 <= val <= 1.0):
                raise ValueError(f"{attr} must be in [0.0, 1.0], got {val}")


@dataclass
class PipelineConfig:
    """
    Pipeline execution configuration.

    Attributes:
        coverage_target: Desired coverage score (0.0-1.0), default 0.8
        max_iterations: Maximum iterations for coverage-driven loop (Phase B+)
        lint_enabled: Whether to run lint step
        simulation_timeout: Timeout for simulation in seconds
        llm_provider: LLM provider configuration dict (Phase B)
            - type: "openai", "anthropic", "vllm", or "ollama"
            - endpoint: LLM server endpoint
            - model: Model name or identifier
            - timeout: Request timeout in seconds
            - api_key: API key (if required)
        generate_test_plan: Whether to generate test plan (Phase B)
        generate_testbench: Whether to generate testbench (Phase B)
    """

    coverage_target: float = 0.8
    max_iterations: int = 5
    lint_enabled: bool = True
    simulation_timeout: int = 300
    llm_provider: Optional[dict] = None
    generate_test_plan: bool = False
    generate_testbench: bool = False
    synthesis_enabled: bool = False

    def __post_init__(self):
        """Validate configuration values."""
        if not (0.0 <= self.coverage_target <= 1.0):
            raise ValueError(f"coverage_target must be in [0.0, 1.0], got {self.coverage_target}")
        if self.max_iterations < 1:
            raise ValueError(f"max_iterations must be >= 1, got {self.max_iterations}")
        if self.simulation_timeout < 1:
            raise ValueError(f"simulation_timeout must be >= 1, got {self.simulation_timeout}")

        # Validate Phase B config if enabled
        if (self.generate_test_plan or self.generate_testbench) and not self.llm_provider:
            raise ValueError(
                "llm_provider config required when generate_test_plan or "
                "generate_testbench is enabled"
            )


@dataclass
class PipelineResult:
    """
    Final result of a pipeline execution.

    Attributes:
        pipeline_id: Unique identifier for this pipeline run
        steps: List of step results in execution order
        final_coverage: Coverage report (None if no coverage step run)
        test_plan: Test plan from Phase B (None if Phase A or plan generation skipped)
        iterations_used: Number of iterations completed
        total_duration_seconds: Total execution time
        success: Whether entire pipeline succeeded (all steps passed)
        timestamp: Pipeline start time (UTC)
    """

    pipeline_id: str
    steps: list[StepResult]
    final_coverage: Optional[CoverageReport]
    test_plan: Optional["TestPlan"] = None
    iterations_used: int = 0
    total_duration_seconds: float = 0.0
    success: bool = False
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    def get_step(self, step_name: str) -> Optional[StepResult]:
        """
        Retrieve a specific step result by name.

        Args:
            step_name: Name of step to find

        Returns:
            StepResult if found, None otherwise
        """
        return next((s for s in self.steps if s.step_name == step_name), None)

    def all_passed(self) -> bool:
        """Check if all steps passed."""
        return all(s.status == StepStatus.PASSED for s in self.steps)
