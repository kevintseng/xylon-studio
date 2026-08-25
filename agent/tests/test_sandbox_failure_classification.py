"""Failure classification tests at the sandbox execution boundary."""

from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from agent.sandbox.executor import ExecutionResult, SandboxExecutor
from agent.sandbox.manager import SandboxManager


def _completed_process(returncode: int, stdout: str = "", stderr: str = ""):
    result = MagicMock()
    result.returncode = returncode
    result.stdout = stdout.encode()
    result.stderr = stderr.encode()
    return result


def test_executor_classifies_unavailable_container_as_infrastructure():
    executor = SandboxExecutor("xylon-verilator")

    with patch(
        "agent.sandbox.executor.subprocess.run",
        return_value=_completed_process(
            1,
            stderr="Error response from daemon: container is not running",
        ),
    ):
        result = executor.execute(["verilator", "--version"])

    assert result.success is False
    assert result.failure_kind == "infrastructure"


def test_executor_does_not_call_rtl_error_an_infrastructure_failure():
    executor = SandboxExecutor("xylon-verilator")

    with patch(
        "agent.sandbox.executor.subprocess.run",
        return_value=_completed_process(1, stderr="%Error: syntax error"),
    ):
        result = executor.execute(["verilator", "--lint-only", "design.v"])

    assert result.success is False
    assert result.failure_kind is None


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
