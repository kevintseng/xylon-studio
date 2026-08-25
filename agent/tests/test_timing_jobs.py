"""Lifecycle tests for API-owned timing jobs and exact cancellation."""

from __future__ import annotations

import asyncio
import json
import signal
from unittest.mock import AsyncMock

from fastapi import HTTPException, Request

from agent.api.execution import run_in_local_eda_slot
from agent.api.routes import timing as timing_routes

RUN_ID = "a" * 32


def _request(run_id: str = RUN_ID) -> Request:
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": f"/api/timing/runs/{run_id}/cancel",
        "raw_path": b"",
        "query_string": b"",
        "headers": [(b"origin", b"http://127.0.0.1:3000")],
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 5001),
    })


def _payload(run_id: str = RUN_ID) -> dict:
    return {
        "run_id": run_id,
        "rtl": "module demo(input clk); endmodule",
        "sdc": "create_clock -period 1 [get_ports clk]",
        "top_module": "demo",
        "platform": "sky130hd",
    }


def _cancelled_state(run_id: str = RUN_ID) -> dict:
    return {
        "schema_version": "xylon-timing-api/v1",
        "run_id": run_id,
        "phase": "cancelled",
        "platform": "sky130hd",
        "top_module": "demo",
        "source_revision": None,
        "clock": None,
        "metrics": None,
        "evidence": {
            "report_sha256": None,
            "checkpoint_sha256": None,
            "cleanup_verified": True,
        },
        "proposal": None,
        "confirmation": None,
        "comparison": None,
        "failure": {
            "code": "TimingRunCancelled",
            "message": "The timing run was stopped.",
            "recovery": "Review the saved input before starting a new baseline.",
            "candidate_run_id": None,
        },
    }


def _write_operation_file(
    operations_root,
    run_id: str,
    *,
    state: str,
    command: str,
    bridge_pid: int | None = None,
    public_state: dict | None = None,
) -> None:
    operations_root.mkdir(parents=True, exist_ok=True)
    payload: dict = {
        "schema_version": "xylon-timing-operation/v1",
        "run_id": run_id,
        "command": command,
        "state": state,
        "bridge_pid": bridge_pid,
        "source_revision": None,
        "updated_at": "1970-01-01T00:00:00Z",
        "public_state": public_state or _cancelled_state(run_id),
    }
    (operations_root / f"{run_id}.json").write_text(json.dumps(payload))


class _FakeProcess:
    def __init__(self) -> None:
        self.pid = 4242
        self.returncode = None
        self.signals: list[signal.Signals] = []
        self.signalled = asyncio.Event()

    def send_signal(self, requested_signal: signal.Signals) -> None:
        self.signals.append(requested_signal)
        self.signalled.set()


async def _active_cancel_scenario(tmp_path, monkeypatch) -> None:
    process = _FakeProcess()
    bridge_started = asyncio.Event()

    async def fake_bridge(command: str, payload: dict, *, job=None) -> dict:
        if command == "status":
            return _cancelled_state(payload["run_id"])
        assert job is not None
        job.process = process
        bridge_started.set()
        await process.signalled.wait()
        raise HTTPException(status_code=503, detail={
            "error": "TimingRunCancelled",
            "message": "The timing run was stopped.",
            "recovery": "Review the saved input before starting a new baseline.",
            "run_id": payload["run_id"],
        })

    monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", tmp_path / "operations")
    monkeypatch.setattr(timing_routes, "_require_timing_admission", AsyncMock())
    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", fake_bridge)

    job = await timing_routes._start_timing_job("analyze", _payload())
    assert job.public_state["phase"] == "queued"
    assert not job.done.is_set()
    await asyncio.wait_for(bridge_started.wait(), timeout=1)

    result = await timing_routes.cancel_timing_run(RUN_ID, _request())

    assert result["phase"] == "cancelled"
    assert result["evidence"]["cleanup_verified"] is True
    assert process.signals == [signal.SIGUSR1]
    assert job.done.is_set()
    assert RUN_ID not in timing_routes._active_timing_jobs()
    operation = json.loads((tmp_path / "operations" / f"{RUN_ID}.json").read_text())
    assert operation["state"] == "terminal"
    assert operation["public_state"]["phase"] == "cancelled"


