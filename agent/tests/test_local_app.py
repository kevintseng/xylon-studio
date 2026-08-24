"""Local application lifecycle contract tests."""

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import patch
from urllib.request import urlopen

import pytest

import agent.local_app as local_app

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_doctor_accepts_the_current_prebuilt_workspace_without_starting_services(capsys):
    api_port = _unused_port()
    web_port = _unused_port()
    while web_port == api_port:
        web_port = _unused_port()

    assert local_app.doctor(api_port=api_port, web_port=web_port) == 0
    output = capsys.readouterr().out
    assert "READY: local prerequisites are available" in output
    assert "RESOURCE READY:" in output or "RESOURCE BLOCKED:" in output
    assert f"STOPPED: API http://127.0.0.1:{api_port}" in output
    assert f"STOPPED: Web http://127.0.0.1:{web_port}" in output


def test_resource_preflight_allows_capacity_for_one_capped_local_run():
    snapshot_type = getattr(local_app, "ResourceSnapshot", None)
    evaluate = getattr(local_app, "evaluate_resource_preflight", None)
    assert snapshot_type is not None and callable(evaluate)

    snapshot = snapshot_type(
        logical_cpus=12,
        load_one_minute=8.0,
        memory_free_percent=61,
        disk_free_bytes=47 * 1024**3,
        memory_available_bytes=10 * 1024**3,
    )

    assert evaluate(snapshot) == []


def test_resource_preflight_blocks_saturated_cpu_low_memory_and_low_disk():
    snapshot_type = getattr(local_app, "ResourceSnapshot", None)
    evaluate = getattr(local_app, "evaluate_resource_preflight", None)
    assert snapshot_type is not None and callable(evaluate)

    snapshot = snapshot_type(
        logical_cpus=12,
        load_one_minute=12.0,
        memory_free_percent=19,
        disk_free_bytes=9 * 1024**3,
        memory_available_bytes=6 * 1024**3,
    )

    assert evaluate(snapshot) == [
        "CPU load 12.00 has reached 12 logical CPUs",
        "memory available 6.0 GiB is below the 8.0 GiB safety floor",
        "memory free 19% is below the 20% safety floor",
        "workspace disk free 9.0 GiB is below the 10.0 GiB safety floor",
    ]


def test_resource_preflight_classifies_blockers_for_ui_surfaces():
    snapshot = local_app.ResourceSnapshot(
        logical_cpus=8,
        load_one_minute=8.2,
        memory_free_percent=12,
        disk_free_bytes=6 * 1024**3,
        memory_available_bytes=10 * 1024**3,
    )

    assert local_app.identify_resource_blockers(snapshot) == [
        "cpu_saturated",
        "memory_low",
        "disk_low",
    ]


def test_local_readiness_reports_ready_only_when_runtime_and_resources_are_both_healthy():
    snapshot = local_app.ResourceSnapshot(
        logical_cpus=12,
        load_one_minute=4.0,
        memory_free_percent=61,
        disk_free_bytes=47 * 1024**3,
        memory_available_bytes=10 * 1024**3,
        memory_total_bytes=16 * 1024**3,
        disk_total_bytes=128 * 1024**3,
    )

    readiness = local_app.summarize_local_readiness(snapshot, runtime_healthy=True)

    assert readiness.status == "ready"
    assert readiness.runtime_healthy is True
    assert readiness.resource_blocker_codes == ()
    assert readiness.policy["max_heavy_jobs"] == 1
    assert readiness.snapshot.to_dict()["memory_free_bytes"] == 10 * 1024**3


def test_local_readiness_reports_runtime_unavailable_without_fabricating_resource_failures():
    snapshot = local_app.ResourceSnapshot(
        logical_cpus=12,
        load_one_minute=4.0,
        memory_free_percent=61,
        disk_free_bytes=47 * 1024**3,
        memory_available_bytes=10 * 1024**3,
        memory_total_bytes=16 * 1024**3,
        disk_total_bytes=128 * 1024**3,
    )

    readiness = local_app.summarize_local_readiness(snapshot, runtime_healthy=False)

    assert readiness.status == "runtime_unavailable"
    assert readiness.resource_blocker_codes == ()


def test_local_readiness_prioritizes_blocked_status_when_host_capacity_is_unsafe():
    snapshot = local_app.ResourceSnapshot(
        logical_cpus=12,
        load_one_minute=12.0,
        memory_free_percent=19,
        disk_free_bytes=47 * 1024**3,
        memory_available_bytes=10 * 1024**3,
    )

    readiness = local_app.summarize_local_readiness(snapshot, runtime_healthy=False)

    assert readiness.status == "blocked"
    assert readiness.resource_blocker_codes == ("cpu_saturated", "memory_low")
