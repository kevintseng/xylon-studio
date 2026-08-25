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

import os
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum

# ==================== Enums ====================


class StepStatus(StrEnum):
    """Pipeline step execution status."""

    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"
    ERROR = "error"


class FailureKind(StrEnum):
    """Stable category for a non-success step."""

    CONFIGURATION = "configuration"
    INFRASTRUCTURE = "infrastructure"
    CANCELLATION = "cancellation"
    UNSUPPORTED = "unsupported"
    VERIFICATION = "verification"
    INCONCLUSIVE = "inconclusive"


class RunMode(StrEnum):
    """How a pipeline run obtained its verification testbench."""

    LINT_ONLY = "lint_only"
    PROVIDED_TESTBENCH = "provided_testbench"


class PipelineOutcome(StrEnum):
    """Truthful terminal outcome of a pipeline run."""

    VERIFIED = "verified"
    LINT_ONLY = "lint_only"
    TARGET_NOT_MET = "target_not_met"
    INCONCLUSIVE = "inconclusive"
    VERIFICATION_FAILED = "verification_failed"
    INFRASTRUCTURE_ERROR = "infrastructure_error"
    CONFIGURATION_ERROR = "configuration_error"
    CANCELLED = "cancelled"
    UNSUPPORTED = "unsupported"


# ==================== Data Classes ====================


@dataclass(frozen=True)
class ArtifactFile:
    """Integrity metadata for one portable file in a run bundle."""

    role: str
    path: str
    sha256: str
    size_bytes: int
    media_type: str

    def to_dict(self) -> dict:
        return {
            "role": self.role,
            "path": self.path,
            "sha256": self.sha256,
            "size_bytes": self.size_bytes,
            "media_type": self.media_type,
        }


@dataclass(frozen=True)
class ArtifactBundle:
    """Discoverable reference to a durable, integrity-checked run bundle."""

    run_directory: str
    manifest_path: str
    checksums_path: str
    files: list[ArtifactFile]
    rerun_argv: list[str]
    schema_version: int = 1

    def to_dict(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "run_directory": self.run_directory,
            "manifest_path": self.manifest_path,
            "checksums_path": self.checksums_path,
            "files": [item.to_dict() for item in self.files],
            "rerun_argv": list(self.rerun_argv),
        }


