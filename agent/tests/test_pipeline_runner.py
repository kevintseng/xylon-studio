"""Tests for pipeline runner."""

import asyncio
import json
from unittest.mock import patch

import pytest

from agent.pipeline.models import FailureKind, PipelineConfig, StepStatus
from agent.pipeline.runner import run_pipeline

SIMPLE_RTL = """\
module adder_8bit (
    input  [7:0] a,
    input  [7:0] b,
    output [8:0] sum
);
    assign sum = a + b;
endmodule
"""

SIMPLE_TB = """\
#include "Vadder_8bit.h"
#include "verilated.h"
#include <iostream>

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    Vadder_8bit* top = new Vadder_8bit;

    top->a = 10;
    top->b = 20;
    top->evaluate();

    if (top->sum == 30) {
        std::cout << "PASS" << std::endl;
    } else {
        std::cout << "FAIL" << std::endl;
    }

    delete top;
    return 0;
}
"""


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "rtl_code,testbench_code",
    [
        ("m" * (1024 * 1024 + 1), None),
        ("module m; endmodule", "x" * (1024 * 1024 + 1)),
    ],
    ids=["rtl", "testbench"],
)
async def test_pipeline_rejects_oversized_inputs_before_temp_or_artifact_writes(
    rtl_code,
    testbench_code,
):
    with (
        patch("agent.pipeline.runner.tempfile.mkdtemp") as make_temp,
        patch("agent.pipeline.runner.persist_pipeline_artifacts") as persist,
    ):
        with pytest.raises(ValueError, match="exceeds the 1048576-byte limit"):
            await run_pipeline(rtl_code, testbench_code=testbench_code)

    make_temp.assert_not_called()
    persist.assert_not_called()


@pytest.fixture
def mock_sandbox_manager():
    """Mock SandboxManager for pipeline tests."""
    with patch("agent.pipeline.runner.SandboxManager") as MockCls:
        sandbox = MockCls.return_value
        sandbox.verilator_container = "xylon-verilator"
        yield sandbox


@pytest.fixture
def mock_container_ops():
    """Mock Docker container operations.

    Runner writes RTL/testbench to tempdir via open(), so we only need
    the SandboxManager itself mocked (done by mock_sandbox_manager).
    """
    yield


@pytest.mark.asyncio
async def test_pipeline_lint_only(mock_sandbox_manager, mock_container_ops):
    """A clean lint-only run must not claim verification success."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.5,
    }

    result = await run_pipeline(SIMPLE_RTL)

    assert result.mode.value == "lint_only"
    assert result.outcome.value == "lint_only"
    assert result.success is False
    assert [step.step_name for step in result.steps] == ["lint", "artifacts"]
    assert result.get_step("lint").status == StepStatus.PASSED
    assert result.get_step("simulate") is None


@pytest.mark.asyncio
async def test_pipeline_without_testbench_or_lint_fails_closed(
    tmp_path,
    mock_sandbox_manager,
    mock_container_ops,
):
    """No evidence gate must never be described as lint-only evidence."""
    result = await run_pipeline(
        SIMPLE_RTL,
        config=PipelineConfig(
            lint_enabled=False,
            runtime_check_enabled=False,
            artifact_root=str(tmp_path),
        ),
    )

    assert result.mode.value == "lint_only"
    assert result.outcome.value == "configuration_error"
    assert result.success is False
    assert [step.step_name for step in result.steps] == [
        "configuration",
        "artifacts",
    ]
    configuration = result.get_step("configuration")
    assert configuration.status == StepStatus.ERROR
    assert configuration.failure_kind == FailureKind.CONFIGURATION
    assert configuration.recovery_code == "enable_lint_or_provide_testbench"
    mock_sandbox_manager.lint_verilog_string.assert_not_called()
    mock_sandbox_manager.run_verilator_sim_string.assert_not_called()


@pytest.mark.asyncio
async def test_pipeline_classifies_missing_toolchain_as_infrastructure_error(
    mock_sandbox_manager,
    mock_container_ops,
):
    """A broken execution environment must not be blamed on the RTL."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": False,
        "warnings": [],
        "errors": ["container xylon-verilator is not running"],
        "stdout": "",
        "stderr": "container xylon-verilator is not running",
        "duration_seconds": 0.0,
        "failure_kind": "infrastructure",
    }

    result = await run_pipeline(SIMPLE_RTL)

    lint = result.get_step("lint")
    assert lint.failure_kind == FailureKind.INFRASTRUCTURE
    assert lint.recovery_code == "repair_toolchain"
    assert result.outcome.value == "infrastructure_error"
    assert result.success is False