@pytest.mark.parametrize("error", [OSError("unreadable"), ValueError("invalid")])
def test_resource_integer_probe_returns_unknown_on_io_or_format_failure(
    tmp_path: Path,
    error: Exception,
):
    memory_value = tmp_path / "memory.current"
    memory_value.write_text("123", encoding="utf-8")

    with patch.object(Path, "read_text", side_effect=error):
        assert local_app._read_integer(memory_value) is None


def test_linux_memory_probe_returns_unknown_when_proc_meminfo_is_unreadable():
    with patch.object(Path, "read_text", side_effect=OSError("proc unavailable")):
        assert local_app._read_linux_memory() == (None, None)


def test_linux_memory_probe_tolerates_absent_cgroup_limit_without_hiding_host_data():
    def read_text(path: Path, **_kwargs) -> str:
        if path == Path("/proc/meminfo"):
            return "MemTotal: 16777216 kB\nMemAvailable: 10485760 kB\n"
        if path in {
            Path("/sys/fs/cgroup/memory.max"),
            Path("/sys/fs/cgroup/memory.current"),
        }:
            raise OSError("not cgroup v2")
        raise AssertionError(f"unexpected read: {path}")

    with patch.object(Path, "read_text", autospec=True, side_effect=read_text):
        assert local_app._read_linux_memory() == (
            16 * 1024**3,
            10 * 1024**3,
        )


def test_linux_memory_probe_fails_closed_on_invalid_cgroup_limit():
    def read_text(path: Path, **_kwargs) -> str:
        if path == Path("/proc/meminfo"):
            return "MemTotal: 16777216 kB\nMemAvailable: 10485760 kB\n"
        if path == Path("/sys/fs/cgroup/memory.max"):
            return "not-a-limit"
        if path == Path("/sys/fs/cgroup/memory.current"):
            return "1024"
        raise AssertionError(f"unexpected read: {path}")

    with patch.object(Path, "read_text", autospec=True, side_effect=read_text):
        assert local_app._read_linux_memory() == (None, None)


def test_macos_memory_probe_returns_unknown_when_system_command_fails():
    with (
        patch("agent.local_app.shutil.which", side_effect=lambda command: f"/usr/bin/{command}"),
        patch("agent.local_app.subprocess.run", side_effect=OSError("spawn failed")),
    ):
        assert local_app._read_macos_memory() == (None, None, None)


def test_macos_memory_probe_returns_unknown_for_invalid_total_memory():
    pressure = subprocess.CompletedProcess(
        ["memory_pressure", "-Q"],
        0,
        stdout="System-wide memory free percentage: 62%\n",
        stderr="",
    )
    total = subprocess.CompletedProcess(
        ["sysctl", "-n", "hw.memsize"],
        0,
        stdout="invalid\n",
        stderr="",
    )
    with (
        patch("agent.local_app.shutil.which", side_effect=lambda command: f"/usr/bin/{command}"),
        patch("agent.local_app.subprocess.run", side_effect=[pressure, total]),
    ):
        assert local_app._read_macos_memory() == (None, None, None)


def test_resource_snapshot_keeps_load_failures_visible_as_unknown(tmp_path: Path):
    with (
        patch("agent.local_app.os.getloadavg", side_effect=OSError("unavailable")),
        patch(
            "agent.local_app._read_linux_memory",
            return_value=(16 * 1024**3, 10 * 1024**3),
        ),
    ):
        snapshot = local_app.collect_resource_snapshot(tmp_path)

    assert snapshot.load_one_minute is None
    assert local_app.evaluate_resource_preflight(snapshot)[0].startswith(
        "CPU load could not be measured safely"
    )
    assert snapshot.memory_free_percent == 62
    assert snapshot.memory_available_bytes == 10 * 1024**3


def test_runtime_version_preflight_accepts_supported_python_and_node():
    evaluate = getattr(local_app, "evaluate_runtime_version_preflight", None)
    assert callable(evaluate)

    assert evaluate("Python 3.14.6", "v24.15.0") == []


def test_runtime_version_preflight_rejects_versions_below_supported_minimums():
    evaluate = getattr(local_app, "evaluate_runtime_version_preflight", None)
    assert callable(evaluate)

    assert evaluate("Python 3.10.16", "v20.8.1") == [
        "Python 3.10.16 is below the required 3.11.0",
        "Node.js 20.8.1 is below the required 20.9.0",
    ]


