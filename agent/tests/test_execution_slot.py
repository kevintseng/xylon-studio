"""Concurrency proof for the shared high-load EDA lease."""

from __future__ import annotations

import asyncio
import multiprocessing

import pytest

from agent.api.execution import (
    EdaSlotBusyError,
    _release_file_lease,
    _try_file_lease,
    run_in_exclusive_eda_slot,
)


def _hold_foreign_lease(lease_path: str, ready_queue, release_queue) -> None:
    """Simulate a second API worker process that already owns the host-wide lease."""
    import os

    os.environ["XYLON_EDA_LEASE_PATH"] = lease_path
    handle = _try_file_lease()
    try:
        ready_queue.put("locked")
        release_queue.get(timeout=5)
    finally:
        _release_file_lease(handle)


@pytest.mark.asyncio
async def test_exclusive_eda_slot_rejects_second_request_without_starting_it(tmp_path, monkeypatch):
    monkeypatch.setenv("XYLON_EDA_LEASE_PATH", str(tmp_path / "heavy-eda.lock"))
    started = asyncio.Event()
    release = asyncio.Event()
    second_started = False

    async def first_operation():
        started.set()
        await release.wait()
        return "first"

    async def second_operation():
        nonlocal second_started
        second_started = True
        return "second"

    first = asyncio.create_task(run_in_exclusive_eda_slot(first_operation))
    await asyncio.wait_for(started.wait(), timeout=1)

    with pytest.raises(EdaSlotBusyError, match="another Xylon high-load EDA job"):
        await run_in_exclusive_eda_slot(second_operation)

    assert second_started is False
    release.set()
    assert await asyncio.wait_for(first, timeout=1) == "first"
    assert await run_in_exclusive_eda_slot(lambda: _completed("follow-up")) == "follow-up"


@pytest.mark.asyncio
async def test_exclusive_eda_slot_rejects_foreign_process_owner_without_starting_it(tmp_path, monkeypatch):
    lease_path = tmp_path / "heavy-eda.lock"
    monkeypatch.setenv("XYLON_EDA_LEASE_PATH", str(lease_path))
    context = multiprocessing.get_context("spawn")
    ready_queue = context.Queue()
    release_queue = context.Queue()
    process = context.Process(
        target=_hold_foreign_lease,
        args=(str(lease_path), ready_queue, release_queue),
    )
    process.start()
    second_started = False

    try:
        assert ready_queue.get(timeout=5) == "locked"

        async def second_operation():
            nonlocal second_started
            second_started = True
            return "second"

        with pytest.raises(EdaSlotBusyError, match="another Xylon high-load EDA job"):
            await run_in_exclusive_eda_slot(second_operation)

        assert second_started is False
    finally:
        release_queue.put("release")
        process.join(timeout=5)
        if process.is_alive():
            process.kill()
            process.join(timeout=5)

    assert process.exitcode == 0
    assert await run_in_exclusive_eda_slot(lambda: _completed("follow-up")) == "follow-up"


async def _completed(value: str) -> str:
    return value