@pytest.mark.asyncio
async def test_pipeline_classifies_invalid_rtl_as_configuration_error(
    mock_sandbox_manager,
    mock_container_ops,
):
    """Tool-reported RTL syntax errors are actionable input configuration failures."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": False,
        "warnings": [],
        "errors": ["%Error: syntax error"],
        "stdout": "",
        "stderr": "%Error: syntax error",
        "duration_seconds": 0.1,
    }

    result = await run_pipeline("module broken(")

    lint = result.get_step("lint")
    assert lint.failure_kind == FailureKind.CONFIGURATION
    assert lint.recovery_code == "correct_rtl"
    assert result.outcome.value == "configuration_error"
    assert result.success is False


@pytest.mark.asyncio
async def test_pipeline_cancellation_before_start_runs_no_tools(
    mock_sandbox_manager,
    mock_container_ops,
):
    cancellation_event = asyncio.Event()
    cancellation_event.set()

    result = await run_pipeline(
        SIMPLE_RTL,
        cancellation_event=cancellation_event,
    )

    assert result.outcome.value == "cancelled"
    assert result.success is False
    cancelled_step = result.get_step("cancelled")
    assert cancelled_step.failure_kind == FailureKind.CANCELLATION
    assert cancelled_step.recovery_code == "rerun_when_ready"
    mock_sandbox_manager.lint_verilog_string.assert_not_called()


@pytest.mark.asyncio
async def test_pipeline_cancellation_between_steps_stops_next_tool(
    mock_sandbox_manager,
    mock_container_ops,
):
    cancellation_event = asyncio.Event()
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.1,
    }

    async def cancel_after_lint(step):
        if step.step_name == "lint":
            cancellation_event.set()

    result = await run_pipeline(
        SIMPLE_RTL,
        testbench_code=SIMPLE_TB,
        cancellation_event=cancellation_event,
        on_step_complete=cancel_after_lint,
    )

    assert result.outcome.value == "cancelled"
    assert result.get_step("simulate") is None
    mock_sandbox_manager.run_verilator_sim_string.assert_not_called()


@pytest.mark.asyncio
async def test_pipeline_cancellation_after_simulation_skips_coverage(
    mock_sandbox_manager,
    mock_container_ops,
):
    cancellation_event = asyncio.Event()
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.1,
    }
    mock_sandbox_manager.run_verilator_sim_string.return_value = {
        "success": True,
        "stdout": "PASS\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": None,
        "duration_seconds": 0.2,
    }

    async def cancel_after_simulation(step):
        if step.step_name == "simulate":
            cancellation_event.set()

    result = await run_pipeline(
        SIMPLE_RTL,
        testbench_code=SIMPLE_TB,
        cancellation_event=cancellation_event,
        on_step_complete=cancel_after_simulation,
    )

    assert result.outcome.value == "cancelled"
    assert result.get_step("simulate") is not None
    assert result.get_step("coverage") is None
    assert mock_sandbox_manager.run_verilator_sim_string.call_count == 1


@pytest.mark.asyncio
async def test_every_terminal_run_persists_canonical_rerunnable_artifacts(
    tmp_path,
    mock_sandbox_manager,
    mock_container_ops,
):
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.1,
    }

    result = await run_pipeline(
        SIMPLE_RTL,
        config=PipelineConfig(artifact_root=str(tmp_path)),
    )

    artifact_step = result.get_step("artifacts")
    assert artifact_step.status == StepStatus.PASSED
    assert artifact_step.required is True
    assert result.artifacts is not None
    manifest_path = (
        tmp_path / result.pipeline_id / result.artifacts.manifest_path
    )
    manifest = json.loads(manifest_path.read_text())
    assert manifest["result"] == result.to_dict()
    assert (tmp_path / result.pipeline_id / "inputs" / "design.v").read_text() == SIMPLE_RTL


@pytest.mark.asyncio
async def test_artifact_persistence_failure_is_a_required_infrastructure_failure(
    tmp_path,
    mock_sandbox_manager,
    mock_container_ops,
):
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.1,
    }

    with patch(
        "agent.pipeline.runner.persist_pipeline_artifacts",
        side_effect=OSError("disk is read-only"),
    ):
        result = await run_pipeline(
            SIMPLE_RTL,
            config=PipelineConfig(artifact_root=str(tmp_path)),
        )

    artifact_step = result.get_step("artifacts")
    assert artifact_step.status == StepStatus.ERROR
    assert artifact_step.failure_kind == FailureKind.INFRASTRUCTURE
    assert artifact_step.recovery_code == "repair_artifact_storage"
    assert result.artifacts is None
    assert result.outcome.value == "infrastructure_error"
    assert result.success is False


@pytest.mark.asyncio
async def test_pipeline_preserves_explicit_unsupported_tool_result(
    mock_sandbox_manager,
    mock_container_ops,
):
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": False,
        "warnings": [],
        "errors": ["%Error-UNSUPPORTED: unsupported construct"],
        "stdout": "",
        "stderr": "%Error-UNSUPPORTED: unsupported construct",
        "duration_seconds": 0.1,
    }

    result = await run_pipeline(SIMPLE_RTL)

    lint = result.get_step("lint")
    assert lint.failure_kind == FailureKind.UNSUPPORTED
    assert lint.recovery_code == "use_supported_hdl"
    assert result.outcome.value == "unsupported"


@pytest.mark.asyncio
async def test_pipeline_lint_failure_stops(mock_sandbox_manager, mock_container_ops):
    """Pipeline should stop early if lint fails with errors."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": False,
        "warnings": [],
        "errors": ["%Error: syntax error"],
        "stdout": "",
        "stderr": "%Error: syntax error",
        "duration_seconds": 0.2,
    }

    result = await run_pipeline(SIMPLE_RTL)

    assert result.success is False
    assert [step.step_name for step in result.steps] == ["lint", "artifacts"]
    assert result.get_step("lint").status == StepStatus.FAILED