def test_runtime_version_preflight_fails_closed_on_unrecognized_output():
    evaluate = getattr(local_app, "evaluate_runtime_version_preflight", None)
    assert callable(evaluate)

    assert evaluate("unknown", "unavailable") == [
        "could not determine the Python version",
        "could not determine the Node.js version",
    ]


def test_runtime_project_identity_is_stable_and_checkout_specific(tmp_path: Path):
    first = local_app.runtime_project_name(tmp_path / "checkout-a")
    repeated = local_app.runtime_project_name(tmp_path / "checkout-a")
    second = local_app.runtime_project_name(tmp_path / "checkout-b")

    assert first == repeated
    assert first.startswith("xylon-")
    assert first != second


def test_default_api_command_bounds_websocket_frames(tmp_path: Path):
    app = local_app.LocalApplication(repo_root=tmp_path)

    assert "--ws-max-size" in app.api_command
    index = app.api_command.index("--ws-max-size")
    assert app.api_command[index + 1] == str(
        local_app.MAX_PIPELINE_WS_MESSAGE_BYTES
    )


def test_eda_runtime_health_replays_the_pinned_identity_check(tmp_path: Path):
    runtime = local_app.EdaRuntime(tmp_path)

    with patch(
        "agent.local_app.subprocess.run",
        return_value=subprocess.CompletedProcess([], 0),
    ) as run:
        assert runtime.is_running() is True

    run.assert_called_once_with(
        [str(tmp_path / "scripts" / "eda-runtime"), "verify"],
        cwd=tmp_path,
        check=False,
        timeout=30,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _long_running_child(marker: str) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)", marker],
        start_new_session=True,
        text=True,
    )


def _force_cleanup(child: subprocess.Popen[str]) -> None:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=2)


def test_stop_terminates_the_owned_process_group():
    process_type = getattr(local_app, "ManagedProcess", None)
    terminate = getattr(local_app, "terminate_managed_process", None)
    assert process_type is not None and callable(terminate)

    child = _long_running_child("xylon-test-owned")
    try:
        record = process_type(
            name="test",
            pid=child.pid,
            command_marker="xylon-test-owned",
            log_path="test.log",
        )

        assert terminate(record, grace_seconds=0.2) == "stopped"
        assert child.wait(timeout=2) == -signal.SIGTERM
    finally:
        _force_cleanup(child)


def test_stop_preserves_a_reused_pid_when_the_command_identity_does_not_match():
    process_type = getattr(local_app, "ManagedProcess", None)
    terminate = getattr(local_app, "terminate_managed_process", None)
    assert process_type is not None and callable(terminate)

    child = _long_running_child("xylon-test-unrelated")
    try:
        record = process_type(
            name="api",
            pid=child.pid,
            command_marker="agent.api.main:app",
            log_path="api.log",
        )

        assert terminate(record, grace_seconds=0.2) == "identity_mismatch"
        assert child.poll() is None
    finally:
        _force_cleanup(child)


def test_process_identity_lookup_fails_closed_when_ps_is_not_permitted(monkeypatch):
    def deny_ps(*_args, **_kwargs):
        raise PermissionError("ps is blocked by the execution environment")

    monkeypatch.setattr(local_app.subprocess, "run", deny_ps)

    assert local_app._process_command(12345) is None


def test_process_identity_lookup_reads_the_full_linux_proc_command(
    tmp_path: Path,
    monkeypatch,
):
    process_dir = tmp_path / "12345"
    process_dir.mkdir()
    long_marker = "xylon-test-owned-" + "x" * 256
    (process_dir / "cmdline").write_bytes(
        b"python\0-c\0import time; time.sleep(60)\0"
        + long_marker.encode()
        + b"\0"
    )
    monkeypatch.setattr(local_app, "PROC_ROOT", tmp_path)

    with patch("agent.local_app.subprocess.run") as run:
        assert local_app._process_command(12345) == (
            "python -c import time; time.sleep(60) " + long_marker
        )

    run.assert_not_called()


def test_process_identity_lookup_requests_an_untruncated_ps_fallback(
    tmp_path: Path,
    monkeypatch,
):
    monkeypatch.setattr(local_app, "PROC_ROOT", tmp_path / "missing-proc")
    completed = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout="python xylon-test-owned\n",
        stderr="",
    )
    with patch("agent.local_app.subprocess.run", return_value=completed) as run:
        assert local_app._process_command(12345) == "python xylon-test-owned"

    run.assert_called_once_with(
        ["ps", "-ww", "-p", "12345", "-o", "command="],
        capture_output=True,
        text=True,
        check=False,
    )