def test_active_cancel_signals_only_the_exact_bridge_and_returns_cleanup(tmp_path, monkeypatch):
    asyncio.run(_active_cancel_scenario(tmp_path, monkeypatch))


async def _queued_cancel_scenario(tmp_path, monkeypatch) -> None:
    blocker_started = asyncio.Event()
    release_blocker = asyncio.Event()

    async def hold_slot() -> None:
        blocker_started.set()
        await release_blocker.wait()

    async def missing_status(_command: str, _payload: dict, **_kwargs) -> dict:
        raise HTTPException(status_code=404, detail={"error": "TimingRunNotFound"})

    bridge = AsyncMock(side_effect=missing_status)
    monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", tmp_path / "operations")
    monkeypatch.setattr(timing_routes, "_require_timing_admission", AsyncMock())
    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", bridge)

    blocker = asyncio.create_task(run_in_local_eda_slot(hold_slot))
    await asyncio.wait_for(blocker_started.wait(), timeout=1)
    job = await timing_routes._start_timing_job("analyze", _payload())
    await asyncio.sleep(0)

    result = await asyncio.wait_for(
        timing_routes.cancel_timing_run(RUN_ID, _request()),
        timeout=1,
    )

    assert result["phase"] == "cancelled"
    assert result["failure"]["code"] == "TimingRunCancelledBeforeStart"
    assert result["evidence"] is None
    bridge.assert_not_awaited()
    assert job.done.is_set()

    second = await timing_routes.cancel_timing_run(RUN_ID, _request())
    assert second == result
    bridge.assert_awaited_once_with("status", {"run_id": RUN_ID})

    release_blocker.set()
    await blocker


def test_queued_cancel_does_not_wait_for_eda_slot_or_start_bridge(tmp_path, monkeypatch):
    asyncio.run(_queued_cancel_scenario(tmp_path, monkeypatch))


async def _resource_wait_then_start_scenario(tmp_path, monkeypatch) -> None:
    ready = asyncio.Event()
    bridge_started = asyncio.Event()

    async def admission() -> None:
        if not ready.is_set():
            raise HTTPException(status_code=503, detail={
                "error": "ResourceAdmissionBlocked",
                "message": "Memory is below the safety floor.",
                "recovery": "Wait for capacity.",
                "retryable": True,
            })

    async def bridge(command: str, payload: dict, *, job=None) -> dict:
        assert command == "analyze"
        assert job is not None
        bridge_started.set()
        return {**job.public_state, "phase": "diagnosis_ready"}

    monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", tmp_path / "operations")
    monkeypatch.setattr(timing_routes, "TIMING_ADMISSION_POLL_SECONDS", 0.01)
    monkeypatch.setattr(timing_routes, "_require_timing_admission", admission)
    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", bridge)

    job = await timing_routes._start_timing_job("analyze", _payload())
    operation_path = tmp_path / "operations" / f"{RUN_ID}.json"
    for _ in range(20):
        operation = json.loads(operation_path.read_text())
        if operation["state"] == "waiting_for_resources":
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("timing job never entered resource waiting")

    assert job.public_state["phase"] == "queued"
    assert not bridge_started.is_set()
    ready.set()
    await asyncio.wait_for(job.done.wait(), timeout=1)
    assert bridge_started.is_set()
    assert job.result is not None and job.result["phase"] == "diagnosis_ready"


def test_resource_wait_stays_queued_then_starts_bridge_once(tmp_path, monkeypatch):
    asyncio.run(_resource_wait_then_start_scenario(tmp_path, monkeypatch))


async def _resource_wait_cancel_scenario(tmp_path, monkeypatch) -> None:
    async def blocked_admission() -> None:
        raise HTTPException(status_code=503, detail={
            "error": "ResourceAdmissionBlocked",
            "message": "Memory is below the safety floor.",
            "recovery": "Wait for capacity.",
            "retryable": True,
        })

    bridge = AsyncMock()
    monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", tmp_path / "operations")
    monkeypatch.setattr(timing_routes, "TIMING_ADMISSION_POLL_SECONDS", 60.0)
    monkeypatch.setattr(timing_routes, "_require_timing_admission", blocked_admission)
    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", bridge)

    job = await timing_routes._start_timing_job("analyze", _payload())
    operation_path = tmp_path / "operations" / f"{RUN_ID}.json"
    for _ in range(20):
        operation = json.loads(operation_path.read_text())
        if operation["state"] == "waiting_for_resources":
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("timing job never entered resource waiting")

    result = await asyncio.wait_for(timing_routes.cancel_timing_run(RUN_ID, _request()), timeout=1)
    assert result["phase"] == "cancelled"
    assert result["failure"]["code"] == "TimingRunCancelledBeforeStart"
    bridge.assert_not_awaited()
    assert job.done.is_set()