@pytest.mark.asyncio
async def test_pipeline_full_run(mock_sandbox_manager, mock_container_ops):
    """Pipeline with testbench should run lint, simulate, and coverage."""
    # Lint passes
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.3,
    }

    # One coverage-enabled simulation supplies both behavioral and coverage evidence.
    mock_sandbox_manager.run_verilator_sim_string.return_value = {
        "success": True,
        "stdout": "PASS\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": {
            "success": True,
            "raw_report": "Coverage Summary:\n  toggle : 90.0% (90/100)",
            "summary": "",
        },
        "duration_seconds": 1.0,
    }

    result = await run_pipeline(SIMPLE_RTL, testbench_code=SIMPLE_TB)

    assert result.success is True
    assert [step.step_name for step in result.steps] == [
        "lint", "simulate", "coverage", "artifacts",
    ]
    assert result.get_step("lint").status == StepStatus.PASSED
    assert result.get_step("simulate").status == StepStatus.PASSED
    assert result.get_step("coverage").status == StepStatus.PASSED
    assert result.final_coverage is not None
    assert result.final_coverage.line_coverage is None
    assert result.final_coverage.toggle_coverage == pytest.approx(0.90)
    assert result.final_coverage.score == pytest.approx(0.90)
    assert result.final_coverage.metric_sources == {
        "toggle_coverage": "verilator_summary",
        "score": "computed_verilator_point_counts",
    }
    assert mock_sandbox_manager.run_verilator_sim_string.call_count == 1


