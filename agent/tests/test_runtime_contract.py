"""Pinned local EDA runtime contract tests."""

import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from agent.pipeline.models import FailureKind, PipelineConfig, StepStatus
from agent.pipeline.runner import run_pipeline
from agent.sandbox.executor import ExecutionResult
from agent.sandbox.manager import SandboxManager
from agent.sandbox.runtime import load_runtime_spec

REPO_ROOT = Path(__file__).resolve().parents[2]


def _execution(stdout: str) -> ExecutionResult:
    return ExecutionResult(
        success=True,
        stdout=stdout,
        stderr="",
        exit_code=0,
        duration_seconds=0.01,
    )


def test_runtime_spec_pins_release_tags_commits_and_base_digest():
    spec = load_runtime_spec()

    assert spec.image == "xylon-eda:verilator-5.050-yosys-0.65"
    assert spec.verilator_version == "5.050"
    assert spec.verilator_commit == "848d926ebd4addacacd294dc84e35d9d4ae8078c"
    assert spec.yosys_version == "0.65"
    assert spec.yosys_commit == "b85cad634782fafac275e5f540c056bfacb2b5d2"
    assert spec.base_image == (
        "debian:bookworm-slim@"
        "sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241"
    )


def test_dockerfile_base_default_matches_the_runtime_spec():
    spec = load_runtime_spec()
    dockerfile = (REPO_ROOT / "runtime" / "Dockerfile").read_text()

    assert f"ARG BASE_IMAGE={spec.base_image}" in dockerfile


def test_compose_caps_local_eda_resources_and_does_not_auto_restart():
    compose = (REPO_ROOT / "compose.eda.yaml").read_text()

    assert "mem_limit: 4g" in compose
    assert "cpus: 2" in compose
    assert "pids_limit: 512" in compose
    assert 'restart: "no"' in compose


def test_public_launchers_use_repo_python_instead_of_path_python():
    for relative_path in (
        "scripts/xylon",
        "scripts/eda-runtime",
        "scripts/xylon-openroad",
    ):
        source = (REPO_ROOT / relative_path).read_text(encoding="utf-8")
        assert 'python_bin="${repo_root}/agent/venv/bin/python"' in source
        assert "python3 -m agent." not in source


def test_runtime_up_reuses_an_existing_image_instead_of_forcing_a_rebuild(tmp_path: Path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_docker = fake_bin / "docker"
    fake_docker.write_text(
        "#!/bin/sh\n"
        "case \" $* \" in\n"
        "  *\" --build \"*) echo 'forced rebuild' >&2; exit 23 ;;\n"
        "  *) exit 0 ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)
    environment = os.environ.copy()
    environment["PATH"] = f"{fake_bin}:{environment['PATH']}"

    result = subprocess.run(
        [str(REPO_ROOT / "scripts" / "eda-runtime"), "up"],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_importing_sandbox_package_does_not_preload_runtime_module():
    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; import agent.sandbox; "
                "print('agent.sandbox.runtime' in sys.modules)"
            ),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert probe.returncode == 0
    assert probe.stdout.strip() == "False"


def test_runtime_identity_requires_expected_image_and_tool_versions():
    manager = SandboxManager()
    manager.verilator = MagicMock()
    manager.yosys = MagicMock()
    manager.verilator.execute.return_value = _execution(
        "Verilator 5.050 2026-07-01 rev v5.050\n"
    )
    manager.yosys.execute.return_value = _execution(
        "Yosys 0.65 (git sha1 b85cad634)\n"
    )
    inspect = SimpleNamespace(
        returncode=0,
        stdout=(
            b"xylon-eda:verilator-5.050-yosys-0.65|"
            b"sha256:0123456789abcdef\n"
        ),
        stderr=b"",
    )

    with patch("agent.sandbox.manager.subprocess.run", return_value=inspect):
        identity = manager.get_tool_identity()

    assert identity["verified"] is True
    assert identity["errors"] == []
    assert identity["expected"]["verilator"]["version"] == "5.050"
    assert identity["observed"]["verilator"]["image_id"] == (
        "sha256:0123456789abcdef"
    )
    assert identity["observed"]["yosys"]["version_output"].startswith(
        "Yosys 0.65"
    )


def test_runtime_identity_rejects_tool_version_drift():
    manager = SandboxManager()
    manager.verilator = MagicMock()
    manager.yosys = MagicMock()
    manager.verilator.execute.return_value = _execution("Verilator 5.048\n")
    manager.yosys.execute.return_value = _execution("Yosys 0.65\n")
    inspect = SimpleNamespace(
        returncode=0,
        stdout=(
            b"xylon-eda:verilator-5.050-yosys-0.65|"
            b"sha256:0123456789abcdef\n"
        ),
        stderr=b"",
    )

    with patch("agent.sandbox.manager.subprocess.run", return_value=inspect):
        identity = manager.get_tool_identity()

    assert identity["verified"] is False
    assert any("Verilator" in error and "5.050" in error for error in identity["errors"])


@pytest.mark.asyncio
async def test_runner_fails_closed_before_lint_when_runtime_is_not_pinned(tmp_path):
    sandbox = MagicMock()
    sandbox.get_tool_identity.return_value = {
        "verified": False,
        "errors": ["Verilator expected 5.050, observed 5.048"],
        "expected": {},
        "observed": {},
    }

    with patch("agent.pipeline.runner.SandboxManager", return_value=sandbox):
        result = await run_pipeline(
            "module m; endmodule\n",
            config=PipelineConfig(
                runtime_check_enabled=True,
                artifact_root=str(tmp_path),
            ),
        )

    assert [step.step_name for step in result.steps] == ["runtime", "artifacts"]
    runtime = result.get_step("runtime")
    assert runtime.status == StepStatus.ERROR
    assert runtime.failure_kind == FailureKind.INFRASTRUCTURE
    assert runtime.recovery_code == "start_pinned_runtime"
    assert result.outcome.value == "infrastructure_error"
    assert result.success is False
    sandbox.lint_verilog_string.assert_not_called()

    manifest = tmp_path / result.pipeline_id / "manifest.json"
    assert "Verilator expected 5.050" in manifest.read_text()
