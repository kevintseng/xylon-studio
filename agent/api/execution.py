"""Shared resource gate for heavy local EDA work."""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import os
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypeVar
from weakref import WeakKeyDictionary

_Result = TypeVar("_Result")
_LOCAL_EDA_SLOTS: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock] = WeakKeyDictionary()


class EdaSlotBusyError(RuntimeError):
    """Raised when a fail-fast heavy EDA request meets an existing owner."""


def _lease_path() -> Path:
    configured = os.environ.get("XYLON_EDA_LEASE_PATH")
    if configured:
        return Path(configured).expanduser()
    return Path(tempfile.gettempdir()) / f"xylon-heavy-eda-{os.getuid()}.lock"


def _try_file_lease() -> object:
    path = _lease_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = path.open("a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        handle.close()
        raise EdaSlotBusyError("another Xylon high-load EDA job is already running") from error
    handle.seek(0)
    handle.truncate()
    handle.write(f"pid={os.getpid()}\n")
    handle.flush()
    return handle


def _release_file_lease(handle: object) -> None:
    with contextlib.suppress(OSError):
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    with contextlib.suppress(OSError):
        handle.close()


def _local_eda_slot() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    slot = _LOCAL_EDA_SLOTS.get(loop)
    if slot is None:
        slot = asyncio.Lock()
        _LOCAL_EDA_SLOTS[loop] = slot
    return slot


async def run_in_local_eda_slot(operation: Callable[[], Awaitable[_Result]]) -> _Result:
    """Run exactly one pipeline or timing workload in the local API process."""
    async with _local_eda_slot():
        return await operation()


async def run_in_exclusive_eda_slot(operation: Callable[[], Awaitable[_Result]]) -> _Result:
    """Run one heavy EDA operation with process- and host-wide fail-fast locking.

    The in-process lock protects concurrent coroutines while the advisory file lock
    also coordinates separate API worker processes. The lock is released by the OS
    if a worker dies, so stale metadata cannot strand future work.
    """
    release = await acquire_exclusive_eda_slot()
    try:
        return await operation()
    finally:
        await release()


async def acquire_exclusive_eda_slot() -> Callable[[], Awaitable[None]]:
    """Acquire the shared heavy-EDA lease and return its idempotent release hook."""
    slot = _local_eda_slot()
    if slot.locked():
        raise EdaSlotBusyError("another Xylon high-load EDA job is already running")
    await slot.acquire()
    handle = None
    try:
        handle = await asyncio.to_thread(_try_file_lease)
    except BaseException:
        slot.release()
        raise

    released = False

    async def release() -> None:
        nonlocal released
        if released:
            return
        released = True
        if handle is not None:
            await asyncio.to_thread(_release_file_lease, handle)
        slot.release()

    return release
