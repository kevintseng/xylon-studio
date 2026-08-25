"""Resource admission checks for the local OpenROAD assistant runtime."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

from agent.local_app import ResourceSnapshot, collect_resource_snapshot

DEFAULT_CPUS = 4
MAXIMUM_CPUS = 4
MINIMUM_MEMORY_FREE_PERCENT = 35
MINIMUM_MEMORY_AVAILABLE_GIB = 8.0
MINIMUM_DISK_FREE_GIB = 10.0


def evaluate_openroad_preflight(
    snapshot: ResourceSnapshot,
    *,
    requested_cpus: int = DEFAULT_CPUS,
) -> list[str]:
    """Return blockers before starting the amd64 OpenROAD compatibility runtime."""
    blockers: list[str] = []
    if requested_cpus < 1:
        blockers.append("requested CPUs must be at least 1")
    elif requested_cpus > MAXIMUM_CPUS:
        blockers.append(f"requested CPUs must not exceed {MAXIMUM_CPUS}")
    elif snapshot.load_one_minute is None:
        blockers.append(
            "CPU load could not be measured safely; OpenROAD admission is fail-closed"
        )
    elif snapshot.load_one_minute + requested_cpus > snapshot.logical_cpus:
        blockers.append(
            "current CPU load plus the OpenROAD allocation would exceed "
            f"{snapshot.logical_cpus} logical CPUs"
        )
    if snapshot.memory_available_bytes is None:
        blockers.append(
            "available memory could not be measured safely; "
            "OpenROAD admission is fail-closed"
        )
    elif snapshot.memory_available_bytes < MINIMUM_MEMORY_AVAILABLE_GIB * 1024**3:
        blockers.append(
            f"memory available {snapshot.memory_available_bytes / 1024**3:.1f} GiB "
            f"is below the {MINIMUM_MEMORY_AVAILABLE_GIB:.1f} GiB OpenROAD safety floor"
        )
    if snapshot.memory_free_percent is None:
        blockers.append(
            "memory availability percentage could not be measured safely; "
            "OpenROAD admission is fail-closed"
        )
    elif snapshot.memory_free_percent < MINIMUM_MEMORY_FREE_PERCENT:
        blockers.append(
            f"memory free {snapshot.memory_free_percent}% is below the "
            f"{MINIMUM_MEMORY_FREE_PERCENT}% OpenROAD safety floor"
        )
    disk_free_gib = snapshot.disk_free_bytes / 1024**3
    if disk_free_gib < MINIMUM_DISK_FREE_GIB:
        blockers.append(
            f"workspace disk free {disk_free_gib:.1f} GiB is below the "
            f"{MINIMUM_DISK_FREE_GIB:.1f} GiB safety floor"
        )
    return blockers


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--cpus", type=int, default=DEFAULT_CPUS)
    args = parser.parse_args(argv)

    snapshot = collect_resource_snapshot(args.repo.resolve())
    blockers = evaluate_openroad_preflight(snapshot, requested_cpus=args.cpus)
    payload = {
        "status": "blocked" if blockers else "ready",
        "requested_cpus": args.cpus,
        "resource": asdict(snapshot),
        "blockers": blockers,
    }
    stream = sys.stderr if blockers else sys.stdout
    print(json.dumps(payload, sort_keys=True), file=stream)
    return 1 if blockers else 0


if __name__ == "__main__":
    raise SystemExit(main())
