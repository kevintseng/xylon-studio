"""OpenROAD snapshot API route."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

router = APIRouter(tags=["openroad"])

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SNAPSHOT_PATH = Path(".xylon/openroad/snapshot.json")
MAX_SNAPSHOT_BYTES = 1024 * 1024
SUPPORTED_SCHEMA_VERSION = 1
EMPTY_SNAPSHOT = {
    "schema_version": SUPPORTED_SCHEMA_VERSION,
    "updated_at": None,
    "server": {"status": "stopped"},
    "sessions": [],
    "last_error": None,
}


def _path_within_repo(candidate: Path) -> bool:
    try:
        candidate.resolve(strict=False).relative_to(REPO_ROOT.resolve())
    except ValueError:
        return False
    return True


def _configured_snapshot_path() -> Path:
    raw_path = os.environ.get("XYLON_OPENROAD_SNAPSHOT_PATH")
    candidate = DEFAULT_SNAPSHOT_PATH if raw_path is None else Path(raw_path)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    _reject_symlink_path(candidate)
    if not _path_within_repo(candidate):
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot path is outside the local workspace",
        )
    return candidate


def _reject_symlink_path(candidate: Path) -> None:
    probe = candidate
    workspace_root = REPO_ROOT.resolve()
    while True:
        if probe.is_symlink():
            raise HTTPException(
                status_code=500,
                detail="OpenROAD snapshot path must not use symlinks",
            )
        if probe == workspace_root:
            return
        if probe.parent == probe:
            return
        probe = probe.parent


def _canonical_snapshot(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot must be a JSON object",
        )

    schema_version = payload.get("schema_version")
    if schema_version != SUPPORTED_SCHEMA_VERSION:
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot schema is unsupported",
        )

    updated_at = payload.get("updated_at")
    if updated_at is not None and not isinstance(updated_at, str):
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot updated_at must be a string or null",
        )

    server = payload.get("server")
    if not isinstance(server, dict):
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot server must be an object",
        )

    sessions = payload.get("sessions")
    if not isinstance(sessions, list):
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot sessions must be an array",
        )

    last_error = payload.get("last_error")
    if last_error is not None and not isinstance(last_error, (dict, str)):
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot last_error must be an object, string, or null",
        )

    return {
        "schema_version": schema_version,
        "updated_at": updated_at,
        "server": server,
        "sessions": sessions,
        "last_error": last_error,
    }


def _load_snapshot() -> dict[str, Any]:
    snapshot_path = _configured_snapshot_path()
    if not snapshot_path.exists():
        return dict(EMPTY_SNAPSHOT)
    if not snapshot_path.is_file():
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot path is not a regular file",
        )

    try:
        size = snapshot_path.stat().st_size
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot could not be read",
        ) from exc
    if size > MAX_SNAPSHOT_BYTES:
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot exceeds the 1 MiB limit",
        )

    try:
        payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot contains invalid JSON",
        ) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail="OpenROAD snapshot could not be read",
        ) from exc

    return _canonical_snapshot(payload)


@router.get("/openroad/snapshot")
async def get_openroad_snapshot() -> dict[str, Any]:
    """Return the canonical local OpenROAD snapshot contract."""
    return _load_snapshot()
