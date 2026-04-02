"""
XylonStudio Verification Pipeline.

Sequential pipeline for chip design verification:
lint -> test_plan -> testbench_gen -> simulate -> coverage -> iterate.

Phase A: No LLM. Testbench provided externally.
Phase B: LLM-driven test plan, testbench generation, coverage-driven iteration.
"""

from agent.pipeline.models import (
    PipelineConfig,
    PipelineMode,
    PipelineResult,
    StepResult,
    StepStatus,
    CoverageReport,
    TestPlan,
    TestScenario,
)
from agent.pipeline.runner import run_pipeline

__all__ = [
    "run_pipeline",
    "PipelineConfig",
    "PipelineMode",
    "PipelineResult",
    "StepResult",
    "StepStatus",
    "CoverageReport",
    "TestPlan",
    "TestScenario",
]
