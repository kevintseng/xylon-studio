"""Failure classification tests at the sandbox execution boundary."""

import io
import subprocess
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest

from agent.sandbox.executor import ExecutionError, ExecutionResult, SandboxExecutor
from agent.sandbox.manager import SandboxManager, main
from agent.sandbox.runtime import runtime_container_name


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
    assert "cleanup verified" in str(caught.value)
    assert "host cleanup verified" in str(caught.value)
    assert "container cleanup verified (process group 42 terminated)" in str(
        caught.value
    )
    cleanup.assert_called_once()


def test_executor_cancellation_interrupts_active_container_execution():
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
            executor.execute(
                ["tool"],
                timeout=60,
                cancel_requested=lambda: True,
            )

    assert caught.value.failure_kind == "cancellation"
    assert process.terminated is True
    assert "Execution cancelled" in str(caught.value)
    assert "cleanup verified" in str(caught.value)
    cleanup.assert_called_once()


def test_executor_cancellation_fails_closed_when_cleanup_is_unverified():
    executor = SandboxExecutor("xylon-verilator")
    process = _FakePopen(times_out=True)

    with (
        patch("agent.sandbox.executor.subprocess.Popen", return_value=process),
        patch.object(
            executor,
            "_cleanup_after_interruption",
            return_value=(False, "container process still running"),
        ),
    ):
        with pytest.raises(ExecutionError) as caught:
            executor.execute(
                ["tool"],
                timeout=60,
                cancel_requested=lambda: True,
            )

    assert caught.value.failure_kind == "infrastructure"
    assert "cleanup NOT verified" in str(caught.value)


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


def test_stop_host_process_uses_kill_after_term_wait_timeout():
    process = MagicMock()
    process.returncode = None
    process.wait.side_effect = [
        subprocess.TimeoutExpired("docker exec", 2),
        137,
    ]

    verified, detail = SandboxExecutor._stop_host_process(process)

    assert verified is True
    assert "exited after KILL (137)" in detail
    process.terminate.assert_called_once_with()
    process.kill.assert_called_once_with()


def test_stop_host_process_uses_kill_after_term_wait_error():
    process = MagicMock()
    process.returncode = None
    process.wait.side_effect = [OSError("TERM wait unavailable"), 137]

    verified, detail = SandboxExecutor._stop_host_process(process)

    assert verified is True
    assert "exited after KILL (137)" in detail
    process.kill.assert_called_once_with()


def test_stop_host_process_returns_unverified_after_term_and_kill_wait_failures():
    process = MagicMock()
    process.returncode = None
    process.wait.side_effect = [
        subprocess.TimeoutExpired("docker exec", 2),
        OSError("cannot reap process"),
    ]

    verified, detail = SandboxExecutor._stop_host_process(process)

    assert verified is False
    assert "TERM wait timed out" in detail
    assert "KILL wait failed: cannot reap process" in detail


def test_stop_host_process_reports_signal_and_final_wait_failures_without_raising():
    process = MagicMock()
    process.returncode = None
    process.terminate.side_effect = OSError("TERM unavailable")
    process.kill.side_effect = OSError("KILL unavailable")
    process.wait.side_effect = [
        subprocess.TimeoutExpired("docker exec", 2),
        subprocess.TimeoutExpired("docker exec", 2),
    ]

    verified, detail = SandboxExecutor._stop_host_process(process)

    assert verified is False
    assert "TERM failed: TERM unavailable" in detail
    assert "TERM wait timed out" in detail
    assert "KILL failed: KILL unavailable" in detail
    assert "KILL wait timed out" in detail


def test_timeout_attempts_container_cleanup_when_host_cleanup_is_unverified():
    executor = SandboxExecutor("xylon-verilator")
    process = _FakePopen(times_out=True)

    with (
        patch("agent.sandbox.executor.subprocess.Popen", return_value=process),
        patch.object(
            executor,
            "_stop_host_process",
            return_value=(False, "KILL wait timed out"),
        ),
        patch.object(
            executor,
            "_cleanup_interrupted_execution",
            return_value=(True, "process group 42 terminated"),
        ) as container_cleanup,
    ):
        with pytest.raises(ExecutionError) as caught:
            executor.execute(["tool"], timeout=0.01)

    container_cleanup.assert_called_once()
    assert "cleanup NOT verified" in str(caught.value)
    assert "host cleanup unverified" in str(caught.value)
    assert "./scripts/eda-runtime down" in str(caught.value)
    assert "./scripts/eda-runtime up" in str(caught.value)
    assert "./scripts/eda-runtime verify" in str(caught.value)
    assert "Automatic continuation is blocked" in str(caught.value)