def test_stop_preserves_a_live_process_when_identity_cannot_be_read(monkeypatch):
    process_type = getattr(local_app, "ManagedProcess", None)
    terminate = getattr(local_app, "terminate_managed_process", None)
    assert process_type is not None and callable(terminate)

    child = _long_running_child("xylon-test-identity-unavailable")
    try:
        monkeypatch.setattr(local_app, "_process_command", lambda _pid: None)
        record = process_type(
            name="api",
            pid=child.pid,
            command_marker="xylon-test-identity-unavailable",
            log_path="api.log",
        )

        assert terminate(record, grace_seconds=0.2) == "identity_unavailable"
        assert child.poll() is None
    finally:
        _force_cleanup(child)


def test_stop_reports_cleanup_unverified_when_process_survives_sigkill(monkeypatch):
    record = local_app.ManagedProcess(
        name="api",
        pid=12345,
        command_marker="xylon-test-api",
        log_path="api.log",
    )
    signals: list[int] = []
    monkeypatch.setattr(local_app, "_pid_exists", lambda _pid: True)
    monkeypatch.setattr(
        local_app,
        "_process_command",
        lambda _pid: "python xylon-test-api",
    )
    monkeypatch.setattr(local_app, "_process_state", lambda _pid: "S")
    monkeypatch.setattr(local_app, "_process_is_running", lambda _pid: True)
    monkeypatch.setattr(
        local_app.os,
        "killpg",
        lambda _pid, sent_signal: signals.append(sent_signal),
    )

    assert (
        local_app.terminate_managed_process(record, grace_seconds=0)
        == "cleanup_unverified"
    )
    assert signals == [signal.SIGTERM, signal.SIGKILL]


def test_termination_verification_fails_closed_on_conflicting_liveness_reads(
    monkeypatch,
):
    monkeypatch.setattr(local_app, "_process_is_running", lambda _pid: True)
    monkeypatch.setattr(local_app, "_process_state", lambda _pid: "Z")
    monkeypatch.setattr(local_app, "_pid_exists", lambda _pid: True)

    assert local_app._termination_is_verified(12345) is False


def test_termination_verification_fails_closed_when_existing_pid_is_unobservable(
    monkeypatch,
):
    monkeypatch.setattr(local_app, "_process_is_running", lambda _pid: False)
    monkeypatch.setattr(local_app, "_process_state", lambda _pid: None)
    monkeypatch.setattr(local_app, "_pid_exists", lambda _pid: True)

    assert local_app._termination_is_verified(12345) is False


def test_stop_treats_a_missing_process_group_during_sigkill_as_not_running(
    monkeypatch,
):
    record = local_app.ManagedProcess(
        name="api",
        pid=12345,
        command_marker="xylon-test-api",
        log_path="api.log",
    )
    signals: list[int] = []

    def signal_process_group(_pid: int, sent_signal: int) -> None:
        signals.append(sent_signal)
        if sent_signal == signal.SIGKILL:
            raise ProcessLookupError

    monkeypatch.setattr(local_app, "_pid_exists", lambda _pid: True)
    monkeypatch.setattr(
        local_app,
        "_process_command",
        lambda _pid: "python xylon-test-api",
    )
    monkeypatch.setattr(local_app, "_process_state", lambda _pid: "S")
    monkeypatch.setattr(local_app, "_process_is_running", lambda _pid: True)
    monkeypatch.setattr(local_app.os, "killpg", signal_process_group)

    assert (
        local_app.terminate_managed_process(record, grace_seconds=0)
        == "not_running"
    )
    assert signals == [signal.SIGTERM, signal.SIGKILL]


def _write_state(state_dir: Path, *, api_pid: int, api_marker: str, web_pid: int) -> Path:
    state_dir.mkdir(parents=True)
    state_path = state_dir / "state.json"
    state_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "runtime_owned": False,
                "api_port": 5001,
                "web_port": 3000,
                "api": {
                    "name": "api",
                    "pid": api_pid,
                    "command_marker": api_marker,
                    "log_path": "api.log",
                },
                "web": {
                    "name": "web",
                    "pid": web_pid,
                    "command_marker": "xylon-test-web",
                    "log_path": "web.log",
                },
            }
        ),
        encoding="utf-8",
    )
    return state_path


