"""Failure classification tests at the sandbox execution boundary."""

import io
import subprocess
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest

from agent.sandbox.executor import ExecutionError, ExecutionResult, SandboxExecutor
from agent.sandbox.manager import SandboxManager, main


def _completed_process(returncode: int, stdout: str = "", stderr: str = ""):
    result = MagicMock()
    result.returncode = returncode
    result.stdout = stdout.encode()
    result.stderr = stderr.encode()
    return result


class _FakePopen:
    def __init__(self, returncode=0, stdout=b"", stderr=b"", *, times_out=False):
        self.returncode = None
        self._final_returncode = returncode
        self.stdout = io.BytesIO(stdout)
        self.stderr = io.BytesIO(stderr)
        self.times_out = times_out
        self.terminated = False
        self.killed = False

    def wait(self, timeout=None):
        if self.times_out and not self.terminated and not self.killed:
            raise subprocess.TimeoutExpired("docker exec", timeout)
        self.returncode = self._final_returncode
        return self.returncode

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


def test_executor_classifies_unavailable_container_as_infrastructure():
    executor = SandboxExecutor("xylon-verilator")

    process = _FakePopen(
        1,
        stderr=b"Error response from daemon: container is not running",
    )
    with (
        patch("agent.sandbox.executor.subprocess.Popen", return_value=process),
        patch(
            "agent.sandbox.executor.subprocess.run",
            return_value=_completed_process(0),
        ),
    ):
        result = executor.execute(["verilator", "--version"])

    assert result.success is False
    assert result.failure_kind == "infrastructure"


def test_executor_does_not_call_rtl_error_an_infrastructure_failure():
    executor = SandboxExecutor("xylon-verilator")

    process = _FakePopen(1, stderr=b"%Error: syntax error")
    with (
        patch("agent.sandbox.executor.subprocess.Popen", return_value=process),
        patch(
            "agent.sandbox.executor.subprocess.run",
            return_value=_completed_process(0),
        ),
    ):
        result = executor.execute(["verilator", "--lint-only", "design.v"])

    assert result.success is False
    assert result.failure_kind is None


def test_executor_bounds_stdout_and_stderr_while_draining():
    executor = SandboxExecutor("xylon-verilator")
    process = _FakePopen(0, stdout=b"x" * 256, stderr=b"y" * 256)

    with (
        patch.object(SandboxExecutor, "MAX_OUTPUT_SIZE", 64),
        patch("agent.sandbox.executor.subprocess.Popen", return_value=process),
        patch(
            "agent.sandbox.executor.subprocess.run",
            return_value=_completed_process(0),
        ),
    ):
        result = executor.execute(["tool"])

    assert len(result.stdout.encode()) <= 64
    assert len(result.stderr.encode()) <= 64
    assert result.stdout.endswith("[OUTPUT TRUNCATED]\n")
    assert result.stderr.endswith("[OUTPUT TRUNCATED]\n")


def test_executor_wraps_each_command_in_a_recorded_process_group():
    executor = SandboxExecutor("xylon-verilator")
    process = _FakePopen()

    with (
        patch(
            "agent.sandbox.executor.subprocess.Popen",
            return_value=process,
        ) as popen,
        patch(
            "agent.sandbox.executor.subprocess.run",
            return_value=_completed_process(0),
        ),
    ):
        executor.execute(["verilator", "--version"])

    docker_command = popen.call_args.args[0]
    wrapper = docker_command[docker_command.index("-c") + 1]
    assert "os.setsid()" in wrapper
    assert "running:%s" in wrapper
    assert "kill -KILL" in wrapper


def test_executor_timeout_requires_verified_container_cleanup():
    executor = SandboxExecutor("xylon-verilator")
    process = _FakePopen(times_out=True)

    with (
        patch("agent.sandbox.executor.subprocess.Popen", return_value=process),
        patch.object(
            executor,
            "_terminate_container_execution",
            return_value=(True, "process group 42 terminated"),
        ) as cleanup,
    ):
        with pytest.raises(ExecutionError) as caught:
            executor.execute(["tool"], timeout=0.01)

    assert process.terminated is True
    assert "cleanup verified: process group 42 terminated" in str(caught.value)
    cleanup.assert_called_once()


def test_executor_timeout_fails_closed_when_cleanup_cannot_be_proven():
    executor = SandboxExecutor("xylon-verilator")
    process = _FakePopen(times_out=True)

    with (
        patch("agent.sandbox.executor.subprocess.Popen", return_value=process),
        patch.object(
            executor,
            "_terminate_container_execution",
            return_value=(False, "execution state was not established"),
        ),
        patch.object(
            executor,
            "_stop_container_and_verify",
            return_value=(False, "Docker daemon unavailable"),
        ),
    ):
        with pytest.raises(ExecutionError) as caught:
            executor.execute(["tool"], timeout=0.01)

    assert caught.value.failure_kind == "infrastructure"
    assert "cleanup NOT verified" in str(caught.value)
    assert "container stop unverified" in str(caught.value)


def test_executor_timeout_stops_container_when_exact_cleanup_is_unverified():
    executor = SandboxExecutor("xylon-verilator")
    process = _FakePopen(times_out=True)

    with (
        patch("agent.sandbox.executor.subprocess.Popen", return_value=process),
        patch.object(
            executor,
            "_terminate_container_execution",
            return_value=(False, "execution state was not established"),
        ),
        patch.object(
            executor,
            "_stop_container_and_verify",
            return_value=(True, "container xylon-verilator stop verified"),
        ) as stop_container,
    ):
        with pytest.raises(ExecutionError) as caught:
            executor.execute(["tool"], timeout=0.01)

    assert "cleanup verified" in str(caught.value)
    assert "container xylon-verilator stop verified" in str(caught.value)
    stop_container.assert_called_once()