def test_cleanup_coordinator_continues_when_host_cleanup_raises_unexpectedly():
    executor = SandboxExecutor("xylon-verilator")
    process = MagicMock()
    process.returncode = None

    with (
        patch.object(
            executor,
            "_stop_host_process",
            side_effect=RuntimeError("unexpected host cleanup error"),
        ),
        patch.object(
            executor,
            "_cleanup_interrupted_execution",
            return_value=(True, "process group 42 terminated"),
        ) as container_cleanup,
    ):
        verified, detail = executor._cleanup_after_interruption(
            process, "/tmp/xylon-exec-test.state"
        )

    container_cleanup.assert_called_once()
    assert verified is False
    assert "host cleanup raised: unexpected host cleanup error" in detail
    assert "container cleanup verified" in detail
    assert "Automatic continuation is blocked" in detail


def test_cleanup_coordinator_reaps_container_process_before_stopping_host_client():
    executor = SandboxExecutor("xylon-verilator")
    process = MagicMock()
    process.returncode = None
    cleanup_order = []

    with (
        patch.object(
            executor,
            "_cleanup_interrupted_execution",
            side_effect=lambda _state: (
                cleanup_order.append("container") or True,
                "process group 42 terminated",
            ),
        ),
        patch.object(
            executor,
            "_stop_host_process",
            side_effect=lambda _process: (
                cleanup_order.append("host") or True,
                "host client exited",
            ),
        ),
    ):
        verified, _detail = executor._cleanup_after_interruption(
            process,
            "/tmp/xylon-exec-test.state",
        )

    assert verified is True
    assert cleanup_order == ["container", "host"]


def test_cleanup_coordinator_fails_closed_when_container_cleanup_raises():
    executor = SandboxExecutor("xylon-verilator")
    process = MagicMock()
    process.returncode = 0

    with patch.object(
        executor,
        "_cleanup_interrupted_execution",
        side_effect=RuntimeError("unexpected container cleanup error"),
    ):
        verified, detail = executor._cleanup_after_interruption(
            process, "/tmp/xylon-exec-test.state"
        )

    assert verified is False
    assert "host cleanup verified" in detail
    assert "container cleanup raised: unexpected container cleanup error" in detail
    assert "Automatic continuation is blocked" in detail


def test_generic_execution_error_attempts_host_and_container_cleanup_independently():
    executor = SandboxExecutor("xylon-verilator")
    process = MagicMock()
    process.returncode = None
    process.stdout = io.BytesIO(b"partial output")
    process.stderr = io.BytesIO(b"")
    process.wait.side_effect = [OSError("docker wait failed"), 143]

    with (
        patch("agent.sandbox.executor.subprocess.Popen", return_value=process),
        patch.object(
            executor,
            "_cleanup_interrupted_execution",
            return_value=(True, "process group 42 terminated"),
        ) as container_cleanup,
    ):
        with pytest.raises(ExecutionError) as caught:
            executor.execute(["tool"])

    process.terminate.assert_called_once_with()
    container_cleanup.assert_called_once()
    assert caught.value.failure_kind == "infrastructure"
    assert caught.value.stdout == "partial output"
    assert "cleanup verified" in str(caught.value)


def test_unexpected_execution_error_still_runs_cleanup_and_is_classified():
    executor = SandboxExecutor("xylon-verilator")
    process = MagicMock()
    process.returncode = None
    process.stdout = io.BytesIO(b"")
    process.stderr = io.BytesIO(b"")
    process.wait.side_effect = [RuntimeError("unexpected wait failure"), 143]

    with (
        patch("agent.sandbox.executor.subprocess.Popen", return_value=process),
        patch.object(
            executor,
            "_cleanup_interrupted_execution",
            return_value=(True, "process group 42 terminated"),
        ) as container_cleanup,
    ):
        with pytest.raises(ExecutionError) as caught:
            executor.execute(["tool"])

    container_cleanup.assert_called_once()
    assert caught.value.failure_kind == "infrastructure"
    assert "unexpected wait failure" in str(caught.value)
    assert "cleanup verified" in str(caught.value)