@dataclass
class StepResult:
    """
    Result of a single pipeline step execution.

    Attributes:
        step_name: Step identifier ("runtime", "lint", "simulate", "coverage", "synthesis", "artifacts")
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
    failure_kind: FailureKind | None = None
    recovery_code: str | None = None
    required: bool = True
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict:
        """Serialize the canonical live and persisted step contract."""
        return {
            "step_name": self.step_name,
            "status": self.status.value,
            "duration_seconds": self.duration_seconds,
            "output": self.output,
            "errors": self.errors,
            "warnings": self.warnings,
            "failure_kind": self.failure_kind.value if self.failure_kind else None,
            "recovery_code": self.recovery_code,
            "required": self.required,
            "timestamp": self.timestamp,
        }


@dataclass
class CoverageReport:
    """
    Coverage metrics from Verilator simulation.

    Attributes:
        line_coverage: Fraction of lines covered, or None when unavailable
        toggle_coverage: Fraction of toggles covered, or None when unavailable
        branch_coverage: Fraction of branches covered, or None when unavailable
        score: Aggregate/weighted coverage score, or None when unavailable
        metric_sources: Provenance for each available metric
        uncovered_lines: List of uncovered source lines
        raw_output: Full coverage report from Verilator
    """

    line_coverage: float | None
    toggle_coverage: float | None
    branch_coverage: float | None
    score: float | None
    uncovered_lines: list[str] = field(default_factory=list)
    raw_output: str = ""
    metric_sources: dict[str, str] = field(default_factory=dict)

    # Default weights used by compute_score() — can be overridden per-call.
    DEFAULT_WEIGHTS = {"line": 0.4, "toggle": 0.3, "branch": 0.3}

    def __post_init__(self):
        """Validate every available coverage value is in [0.0, 1.0]."""
        for attr in ["line_coverage", "toggle_coverage", "branch_coverage", "score"]:
            val = getattr(self, attr)
            if val is not None and not (0.0 <= val <= 1.0):
                raise ValueError(f"{attr} must be in [0.0, 1.0], got {val}")

    @classmethod
    def compute_score(
        cls,
        line_coverage: float,
        toggle_coverage: float,
        branch_coverage: float,
        weights: dict | None = None,
    ) -> float:
        """
        Compute weighted coverage score.

        Args:
            line_coverage: Line coverage fraction (0.0-1.0)
            toggle_coverage: Toggle coverage fraction (0.0-1.0)
            branch_coverage: Branch coverage fraction (0.0-1.0)
            weights: Optional weight dict with keys 'line', 'toggle', 'branch'.
                     Defaults to {line: 0.4, toggle: 0.3, branch: 0.3}.

        Returns:
            Weighted average score in [0.0, 1.0]
        """
        w = weights or cls.DEFAULT_WEIGHTS
        return (
            line_coverage * w.get("line", 0.0)
            + toggle_coverage * w.get("toggle", 0.0)
            + branch_coverage * w.get("branch", 0.0)
        )


@dataclass
class PipelineConfig:
    """
    Pipeline execution configuration.

    Attributes:
        coverage_target: Desired coverage score (0.0-1.0), default 0.8
        lint_enabled: Whether to run lint step
        simulation_timeout: Timeout for simulation in seconds
        synthesis_enabled: Whether to run the optional Yosys report
    """

    coverage_target: float = 0.8
    lint_enabled: bool = True
    simulation_timeout: int = 300
    synthesis_enabled: bool = False
    runtime_check_enabled: bool = field(
        default_factory=lambda: os.environ.get(
            "XYLON_SKIP_RUNTIME_CHECK",
            "0",
        ) != "1"
    )
    artifact_root: str = field(
        default_factory=lambda: os.environ.get(
            "XYLON_ARTIFACT_ROOT",
            ".xylon/runs",
        )
    )

    def __post_init__(self):
        """Validate configuration values."""
        if not (0.0 <= self.coverage_target <= 1.0):
            raise ValueError(f"coverage_target must be in [0.0, 1.0], got {self.coverage_target}")
        if self.simulation_timeout < 1:
            raise ValueError(f"simulation_timeout must be >= 1, got {self.simulation_timeout}")


@dataclass
class PipelineResult:
    """
    Final result of a pipeline execution.

    Attributes:
        pipeline_id: Unique identifier for this pipeline run
        steps: List of step results in execution order
        final_coverage: Coverage report (None if no coverage step run)
        iterations_used: Number of iterations completed
        total_duration_seconds: Total execution time
        success: Whether entire pipeline succeeded (all steps passed)
        timestamp: Pipeline start time (UTC)
    """

    pipeline_id: str
    steps: list[StepResult]
    final_coverage: CoverageReport | None
    iterations_used: int = 0
    total_duration_seconds: float = 0.0
    success: bool = False
    mode: RunMode = RunMode.LINT_ONLY
    outcome: PipelineOutcome = PipelineOutcome.LINT_ONLY
    artifacts: ArtifactBundle | None = None
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def get_step(self, step_name: str) -> StepResult | None:
        """
        Retrieve a specific step result by name.

        Args:
            step_name: Name of step to find

        Returns:
            StepResult if found, None otherwise
        """
        return next((s for s in self.steps if s.step_name == step_name), None)

    def all_passed(self) -> bool:
        """Check whether every required gate ran and passed."""
        required_steps = [step for step in self.steps if step.required]
        return bool(required_steps) and all(
            step.status == StepStatus.PASSED for step in required_steps
        )

    def to_dict(self) -> dict:
        """
        Serialize to a JSON-safe dict.

        Useful for API responses and persistence. Enums are converted to
        their string values; nested dataclasses are unwrapped.
        """
        coverage_dict = None
        if self.final_coverage is not None:
            coverage_dict = {
                "line_coverage": self.final_coverage.line_coverage,
                "toggle_coverage": self.final_coverage.toggle_coverage,
                "branch_coverage": self.final_coverage.branch_coverage,
                "score": self.final_coverage.score,
                "uncovered_lines": list(self.final_coverage.uncovered_lines),
                "metric_sources": dict(self.final_coverage.metric_sources),
            }

        return {
            "pipeline_id": self.pipeline_id,
            "steps": [step.to_dict() for step in self.steps],
            "final_coverage": coverage_dict,
            "iterations_used": self.iterations_used,
            "total_duration_seconds": self.total_duration_seconds,
            "success": self.success,
            "mode": self.mode.value,
            "outcome": self.outcome.value,
            "artifacts": self.artifacts.to_dict() if self.artifacts else None,
            "timestamp": self.timestamp,
        }