def test_stop_consumes_owned_state_and_removes_it_after_both_services_exit(tmp_path: Path):
    app_type = getattr(local_app, "LocalApplication", None)
    assert app_type is not None

    api = _long_running_child("xylon-test-api")
    web = _long_running_child("xylon-test-web")
    state_dir = tmp_path / "local"
    state_path = _write_state(
        state_dir,
        api_pid=api.pid,
        api_marker="xylon-test-api",
        web_pid=web.pid,
    )
    try:
        app = app_type(repo_root=REPO_ROOT, state_dir=state_dir)

        assert app.stop(grace_seconds=0.2) == 0
        assert api.wait(timeout=2) == -signal.SIGTERM
        assert web.wait(timeout=2) == -signal.SIGTERM
        assert not state_path.exists()
    finally:
        _force_cleanup(api)
        _force_cleanup(web)


def test_stop_keeps_state_when_a_saved_pid_belongs_to_an_unrelated_process(tmp_path: Path):
    app_type = getattr(local_app, "LocalApplication", None)
    assert app_type is not None

    api = _long_running_child("xylon-test-unrelated")
    web = _long_running_child("xylon-test-web")
    state_dir = tmp_path / "local"
    state_path = _write_state(
        state_dir,
        api_pid=api.pid,
        api_marker="agent.api.main:app",
        web_pid=web.pid,
    )
    try:
        app = app_type(repo_root=REPO_ROOT, state_dir=state_dir)

        assert app.stop(grace_seconds=0.2) == 1
        assert api.poll() is None
        assert web.wait(timeout=2) == -signal.SIGTERM
        assert state_path.exists()
    finally:
        _force_cleanup(api)
        _force_cleanup(web)


class _TestRuntime:
    def __init__(self) -> None:
        self.running = False
        self.actions: list[str] = []

    def is_running(self) -> bool:
        return self.running

    def run(self, action: str, *, timeout: float) -> bool:
        del timeout
        self.actions.append(action)
        if action in {"up", "verify"}:
            self.running = True
            return True
        if action == "down":
            self.running = False
            return True
        return False


def _safe_resource_probe() -> local_app.ResourceSnapshot:
    return local_app.ResourceSnapshot(
        logical_cpus=12,
        load_one_minute=4.0,
        memory_free_percent=60,
        disk_free_bytes=40 * 1024**3,
        memory_available_bytes=12 * 1024**3,
    )


def _managed_state(*, runtime_owned: bool = True) -> local_app.LocalState:
    return local_app.LocalState(
        schema_version=2,
        runtime_owned=runtime_owned,
        api_port=5001,
        web_port=3000,
        api=local_app.ManagedProcess("api", 1001, "xylon-test-api", "api.log"),
        web=local_app.ManagedProcess("web", 1002, "xylon-test-web", "web.log"),
    )


def test_stop_keeps_runtime_and_state_when_service_cleanup_is_unverified(
    tmp_path: Path,
    capsys,
):
    runtime = _TestRuntime()
    runtime.running = True
    app = local_app.LocalApplication(
        repo_root=REPO_ROOT,
        state_dir=tmp_path / "local",
        runtime=runtime,
    )
    app._write_state(_managed_state())

    with patch(
        "agent.local_app.terminate_managed_process",
        side_effect=["cleanup_unverified", "stopped"],
    ):
        assert app.stop(grace_seconds=0) == 1

    assert app.state_path.exists()
    assert runtime.running is True
    assert "down" not in runtime.actions
    output = capsys.readouterr().out
    assert "EDA runtime shutdown was intentionally skipped" in output
    assert "rerun scripts/xylon stop" in output


def test_rollback_writes_state_and_keeps_runtime_when_identity_is_unavailable(
    tmp_path: Path,
    capsys,
):
    runtime = _TestRuntime()
    runtime.running = True
    app = local_app.LocalApplication(
        repo_root=REPO_ROOT,
        state_dir=tmp_path / "local",
        runtime=runtime,
    )

    with patch(
        "agent.local_app.terminate_managed_process",
        side_effect=["identity_unavailable", "not_running"],
    ):
        assert app._rollback(_managed_state(), grace_seconds=0) is False

    assert app.state_path.exists()
    assert runtime.running is True
    assert "down" not in runtime.actions
    output = capsys.readouterr().out
    assert "identity_unavailable" in output
    assert "EDA runtime shutdown was intentionally skipped" in output


