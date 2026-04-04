"""Tests for pipeline data models."""

import pytest

from agent.pipeline.models import (
    CoverageReport,
    PipelineConfig,
    PipelineResult,
    StepResult,
    StepStatus,
)


class TestStepResult:
    def test_defaults(self):
        result = StepResult(
            step_name="lint",
            status=StepStatus.PASSED,
            duration_seconds=1.5,
        )
        assert result.output == {}
        assert result.errors == []
        assert result.warnings == []

    def test_with_errors(self):
        result = StepResult(
            step_name="lint",
            status=StepStatus.FAILED,
            duration_seconds=0.3,
            errors=["%Error: syntax error"],
        )
        assert len(result.errors) == 1
        assert result.status == StepStatus.FAILED


class TestCoverageReport:
    def test_compute_score_defaults(self):
        score = CoverageReport.compute_score(1.0, 1.0, 1.0)
        assert score == pytest.approx(1.0)

    def test_compute_score_zero(self):
        score = CoverageReport.compute_score(0.0, 0.0, 0.0)
        assert score == pytest.approx(0.0)

    def test_compute_score_mixed(self):
        # line=0.8*0.4 + toggle=0.6*0.3 + branch=0.4*0.3
        # = 0.32 + 0.18 + 0.12 = 0.62
        score = CoverageReport.compute_score(0.8, 0.6, 0.4)
        assert score == pytest.approx(0.62)

    def test_compute_score_custom_weights(self):
        score = CoverageReport.compute_score(
            1.0, 0.0, 0.0,
            weights={"line": 1.0, "toggle": 0.0, "branch": 0.0}
        )
        assert score == pytest.approx(1.0)

    def test_report_fields(self):
        report = CoverageReport(
            line_coverage=0.85,
            toggle_coverage=0.72,
            branch_coverage=0.60,
            score=0.74,
            uncovered_lines=["design.v:10", "design.v:15"],
        )
        assert report.line_coverage == 0.85
        assert len(report.uncovered_lines) == 2


class TestPipelineConfig:
    def test_defaults(self):
        config = PipelineConfig()
        assert config.coverage_target == 0.8
        assert config.max_iterations == 5
        assert config.lint_enabled is True
        assert config.simulation_timeout == 300
        assert config.llm_provider is None


class TestPipelineResult:
    def test_get_step(self):
        lint = StepResult("lint", StepStatus.PASSED, 1.0)
        sim = StepResult("simulate", StepStatus.PASSED, 2.0)
        result = PipelineResult(
            pipeline_id="pipe-abc123",
            steps=[lint, sim],
            final_coverage=None,
            iterations_used=0,
            total_duration_seconds=3.0,
            success=True,
        )
        assert result.get_step("lint") is lint
        assert result.get_step("simulate") is sim
        assert result.get_step("nonexistent") is None

    def test_to_dict(self):
        lint = StepResult("lint", StepStatus.PASSED, 1.0, warnings=["minor"])
        result = PipelineResult(
            pipeline_id="pipe-abc123",
            steps=[lint],
            final_coverage=CoverageReport(0.8, 0.6, 0.5, 0.65),
            iterations_used=0,
            total_duration_seconds=1.0,
            success=True,
        )
        d = result.to_dict()
        assert d["pipeline_id"] == "pipe-abc123"
        assert d["success"] is True
        assert len(d["steps"]) == 1
        assert d["steps"][0]["status"] == "passed"
        assert d["final_coverage"]["line_coverage"] == 0.8

    def test_to_dict_no_coverage(self):
        result = PipelineResult(
            pipeline_id="pipe-abc123",
            steps=[],
            final_coverage=None,
            iterations_used=0,
            total_duration_seconds=0.0,
            success=False,
        )
        d = result.to_dict()
        assert d["final_coverage"] is None
