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
from typing import Any, Literal

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


class LibreLaneRepairApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    approved: bool = False
    proposal_id: str = Field(pattern=r"^[a-f0-9]{64}$")


class LibreLaneRepairProposalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    strategy: Literal["density", "cts"] = "density"


LIBRELANE_PROPOSAL_TTL_SECONDS = 15 * 60
LIBRELANE_CANDIDATE_DENSITY = 0.65
LIBRELANE_CTS_REPAIR_PARAMETER = "RUN_POST_CTS_RESIZER_TIMING"


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


def _load_librelane_run(run_id: str) -> tuple[Path, dict[str, Any]]:
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
    return run_root, payload


def _load_prepared_librelane_run(run_id: str) -> tuple[Path, dict[str, Any]]:
    run_root, payload = _load_librelane_run(run_id)
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
    if not isinstance(rtl, list) or not rtl or not all(isinstance(path, str) for path in rtl):
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


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _librelane_inputs_sha256(inputs_root: Path) -> str:
    if inputs_root.is_symlink() or not inputs_root.is_dir():
        raise ProjectStoreError("baseline LibreLane inputs are unavailable")
    entries: list[dict[str, object]] = []
    for candidate in sorted(inputs_root.rglob("*")):
        if candidate.is_symlink():
            raise ProjectStoreError("baseline LibreLane inputs contain an unsupported symbolic link")
        if candidate.is_dir():
            continue
        if not candidate.is_file():
            raise ProjectStoreError("baseline LibreLane inputs contain an unsupported file")
        entries.append({
            "path": candidate.relative_to(inputs_root).as_posix(),
            "size": candidate.stat().st_size,
            "sha256": hashlib.sha256(candidate.read_bytes()).hexdigest(),
        })
    if not entries:
        raise ProjectStoreError("baseline LibreLane inputs are empty")
    return _canonical_sha256(entries)


def _librelane_setup_wns(payload: dict[str, Any]) -> float:
    execution = payload.get("execution")
    result = execution.get("result") if isinstance(execution, dict) else None
    readback = result.get("readback") if isinstance(result, dict) else None
    metrics = readback.get("metrics") if isinstance(readback, dict) else None
    value = metrics.get("timing__setup__wns") if isinstance(metrics, dict) else None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProjectStoreError("native LibreLane setup WNS is unavailable")
    return float(value)


