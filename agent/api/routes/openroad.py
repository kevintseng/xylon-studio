"""OpenROAD snapshot API route."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from agent.openroad.librelane_adapter import (
    IDENTITY_RE,
    LibreLaneAdapterError,
    LibreLaneExecutionError,
    LibreLaneMaterializedProject,
    build_config,
    build_execution_plan,
    build_identity,
    execute_plan,
    probe_librelane,
)
from agent.openroad.librelane_adapter import (
    parse_request as parse_librelane_request,
)
from agent.openroad.librelane_readiness import collect_librelane_readiness
from agent.openroad.project_manifest import preflight_project_manifest
from agent.openroad.project_store import (
    MAX_PROJECT_FILES,
    MAX_PROJECT_TOTAL_BYTES,
    SUPPORTED_PROJECT_FILE_EXTENSIONS,
    ProjectStoreError,
    store_project_bundle,
)

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


class LibreLaneProjectPreparationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$")
    project_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")


class LibreLaneExecutionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    approved: bool = False


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


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _sha256_json(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _load_ready_imported_project_manifest(project_id: str) -> dict[str, Any]:
    project_root = REPO_ROOT / ".xylon" / "projects" / project_id
    manifest_path = project_root / "manifest.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise ProjectStoreError("imported project manifest is unavailable; import the bundle again")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("project_id") != project_id:
        raise ProjectStoreError("imported project manifest identity is invalid")
    if manifest.get("state") != "ready":
        raise ProjectStoreError("project preflight is not ready; correct the bundle before preparing LibreLane")
    declared_manifest = manifest.get("manifest")
    if not isinstance(declared_manifest, dict):
        raise ProjectStoreError("imported project manifest payload is invalid")
    current_preflight = preflight_project_manifest(REPO_ROOT, declared_manifest)
    if current_preflight["state"] != "ready" or current_preflight["manifest"] is None:
        failure = current_preflight.get("failure") or {}
        raise ProjectStoreError(
            str(failure.get("message", "the imported project changed after preflight"))
        )
    current_manifest = current_preflight["manifest"]
    if current_manifest.get("source_revision") != declared_manifest.get("source_revision"):
        raise ProjectStoreError("imported project source revision changed after preflight")
    return current_manifest


def _collect_prepared_project_files(project_root: Path, manifest: dict[str, Any]) -> list[str]:
    files: set[str] = set(str(path) for path in manifest.get("rtl", []))
    files.add(str(manifest.get("sdc", "")))
    total_bytes = 0
    for directory in manifest.get("include_dirs", []):
        include_root = (project_root / str(directory)).resolve()
        if include_root.is_symlink() or not include_root.is_dir() or not include_root.is_relative_to(project_root):
            raise ProjectStoreError("project include directory is no longer a local regular directory")
        for candidate in include_root.rglob("*"):
            if candidate.is_symlink():
                raise ProjectStoreError("project include directory contains an unsupported symbolic link")
            if candidate.is_dir():
                continue
            resolved = candidate.resolve()
            if not resolved.is_file() or not resolved.is_relative_to(project_root):
                raise ProjectStoreError("project include directory contains an unsupported file")
            relative = resolved.relative_to(project_root).as_posix()
            if resolved.suffix.lower() not in SUPPORTED_PROJECT_FILE_EXTENSIONS:
                continue
            files.add(relative)
    ordered = sorted(files)
    if not ordered or len(ordered) > MAX_PROJECT_FILES:
        raise ProjectStoreError(
            f"prepared LibreLane project must contain 1 to {MAX_PROJECT_FILES} files"
        )
    for relative in ordered:
        source = (project_root / relative).resolve()
        if source.is_symlink() or not source.is_file() or not source.is_relative_to(project_root):
            raise ProjectStoreError(f"project file is not a local regular file: {relative}")
        total_bytes += source.stat().st_size
        if total_bytes > MAX_PROJECT_TOTAL_BYTES:
            raise ProjectStoreError("prepared LibreLane project exceeds the 4 MiB total limit")
    return ordered


def _stage_librelane_preparation(
    request: LibreLaneProjectPreparationRequest,
    manifest: dict[str, Any],
    readiness: dict[str, Any],
) -> dict[str, Any]:
    project_root = (REPO_ROOT / str(manifest.get("root", ""))).resolve()
    if project_root.is_symlink() or not project_root.is_dir() or not project_root.is_relative_to(REPO_ROOT.resolve()):
        raise ProjectStoreError("imported project root is unavailable")
    clocks = manifest.get("clocks")
    if not isinstance(clocks, list) or len(clocks) != 1 or not isinstance(clocks[0], dict):
        raise ProjectStoreError("LibreLane preparation currently supports exactly one declared clock")
    staged_files = _collect_prepared_project_files(project_root, manifest)
    run_root = REPO_ROOT / ".xylon" / "timing" / "runs" / request.run_id
    if run_root.exists() or run_root.is_symlink():
        raise FileExistsError("run_id already exists; choose a new local LibreLane run identity")
    inputs_root = run_root / "inputs" / "project"
    try:
        inputs_root.mkdir(parents=True, mode=0o700)
        for relative in staged_files:
            source = (project_root / relative).resolve()
            destination = inputs_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copyfile(source, destination)
            destination.chmod(0o600)
        clock = clocks[0]
        config = build_config(
            top=str(manifest.get("top", "")),
            rtl_paths=[f"inputs/project/{relative}" for relative in manifest.get("rtl", [])],
            sdc_path=f"inputs/project/{manifest.get('sdc', '')}",
            clock_port=str(clock.get("port", "")),
            clock_period_ns=clock.get("period_ns"),
            include_dirs=[f"inputs/project/{directory}" for directory in manifest.get("include_dirs", [])],
        )
        config_path = run_root / "config.json"
        config_path.write_text(
            json.dumps(config, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        config_path.chmod(0o600)
        adapter_request = parse_librelane_request(
            {
                "platform": manifest.get("platform"),
                "run_id": request.run_id,
                "config_path": "config.json",
            }
        )
        state = "prepared" if readiness.get("state") == "ready" else "blocked"
        response = {
            "schema_version": "xylon-librelane-project-preparation/v1",
            "run_id": request.run_id,
            "project_id": request.project_id,
            "state": state,
            "source_revision": manifest.get("source_revision"),
            "readiness": readiness,
            "runtime_identity": None,
            "preparation": {
                "root": f".xylon/timing/runs/{request.run_id}",
                "inputs_root": "inputs/project",
                "config_path": "config.json",
                "config_sha256": hashlib.sha256(config_path.read_bytes()).hexdigest(),
                "adapter_request": adapter_request,
                "files": staged_files,
            },
            "failure": None,
            "next_action": (
                "Use the exact saved config handoff with a future bounded LibreLane executor."
                if state == "prepared"
                else "Resolve the listed LibreLane readiness blockers before starting any subprocess."
            ),
        }
        manifest_payload = {
            **response,
            "manifest": {
                "top": manifest.get("top"),
                "platform": manifest.get("platform"),
                "rtl": manifest.get("rtl"),
                "include_dirs": manifest.get("include_dirs"),
                "sdc": manifest.get("sdc"),
                "clocks": manifest.get("clocks"),
            },
        }
        if state == "blocked":
            manifest_payload["failure"] = {
                "code": "LibreLaneReadinessBlocked",
                "message": "Xylon prepared the LibreLane run inputs but did not start any subprocess.",
                "recovery": str(readiness.get("next_action", "Resolve the first readiness blocker, then retry.")),
            }
            response["failure"] = manifest_payload["failure"]
        manifest_path = run_root / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest_payload, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        manifest_path.chmod(0o600)
        return response
    except Exception:
        shutil.rmtree(run_root, ignore_errors=True)
        raise


def _load_prepared_librelane_run(run_id: str) -> tuple[Path, dict[str, Any]]:
    if not IDENTITY_RE.fullmatch(run_id):
        raise ProjectStoreError("invalid LibreLane run identity")
    run_root = REPO_ROOT / ".xylon" / "timing" / "runs" / run_id
    manifest_path = run_root / "manifest.json"
    if run_root.is_symlink() or not run_root.is_dir() or manifest_path.is_symlink() or not manifest_path.is_file():
        raise ProjectStoreError("prepared LibreLane run is unavailable")
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProjectStoreError("prepared LibreLane run manifest is unreadable") from error
    if not isinstance(payload, dict) or payload.get("run_id") != run_id:
        raise ProjectStoreError("prepared LibreLane run manifest is invalid")
    state = payload.get("state")
    if state == "blocked":
        failure = payload.get("failure")
        if not isinstance(failure, dict) or failure.get("code") != "LibreLaneReadinessBlocked":
            raise ProjectStoreError("LibreLane run is not awaiting execution")
    elif state != "prepared":
        raise ProjectStoreError("LibreLane run is not awaiting execution")
    return run_root, payload


def _build_prepared_librelane_project(run_root: Path, payload: dict[str, Any]) -> LibreLaneMaterializedProject:
    preparation = payload.get("preparation")
    if not isinstance(preparation, dict):
        raise ProjectStoreError("prepared LibreLane run has no preparation record")
    request = preparation.get("adapter_request")
    if not isinstance(request, dict):
        raise ProjectStoreError("prepared LibreLane run has no adapter request")
    config_path = str(preparation.get("config_path", ""))
    adapter_request = parse_librelane_request(request)
    config = (run_root / config_path).resolve()
    if config.is_symlink() or not config.is_file() or not config.is_relative_to(run_root.resolve()):
        raise ProjectStoreError("prepared LibreLane config is unavailable")
    digest = hashlib.sha256(config.read_bytes()).hexdigest()
    if digest != preparation.get("config_sha256"):
        raise ProjectStoreError("prepared LibreLane config hash no longer matches")
    manifest = payload.get("manifest")
    if not isinstance(manifest, dict):
        raise ProjectStoreError("prepared LibreLane run has no design manifest")
    rtl = manifest.get("rtl")
    include_dirs = manifest.get("include_dirs")
    if not isinstance(rtl, list) or not all(isinstance(path, str) for path in rtl):
        raise ProjectStoreError("prepared LibreLane run has invalid RTL paths")
    if not isinstance(include_dirs, list) or not all(isinstance(path, str) for path in include_dirs):
        raise ProjectStoreError("prepared LibreLane run has invalid include paths")
    sdc = manifest.get("sdc")
    top = manifest.get("top")
    source_revision = payload.get("source_revision")
    if not isinstance(sdc, str) or not isinstance(top, str) or not isinstance(source_revision, str):
        raise ProjectStoreError("prepared LibreLane run is missing design identity")
    return LibreLaneMaterializedProject(
        request=adapter_request,
        top=top,
        source_revision=source_revision,
        design_path=f"inputs/project/{rtl[0]}",
        sdc_path=f"inputs/project/{sdc}",
        config_path=config_path,
    )


def _persist_librelane_run(run_root: Path, payload: dict[str, Any]) -> None:
    manifest_path = run_root / "manifest.json"
    manifest_path.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    manifest_path.chmod(0o600)


@router.get("/openroad/snapshot")
async def get_openroad_snapshot() -> dict[str, Any]:
    """Return the canonical local OpenROAD snapshot contract."""
    return _load_snapshot()


@router.get("/openroad/librelane-readiness")
async def get_librelane_readiness() -> dict[str, object]:
    """Return measured pinned-LibreLane readiness without starting or pulling anything."""
    return await asyncio.to_thread(collect_librelane_readiness, REPO_ROOT)


@router.post("/openroad/librelane-project-runs", status_code=201)
async def post_librelane_project_preparation(
    request: LibreLaneProjectPreparationRequest,
) -> dict[str, Any]:
    """Prepare an imported project for a future LibreLane run without starting any subprocess."""
    try:
        manifest = _load_ready_imported_project_manifest(request.project_id)
        probe = probe_librelane()
        readiness = await asyncio.to_thread(collect_librelane_readiness, REPO_ROOT, probe=probe)
        result = await asyncio.to_thread(_stage_librelane_preparation, request, manifest, readiness)
        if probe.state == "available":
            identity = build_identity(probe, platform=str(manifest.get("platform", "")))
            result["runtime_identity"] = asdict(identity)
            result["preparation"]["runtime_identity_sha256"] = _sha256_json(asdict(identity))
            manifest_path = REPO_ROOT / result["preparation"]["root"] / "manifest.json"
            persisted = json.loads(manifest_path.read_text(encoding="utf-8"))
            persisted["runtime_identity"] = result["runtime_identity"]
            persisted["preparation"]["runtime_identity_sha256"] = result["preparation"]["runtime_identity_sha256"]
            manifest_path.write_text(
                json.dumps(persisted, sort_keys=True, indent=2) + "\n",
                encoding="utf-8",
            )
        return result
    except FileExistsError as error:
        raise HTTPException(status_code=409, detail={
            "error": "LibreLaneRunConflict",
            "message": str(error),
            "recovery": "Choose a new local LibreLane run identity for this prepared project.",
        }) from error
    except (OSError, json.JSONDecodeError, KeyError, ProjectStoreError, LibreLaneAdapterError) as error:
        raise HTTPException(status_code=422, detail={
            "error": "LibreLaneProjectPreparationInvalid",
            "message": str(error),
            "recovery": "Import the project again, keep one declared clock, and correct the first readiness or project blocker before preparing LibreLane.",
            "project_id": request.project_id,
        }) from error


@router.post("/openroad/librelane-project-runs/{run_id}/execute")
async def post_librelane_project_execution(
    run_id: str,
    request: LibreLaneExecutionRequest,
) -> dict[str, Any]:
    """Execute one prepared run only after explicit approval and readiness recheck."""
    if not request.approved:
        raise HTTPException(status_code=403, detail={
            "error": "LibreLaneApprovalRequired",
            "message": "Xylon will not start LibreLane until the user explicitly approves this run.",
            "recovery": "Review the prepared project and call this endpoint again with approved=true.",
        })
    try:
        run_root, payload = _load_prepared_librelane_run(run_id)
        probe = probe_librelane()
        readiness = await asyncio.to_thread(collect_librelane_readiness, REPO_ROOT, probe=probe)
        if readiness.get("state") != "ready":
            payload["state"] = "blocked"
            payload["readiness"] = readiness
            payload["failure"] = {
                "code": "LibreLaneReadinessBlocked",
                "message": "Xylon did not start LibreLane because the measured readiness gate is blocked.",
                "recovery": str(readiness.get("next_action", "Resolve the first readiness blocker, then retry.")),
            }
            _persist_librelane_run(run_root, payload)
            raise HTTPException(status_code=409, detail=payload["failure"])
        project = _build_prepared_librelane_project(run_root, payload)
        plan = build_execution_plan(probe, run_dir=run_root, project=project)
        payload["state"] = "running"
        payload["readiness"] = readiness
        payload["runtime_identity"] = asdict(plan.identity)
        payload["execution"] = {
            "approved": True,
            "started_at": datetime.now(UTC).isoformat(),
            "plan_identity_sha256": plan.plan_identity_sha256,
        }
        _persist_librelane_run(run_root, payload)
        result = await asyncio.to_thread(execute_plan, REPO_ROOT, run_dir=run_root, plan=plan)
        payload["state"] = "succeeded"
        payload["execution"]["finished_at"] = datetime.now(UTC).isoformat()
        payload["execution"]["result"] = result
        payload["failure"] = None
        payload["next_action"] = "Review the native timing metrics and request one bounded repair if needed."
        _persist_librelane_run(run_root, payload)
        return payload
    except HTTPException:
        raise
    except (OSError, json.JSONDecodeError, KeyError, ProjectStoreError, LibreLaneAdapterError, LibreLaneExecutionError) as error:
        if "run_root" in locals() and "payload" in locals():
            payload["state"] = "failed"
            payload["failure"] = {
                "code": "LibreLaneExecutionFailed",
                "message": str(error),
                "recovery": "Inspect the bounded execution evidence and correct the first reported failure before requesting another run.",
            }
            _persist_librelane_run(run_root, payload)
        raise HTTPException(status_code=422, detail={
            "error": "LibreLaneExecutionFailed",
            "message": str(error),
            "recovery": "Inspect the bounded execution evidence and correct the first reported failure before requesting another run.",
            "run_id": run_id,
        }) from error


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