@pytest.mark.asyncio
async def test_pipeline_below_coverage_target_is_not_verified(
    mock_sandbox_manager,
    mock_container_ops,
):
    """Executing coverage successfully must not bypass the requested target."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.1,
    }
    mock_sandbox_manager.run_verilator_sim_string.return_value = {
        "success": True,
        "stdout": "PASS\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": {
            "success": True,
            "raw_report": "Coverage Summary:\n  toggle : 10.0% (10/100)",
            "summary": "",
        },
        "duration_seconds": 0.1,
    }

    result = await run_pipeline(
        SIMPLE_RTL,
        testbench_code=SIMPLE_TB,
        config=PipelineConfig(coverage_target=0.80),
    )

    assert result.final_coverage.score == pytest.approx(0.10)
    assert result.outcome.value == "target_not_met"
    assert result.success is False
    assert mock_sandbox_manager.run_verilator_sim_string.call_count == 1


@pytest.mark.asyncio
async def test_pipeline_without_required_coverage_evidence_is_inconclusive(
    mock_sandbox_manager,
    mock_container_ops,
):
    """A passing simulation cannot verify when required coverage is unavailable."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.1,
    }
    mock_sandbox_manager.run_verilator_sim_string.side_effect = [
        {
            "success": True,
            "stdout": "PASS\n",
            "stderr": "",
            "vcd_file": None,
            "coverage_data": None,
            "duration_seconds": 0.1,
        },
        {
            "success": True,
            "stdout": "PASS\n",
            "stderr": "",
            "vcd_file": None,
            "coverage_data": {
                "success": False,
                "raw_report": "",
                "summary": "coverage.dat was not produced",
            },
            "duration_seconds": 0.1,
        },
    ]

    result = await run_pipeline(
        SIMPLE_RTL,
        testbench_code=SIMPLE_TB,
        config=PipelineConfig(coverage_target=0.80),
    )

    assert result.final_coverage.score is None
    assert result.outcome.value == "inconclusive"
    assert result.success is False


@pytest.mark.asyncio
async def test_pipeline_sim_failure_skips_coverage(mock_sandbox_manager, mock_container_ops):
    """If simulation fails, coverage should not run."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True,
        "warnings": [],
        "errors": [],
        "stdout": "",
        "stderr": "",
        "duration_seconds": 0.3,
    }

    mock_sandbox_manager.run_verilator_sim_string.return_value = {
        "success": False,
        "stdout": "",
        "stderr": "Build error",
        "vcd_file": None,
        "coverage_data": None,
        "duration_seconds": 0.5,
    }

    result = await run_pipeline(SIMPLE_RTL, testbench_code=SIMPLE_TB)

    assert result.success is False
    # lint + failed simulate + preserved evidence, no coverage step
    assert [step.step_name for step in result.steps] == [
        "lint", "simulate", "artifacts",
    ]
    assert result.final_coverage is None


@pytest.mark.asyncio
async def test_pipeline_lint_disabled(mock_sandbox_manager, mock_container_ops):
    """Pipeline with lint_enabled=False should skip lint."""
    mock_sandbox_manager.run_verilator_sim_string.return_value = {
        "success": True,
        "stdout": "PASS\n",
        "stderr": "",
        "vcd_file": None,
        "coverage_data": {
            "success": True,
            "raw_report": "Coverage Summary:\n  toggle : 95.0% (95/100)",
            "summary": "",
        },
        "duration_seconds": 1.0,
    }

    config = PipelineConfig(lint_enabled=False)
    result = await run_pipeline(SIMPLE_RTL, testbench_code=SIMPLE_TB, config=config)

    assert result.success is True
    assert result.get_step("lint") is None  # lint was not run
    assert mock_sandbox_manager.run_verilator_sim_string.call_count == 1


@pytest.mark.asyncio
async def test_pipeline_result_to_dict(mock_sandbox_manager, mock_container_ops):
    """Pipeline result should serialize to dict correctly."""
    mock_sandbox_manager.lint_verilog_string.return_value = {
        "success": True, "warnings": [], "errors": [],
        "stdout": "", "stderr": "", "duration_seconds": 0.1,
    }

    result = await run_pipeline(SIMPLE_RTL)
    d = result.to_dict()

    assert "pipeline_id" in d
    # pipeline_id is a UUID4 string (36 chars with hyphens)
    assert len(d["pipeline_id"]) == 36
    assert isinstance(d["steps"], list)
    assert isinstance(d["total_duration_seconds"], float)