def test_rollback_removes_state_after_services_and_runtime_are_stopped(tmp_path: Path):
    runtime = _TestRuntime()
    runtime.running = True
    app = local_app.LocalApplication(
        repo_root=REPO_ROOT,
        state_dir=tmp_path / "local",
        runtime=runtime,
    )
    app._write_state(_managed_state())

    with patch(
        "agent.local_app.terminate_managed_process",
        side_effect=["stopped", "not_running"],
    ):
        assert app._rollback(_managed_state(), grace_seconds=0) is True

    assert app.state_path.exists() is False
    assert runtime.running is False
    assert runtime.actions == ["down"]


def test_rollback_keeps_state_when_runtime_shutdown_fails(tmp_path: Path, capsys):
    runtime = _TestRuntime()
    runtime.running = True
    app = local_app.LocalApplication(
        repo_root=REPO_ROOT,
        state_dir=tmp_path / "local",
        runtime=runtime,
    )
    app._write_state(_managed_state())

    with (
        patch(
            "agent.local_app.terminate_managed_process",
            side_effect=["stopped", "not_running"],
        ),
        patch.object(runtime, "run", return_value=False) as runtime_run,
    ):
        assert app._rollback(_managed_state(), grace_seconds=0) is False

    runtime_run.assert_called_once_with("down", timeout=60)
    assert app.state_path.exists()
    assert runtime.running is True
    assert "restore Docker" in capsys.readouterr().out


def _unused_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _http_service_command(port: int, marker: str, *, api: bool) -> list[str]:
    response = (
        b'{"status":"healthy","service":"xylonstudio-api","version":"0.4.0"}'
        if api
        else b"XylonStudio"
    )
    code = (
        "from http.server import BaseHTTPRequestHandler,HTTPServer;"
        f"body={response!r};"
        "handler=type('Handler',(BaseHTTPRequestHandler,),{"
        "'do_GET':lambda self:(self.send_response(200),self.end_headers(),self.wfile.write(body)),"
        "'log_message':lambda *args:None});"
        "HTTPServer(('127.0.0.1',int(__import__('sys').argv[1])),handler).serve_forever()"
    )
    return [sys.executable, "-u", "-c", code, str(port), marker]


def test_start_status_stop_manages_real_local_http_processes_and_owned_runtime(tmp_path: Path):
    app_type = getattr(local_app, "LocalApplication", None)
    assert app_type is not None

    api_port = _unused_port()
    web_port = _unused_port()
    runtime = _TestRuntime()
    app = app_type(
        repo_root=REPO_ROOT,
        state_dir=tmp_path / "local",
        api_port=api_port,
        web_port=web_port,
        api_command=_http_service_command(api_port, "xylon-test-api", api=True),
        web_command=_http_service_command(web_port, "xylon-test-web", api=False),
        api_command_marker="xylon-test-api",
        web_command_marker="xylon-test-web",
        runtime=runtime,
        resource_probe=_safe_resource_probe,
    )
    app.state_dir.mkdir(parents=True)
    (app.state_dir / "api.log").write_text("stale-api-log\n", encoding="utf-8")
    (app.state_dir / "web.log").write_text("stale-web-log\n", encoding="utf-8")

    try:
        assert app.start(health_timeout=2) == 0
        first_state = json.loads(app.state_path.read_text(encoding="utf-8"))
        assert app.start(health_timeout=2) == 0
        assert json.loads(app.state_path.read_text(encoding="utf-8")) == first_state
        assert "stale-api-log" not in (app.state_dir / "api.log").read_text(encoding="utf-8")
        assert "stale-web-log" not in (app.state_dir / "web.log").read_text(encoding="utf-8")
        assert json.loads(urlopen(f"http://127.0.0.1:{api_port}/health").read())["status"] == "healthy"
        assert urlopen(f"http://127.0.0.1:{web_port}/").read() == b"XylonStudio"
        assert app.status() == 0
        assert app.stop(grace_seconds=0.2) == 0
        assert not (tmp_path / "local" / "state.json").exists()
        assert runtime.running is False
    finally:
        app.stop(grace_seconds=0.1)