def test_resource_wait_can_cancel_without_starting_bridge(tmp_path, monkeypatch):
    asyncio.run(_resource_wait_cancel_scenario(tmp_path, monkeypatch))


async def _shutdown_scenario(tmp_path, monkeypatch) -> None:
    process = _FakeProcess()
    bridge_started = asyncio.Event()

    async def fake_bridge(command: str, payload: dict, *, job=None) -> dict:
        if command == "status":
            return _cancelled_state(payload["run_id"])
        assert job is not None
        job.process = process
        bridge_started.set()
        await process.signalled.wait()
        raise HTTPException(status_code=503, detail={
            "error": "TimingRunInterrupted",
            "message": "The local application stopped the timing run.",
            "recovery": "Restart Xylon and review the saved run status.",
            "run_id": payload["run_id"],
        })

    monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", tmp_path / "operations")
    monkeypatch.setattr(timing_routes, "_require_timing_admission", AsyncMock())
    monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", fake_bridge)

    await timing_routes._start_timing_job("analyze", _payload())
    await asyncio.wait_for(bridge_started.wait(), timeout=1)

    assert await timing_routes.cancel_active_timing_jobs(shutdown=True) is True
    assert process.signals == [signal.SIGTERM]
    assert timing_routes._active_timing_jobs() == {}


def test_api_shutdown_interrupts_and_awaits_owned_timing_job(tmp_path, monkeypatch):
    asyncio.run(_shutdown_scenario(tmp_path, monkeypatch))


def test_cancel_requires_exact_local_browser_origin():
    async def scenario() -> None:
        foreign = _request()
        foreign.scope["headers"] = [(b"origin", b"https://example.invalid")]
        try:
            await timing_routes.cancel_timing_run(RUN_ID, foreign)
        except HTTPException as exc:
            assert exc.status_code == 403
        else:
            raise AssertionError("foreign origin unexpectedly cancelled timing work")

    asyncio.run(scenario())


def test_reconcile_recovers_verified_marker_and_transitions_to_terminal(tmp_path, monkeypatch):
    async def scenario() -> None:
        run_id = "f" * 32
        operations_root = tmp_path / "operations"
        _write_operation_file(
            operations_root,
            run_id,
            state="queued",
            command="analyze",
            bridge_pid=4242,
            public_state={
                **_cancelled_state(run_id),
                "phase": "queued",
            },
        )

        terminate_calls: list[tuple[int, str, float]] = []

        def fake_terminate(process, *, grace_seconds: float = 10.0) -> str:
            terminate_calls.append((process.pid, process.command_marker, grace_seconds))
            return "stopped"

        async def fake_recover(command: str, payload: dict, **_kwargs) -> dict:
            assert command == "recover"
            assert payload["run_id"] == run_id
            return {
                "schema_version": "xylon-timing-api/v1",
                "run_id": run_id,
                "phase": "interrupted",
                "platform": "sky130hd",
                "top_module": "demo",
                "source_revision": None,
                "clock": None,
                "metrics": None,
                "evidence": None,
                "proposal": None,
                "confirmation": None,
                "comparison": None,
                "failure": None,
            }

        monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", operations_root)
        monkeypatch.setattr(timing_routes, "terminate_managed_process", fake_terminate)
        monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", fake_recover)

        result = await timing_routes.reconcile_interrupted_timing_jobs()

        assert result is True
        assert terminate_calls == [
            (
                4242,
                f"{timing_routes.TIMING_BRIDGE} analyze {run_id}",
                timing_routes.TIMING_CANCEL_WAIT_SECONDS / 2,
            ),
        ]
        operation = json.loads((operations_root / f"{run_id}.json").read_text())
        assert operation["state"] == "terminal"
        assert operation["public_state"]["phase"] == "interrupted"
        assert "recovery_stop_result" not in operation

    asyncio.run(scenario())


