"""Smoke tests for the xylon CLI."""

import subprocess
import sys
from unittest.mock import AsyncMock, patch

import pytest

from agent import cli

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


def test_cli_run_help_shows_args():
    """`xylon run --help` shows all documented flags."""
    result = subprocess.run(
        [sys.executable, "-m", "agent.cli", "run", "--help"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    for flag in ["--testbench", "--coverage-target", "--max-iterations",
                 "--synthesis", "--llm", "--model", "--timeout"]:
        assert flag in result.stdout


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


# ── Config assembly tests (mocked pipeline) ──


@pytest.mark.asyncio
async def test_cli_config_assembly_phase_a(tmp_path):
    """Phase A (no LLM): config has synthesis_enabled from --synthesis flag."""
    rtl = tmp_path / "design.v"
    rtl.write_text("module m; endmodule\n")
    tb = tmp_path / "tb.cpp"
    tb.write_text("int main() { return 0; }\n")

    captured_config = {}

    async def fake_run_pipeline(**kwargs):
        captured_config["config"] = kwargs["config"]
        captured_config["rtl_code"] = kwargs["rtl_code"]
        captured_config["testbench_code"] = kwargs["testbench_code"]
        result = AsyncMock()
        result.success = True
        result.iterations_used = 1
        result.final_coverage = None
        return result

    args = type("Args", (), {
        "command": "run",
        "rtl_file": str(rtl),
        "testbench": str(tb),
        "coverage_target": 0.75,
        "max_iterations": 2,
        "synthesis": True,
        "llm": None,
        "llm_endpoint": "http://localhost:11434",
        "model": "qwen2.5-coder:32b",
        "timeout": 300,
    })()

    with patch("agent.cli.run_pipeline", side_effect=fake_run_pipeline):
        with pytest.raises(SystemExit) as exc:
            await cli.run_command(args)

    assert exc.value.code == 0
    cfg = captured_config["config"]
    assert cfg.synthesis_enabled is True
    assert cfg.coverage_target == 0.75
    assert cfg.max_iterations == 2
    assert cfg.generate_testbench is False  # no LLM
    assert cfg.generate_test_plan is False
    assert cfg.llm_provider is None
    assert captured_config["testbench_code"] == "int main() { return 0; }\n"


@pytest.mark.asyncio
async def test_cli_config_assembly_phase_b(tmp_path):
    """Phase B (--llm set): config has llm_provider and generate flags."""
    rtl = tmp_path / "design.v"
    rtl.write_text("module m; endmodule\n")

    captured = {}

    async def fake_run_pipeline(**kwargs):
        captured["config"] = kwargs["config"]
        result = AsyncMock()
        result.success = False
        result.iterations_used = 0
        result.final_coverage = None
        return result

    args = type("Args", (), {
        "command": "run",
        "rtl_file": str(rtl),
        "testbench": None,
        "coverage_target": 0.80,
        "max_iterations": 3,
        "synthesis": False,
        "llm": "ollama",
        "llm_endpoint": "http://localhost:11434",
        "model": "qwen2.5-coder:7b",
        "timeout": 120,
    })()

    # Mock create_llm_provider so we don't actually hit Ollama
    with patch("agent.core.llm_provider.create_llm_provider"), \
         patch("agent.cli.run_pipeline", side_effect=fake_run_pipeline):
        with pytest.raises(SystemExit) as exc:
            await cli.run_command(args)

    assert exc.value.code == 1  # result.success = False
    cfg = captured["config"]
    assert cfg.generate_testbench is True
    assert cfg.generate_test_plan is True
    assert cfg.llm_provider == {
        "type": "ollama",
        "endpoint": "http://localhost:11434",
        "model": "qwen2.5-coder:7b",
        "timeout": 120,
    }