def test_failed_web_start_rolls_back_the_api_runtime_and_partial_state(tmp_path: Path):
    app_type = getattr(local_app, "LocalApplication", None)
    assert app_type is not None

    api_port = _unused_port()
    web_port = _unused_port()
    runtime = _TestRuntime()
    app = app_type(
        repo_root=REPO_ROOT,
        state_dir=tmp_path / "local",
        api_port=api_port,
        web_port=web_port,
        api_command=_http_service_command(api_port, "xylon-test-api", api=True),
        web_command=[sys.executable, "-c", "raise SystemExit(7)", "xylon-test-web"],
        api_command_marker="xylon-test-api",
        web_command_marker="xylon-test-web",
        runtime=runtime,
        resource_probe=_safe_resource_probe,
    )

    assert app.start(health_timeout=0.5) == 1
    assert local_app._port_is_open(api_port) is False
    assert local_app._port_is_open(web_port) is False
    assert not (tmp_path / "local" / "state.json").exists()
    assert runtime.running is False


def test_start_injects_the_selected_web_port_into_the_api_origin_policy(tmp_path: Path):
    api_port = _unused_port()
    web_port = _unused_port()
    api_command = _http_service_command(api_port, "xylon-test-api", api=True)
    api_command[3] = (
        f"import os; assert os.environ['XYLON_WEB_PORT'] == {str(web_port)!r};"
        + api_command[3]
    )
    runtime = _TestRuntime()
    app = local_app.LocalApplication(
        repo_root=REPO_ROOT,
        state_dir=tmp_path / "local",
        api_port=api_port,
        web_port=web_port,
        api_command=api_command,
        web_command=_http_service_command(web_port, "xylon-test-web", api=False),
        api_command_marker="xylon-test-api",
        web_command_marker="xylon-test-web",
        runtime=runtime,
        resource_probe=_safe_resource_probe,
    )

    try:
        assert app.start(health_timeout=2) == 0
    finally:
        app.stop(grace_seconds=0.1)


def test_start_blocks_before_runtime_or_services_when_host_resources_are_unsafe(tmp_path: Path):
    api_port = _unused_port()
    web_port = _unused_port()
    runtime = _TestRuntime()
    unsafe = local_app.ResourceSnapshot(
        logical_cpus=12,
        load_one_minute=12.5,
        memory_free_percent=15,
        disk_free_bytes=8 * 1024**3,
        memory_available_bytes=4 * 1024**3,
    )
    app = local_app.LocalApplication(
        repo_root=REPO_ROOT,
        state_dir=tmp_path / "local",
        api_port=api_port,
        web_port=web_port,
        api_command=_http_service_command(api_port, "xylon-test-api", api=True),
        web_command=_http_service_command(web_port, "xylon-test-web", api=False),
        api_command_marker="xylon-test-api",
        web_command_marker="xylon-test-web",
        runtime=runtime,
        resource_probe=lambda: unsafe,
    )

    assert app.start(health_timeout=0.5) == 1
    assert runtime.running is False
    assert local_app._port_is_open(api_port) is False
    assert local_app._port_is_open(web_port) is False
    assert app.state_path.exists() is False


def test_web_health_requires_starting_the_process_from_its_configured_workspace(tmp_path: Path):
    api_port = _unused_port()
    web_port = _unused_port()
    web_workspace = tmp_path / "web-workspace"
    web_workspace.mkdir()
    expected_workspace = str(web_workspace)
    web_command = _http_service_command(web_port, "xylon-test-web", api=False)
    web_command[3] = (
        f"from pathlib import Path; assert str(Path.cwd()) == {expected_workspace!r};"
        + web_command[3]
    )
    runtime = _TestRuntime()

    app = local_app.LocalApplication(
        repo_root=REPO_ROOT,
        state_dir=tmp_path / "local",
        api_port=api_port,
        web_port=web_port,
        api_command=_http_service_command(api_port, "xylon-test-api", api=True),
        web_command=web_command,
        api_command_marker="xylon-test-api",
        web_command_marker="xylon-test-web",
        web_cwd=web_workspace,
        runtime=runtime,
        resource_probe=_safe_resource_probe,
    )

    try:
        assert app.start(health_timeout=2) == 0
    finally:
        app.stop(grace_seconds=0.1)


