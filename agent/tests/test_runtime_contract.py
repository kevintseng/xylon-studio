"""Pinned local EDA runtime contract tests."""

import os
import shutil
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


def test_openroad_launcher_propagates_every_doctor_and_resource_blocker():
    source = (REPO_ROOT / "scripts" / "xylon-openroad").read_text(
        encoding="utf-8"
    )

    assert "resource_preflight || return 1" in source
    assert "doctor >/dev/null || return 1" in source
    assert "doctor >/dev/null || exit $?" in source


def test_openroad_ci_prepares_repo_python_before_calling_public_launcher():
    workflow = (REPO_ROOT / ".github" / "workflows" / "verification-gate.yml").read_text(
        encoding="utf-8"
    )
    job = workflow.split("  openroad-foundation:", 1)[1].split("\n  frontend:", 1)[0]

    checkout_revision = job.index("Check out exact revision")
    setup_python = job.index("actions/setup-python@")
    verify_source_identity = job.index(
        'test "$(git rev-parse HEAD)" = "${XYLON_SOURCE_REVISION}"'
    )
    create_environment = job.index("python -m venv agent/venv")
    install_runtime = job.index("scripts/xylon-openroad install")

    assert checkout_revision < verify_source_identity < setup_python
    assert setup_python < create_environment < install_runtime
    assert 'XYLON_OPENROAD_CPUS: "1"' in job
    assert 'XYLON_SOURCE_REVISION: ${{ github.sha }}' in job
    assert 'test "$(git rev-parse HEAD)" = "${XYLON_SOURCE_REVISION}"' in job
    assert "github.event.pull_request.head.sha" not in job


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


def test_openroad_smoke_stops_after_the_first_failed_doctor_probe(tmp_path: Path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    call_log = tmp_path / "calls.log"
    fake_node = fake_bin / "node"
    fake_node.write_text(
        "#!/bin/sh\n"
        f"printf 'node %s\\n' \"$*\" >> {call_log}\n"
        "if [ \"$1\" = \"--version\" ]; then echo v26.0.0; exit 0; fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    fake_docker = fake_bin / "docker"
    fake_docker.write_text(
        "#!/bin/sh\n"
        f"printf 'docker %s\\n' \"$*\" >> {call_log}\n"
        "if [ \"$1\" = \"info\" ]; then exit 23; fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    fake_npm = fake_bin / "npm"
    fake_npm.write_text(
        "#!/bin/sh\n"
        f"printf 'npm %s\\n' \"$*\" >> {call_log}\n"
        "exit 0\n",
        encoding="utf-8",
    )
    for executable in (fake_node, fake_docker, fake_npm):
        executable.chmod(0o755)

    environment = os.environ.copy()
    environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
    result = subprocess.run(
        [str(REPO_ROOT / "scripts" / "xylon-openroad"), "smoke"],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    calls = call_log.read_text(encoding="utf-8")
    assert result.returncode != 0
    assert "BLOCKED: Docker is unavailable" in result.stderr
    assert "Connection closed" not in result.stderr
    assert "docker info" in calls
    assert "docker image inspect" not in calls
    assert "npm " not in calls
    assert "smoke-client.mjs" not in calls


def test_openroad_install_does_not_require_macos_spawn_helper_on_linux(tmp_path: Path):
    fake_repo = tmp_path / "repo"
    scripts_dir = fake_repo / "scripts"
    package_dir = fake_repo / "agent" / "openroad"
    python_dir = fake_repo / "agent" / "venv" / "bin"
    fake_bin = tmp_path / "bin"
    preflight_log = tmp_path / "preflight.log"
    for directory in (scripts_dir, package_dir, python_dir, fake_bin):
        directory.mkdir(parents=True, exist_ok=True)

    launcher = scripts_dir / "xylon-openroad"
    shutil.copy2(REPO_ROOT / "scripts" / "xylon-openroad", launcher)
    fake_python = python_dir / "python"
    fake_python.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$*\" >> \"{preflight_log}\"\n"
        "exit 0\n",
        encoding="utf-8",
    )
    fake_python.chmod(0o755)

    fake_node = fake_bin / "node"
    fake_node.write_text(
        "#!/bin/sh\n"
        "if [ \"$1\" = \"--version\" ]; then echo v22.0.0; exit 0; fi\n"
        "if [ \"$1\" = \"-p\" ]; then echo linux; exit 0; fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    for command in ("npm", "docker"):
        executable = fake_bin / command
        executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        executable.chmod(0o755)
    fake_node.chmod(0o755)

    environment = os.environ.copy()
    environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
    environment["XYLON_OPENROAD_CPUS"] = "2"
    result = subprocess.run(
        [str(launcher), "install"],
        cwd=fake_repo,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "READY: official OpenROAD-MCP" in result.stdout
    assert "spawn-helper" not in result.stderr
    assert "--cpus 2" in preflight_log.read_text(encoding="utf-8")


def test_openroad_wrapper_uses_the_same_bounded_cpu_budget(tmp_path: Path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    docker_log = tmp_path / "docker.log"
    fake_docker = fake_bin / "docker"
    fake_docker.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$*\" >> \"{docker_log}\"\n"
        "exit 0\n",
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)

    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}:{environment['PATH']}",
            "XYLON_OPENROAD_CPUS": "2",
            "XYLON_OPENROAD_SESSION_ID": "budget-test",
            "XYLON_OPENROAD_SERVER_ID": "server-budget-test",
            "XYLON_OPENROAD_REPO_ID": "repo-budget-test",
            "XYLON_OPENROAD_CID_DIR": str(tmp_path / "cids"),
            "XYLON_OPENROAD_STATE_DIR": str(tmp_path / "state"),
        }
    )
    wrapper = REPO_ROOT / "runtime" / "openroad" / "bin" / "openroad"
    result = subprocess.run(
        [str(wrapper), "--version"],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "--cpus 2" in docker_log.read_text(encoding="utf-8")

    environment["XYLON_OPENROAD_CPUS"] = "8"
    blocked = subprocess.run(
        [str(wrapper), "--version"],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert blocked.returncode == 2
    assert "Invalid OpenROAD CPU budget" in blocked.stderr


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
