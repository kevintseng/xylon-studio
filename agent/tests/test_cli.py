"""Smoke tests for the xylon CLI."""

import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from agent import cli
from agent.pipeline.artifacts import RerunRequest
from agent.pipeline.models import (
    ArtifactBundle,
    CoverageReport,
    PipelineConfig,
    PipelineOutcome,
    PipelineResult,
    RunMode,
    StepResult,
    StepStatus,
)

# ── Argparse tests (no mocking needed) ──


def test_cli_help_exits_zero():
    """`xylon --help` prints usage and exits 0."""
    result = subprocess.run(
        [sys.executable, "-m", "agent.cli", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "XylonStudio" in result.stdout
    assert "run" in result.stdout
    assert "rerun" in result.stdout


def test_cli_run_help_shows_args():
    """`xylon run --help` exposes only the supported verification contract."""
    result = subprocess.run(
        [sys.executable, "-m", "agent.cli", "run", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    for flag in ["--testbench", "--coverage-target", "--synthesis", "--timeout"]:
        assert flag in result.stdout
    for removed_flag in ["--max-iterations", "--llm", "--llm-endpoint", "--model"]:
        assert removed_flag not in result.stdout


def test_cli_no_command_exits_nonzero():
    """Running the CLI with no subcommand exits with nonzero status."""
    result = subprocess.run(
        [sys.executable, "-m", "agent.cli"],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0


def test_cli_missing_rtl_file_exits_1(tmp_path):
    """Missing RTL file reports error and exits 1."""
    result = subprocess.run(
        [sys.executable, "-m", "agent.cli", "run", str(tmp_path / "nonexistent.v")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "not found" in result.stdout.lower()


def test_cli_missing_testbench_file_exits_1(tmp_path):
    """Missing testbench file reports error and exits 1."""
    rtl = tmp_path / "design.v"
    rtl.write_text("module m; endmodule\n")

    result = subprocess.run(
        [sys.executable, "-m", "agent.cli", "run", str(rtl),
         "--testbench", str(tmp_path / "missing_tb.cpp")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "not found" in result.stdout.lower()


@pytest.mark.parametrize("flag,suffix", [(None, ".v"), ("--testbench", ".cpp")])
def test_cli_rejects_oversized_source_before_running_pipeline(tmp_path, flag, suffix):
    rtl = tmp_path / "design.v"
    rtl.write_text("module m; endmodule\n")
    oversized = tmp_path / f"oversized{suffix}"
    oversized.write_bytes(b"x" * (1024 * 1024 + 1))
    command = [sys.executable, "-m", "agent.cli", "run"]
    if flag is None:
        command.append(str(oversized))
    else:
        command.extend([str(rtl), flag, str(oversized)])

    result = subprocess.run(command, capture_output=True, text=True)

    assert result.returncode == 1
    assert "exceeds the 1048576-byte limit" in result.stdout


# ── Config assembly tests (mocked pipeline) ──


@pytest.mark.asyncio
async def test_cli_config_assembly_provided_testbench(tmp_path):
    """Provided-testbench mode carries the requested synthesis setting."""
    rtl = tmp_path / "design.v"
    rtl.write_text("module m; endmodule\n")
    tb = tmp_path / "tb.cpp"
    tb.write_text("int main() { return 0; }\n")

    captured_config = {}

    async def fake_run_pipeline(**kwargs):
        captured_config["config"] = kwargs["config"]
        captured_config["rtl_code"] = kwargs["rtl_code"]
        captured_config["testbench_code"] = kwargs["testbench_code"]
        return PipelineResult(
            pipeline_id="run-provided",
            steps=[],
            final_coverage=None,
            success=True,
            mode=RunMode.PROVIDED_TESTBENCH,
            outcome=PipelineOutcome.VERIFIED,
        )

    args = type("Args", (), {
        "command": "run",
        "rtl_file": str(rtl),
        "testbench": str(tb),
        "coverage_target": 0.75,
        "synthesis": True,
        "timeout": 45,
    })()

    with patch("agent.cli.run_pipeline", side_effect=fake_run_pipeline):
        with pytest.raises(SystemExit) as exc:
            await cli.run_command(args)

    assert exc.value.code == 0
    cfg = captured_config["config"]
    assert cfg.synthesis_enabled is True
    assert cfg.coverage_target == 0.75
    assert cfg.simulation_timeout == 45
    assert cfg.resource_check_enabled is True
    assert captured_config["testbench_code"] == "int main() { return 0; }\n"

@pytest.mark.asyncio
async def test_cli_renders_unavailable_coverage_without_coercing_to_zero(
    tmp_path,
    capsys,
):
    """Aggregate coverage must not become fabricated type-specific percentages."""
    rtl = tmp_path / "design.v"
    rtl.write_text("module m; endmodule\n")

    async def fake_run_pipeline(**kwargs):
        return PipelineResult(
            pipeline_id="run-inconclusive",
            steps=[
                StepResult(
                    "coverage",
                    StepStatus.FAILED,
                    0.1,
                    failure_kind=None,
                    recovery_code="collect_coverage_evidence",
                )
            ],
            final_coverage=CoverageReport(
                line_coverage=None,
                toggle_coverage=None,
                branch_coverage=None,
                score=0.85,
                metric_sources={
                    "score": "computed_verilator_point_counts",
                },
            ),
            success=False,
            mode=RunMode.LINT_ONLY,
            outcome=PipelineOutcome.INCONCLUSIVE,
            artifacts=ArtifactBundle(
                run_directory="run-inconclusive",
                manifest_path="manifest.json",
                checksums_path="checksums.sha256",
                files=[],
                rerun_argv=[
                    "agent/venv/bin/python", "-m", "agent.cli", "rerun", "manifest.json"
                ],
            ),
        )

    args = type("Args", (), {
        "command": "run",
        "rtl_file": str(rtl),
        "testbench": None,
        "coverage_target": 0.80,
        "synthesis": False,
        "timeout": 120,
    })()

    with patch("agent.cli.run_pipeline", side_effect=fake_run_pipeline):
        with pytest.raises(SystemExit) as exc:
            await cli.run_command(args)

    assert exc.value.code == 1
    output = capsys.readouterr().out
    assert "line=Unavailable" in output
    assert "toggle=Unavailable" in output
    assert "branch=Unavailable" in output
    assert "score=85%" in output
    assert "outcome: inconclusive" in output
    assert "next action: collect_coverage_evidence" in output
    assert "run-inconclusive/manifest.json" in output
    assert "Phase A" not in output
    assert "FAILED" not in output


@pytest.mark.asyncio
async def test_cli_rerun_succeeds_when_terminal_outcome_is_reproduced(capsys):
    replay = RerunRequest(
        rtl_code="module broken; endmodule\n",
        testbench_code='int main() { puts("FAIL"); }\n',
        config=PipelineConfig(),
        expected_outcome=PipelineOutcome.VERIFICATION_FAILED,
        source_pipeline_id="source-run",
    )
    reproduced = PipelineResult(
        pipeline_id="replay-run",
        steps=[],
        final_coverage=None,
        success=False,
        mode=RunMode.PROVIDED_TESTBENCH,
        outcome=PipelineOutcome.VERIFICATION_FAILED,
    )

    with patch("agent.cli.load_rerun_manifest", return_value=replay), patch(
        "agent.cli.run_pipeline",
        new=AsyncMock(return_value=reproduced),
    ) as run_mock:
        with pytest.raises(SystemExit) as exc:
            await cli.rerun_command(SimpleNamespace(manifest="manifest.json"))

    assert exc.value.code == 0
    run_mock.assert_awaited_once_with(
        rtl_code=replay.rtl_code,
        testbench_code=replay.testbench_code,
        config=replay.config,
    )
    output = capsys.readouterr().out
    assert "REPRODUCED" in output
    assert "verification_failed" in output
    assert "source-run" in output


@pytest.mark.asyncio
async def test_cli_rerun_fails_when_terminal_outcome_drifts(capsys):
    replay = RerunRequest(
        rtl_code="module m; endmodule\n",
        testbench_code="PASS\n",
        config=PipelineConfig(),
        expected_outcome=PipelineOutcome.VERIFIED,
        source_pipeline_id="source-run",
    )
    drifted = PipelineResult(
        pipeline_id="replay-run",
        steps=[],
        final_coverage=None,
        success=False,
        mode=RunMode.PROVIDED_TESTBENCH,
        outcome=PipelineOutcome.INFRASTRUCTURE_ERROR,
    )

    with patch("agent.cli.load_rerun_manifest", return_value=replay), patch(
        "agent.cli.run_pipeline",
        new=AsyncMock(return_value=drifted),
    ):
        with pytest.raises(SystemExit) as exc:
            await cli.rerun_command(SimpleNamespace(manifest="manifest.json"))

    assert exc.value.code == 1
    output = capsys.readouterr().out
    assert "DRIFTED" in output
    assert "expected=verified" in output
    assert "actual=infrastructure_error" in output