def test_status_and_stop_recognize_next_server_after_it_rewrites_its_process_title(tmp_path: Path):
    node = shutil.which("node")
    assert node is not None
    api_port = _unused_port()
    web_port = _unused_port()
    runtime = _TestRuntime()
    web_code = (
        "const http=require('http');process.title='next-server';"
        f"http.createServer((req,res)=>res.end('XylonStudio')).listen({web_port},'127.0.0.1')"
    )
    app = local_app.LocalApplication(
        repo_root=REPO_ROOT,
        state_dir=tmp_path / "local",
        api_port=api_port,
        web_port=web_port,
        api_command=_http_service_command(api_port, "xylon-test-api", api=True),
        web_command=[node, "-e", web_code],
        api_command_marker="xylon-test-api",
        runtime=runtime,
        resource_probe=_safe_resource_probe,
    )

    try:
        assert app.start(health_timeout=2) == 0
        assert app.status() == 0
        assert app.stop(grace_seconds=0.2) == 0
    finally:
        if app.state_path.exists():
            payload = json.loads(app.state_path.read_text(encoding="utf-8"))
            for key in ("api", "web"):
                try:
                    os.killpg(int(payload[key]["pid"]), signal.SIGKILL)
                except ProcessLookupError:
                    pass


def test_logs_prints_a_bounded_tail_and_the_full_log_location(tmp_path: Path, capsys):
    app = local_app.LocalApplication(repo_root=REPO_ROOT, state_dir=tmp_path / "local")
    app.state_dir.mkdir(parents=True)
    (app.state_dir / "api.log").write_text("api-1\napi-2\napi-3\n", encoding="utf-8")
    (app.state_dir / "web.log").write_text("web-1\nweb-2\nweb-3\n", encoding="utf-8")

    assert app.logs(tail=2) == 0
    output = capsys.readouterr().out
    assert "api-1" not in output and "web-1" not in output
    assert "api-2\napi-3" in output
    assert "web-2\nweb-3" in output
    assert str(app.state_dir / "api.log") in output


def test_scripts_xylon_is_the_supported_doctor_entry_point():
    result = subprocess.run(
        [str(REPO_ROOT / "scripts" / "xylon"), "doctor"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Python 3.9" not in result.stderr
    assert "READY: local prerequisites are available" in result.stdout


def test_scripts_xylon_doctor_reports_a_custom_web_port():
    port = _unused_port()
    result = subprocess.run(
        [str(REPO_ROOT / "scripts" / "xylon"), "doctor", "--web-port", str(port)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert f"STOPPED: Web http://127.0.0.1:{port}" in result.stdout


def test_prepare_standalone_copies_public_and_static_assets_into_the_runtime(tmp_path: Path):
    node = shutil.which("node")
    assert node is not None
    web_root = tmp_path / "web"
    (web_root / "public").mkdir(parents=True)
    (web_root / ".next" / "static" / "chunks").mkdir(parents=True)
    (web_root / ".next" / "standalone").mkdir(parents=True)
    (web_root / "public" / "asset.txt").write_text("public-asset", encoding="utf-8")
    (web_root / ".next" / "static" / "chunks" / "app.js").write_text(
        "static-asset", encoding="utf-8"
    )

    result = subprocess.run(
        [node, str(REPO_ROOT / "web" / "scripts" / "prepare-standalone.mjs"), str(web_root)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert (web_root / ".next" / "standalone" / "public" / "asset.txt").read_text() == "public-asset"
    assert (
        web_root / ".next" / "standalone" / ".next" / "static" / "chunks" / "app.js"
    ).read_text() == "static-asset"


def test_npm_start_uses_the_standalone_runtime_and_serves_its_static_assets():
    node = shutil.which("node")
    npm = shutil.which("npm")
    assert node is not None and npm is not None
    web_root = REPO_ROOT / "web"
    prepare = subprocess.run(
        [node, str(web_root / "scripts" / "prepare-standalone.mjs"), str(web_root)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert prepare.returncode == 0, prepare.stderr

    port = _unused_port()
    environment = os.environ.copy()
    environment.update({"HOSTNAME": "127.0.0.1", "PORT": str(port)})
    child = subprocess.Popen(
        [npm, "start"],
        cwd=web_root,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        text=True,
    )
    page = b""
    output = ""
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if child.poll() is not None:
                break
            try:
                page = urlopen(f"http://127.0.0.1:{port}/pipeline", timeout=0.2).read()
                break
            except OSError:
                time.sleep(0.05)
        assert page, "npm start did not honor HOSTNAME/PORT or become healthy"

        asset_match = re.search(rb'src="(/_next/static/[^\"]+\.js)"', page)
        assert asset_match is not None
        asset = urlopen(
            f"http://127.0.0.1:{port}{asset_match.group(1).decode()}", timeout=1
        ).read()
        assert len(asset) > 100
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
        try:
            output = child.communicate(timeout=3)[0]
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            output = child.communicate(timeout=3)[0]

    assert 'does not work with "output: standalone"' not in output
