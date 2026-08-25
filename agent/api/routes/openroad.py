"""OpenROAD snapshot API route."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from agent.openroad.project_manifest import preflight_project_manifest
from agent.openroad.project_store import ProjectStoreError, store_project_bundle

router = APIRouter(tags=["openroad"])

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SNAPSHOT_PATH = Path(".xylon/openroad/snapshot.json")
MAX_SNAPSHOT_BYTES = 1024 * 1024
MAX_PROJECT_IMPORT_BODY_BYTES = 5 * 1024 * 1024
SUPPORTED_SCHEMA_VERSION = 1
EMPTY_SNAPSHOT = {
    "schema_version": SUPPORTED_SCHEMA_VERSION,
    "updated_at": None,
    "server": {"status": "stopped"},
    "sessions": [],
    "last_error": None,
}


class ProjectClockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=128)
    port: str = Field(min_length=1, max_length=128)
    period_ns: float


class ProjectPreflightRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    root: str = Field(min_length=1, max_length=512)
    top: str = Field(min_length=1, max_length=128)
    platform: str = Field(min_length=1, max_length=32)
    rtl: list[str] = Field(min_length=1)
    include_dirs: list[str] = Field(default_factory=list)
    sdc: str = Field(min_length=1, max_length=512)
    clocks: list[ProjectClockRequest] = Field(min_length=1)
    macros: list[str] = Field(default_factory=list)


class ProjectFileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=512)
    content: str = Field(min_length=1, max_length=MAX_PROJECT_IMPORT_BODY_BYTES)


class ProjectImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    top: str = Field(min_length=1, max_length=128)
    platform: str = Field(min_length=1, max_length=32)
    rtl: list[str] = Field(min_length=1)
    include_dirs: list[str] = Field(default_factory=list)
    sdc: str = Field(min_length=1, max_length=512)
    clocks: list[ProjectClockRequest] = Field(min_length=1)
    macros: list[str] = Field(default_factory=list)
    files: list[ProjectFileRequest] = Field(min_length=1, max_length=32)


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


@router.post("/openroad/project-preflight")
async def post_openroad_project_preflight(
    request: ProjectPreflightRequest,
) -> dict[str, Any]:
    """Validate an imported multi-file project manifest before any heavy EDA work."""
    return preflight_project_manifest(REPO_ROOT, request.model_dump())


@router.post("/openroad/projects", status_code=201)
async def post_openroad_project_import(request: ProjectImportRequest) -> dict[str, Any]:
    """Store a bounded local bundle, then run the same preflight before EDA."""
    try:
        root = store_project_bundle(
            REPO_ROOT,
            project_id=request.project_id,
            files=((item.path, item.content) for item in request.files),
        )
    except ProjectStoreError as error:
        raise HTTPException(status_code=422, detail={
            "error": "ProjectImportInvalid",
            "message": str(error),
            "recovery": "Correct the project files or choose a new local project identifier, then import again.",
        }) from error
    manifest_payload = {
        **request.model_dump(exclude={"project_id", "files"}),
        "root": root,
    }
    preflight = preflight_project_manifest(REPO_ROOT, manifest_payload)
    project_manifest_path = REPO_ROOT / root / "manifest.json"
    try:
        with project_manifest_path.open("x", encoding="utf-8") as handle:
            json.dump({
                "schema_version": "xylon-project-import/v1",
                "project_id": request.project_id,
                "state": preflight["state"],
                "manifest": preflight["manifest"],
                "failure": preflight["failure"],
            }, handle, sort_keys=True)
            handle.write("\n")
        project_manifest_path.chmod(0o600)
    except OSError as error:
        raise HTTPException(status_code=500, detail={
            "error": "ProjectImportPersistenceFailed",
            "message": "Xylon could not persist the imported project manifest.",
            "recovery": "Remove only this failed project import from the local workspace, then import it again.",
        }) from error
    return {
        "schema_version": "xylon-project-import/v1",
        "project_id": request.project_id,
        "root": root,
        "preflight": preflight,
    }