def _create_librelane_proposal(
    run_root: Path,
    payload: dict[str, Any],
    strategy: Literal["density", "cts"] = "density",
) -> dict[str, Any]:
    if payload.get("state") != "succeeded":
        existing = payload.get("proposal")
        if payload.get("state") == "proposal_ready" and isinstance(existing, dict) and existing.get("state") == "awaiting_approval":
            try:
                expires_at = datetime.fromisoformat(str(existing.get("expires_at")))
            except ValueError as error:
                raise ProjectStoreError("LibreLane repair proposal expiry is invalid") from error
            if expires_at.tzinfo is None or datetime.now(UTC) < expires_at:
                raise ProjectStoreError("this LibreLane baseline already has a repair proposal")
            payload["proposal"] = None
            payload["state"] = "succeeded"
        else:
            raise ProjectStoreError("a succeeded LibreLane baseline is required before proposing a repair")
    if payload.get("proposal") is not None:
        raise ProjectStoreError("this LibreLane baseline already has a repair proposal")
    baseline_wns = _librelane_setup_wns(payload)
    if baseline_wns >= 0:
        raise ProjectStoreError("a bounded repair requires a measured negative setup WNS")
    preparation = payload.get("preparation")
    if not isinstance(preparation, dict):
        raise ProjectStoreError("LibreLane preparation provenance is missing")
    config_path = str(preparation.get("config_path", ""))
    declared_config = run_root / config_path
    config_file = declared_config.resolve()
    if declared_config.is_symlink() or not config_file.is_file() or not config_file.is_relative_to(run_root.resolve()):
        raise ProjectStoreError("baseline LibreLane config is unavailable")
    if hashlib.sha256(config_file.read_bytes()).hexdigest() != preparation.get("config_sha256"):
        raise ProjectStoreError("baseline LibreLane config hash no longer matches")
    try:
        config = json.loads(config_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProjectStoreError("baseline LibreLane config is unreadable") from error
    if not isinstance(config, dict):
        raise ProjectStoreError("baseline LibreLane config is invalid")
    if strategy == "density" and config.get("PL_TARGET_DENSITY") != 0.60:
        raise ProjectStoreError("baseline LibreLane density is outside the supported repair boundary")
    if strategy == "cts" and config.get(LIBRELANE_CTS_REPAIR_PARAMETER) is not False:
        raise ProjectStoreError("baseline LibreLane CTS timing repair is outside the supported repair boundary")
    created_at = datetime.now(UTC)
    expires_at = created_at.timestamp() + LIBRELANE_PROPOSAL_TTL_SECONDS
    if strategy == "cts":
        action = {
            "type": "librelane_flow_parameter",
            "parameter": LIBRELANE_CTS_REPAIR_PARAMETER,
            "from": 0,
            "to": 1,
            "scope": "one_candidate_librelane_rerun",
            "functional_inputs_unchanged": True,
        }
        rationale = {
            "hypothesis": "啟用 post-CTS timing repair 可能透過 buffer 與 cell sizing 改善最差 setup path。",
            "expected_signal": "candidate 的 native setup WNS 或 TNS 改善。",
            "confidence": "heuristic_requires_measurement",
        }
        tradeoffs = [
            "候選流程可能需要更多執行時間。",
            "buffer 與 cell sizing 可能增加面積或功耗。",
            "candidate 必須重新讀回 native metrics 才能判定結果。",
        ]
    else:
        action = {
            "type": "librelane_flow_parameter",
            "parameter": "PL_TARGET_DENSITY",
            "from": 0.60,
            "to": LIBRELANE_CANDIDATE_DENSITY,
            "scope": "one_candidate_librelane_rerun",
            "functional_inputs_unchanged": True,
        }
        rationale = {
            "hypothesis": "提高 placement 利用率可能增加擁塞，但有機會改善最差 setup path 的繞線與延遲。",
            "expected_signal": "candidate 的 native setup WNS 或 TNS 改善。",
            "confidence": "heuristic_requires_measurement",
        }
        tradeoffs = [
            "placement、routing 可能變慢。",
            "密度改變可能造成 congestion 或面積代價。",
            "candidate 必須重新讀回 native metrics 才能判定結果。",
        ]
    binding = {
        "run_id": payload.get("run_id"),
        "source_revision": payload.get("source_revision"),
        "config_sha256": preparation.get("config_sha256"),
        "inputs_sha256": _librelane_inputs_sha256(run_root / "inputs"),
        "baseline_wns": baseline_wns,
    }
    proposal_id = _canonical_sha256({"binding": binding, "action": action})
    proposal = {
        "schema_version": "xylon-librelane-repair-proposal/v1",
        "proposal_id": proposal_id,
        "state": "awaiting_approval",
        "created_at": created_at.isoformat(),
        "expires_at": datetime.fromtimestamp(expires_at, UTC).isoformat(),
        "binding": binding,
        "action": action,
        "rationale": rationale,
        "tradeoffs": tradeoffs,
    }
    payload["proposal"] = proposal
    payload["state"] = "proposal_ready"
    payload["next_action"] = "Review the bounded placement-density proposal, then approve one candidate rerun."
    _persist_librelane_run(run_root, payload)
    return proposal


def _stage_librelane_candidate(run_root: Path, payload: dict[str, Any], proposal: dict[str, Any]) -> tuple[Path, LibreLaneMaterializedProject]:
    candidate_root = run_root / "candidate" / proposal["proposal_id"][:16]
    if candidate_root.exists() or candidate_root.is_symlink():
        raise ProjectStoreError("candidate run directory already exists")
    source_inputs = run_root / "inputs"
    if source_inputs.is_symlink() or not source_inputs.is_dir():
        raise ProjectStoreError("baseline LibreLane inputs are unavailable")
    if any(candidate.is_symlink() for candidate in source_inputs.rglob("*")):
        raise ProjectStoreError("baseline LibreLane inputs contain an unsupported symbolic link")
    try:
        shutil.copytree(source_inputs, candidate_root / "inputs", symlinks=False)
        preparation = payload.get("preparation")
        if not isinstance(preparation, dict):
            raise ProjectStoreError("LibreLane preparation provenance is missing")
        config_path = str(preparation.get("config_path", ""))
        baseline_config = (run_root / config_path).resolve()
        config = json.loads(baseline_config.read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            raise ProjectStoreError("baseline LibreLane config is invalid")
        action = proposal.get("action")
        if not isinstance(action, dict):
            raise ProjectStoreError("LibreLane repair action is missing")
        if action.get("parameter") == "PL_TARGET_DENSITY":
            config["PL_TARGET_DENSITY"] = LIBRELANE_CANDIDATE_DENSITY
        elif action.get("parameter") == LIBRELANE_CTS_REPAIR_PARAMETER:
            config[LIBRELANE_CTS_REPAIR_PARAMETER] = True
        else:
            raise ProjectStoreError("LibreLane repair action is outside the supported boundary")
        candidate_config = candidate_root / "config.json"
        candidate_config.write_text(json.dumps(config, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        candidate_config.chmod(0o600)
        manifest = payload.get("manifest")
        if not isinstance(manifest, dict):
            raise ProjectStoreError("LibreLane design manifest is missing")
        rtl = manifest.get("rtl")
        if not isinstance(rtl, list) or not rtl or not all(isinstance(path, str) for path in rtl):
            raise ProjectStoreError("LibreLane RTL manifest is invalid")
        sdc = manifest.get("sdc")
        top = manifest.get("top")
        source_revision = payload.get("source_revision")
        if not isinstance(sdc, str) or not isinstance(top, str) or not isinstance(source_revision, str):
            raise ProjectStoreError("LibreLane design identity is missing")
        project = LibreLaneMaterializedProject(
            request={"platform": "sky130hd", "run_id": payload["run_id"], "config_path": "config.json"},
            top=top,
            source_revision=source_revision,
            design_path=f"inputs/project/{rtl[0]}",
            sdc_path=f"inputs/project/{sdc}",
            config_path="config.json",
        )
        return candidate_root, project
    except Exception:
        shutil.rmtree(candidate_root, ignore_errors=True)
        raise


def _validate_librelane_proposal(
    run_root: Path,
    payload: dict[str, Any],
    proposal_id: str,
) -> dict[str, Any]:
    if payload.get("state") != "proposal_ready":
        raise ProjectStoreError("LibreLane run has no repair proposal awaiting approval")
    proposal = payload.get("proposal")
    if not isinstance(proposal, dict) or proposal.get("state") != "awaiting_approval":
        raise ProjectStoreError("LibreLane repair proposal is not awaiting approval")
    if proposal.get("proposal_id") != proposal_id:
        raise ProjectStoreError("LibreLane repair approval does not match the saved proposal")
    try:
        expires_at = datetime.fromisoformat(str(proposal.get("expires_at")))
    except ValueError as error:
        raise ProjectStoreError("LibreLane repair proposal expiry is invalid") from error
    if expires_at.tzinfo is None or datetime.now(UTC) >= expires_at:
        raise ProjectStoreError("LibreLane repair proposal has expired; create a new baseline run")
    binding = proposal.get("binding")
    action = proposal.get("action")
    preparation = payload.get("preparation")
    if not isinstance(binding, dict) or not isinstance(action, dict) or not isinstance(preparation, dict):
        raise ProjectStoreError("LibreLane repair proposal provenance is invalid")
    declared_config = run_root / str(preparation.get("config_path", ""))
    config_path = declared_config.resolve()
    if declared_config.is_symlink() or not config_path.is_file() or not config_path.is_relative_to(run_root.resolve()):
        raise ProjectStoreError("baseline LibreLane config is unavailable")
    current_config_sha256 = hashlib.sha256(config_path.read_bytes()).hexdigest()
    if (
        binding.get("run_id") != payload.get("run_id")
        or binding.get("source_revision") != payload.get("source_revision")
        or binding.get("config_sha256") != preparation.get("config_sha256")
        or binding.get("config_sha256") != current_config_sha256
        or binding.get("inputs_sha256") != _librelane_inputs_sha256(run_root / "inputs")
        or proposal_id != _canonical_sha256({"binding": binding, "action": action})
    ):
        raise ProjectStoreError("LibreLane repair proposal no longer matches the baseline")
    expected_actions = [
        {
            "type": "librelane_flow_parameter",
            "parameter": "PL_TARGET_DENSITY",
            "from": 0.60,
            "to": LIBRELANE_CANDIDATE_DENSITY,
            "scope": "one_candidate_librelane_rerun",
            "functional_inputs_unchanged": True,
        },
        {
            "type": "librelane_flow_parameter",
            "parameter": LIBRELANE_CTS_REPAIR_PARAMETER,
            "from": 0,
            "to": 1,
            "scope": "one_candidate_librelane_rerun",
            "functional_inputs_unchanged": True,
        },
    ]
    if action not in expected_actions:
        raise ProjectStoreError("LibreLane repair action is outside the supported boundary")
    return proposal


def _candidate_metrics(result: dict[str, Any]) -> dict[str, Any]:
    readback = result.get("readback")
    metrics = readback.get("metrics") if isinstance(readback, dict) else None
    if not isinstance(metrics, dict):
        raise ProjectStoreError("candidate LibreLane native metrics are unavailable")
    return metrics


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


@router.post("/openroad/librelane-project-runs/{run_id}/proposal")
async def post_librelane_repair_proposal(
    run_id: str,
    request: LibreLaneRepairProposalRequest | None = None,
) -> dict[str, Any]:
    """Persist one bounded repair proposal from a measured negative-WNS baseline."""
    try:
        run_root, payload = _load_librelane_run(run_id)
        proposal = _create_librelane_proposal(run_root, payload, (request or LibreLaneRepairProposalRequest()).strategy)
        return {
            "run_id": run_id,
            "state": payload["state"],
            "proposal": proposal,
            "next_action": payload["next_action"],
        }
    except (OSError, json.JSONDecodeError, KeyError, ProjectStoreError) as error:
        raise HTTPException(status_code=422, detail={
            "error": "LibreLaneRepairProposalInvalid",
            "message": str(error),
            "recovery": "Use a succeeded baseline with measured negative setup WNS, or create a fresh baseline run.",
            "run_id": run_id,
        }) from error


@router.post("/openroad/librelane-project-runs/{run_id}/repair")
async def post_librelane_repair_execution(
    run_id: str,
    request: LibreLaneRepairApprovalRequest,
) -> dict[str, Any]:
    """Run the exact saved bounded repair once after approval and a fresh readiness check."""
    if not request.approved:
        raise HTTPException(status_code=403, detail={
            "error": "LibreLaneRepairApprovalRequired",
            "message": "Xylon will not run the repair candidate until the user explicitly approves the saved proposal.",
            "recovery": "Review the proposal and call this endpoint again with approved=true and its exact proposal_id.",
        })
    try:
        run_root, payload = _load_librelane_run(run_id)
        proposal = _validate_librelane_proposal(run_root, payload, request.proposal_id)
    except (OSError, json.JSONDecodeError, KeyError, ProjectStoreError) as error:
        raise HTTPException(status_code=422, detail={
            "error": "LibreLaneRepairApprovalInvalid",
            "message": str(error),
            "recovery": "Approve the exact unexpired saved proposal, or create a fresh baseline run and proposal.",
            "run_id": run_id,
        }) from error
    candidate_staged = False
    try:
        probe = probe_librelane()
        readiness = await asyncio.to_thread(collect_librelane_readiness, REPO_ROOT, probe=probe)
        if readiness.get("state") != "ready":
            proposal["last_attempt"] = {
                "state": "blocked",
                "checked_at": datetime.now(UTC).isoformat(),
                "readiness": readiness,
            }
            payload["readiness"] = readiness
            payload["failure"] = {
                "code": "LibreLaneRepairReadinessBlocked",
                "message": "Xylon did not stage or start the repair candidate because the readiness gate is blocked.",
                "recovery": str(readiness.get("next_action", "Resolve the first readiness blocker, then retry.")),
            }
            payload["next_action"] = payload["failure"]["recovery"]
            _persist_librelane_run(run_root, payload)
            raise HTTPException(status_code=409, detail=payload["failure"])
        proposal = _validate_librelane_proposal(run_root, payload, request.proposal_id)
        candidate_root, project = _stage_librelane_candidate(run_root, payload, proposal)
        candidate_staged = True
        candidate_config = candidate_root / project.config_path
        proposal["state"] = "approved"
        proposal["approved_at"] = datetime.now(UTC).isoformat()
        payload["state"] = "candidate_staged"
        payload["candidate"] = {
            "state": "staged",
            "proposal_id": proposal["proposal_id"],
            "source_revision": payload.get("source_revision"),
            "baseline_config_sha256": proposal["binding"]["config_sha256"],
            "baseline_inputs_sha256": proposal["binding"]["inputs_sha256"],
            "root": candidate_root.relative_to(run_root).as_posix(),
            "config_path": project.config_path,
            "config_sha256": hashlib.sha256(candidate_config.read_bytes()).hexdigest(),
            "staged_at": datetime.now(UTC).isoformat(),
        }
        _persist_librelane_run(run_root, payload)
        plan = build_execution_plan(probe, run_dir=candidate_root, project=project)
        payload["state"] = "candidate_running"
        payload["readiness"] = readiness
        payload["failure"] = None
        payload["candidate"].update({
            "state": "running",
            "plan_identity_sha256": plan.plan_identity_sha256,
            "runtime_identity": asdict(plan.identity),
            "started_at": datetime.now(UTC).isoformat(),
        })
        _persist_librelane_run(run_root, payload)
        result = await asyncio.to_thread(execute_plan, REPO_ROOT, run_dir=candidate_root, plan=plan)
        baseline_wns = _librelane_setup_wns(payload)
        candidate_metrics = _candidate_metrics(result)
        candidate_wns_value = candidate_metrics.get("timing__setup__wns")
        if isinstance(candidate_wns_value, bool) or not isinstance(candidate_wns_value, (int, float)):
            raise ProjectStoreError("candidate LibreLane setup WNS is unavailable")
        candidate_wns = float(candidate_wns_value)
        baseline_execution = payload.get("execution")
        baseline_result = baseline_execution.get("result") if isinstance(baseline_execution, dict) else None
        baseline_readback = baseline_result.get("readback") if isinstance(baseline_result, dict) else None
        baseline_metrics = baseline_readback.get("metrics") if isinstance(baseline_readback, dict) else None
        if not isinstance(baseline_metrics, dict):
            raise ProjectStoreError("baseline LibreLane native metrics are unavailable")
        delta = candidate_wns - baseline_wns
        payload["state"] = "comparison_ready"
        proposal["state"] = "applied"
        payload["candidate"].update({
            "state": "succeeded",
            "finished_at": datetime.now(UTC).isoformat(),
            "result": result,
        })
        payload["comparison"] = {
            "schema_version": "xylon-librelane-comparison/v1",
            "baseline_metrics": baseline_metrics,
            "candidate_metrics": candidate_metrics,
            "setup_wns": {
                "baseline": baseline_wns,
                "candidate": candidate_wns,
                "delta": delta,
                "improved": delta > 0,
                "timing_met": candidate_wns >= 0,
            },
        }
        payload["failure"] = None
        payload["next_action"] = (
            "Review the measured comparison before choosing whether to keep the candidate settings."
        )
        _persist_librelane_run(run_root, payload)
        return payload
    except HTTPException:
        raise
    except (
        OSError,
        json.JSONDecodeError,
        KeyError,
        ProjectStoreError,
        LibreLaneAdapterError,
        LibreLaneExecutionError,
    ) as error:
        if candidate_staged and "run_root" in locals() and "payload" in locals():
            payload["state"] = "candidate_failed"
            candidate = payload.get("candidate")
            if isinstance(candidate, dict):
                candidate["state"] = "failed"
                candidate["finished_at"] = datetime.now(UTC).isoformat()
            payload["failure"] = {
                "code": "LibreLaneRepairExecutionFailed",
                "message": str(error),
                "recovery": "Inspect the candidate evidence; keep the baseline unchanged and create a fresh baseline before another repair attempt.",
            }
            payload["next_action"] = payload["failure"]["recovery"]
            _persist_librelane_run(run_root, payload)
        raise HTTPException(status_code=422, detail={
            "error": "LibreLaneRepairExecutionFailed",
            "message": str(error),
            "recovery": "Keep the baseline unchanged and correct the first candidate failure before creating a fresh repair proposal.",
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