def test_execution_result_timestamp_is_explicit_utc():
    result = ExecutionResult(True, "", "", 0, 0.1)

    parsed = datetime.fromisoformat(result.timestamp)
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == UTC.utcoffset(parsed)


def test_container_source_write_adds_one_posix_trailing_newline():
    manager = object.__new__(SandboxManager)

    with patch("agent.sandbox.manager.subprocess.run") as run:
        manager._write_to_container(
            "xylon-verilator",
            "/results/job/design.v",
            "module m; endmodule",
        )
        manager._write_to_container(
            "xylon-verilator",
            "/results/job/testbench.cpp",
            "int main() {}\n",
        )

    assert run.call_args_list[0].kwargs["input"] == b"module m; endmodule\n"
    assert run.call_args_list[1].kwargs["input"] == b"int main() {}\n"


def test_lint_manager_propagates_executor_failure_kind():
    manager = object.__new__(SandboxManager)
    manager.lint_timeout = 30
    manager.verilator = MagicMock()
    manager.verilator.execute.return_value = ExecutionResult(
        success=False,
        stdout="",
        stderr="container is not running",
        exit_code=1,
        duration_seconds=0.1,
        failure_kind="infrastructure",
    )

    result = manager.lint_verilog("/tmp/design.v")

    assert result["success"] is False
    assert result["failure_kind"] == "infrastructure"
    assert result["errors"] == ["container is not running"]


def test_simulation_stops_before_running_binary_on_infrastructure_failure():
    manager = object.__new__(SandboxManager)
    manager.verilator = MagicMock()
    manager.verilator.execute.return_value = ExecutionResult(
        success=False,
        stdout="",
        stderr="container is not running",
        exit_code=1,
        duration_seconds=0.1,
        failure_kind="infrastructure",
    )

    result = manager.run_verilator_sim("/tmp/design.v", "/tmp/tb.cpp")

    assert result["success"] is False
    assert result["failure_kind"] == "infrastructure"
    assert manager.verilator.execute.call_count == 1


def test_simulation_duration_includes_build_run_and_coverage_collection():
    manager = object.__new__(SandboxManager)
    manager.verilator = MagicMock()
    manager.verilator.execute.side_effect = [
        ExecutionResult(True, "", "", 0, 5.0),
        ExecutionResult(True, "PASS", "", 0, 2.0),
        ExecutionResult(True, "Coverage Summary", "", 0, 1.0),
        ExecutionResult(True, "annotated", "", 0, 0.5),
    ]

    result = manager.run_verilator_sim(
        "/results/job/adder.v",
        "/results/job/testbench.cpp",
        coverage=True,
        workdir="/results/job",
    )

    assert result["success"] is True
    assert result["duration_seconds"] == 8.5


def test_simulation_does_not_claim_a_host_vcd_path():
    manager = object.__new__(SandboxManager)
    manager.verilator = MagicMock()
    manager.verilator.execute.side_effect = [
        ExecutionResult(True, "", "", 0, 1.0),
        ExecutionResult(True, "PASS", "", 0, 1.0),
    ]

    with patch("agent.sandbox.manager.os.path.exists") as host_exists:
        result = manager.run_verilator_sim(
            "/results/job/adder.v",
            "/results/job/testbench.cpp",
            workdir="/results/job",
        )

    assert result["success"] is True
    assert result["vcd_file"] is None
    host_exists.assert_not_called()


def test_standalone_manager_entrypoint_is_explicitly_unsupported():
    with patch("agent.sandbox.manager.SandboxManager") as manager:
        assert main() == 2
    manager.assert_not_called()


def test_simulation_subprocesses_share_one_wall_clock_deadline():
    manager = object.__new__(SandboxManager)
    manager.verilator = MagicMock()
    manager.verilator.execute.side_effect = [
        ExecutionResult(True, "", "", 0, 5.0),
        ExecutionResult(True, "PASS", "", 0, 2.0),
        ExecutionResult(True, "Coverage Summary", "", 0, 1.0),
        ExecutionResult(True, "annotated", "", 0, 0.5),
    ]

    with patch(
        "agent.sandbox.manager.time.monotonic",
        side_effect=[0.0, 10.0, 40.0, 70.0, 90.0],
    ):
        result = manager.run_verilator_sim(
            "/results/job/adder.v",
            "/results/job/testbench.cpp",
            timeout=100,
            coverage=True,
            workdir="/results/job",
        )

    assert result["success"] is True
    assert [call.kwargs["timeout"] for call in manager.verilator.execute.call_args_list] == [
        90.0,
        60.0,
        30.0,
        10.0,
    ]


def test_synthesis_manager_propagates_infrastructure_failure():
    manager = object.__new__(SandboxManager)
    manager.synthesis_timeout = 30
    manager.yosys = MagicMock()
    manager.yosys.execute.return_value = ExecutionResult(
        success=False,
        stdout="",
        stderr="no such container: xylon-yosys",
        exit_code=1,
        duration_seconds=0.1,
        failure_kind="infrastructure",
    )

    result = manager.synthesize_verilog("/tmp/design.v")

    assert result["success"] is False
    assert result["failure_kind"] == "infrastructure"