def test_popen_launch_error_does_not_attempt_container_cleanup_or_stop():
    executor = SandboxExecutor(runtime_container_name("verilator"))

    with (
        patch(
            "agent.sandbox.executor.subprocess.Popen",
            side_effect=OSError("docker executable unavailable"),
        ),
        patch.object(
            executor, "_cleanup_interrupted_execution"
        ) as process_cleanup,
        patch.object(executor, "_stop_container_and_verify") as container_stop,
    ):
        with pytest.raises(ExecutionError) as caught:
            executor.execute(["tool"])

    process_cleanup.assert_not_called()
    container_stop.assert_not_called()
    assert caught.value.failure_kind == "infrastructure"
    assert "docker executable unavailable" in str(caught.value)
    assert "cleanup not required" in str(caught.value)
    assert "before a container workload was established" in str(caught.value)
    assert "cleanup verified" not in str(caught.value)


def test_foreign_container_is_only_inspected_and_never_stopped_or_killed():
    executor = SandboxExecutor("foreign-project-verilator-1")

    with patch(
        "agent.sandbox.executor.subprocess.run",
        return_value=_completed_process(0, stdout="true\n"),
    ) as run:
        verified, detail = executor._stop_container_and_verify()

    assert verified is False
    assert "refused stop or kill for non-checkout-owned container" in detail
    commands = [call.args[0] for call in run.call_args_list]
    assert len(commands) == 1
    assert commands[0][:2] == ["docker", "inspect"]
    assert all(command[:2] != ["docker", "stop"] for command in commands)
    assert all(command[:2] != ["docker", "kill"] for command in commands)


def test_container_stop_exception_still_inspects_and_accepts_stopped_state():
    executor = SandboxExecutor(runtime_container_name("verilator"))

    with patch(
        "agent.sandbox.executor.subprocess.run",
        side_effect=[
            subprocess.TimeoutExpired("docker stop", 5),
            _completed_process(0, stdout="false\n"),
        ],
    ) as run:
        verified, detail = executor._stop_container_and_verify()

    assert verified is True
    assert "graceful stop failed" in detail
    assert "observed running=false" in detail
    assert run.call_args_list[1].args[0][:2] == ["docker", "inspect"]


def test_container_stop_exception_force_stops_checkout_owned_running_container():
    container_name = runtime_container_name("verilator")
    executor = SandboxExecutor(container_name)

    with patch(
        "agent.sandbox.executor.subprocess.run",
        side_effect=[
            OSError("stop transport failed"),
            _completed_process(0, stdout="true\n"),
            _completed_process(0, stdout=f"{container_name}\n"),
            _completed_process(0, stdout="false\n"),
        ],
    ) as run:
        verified, detail = executor._stop_container_and_verify()

    assert verified is True
    assert "force-stop verified" in detail
    assert run.call_args_list[2].args[0] == ["docker", "kill", container_name]
    assert run.call_args_list[3].args[0][:2] == ["docker", "inspect"]


def test_force_stop_exception_still_reinspects_and_accepts_stopped_state():
    container_name = runtime_container_name("verilator")
    executor = SandboxExecutor(container_name)

    with patch(
        "agent.sandbox.executor.subprocess.run",
        side_effect=[
            _completed_process(1, stderr="graceful stop failed"),
            _completed_process(0, stdout="true\n"),
            subprocess.TimeoutExpired("docker kill", 5),
            _completed_process(0, stdout="false\n"),
        ],
    ) as run:
        verified, detail = executor._stop_container_and_verify()

    assert verified is True
    assert "bounded force-stop failed" in detail
    assert "post-force-stop observed running=false" in detail
    assert run.call_args_list[3].args[0][:2] == ["docker", "inspect"]


def test_container_inspect_exception_is_unverified_with_actionable_recovery():
    executor = SandboxExecutor(runtime_container_name("verilator"))

    with patch(
        "agent.sandbox.executor.subprocess.run",
        side_effect=[
            _completed_process(0),
            OSError("inspect transport failed"),
        ],
    ):
        verified, detail = executor._stop_container_and_verify()

    assert verified is False
    assert "container inspect failed: inspect transport failed" in detail
    assert "./scripts/eda-runtime down" in detail
    assert "./scripts/eda-runtime up" in detail
    assert "./scripts/eda-runtime verify" in detail
    assert "Automatic continuation is blocked" in detail


