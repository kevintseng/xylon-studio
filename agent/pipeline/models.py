"""
Pipeline Data Models.

Defines the core data structures for the verification pipeline:
- StepResult: output from a single pipeline step
- CoverageReport: parsed Verilator coverage data
- PipelineConfig: pipeline execution parameters
- PipelineResult: complete pipeline execution result
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, List, Dict, Any


class PipelineMode(str, Enum):
    """Pipeline execution mode."""
    EDUCATION = "education"
    PROFESSIONAL = "professional"


class StepStatus(str, Enum):
    """Status of a pipeline step execution."""
    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"
    ERROR = "error"


@dataclass
class StepResult:
    """
    Result from a single pipeline step.

    Attributes:
        step_name: Identifier for the step (e.g., "lint", "simulate", "coverage")
        status: Execution status
        duration_seconds: Wall-clock time for the step
        output: Step-specific structured output
        errors: Error messages from the step
        warnings: Warning messages from the step
    """
    step_name: str
    status: StepStatus
    duration_seconds: float
    output: Dict[str, Any] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


@dataclass
class CoverageReport:
    """
    Parsed Verilator coverage report.

    Verilator --coverage produces a .dat file with line, toggle,
    and branch coverage metrics. This dataclass holds the parsed results.

    Attributes:
        line_coverage: Line coverage ratio (0.0 - 1.0)
        toggle_coverage: Signal toggle coverage ratio (0.0 - 1.0)
        branch_coverage: Branch coverage ratio (0.0 - 1.0)
        score: Weighted average of all coverage types
        uncovered_lines: List of uncovered line references (file:line format)
        raw_output: Raw coverage tool output for debugging
    """
    line_coverage: float
    toggle_coverage: float
    branch_coverage: float
    score: float
    uncovered_lines: List[str] = field(default_factory=list)
    raw_output: str = ""

    @staticmethod
    def compute_score(
        line: float, toggle: float, branch: float,
        weights: Optional[Dict[str, float]] = None
    ) -> float:
        """
        Compute weighted coverage score.

        Default weights: line=0.4, toggle=0.3, branch=0.3
        """
        if weights is None:
            weights = {"line": 0.4, "toggle": 0.3, "branch": 0.3}
        return (
            line * weights["line"]
            + toggle * weights["toggle"]
            + branch * weights["branch"]
        )


@dataclass
class PipelineConfig:
    """
    Configuration for pipeline execution.

    Attributes:
        coverage_target: Target coverage score to consider verification complete (0.0 - 1.0)
        max_iterations: Maximum coverage improvement iterations (Phase B)
        lint_enabled: Whether to run the lint step
        simulation_timeout: Timeout for simulation in seconds
        llm_provider: LLM provider name for test generation (Phase B, None = no LLM)
    """
    coverage_target: float = 0.8
    max_iterations: int = 5
    lint_enabled: bool = True
    synthesis_enabled: bool = False
    simulation_timeout: int = 300
    llm_provider: Optional[str] = None
    mode: PipelineMode = PipelineMode.PROFESSIONAL


@dataclass
class TestScenario:
    """A single test scenario within a test plan."""
    name: str
    description: str
    category: str  # "functional", "edge_case", "reset", "protocol", "boundary"
    priority: str  # "critical", "high", "medium", "low"
    coverage_targets: List[str] = field(default_factory=list)


@dataclass
class TestPlan:
    """
    AI-generated verification test plan.

    Produced by the test_plan_generation step (Phase B).
    Describes what to test without writing code — highest AI error tolerance.

    Attributes:
        module_name: Name of the RTL module under test
        port_analysis: Structured analysis of module ports
        scenarios: Ordered list of test scenarios
        coverage_goals: Recommended coverage targets
        raw_llm_output: Original LLM response for debugging
    """
    module_name: str
    port_analysis: Dict[str, Any]
    scenarios: List[TestScenario]
    coverage_goals: Dict[str, float]
    raw_llm_output: str = ""

    @property
    def scenario_count(self) -> int:
        return len(self.scenarios)

    def critical_scenarios(self) -> List[TestScenario]:
        return [s for s in self.scenarios if s.priority == "critical"]


@dataclass
class PipelineResult:
    """
    Complete result from a pipeline execution.

    Attributes:
        pipeline_id: Unique pipeline run identifier
        steps: Ordered list of step results
        final_coverage: Coverage report from the last coverage step (if run)
        iterations_used: Number of coverage improvement iterations completed
        total_duration_seconds: Total wall-clock time for the entire pipeline
        success: Whether the pipeline completed successfully
    """
    pipeline_id: str
    steps: List[StepResult]
    final_coverage: Optional[CoverageReport]
    iterations_used: int
    total_duration_seconds: float
    success: bool

    def get_step(self, step_name: str) -> Optional[StepResult]:
        """Get a step result by name."""
        for step in self.steps:
            if step.step_name == step_name:
                return step
        return None

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to dictionary for API responses."""
        result = {
            "pipeline_id": self.pipeline_id,
            "steps": [
                {
                    "step_name": s.step_name,
                    "status": s.status.value,
                    "duration_seconds": s.duration_seconds,
                    "output": s.output,
                    "errors": s.errors,
                    "warnings": s.warnings,
                }
                for s in self.steps
            ],
            "final_coverage": None,
            "iterations_used": self.iterations_used,
            "total_duration_seconds": self.total_duration_seconds,
            "success": self.success,
        }
        if self.final_coverage:
            result["final_coverage"] = {
                "line_coverage": self.final_coverage.line_coverage,
                "toggle_coverage": self.final_coverage.toggle_coverage,
                "branch_coverage": self.final_coverage.branch_coverage,
                "score": self.final_coverage.score,
                "uncovered_lines": self.final_coverage.uncovered_lines,
            }
        return result
