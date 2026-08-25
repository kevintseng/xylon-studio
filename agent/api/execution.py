"""Shared resource gate for heavy local EDA work."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar
from weakref import WeakKeyDictionary

_Result = TypeVar("_Result")
_LOCAL_EDA_SLOTS: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock] = WeakKeyDictionary()


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