def test_docker_exec_cleanup_exception_falls_back_to_verified_container_stop():
    container_name = runtime_container_name("verilator")
    executor = SandboxExecutor(container_name)

    with patch(
        "agent.sandbox.executor.subprocess.run",
        side_effect=[
            OSError("docker exec cleanup failed"),
            _completed_process(1, stderr="stop transport failed"),
            _completed_process(0, stdout="false\n"),
        ],
    ):
        verified, detail = executor._cleanup_interrupted_execution(
            "/tmp/xylon-exec-test.state"
        )

    assert verified is True
    assert "process cleanup unverified (docker exec cleanup failed)" in detail
    assert f"container {container_name} stop verified" in detail


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


def test_container_workspace_cleanup_rejects_nonzero_rm_result():
    manager = object.__new__(SandboxManager)
    manager.verilator_container = "xylon-verilator"
    manager.yosys_container = "xylon-yosys"

    with patch(
        "agent.sandbox.manager.subprocess.run",
        return_value=_completed_process(17, stderr="rm transport failed"),
    ) as run:
        with pytest.raises(ExecutionError) as caught:
            manager._cleanup_container_dir(
                "xylon-verilator",
                "/results/xylon-1234abcd",
            )

    assert caught.value.failure_kind == "infrastructure"
    assert caught.value.exit_code == 17
    assert "rm transport failed" in caught.value.message
    assert "./scripts/eda-runtime verify" in caught.value.message
    run.assert_called_once_with(
        [
            "docker",
            "exec",
            "xylon-verilator",
            "rm",
            "-rf",
            "/results/xylon-1234abcd",
        ],
        capture_output=True,
        timeout=10,
        check=False,
    )


def test_container_workspace_cleanup_classifies_docker_exec_oserror():
    manager = object.__new__(SandboxManager)
    manager.verilator_container = "xylon-verilator"
    manager.yosys_container = "xylon-yosys"

    with patch(
        "agent.sandbox.manager.subprocess.run",
        side_effect=OSError("docker transport unavailable"),
    ):
        with pytest.raises(ExecutionError) as caught:
            manager._cleanup_container_dir(
                "xylon-verilator",
                "/results/xylon-1234abcd",
            )

    assert caught.value.failure_kind == "infrastructure"
    assert "docker transport unavailable" in caught.value.message
    assert "./scripts/eda-runtime verify" in caught.value.message


def test_container_workspace_cleanup_refuses_foreign_path_without_running_rm():
    manager = object.__new__(SandboxManager)
    manager.verilator_container = "xylon-verilator"
    manager.yosys_container = "xylon-yosys"

    with patch("agent.sandbox.manager.subprocess.run") as run:
        with pytest.raises(ExecutionError, match="Refusing cleanup"):
            manager._cleanup_container_dir("xylon-verilator", "/results/customer")

    run.assert_not_called()


@pytest.mark.parametrize(
    "string_method,tool_method,args,primary_result",
    [
        (
            "lint_verilog_string",
            "lint_verilog",
            ("module m; endmodule",),
            {
                "success": False,
                "warnings": [],
                "errors": ["primary lint failure"],
                "stdout": "",
                "stderr": "primary lint failure",
                "duration_seconds": 0.1,
                "failure_kind": None,
            },
        ),
        (
            "synthesize_verilog_string",
            "synthesize_verilog",
            ("module m; endmodule",),
            {
                "success": False,
                "stdout": "",
                "stderr": "primary synthesis failure",
                "duration_seconds": 0.1,
                "failure_kind": None,
            },
        ),
        (
            "run_verilator_sim_string",
            "run_verilator_sim",
            ("module m; endmodule", "int main() { return 1; }"),
            {
                "success": False,
                "stdout": "",
                "stderr": "primary simulation failure",
                "vcd_file": None,
                "coverage_data": None,
                "duration_seconds": 0.1,
                "failure_kind": None,
            },
        ),
    ],
)
def test_string_job_preserves_primary_failure_when_cleanup_also_fails(
    string_method,
    tool_method,
    args,
    primary_result,
):
    manager = object.__new__(SandboxManager)
    manager.verilator_container = "xylon-verilator"
    manager.yosys_container = "xylon-yosys"
    manager._write_to_container = MagicMock()
    manager._cleanup_container_dir = MagicMock(
        side_effect=OSError("cleanup transport failed")
    )
    setattr(manager, tool_method, MagicMock(return_value=primary_result))

    result = getattr(manager, string_method)(*args)

    assert "primary" in result["stderr"]
    assert "cleanup transport failed" in result["stderr"]
    assert "./scripts/eda-runtime verify" in result["stderr"]
    assert result["failure_kind"] == "infrastructure"
    assert result["recovery_code"] == "repair_toolchain"
    assert result["success"] is False


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
