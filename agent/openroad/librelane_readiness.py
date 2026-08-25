"""Truthful, low-load readiness evidence for the pinned LibreLane backend."""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path

from agent.local_app import ResourceSnapshot, collect_resource_snapshot
from agent.openroad.librelane_adapter import (
    LIBRELANE_IMAGE,
    LIBRELANE_PDK,
    LIBRELANE_SCL,
    LIBRELANE_VERSION,
    probe_librelane,
)
from agent.openroad.resource import evaluate_openroad_preflight

IMAGE_INSPECT_TIMEOUT_SECONDS = 3.0


def _image_present(
    docker: str | None,
    *,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> bool:
    if not docker:
        return False
    try:
        result = run(
            [docker, "image", "inspect", LIBRELANE_IMAGE],
            check=False,
            capture_output=True,
            text=True,
            timeout=IMAGE_INSPECT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _pdk_present() -> bool:
    raw = os.environ.get("XYLON_LIBRELANE_PDK_ROOT", "")
    if not raw:
        return False
    path = Path(raw).expanduser()
    return path.is_dir() and not path.is_symlink()


def collect_librelane_readiness(
    repo_root: Path,
    *,
    snapshot: ResourceSnapshot | None = None,
    probe=None,
    docker: str | None = None,
    image_present: bool | None = None,
) -> dict[str, object]:
    """Return only measured readiness facts; never starts a flow or pulls an image."""

    current_probe = probe or probe_librelane()
    current_snapshot = snapshot or collect_resource_snapshot(repo_root.resolve())
    current_docker = docker if docker is not None else shutil.which("docker")
    current_image = (
        bool(current_docker and image_present)
        if image_present is not None
        else _image_present(current_docker)
    )
    pdk_present = _pdk_present()
    resource_blockers = evaluate_openroad_preflight(current_snapshot, requested_cpus=1)
    blockers: list[str] = []
    if current_probe.state != "available":
        blockers.append("LibreLane 3.0.10 is not available in the configured Python environment")
    if not current_docker:
        blockers.append("Docker is unavailable")
    elif not current_image:
        blockers.append("the pinned LibreLane image is not present locally")
    if not pdk_present:
        blockers.append("the configured sky130A PDK root is unavailable")
    blockers.extend(resource_blockers)
    state = "ready" if not blockers else "blocked"
    if state == "ready":
        next_action = "Start one pinned LibreLane reference run from the imported project."
    else:
        next_action = "Resolve the first listed blocker, then check LibreLane readiness again."
    return {
        "schema_version": "xylon-librelane-readiness/v1",
        "state": state,
        "backend": {
            "name": "LibreLane",
            "version": LIBRELANE_VERSION,
            "image": LIBRELANE_IMAGE,
            "platform": "linux/arm64",
            "pdk": LIBRELANE_PDK,
            "standard_cell_library": LIBRELANE_SCL,
        },
        "checks": {
            "python": current_probe.state == "available",
            "docker": bool(current_docker),
            "image": current_image,
            "pdk": pdk_present,
            "resources": not resource_blockers,
        },
        "resource": asdict(current_snapshot),
        "resource_blockers": resource_blockers,
        "blockers": blockers,
        "next_action": next_action,
    }