def test_reconcile_rejects_identity_mismatch_without_node_recover(tmp_path, monkeypatch):
    async def scenario() -> None:
        run_id = "0" * 32
        operations_root = tmp_path / "operations"
        _write_operation_file(
            operations_root,
            run_id,
            state="queued",
            command="analyze",
            bridge_pid=4242,
            public_state={
                **_cancelled_state(run_id),
                "phase": "queued",
            },
        )

        def fake_terminate(process, *, grace_seconds: float = 10.0) -> str:
            return "identity_mismatch"

        bridge = AsyncMock()

        monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", operations_root)
        monkeypatch.setattr(timing_routes, "terminate_managed_process", fake_terminate)
        monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", bridge)

        result = await timing_routes.reconcile_interrupted_timing_jobs()

        assert result is False
        operation = json.loads((operations_root / f"{run_id}.json").read_text())
        assert operation["state"] == "terminal"
        assert operation["public_state"]["phase"] == "blocked"
        assert operation["public_state"]["failure"]["code"] == "TimingCleanupUnverified"
        assert operation["recovery_stop_result"] == "identity_mismatch"
        assert bridge.await_count == 0

    asyncio.run(scenario())


def test_reconcile_queued_no_pid_converts_to_timings_run_cancelled_before_start(tmp_path, monkeypatch):
    async def scenario() -> None:
        run_id = "1" * 32
        operations_root = tmp_path / "operations"
        _write_operation_file(
            operations_root,
            run_id,
            state="queued",
            command="analyze",
            bridge_pid=None,
            public_state={
                **_cancelled_state(run_id),
                "phase": "queued",
            },
        )

        async def missing_bridge(command: str, payload: dict, **_kwargs) -> dict:
            raise HTTPException(status_code=404, detail={
                "error": "TimingRunNotFound",
                "message": "run not found",
                "recovery": "run not found during startup recovery",
            })

        bridge = AsyncMock(side_effect=missing_bridge)

        monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", operations_root)
        monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", bridge)

        result = await timing_routes.reconcile_interrupted_timing_jobs()

        assert result is True
        bridge.assert_awaited_once_with("recover", {"run_id": run_id})
        operation = json.loads((operations_root / f"{run_id}.json").read_text())
        assert operation["state"] == "terminal"
        assert operation["public_state"]["failure"]["code"] == "TimingRunCancelledBeforeStart"
        assert operation["public_state"]["phase"] == "cancelled"

    asyncio.run(scenario())


def test_reconcile_marks_malformed_journal_as_unverified(tmp_path, monkeypatch):
    async def scenario() -> None:
        operations_root = tmp_path / "operations"
        operations_root.mkdir(parents=True, exist_ok=True)
        (operations_root / "bad.json").write_text("{not-json")
        (operations_root / f"{'2' * 32}.json").write_text(json.dumps({
            "schema_version": "xylon-timing-operation/v1",
            "run_id": "2" * 32,
            "command": "analyze",
            "state": "queued",
            "public_state": {"foo": "bar"},
        }))

        monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", operations_root)

        result = await timing_routes.reconcile_interrupted_timing_jobs()

        assert result is False
        assert (operations_root / "bad.json").is_file()
        assert (operations_root / f"{'2' * 32}.json").is_file()

    asyncio.run(scenario())


def test_reconcile_blocks_when_operation_count_exceeds_limit(tmp_path, monkeypatch):
    async def scenario() -> None:
        operations_root = tmp_path / "operations"
        operations_root.mkdir(parents=True, exist_ok=True)
        for index in range(timing_routes.MAX_TIMING_OPERATIONS + 1):
            run_id = f"{index + 1:032x}"
            _write_operation_file(
                operations_root,
                run_id,
                state="queued",
                command="analyze",
                bridge_pid=1000 + index,
            )

        bridge = AsyncMock()
        terminate = AsyncMock()

        monkeypatch.setattr(timing_routes, "TIMING_OPERATION_ROOT", operations_root)
        monkeypatch.setattr(timing_routes, "_invoke_timing_bridge", bridge)
        monkeypatch.setattr(timing_routes, "terminate_managed_process", terminate)

        result = await timing_routes.reconcile_interrupted_timing_jobs()

        assert result is False
        bridge.assert_not_awaited()
        terminate.assert_not_called()

    asyncio.run(scenario())
