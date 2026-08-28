"""Local API for the evidence-backed OpenROAD timing journey."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from uuid import uuid4
from weakref import WeakKeyDictionary

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from agent.api import LOCAL_WEB_ORIGINS
from agent.api.execution import run_in_local_eda_slot
from agent.local_app import ManagedProcess, collect_resource_snapshot, terminate_managed_process
from agent.openroad.project_manifest import preflight_project_manifest
from agent.openroad.project_store import ProjectStoreError, materialize_timing_input
from agent.openroad.resource import (
    MINIMUM_DISK_FREE_GIB,
    MINIMUM_MEMORY_AVAILABLE_GIB,
    MINIMUM_MEMORY_FREE_PERCENT,
    evaluate_openroad_preflight,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["timing"])

REPO_ROOT = Path(__file__).resolve().parents[3]
TIMING_BRIDGE = REPO_ROOT / "agent" / "timing" / "api-bridge.mjs"
MAX_TIMING_RTL_BYTES = 1024 * 1024
MAX_TIMING_SDC_BYTES = 16 * 1024
MAX_TIMING_BODY_BYTES = MAX_TIMING_RTL_BYTES + MAX_TIMING_SDC_BYTES + 32 * 1024
MAX_BRIDGE_OUTPUT_BYTES = 2 * 1024 * 1024
TIMING_OPERATION_ROOT = REPO_ROOT / ".xylon" / "timing" / "operations"
TIMING_CANCEL_WAIT_SECONDS = 20.0
TIMING_ADMISSION_POLL_SECONDS = 5.0
MAX_TIMING_OPERATION_BYTES = 1024 * 1024
MAX_TIMING_OPERATIONS = 256


@dataclass
class ActiveTimingJob:
    run_id: str
    command: str
    payload: dict
    public_state: dict
    cancel_requested: asyncio.Event = field(default_factory=asyncio.Event)
    done: asyncio.Event = field(default_factory=asyncio.Event)
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task[None] | None = None
    result: dict | None = None
    error: HTTPException | None = None
    signal_sent: signal.Signals | None = None


class TimingJobCancelledBeforeStart(Exception):
    """The exact queued timing job was cancelled before a bridge was spawned."""


_TIMING_JOBS_BY_LOOP: WeakKeyDictionary[
    asyncio.AbstractEventLoop,
    dict[str, ActiveTimingJob],
] = WeakKeyDictionary()
_TIMING_RECOVERY_VERIFIED_BY_LOOP: WeakKeyDictionary[
    asyncio.AbstractEventLoop,
    bool,
] = WeakKeyDictionary()

TIMING_RECOVERY_BLOCKER = (
    "an interrupted OpenROAD job has not passed exact-owner cleanup verification"
)


def _active_timing_jobs() -> dict[str, ActiveTimingJob]:
    loop = asyncio.get_running_loop()
    jobs = _TIMING_JOBS_BY_LOOP.get(loop)
    if jobs is None:
        jobs = {}
        _TIMING_JOBS_BY_LOOP[loop] = jobs
    return jobs


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _operation_path(run_id: str) -> Path:
    return TIMING_OPERATION_ROOT / f"{run_id}.json"


def _write_operation_sync(run_id: str, document: dict) -> None:
    TIMING_OPERATION_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = _operation_path(run_id)
    temporary = destination.with_name(
        f".{destination.name}.{os.getpid()}.{uuid4().hex}.tmp"
    )
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _read_operation_sync(path: Path) -> dict:
    stat = path.lstat()
    if path.is_symlink() or not path.is_file() or stat.st_size > MAX_TIMING_OPERATION_BYTES:
        raise ValueError("timing operation journal is not a bounded regular file")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("timing operation journal must contain an object")
    return value


async def _persist_operation(job: ActiveTimingJob, state: str) -> None:
    await asyncio.to_thread(
        _write_operation_sync,
        job.run_id,
        {
            "schema_version": "xylon-timing-operation/v1",
            "run_id": job.run_id,
            "command": job.command,
            "state": state,
            "bridge_pid": job.process.pid if job.process else None,
            "source_revision": os.environ.get("XYLON_SOURCE_REVISION"),
            "updated_at": _utc_now(),
            "public_state": job.result or job.public_state,
        },
    )


def _pending_public_state(command: str, payload: dict, current: dict | None = None) -> dict:
    if current is not None:
        return {
            **current,
            "phase": "candidate_queued" if command == "execute" else "queued",
            "failure": None,
        }
    return {
        "schema_version": "xylon-timing-api/v1",
        "run_id": payload["run_id"],
        "phase": "queued",
        "platform": payload.get("platform", "sky130hd"),
        "top_module": payload.get("top_module"),
        "source_revision": payload.get("source_revision") or os.environ.get("XYLON_SOURCE_REVISION"),
        "clock": None,
        "metrics": None,
        "evidence": None,
        "proposal": None,
        "confirmation": None,
        "comparison": None,
        "failure": None,
    }


def _blocked_job_state(job: ActiveTimingJob, detail: dict) -> dict:
    return {
        **job.public_state,
        "phase": "cancelled" if detail.get("error") in {
            "TimingRunCancelled",
            "TimingRunCancelledBeforeStart",
        } else "blocked",
        "failure": {
            "code": str(detail.get("error", "TimingRunBlocked"))[:128],
            "message": str(detail.get("message", "The timing job did not complete."))[:2048],
            "recovery": str(detail.get("recovery", "Review the timing status, then retry."))[:2048],
            "candidate_run_id": None,
        },
    }


def _bounded_utf8(field_name: str, value: str, maximum: int) -> str:
    size = len(value.encode("utf-8"))
    if size == 0 or size > maximum:
        raise ValueError(f"{field_name} must be between 1 and {maximum} UTF-8 bytes")
    return value


class TimingRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    rtl: str = Field(min_length=1, max_length=MAX_TIMING_RTL_BYTES)
    sdc: str = Field(min_length=1, max_length=MAX_TIMING_SDC_BYTES)
    top_module: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z_][A-Za-z0-9_$]*$")
    platform: Literal["sky130hd"] = "sky130hd"

    @field_validator("rtl")
    @classmethod
    def validate_rtl_bytes(cls, value: str) -> str:
        return _bounded_utf8("rtl", value, MAX_TIMING_RTL_BYTES)

    @field_validator("sdc")
    @classmethod
    def validate_sdc_bytes(cls, value: str) -> str:
        return _bounded_utf8("sdc", value, MAX_TIMING_SDC_BYTES)


class TimingProjectRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    project_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")


class TimingConfirmationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    typed_token: str = Field(pattern=r"^[a-f0-9]{12}$")


class TimingCandidateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    confirmation_id: str = Field(pattern=r"^[a-f0-9]{32,64}$")


def _bridge_environment() -> dict[str, str]:
    environment: dict[str, str] = {}
    for key in (
        "PATH",
        "HOME",
        "TMPDIR",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "XYLON_OPENROAD_CPUS",
        "XYLON_SOURCE_REVISION",
    ):
        value = os.environ.get(key)
        if value:
            environment[key] = value
    return environment


def _http_status(error_code: str) -> int:
    if error_code in {"TimingRunNotFound"}:
        return 404
    if "InputInvalid" in error_code or error_code in {
        "UsageError",
        "InvalidSourceRevision",
        "TimingRunInvalid",
        "TimingProposalInvalid",
        "TimingConfirmationInvalid",
        "TimingTopModuleInvalid",
        "TimingClockConstraintInvalid",
    }:
        return 422
    if "Expired" in error_code:
        return 410
    if any(token in error_code for token in ("Busy", "Exists", "Consumed", "Rejected", "Changed")):
        return 409
    if error_code == "ResourceAdmissionBlocked" or any(
        token in error_code for token in ("Runtime", "Cleanup", "Timeout", "Interrupted", "EvidenceReadback")
    ):
        return 503
    return 500


def _require_local_browser_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin not in LOCAL_WEB_ORIGINS:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "TimingConfirmationOriginRejected",
                "message": "Timing confirmation must come from the local Xylon workspace.",
                "recovery": "Open the timing workbench from the local Xylon application and confirm there.",
            },
        )


def _signal_timing_bridge(job: ActiveTimingJob, requested_signal: signal.Signals) -> None:
    process = job.process
    if process is None or process.returncode is not None:
        return
    if job.signal_sent == signal.SIGTERM or job.signal_sent == requested_signal:
        return
    try:
        process.send_signal(requested_signal)
        job.signal_sent = requested_signal
    except ProcessLookupError:
        pass


async def _invoke_timing_bridge(
    command: str,
    payload: dict,
    *,
    job: ActiveTimingJob | None = None,
) -> dict:
    if not TIMING_BRIDGE.is_file():
        raise HTTPException(status_code=500, detail={
            "error": "TimingBridgeUnavailable",
            "message": "The local timing bridge is not installed.",
            "recovery": "Restore the Xylon application files and rerun the local launcher check.",
        })
    process = await asyncio.create_subprocess_exec(
        "node",
        os.fspath(TIMING_BRIDGE),
        command,
        str(payload.get("run_id", "")),
        cwd=os.fspath(REPO_ROOT),
        env=_bridge_environment(),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    if job is not None:
        job.process = process
        await _persist_operation(job, "cancelling" if job.cancel_requested.is_set() else "running")
        if job.cancel_requested.is_set():
            _signal_timing_bridge(job, signal.SIGUSR1)
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    stdout, stderr = await process.communicate(encoded)
    if len(stdout) > MAX_BRIDGE_OUTPUT_BYTES or len(stderr) > MAX_BRIDGE_OUTPUT_BYTES:
        raise HTTPException(status_code=500, detail={
            "error": "TimingBridgeOutputExceeded",
            "message": "The timing bridge returned more data than the local API accepts.",
            "recovery": "Inspect the bounded timing runtime logs, then rerun after correcting repeated output.",
        })
    selected = stdout if process.returncode == 0 else stderr
    try:
        response = json.loads(selected.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail={
            "error": "TimingBridgeResponseInvalid",
            "message": "The timing bridge returned an invalid local response.",
            "recovery": "Run scripts/xylon-openroad doctor, then retry the timing task.",
        }) from exc
    if not isinstance(response, dict):
        raise HTTPException(status_code=500, detail={
            "error": "TimingBridgeResponseInvalid",
            "message": "The timing bridge response was not an object.",
            "recovery": "Run scripts/xylon-openroad doctor, then retry the timing task.",
        })
    if process.returncode != 0:
        error_code = str(response.get("error", "TimingBridgeFailed"))[:128]
        raise HTTPException(status_code=_http_status(error_code), detail={
            "error": error_code,
            "message": str(response.get("message", "The timing task failed."))[:2048],
            "recovery": str(response.get("recovery", "Review the timing evidence and retry."))[:2048],
            **({"run_id": response["run_id"]} if isinstance(response.get("run_id"), str) else {}),
        })
    return response


async def _execute_heavy_timing_job(job: ActiveTimingJob) -> dict:
    async def admitted_operation() -> dict:
        if job.cancel_requested.is_set():
            raise TimingJobCancelledBeforeStart
        await _require_timing_admission()
        if job.cancel_requested.is_set():
            raise TimingJobCancelledBeforeStart
        return await _invoke_timing_bridge(job.command, job.payload, job=job)

    async def queued_operation() -> dict:
        while True:
            if job.cancel_requested.is_set():
                raise TimingJobCancelledBeforeStart from None
            try:
                await _require_timing_admission()
            except HTTPException as exc:
                detail = exc.detail if isinstance(exc.detail, dict) else {}
                if detail.get("error") != "ResourceAdmissionBlocked" or detail.get("retryable") is not True:
                    raise
                await _persist_operation(job, "waiting_for_resources")
                try:
                    await asyncio.wait_for(
                        job.cancel_requested.wait(),
                        timeout=TIMING_ADMISSION_POLL_SECONDS,
                    )
                except TimeoutError:
                    continue
                raise TimingJobCancelledBeforeStart from None
            try:
                return await run_in_local_eda_slot(admitted_operation)
            except HTTPException as exc:
                detail = exc.detail if isinstance(exc.detail, dict) else {}
                if detail.get("error") != "ResourceAdmissionBlocked" or detail.get("retryable") is not True:
                    raise

    operation = asyncio.create_task(queued_operation())
    cancelled = asyncio.create_task(job.cancel_requested.wait())
    try:
        completed, _pending = await asyncio.wait(
            {operation, cancelled},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if operation in completed:
            return await operation
        if job.process is None:
            operation.cancel()
            try:
                await operation
            except asyncio.CancelledError:
                pass
            raise TimingJobCancelledBeforeStart
        _signal_timing_bridge(job, signal.SIGUSR1)
        return await operation
    finally:
        cancelled.cancel()
        try:
            await cancelled
        except asyncio.CancelledError:
            pass


async def _drive_timing_job(job: ActiveTimingJob) -> None:
    try:
        job.result = await _execute_heavy_timing_job(job)
    except TimingJobCancelledBeforeStart:
        job.result = _blocked_job_state(job, {
            "error": "TimingRunCancelledBeforeStart",
            "message": "The queued timing job was stopped before OpenROAD started.",
            "recovery": "Review the inputs, then start a new timing baseline when you are ready.",
        })
    except HTTPException as exc:
        job.error = exc
        detail = exc.detail if isinstance(exc.detail, dict) else {
            "error": f"TimingHttp{exc.status_code}",
            "message": str(exc.detail),
            "recovery": "Review the timing status, then retry.",
        }
        try:
            if not isinstance(detail.get("run_id"), str):
                raise HTTPException(status_code=404, detail="No persisted timing run")
            job.result = await _invoke_timing_bridge("status", {"run_id": job.run_id})
        except HTTPException:
            job.result = _blocked_job_state(job, detail)
    except Exception:
        logger.exception("Unhandled timing job failure: run_id=%s command=%s", job.run_id, job.command)
        job.result = _blocked_job_state(job, {
            "error": "TimingJobFailed",
            "message": "The local timing job failed before a verified result was available.",
            "recovery": "Read the saved run status, then run scripts/xylon doctor before retrying.",
        })
    finally:
        await _persist_operation(job, "terminal")
        job.done.set()
        _active_timing_jobs().pop(job.run_id, None)


async def _start_timing_job(
    command: str,
    payload: dict,
    *,
    current: dict | None = None,
) -> ActiveTimingJob:
    run_id = str(payload.get("run_id", ""))
    active_jobs = _active_timing_jobs()
    if run_id in active_jobs:
        raise HTTPException(status_code=409, detail={
            "error": "TimingRunBusy",
            "message": "This timing run already has an active operation.",
            "recovery": "Keep the current run open and wait for its saved status, or stop that run explicitly.",
            "run_id": run_id,
        })
    job = ActiveTimingJob(
        run_id=run_id,
        command=command,
        payload=payload,
        public_state=_pending_public_state(command, payload, current),
    )
    active_jobs[run_id] = job
    await _persist_operation(job, "queued")
    job.task = asyncio.create_task(_drive_timing_job(job), name=f"timing-{command}-{run_id}")
    return job


async def _run_heavy_timing(command: str, payload: dict) -> dict:
    """Run a managed job and wait for its result for assistant/tool callers."""
    await _reject_nonretryable_timing_admission()
    job = await _start_timing_job(command, payload)
    await job.done.wait()
    if job.error is not None:
        raise job.error
    assert job.result is not None
    return job.result


async def cancel_active_timing_jobs(*, shutdown: bool = False) -> bool:
    jobs = list(_active_timing_jobs().values())
    for job in jobs:
        await _persist_operation(job, "cancelling")
        job.cancel_requested.set()
        if job.process is not None:
            _signal_timing_bridge(job, signal.SIGTERM if shutdown else signal.SIGUSR1)
    if not jobs:
        return True
    try:
        await asyncio.wait_for(
            asyncio.gather(*(job.done.wait() for job in jobs)),
            timeout=TIMING_CANCEL_WAIT_SECONDS,
        )
    except TimeoutError:
        logger.error("Timing job cleanup did not finish before the bounded shutdown deadline")
        return False
    return True


async def reconcile_interrupted_timing_jobs() -> bool:
    try:
        operation_paths = sorted(TIMING_OPERATION_ROOT.glob("*.json"))
    except OSError:
        logger.exception("Unable to enumerate timing operation journals")
        _TIMING_RECOVERY_VERIFIED_BY_LOOP[asyncio.get_running_loop()] = False
        return False
    if len(operation_paths) > MAX_TIMING_OPERATIONS:
        logger.error("Timing operation journal count exceeds the bounded recovery limit")
        _TIMING_RECOVERY_VERIFIED_BY_LOOP[asyncio.get_running_loop()] = False
        return False
    recovered = True
    for operation_path in operation_paths:
        try:
            operation = await asyncio.to_thread(_read_operation_sync, operation_path)
            if operation.get("state") == "terminal":
                continue
            run_id = operation.get("run_id")
            command = operation.get("command")
            if (
                not isinstance(run_id, str)
                or operation_path.name != f"{run_id}.json"
                or len(run_id) != 32
                or any(character not in "0123456789abcdef" for character in run_id)
                or command not in {"analyze", "execute"}
            ):
                raise ValueError("timing operation identity is invalid")
            pending_state = operation.get("public_state")
            if not isinstance(pending_state, dict):
                raise ValueError("timing operation public state is invalid")
            bridge_pid = operation.get("bridge_pid")
            if isinstance(bridge_pid, int) and bridge_pid > 0:
                marker = f"{TIMING_BRIDGE} {command} {run_id}"
                stop_result = await asyncio.to_thread(
                    terminate_managed_process,
                    ManagedProcess("timing-bridge", bridge_pid, marker, ""),
                    grace_seconds=TIMING_CANCEL_WAIT_SECONDS / 2,
                )
                if stop_result in {"identity_mismatch", "identity_unavailable", "cleanup_unverified"}:
                    failure = {
                        "error": "TimingCleanupUnverified",
                        "message": "Xylon could not verify the interrupted timing bridge identity and cleanup.",
                        "recovery": "Do not start another EDA run. Run scripts/xylon-openroad doctor and inspect only the exact saved Run ID.",
                    }
                    terminal = _blocked_job_state(
                        ActiveTimingJob(run_id, command, {}, pending_state),
                        failure,
                    )
                    await asyncio.to_thread(_write_operation_sync, run_id, {
                        **operation,
                        "state": "terminal",
                        "updated_at": _utc_now(),
                        "public_state": terminal,
                        "recovery_stop_result": stop_result,
                    })
                    recovered = False
                    continue
            try:
                terminal = await _invoke_timing_bridge("recover", {"run_id": run_id})
            except HTTPException as exc:
                if exc.status_code == 404 and not isinstance(bridge_pid, int):
                    terminal = _blocked_job_state(
                        ActiveTimingJob(run_id, command, {}, pending_state),
                        {
                            "error": "TimingRunCancelledBeforeStart",
                            "message": "The queued timing job ended when the local API restarted before OpenROAD started.",
                            "recovery": "Review the saved inputs, then start a new timing baseline when ready.",
                        },
                    )
                else:
                    detail = exc.detail if isinstance(exc.detail, dict) else {}
                    terminal = _blocked_job_state(
                        ActiveTimingJob(run_id, command, {}, pending_state),
                        {
                            "error": detail.get("error", "TimingCleanupUnverified"),
                            "message": detail.get("message", "Timing restart recovery failed."),
                            "recovery": detail.get("recovery", "Run scripts/xylon-openroad doctor before starting another EDA run."),
                        },
                    )
                    recovered = False
            await asyncio.to_thread(_write_operation_sync, run_id, {
                **operation,
                "state": "terminal",
                "updated_at": _utc_now(),
                "public_state": terminal,
            })
        except (OSError, ValueError, json.JSONDecodeError):
            logger.exception("Invalid timing operation journal during startup recovery: %s", operation_path)
            recovered = False
    _TIMING_RECOVERY_VERIFIED_BY_LOOP[asyncio.get_running_loop()] = recovered
    return recovered


def _configured_timing_cpus() -> int | None:
    configured = os.environ.get("XYLON_OPENROAD_CPUS", "1")
    return int(configured) if configured in {"1", "2", "3", "4"} else None


def _timing_recovery_verified() -> bool:
    """Return the startup recovery gate for this API event loop.

    The FastAPI lifespan always initializes the gate before accepting requests.
    Direct unit callers that do not run an application lifespan retain the
    historical ready default and still exercise the resource admission logic.
    """
    return _TIMING_RECOVERY_VERIFIED_BY_LOOP.get(asyncio.get_running_loop(), True)


def _timing_readiness(snapshot, *, recovery_verified: bool = True) -> dict:
    requested_cpus = _configured_timing_cpus()
    resource_blockers = (
        evaluate_openroad_preflight(snapshot, requested_cpus=requested_cpus)
        if requested_cpus is not None
        else ["OpenROAD CPU budget must be an integer from 1 to 4"]
    )
    blockers = [TIMING_RECOVERY_BLOCKER] if not recovery_verified else []
    blockers.extend(resource_blockers)
    retryable = bool(blockers) and recovery_verified and requested_cpus is not None
    return {
        "schema_version": "xylon-timing-readiness/v1",
        "state": "blocked" if blockers else "ready",
        "can_start_eda": not blockers,
        "can_queue_eda": retryable,
        "requested_cpus": requested_cpus,
        "thresholds": {
            "memory_available_bytes": int(MINIMUM_MEMORY_AVAILABLE_GIB * 1024**3),
            "memory_free_percent": MINIMUM_MEMORY_FREE_PERCENT,
            "disk_free_bytes": int(MINIMUM_DISK_FREE_GIB * 1024**3),
        },
        "resource": {
            "logical_cpus": snapshot.logical_cpus,
            "load_one_minute": snapshot.load_one_minute,
            "memory_available_bytes": snapshot.memory_available_bytes,
            "memory_free_percent": snapshot.memory_free_percent,
            "disk_free_bytes": snapshot.disk_free_bytes,
        },
        "blockers": blockers,
    }


async def _current_timing_readiness() -> dict:
    snapshot = await asyncio.to_thread(collect_resource_snapshot, REPO_ROOT)
    return _timing_readiness(
        snapshot,
        recovery_verified=_timing_recovery_verified(),
    )


async def _require_timing_admission() -> None:
    readiness = await _current_timing_readiness()
    if readiness["can_start_eda"]:
        return
    blockers = readiness["blockers"]
    recovery_blocked = TIMING_RECOVERY_BLOCKER in blockers
    raise HTTPException(
        status_code=503,
        detail={
            "error": "TimingCleanupUnverified" if recovery_blocked else "ResourceAdmissionBlocked",
            "message": (
                "Xylon cannot start another OpenROAD job because interrupted-job cleanup is unverified."
                if recovery_blocked
                else f"OpenROAD capacity is below the safety floor: {'; '.join(blockers)}"
            ),
            "recovery": (
                "Do not start another EDA run. Run scripts/xylon-openroad doctor and inspect only the exact saved Run ID."
                if recovery_blocked
                else "Wait for CPU, memory, and disk headroom, then refresh the timing workbench."
            ),
            "retryable": readiness["can_queue_eda"],
        },
    )


async def _reject_nonretryable_timing_admission() -> None:
    readiness = await _current_timing_readiness()
    if readiness["can_start_eda"] or readiness["can_queue_eda"]:
        return
    await _require_timing_admission()


@router.get("/timing/readiness")
async def get_timing_readiness() -> dict:
    return await _current_timing_readiness()


@router.post("/timing/runs", status_code=202)
async def create_timing_run(request: TimingRunRequest) -> dict:
    logger.info("Timing analysis requested: top_module=%s platform=%s", request.top_module, request.platform)
    await _reject_nonretryable_timing_admission()
    job = await _start_timing_job("analyze", request.model_dump())
    return job.public_state


@router.post("/timing/project-runs", status_code=202)
async def create_project_timing_run(request: TimingProjectRunRequest) -> dict:
    """Start the existing pinned timing flow from an imported project bundle."""
    project_root = REPO_ROOT / ".xylon" / "projects" / request.project_id
    manifest_path = project_root / "manifest.json"
    try:
        if not manifest_path.is_file() or manifest_path.is_symlink():
            raise ProjectStoreError("imported project manifest is unavailable; import the bundle again")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("project_id") != request.project_id:
            raise ProjectStoreError("imported project manifest identity is invalid")
        if manifest.get("state") != "ready":
            raise ProjectStoreError("project preflight is not ready; correct the bundle before timing")
        declared_manifest = manifest.get("manifest")
        if not isinstance(declared_manifest, dict):
            raise ProjectStoreError("imported project manifest payload is invalid")
        current_preflight = preflight_project_manifest(REPO_ROOT, declared_manifest)
        if current_preflight["state"] != "ready" or current_preflight["manifest"] is None:
            failure = current_preflight.get("failure") or {}
            raise ProjectStoreError(
                str(failure.get("message", "the imported project changed after preflight"))
            )
        if current_preflight["manifest"].get("source_revision") != declared_manifest.get("source_revision"):
            raise ProjectStoreError("imported project source revision changed after preflight")
        timing_input = materialize_timing_input(REPO_ROOT, current_preflight["manifest"])
    except (OSError, json.JSONDecodeError, KeyError, ProjectStoreError) as error:
        raise HTTPException(status_code=422, detail={
            "error": "ProjectTimingInputInvalid",
            "message": str(error),
            "recovery": "Import the project again and wait for a ready preflight before starting timing.",
            "project_id": request.project_id,
        }) from error
    await _reject_nonretryable_timing_admission()
    job = await _start_timing_job("analyze", {"run_id": request.run_id, **timing_input})
    return job.public_state


@router.get("/timing/runs/{run_id}")
async def get_timing_run(run_id: str) -> dict:
    if len(run_id) != 32 or any(character not in "0123456789abcdef" for character in run_id):
        raise HTTPException(status_code=422, detail="Timing run identity is invalid")
    active = _active_timing_jobs().get(run_id)
    if active is not None:
        try:
            state = await _invoke_timing_bridge("status", {"run_id": run_id})
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            state = active.public_state
        if (
            active.command == "execute"
            and state.get("phase") in {"diagnosis_ready", "proposal_ready", "confirmed"}
        ):
            state = active.public_state
        if active.cancel_requested.is_set():
            return {**state, "phase": "cancelling", "failure": None}
        return state
    try:
        return await _invoke_timing_bridge("status", {"run_id": run_id})
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        try:
            operation = json.loads(await asyncio.to_thread(_operation_path(run_id).read_text, "utf-8"))
        except (OSError, json.JSONDecodeError):
            raise
        public_state = operation.get("public_state")
        if operation.get("state") == "terminal" and isinstance(public_state, dict):
            return public_state
        raise HTTPException(status_code=503, detail={
            "error": "TimingRunRecoveryPending",
            "message": "Xylon found an unfinished timing operation after the local API restarted.",
            "recovery": "Keep the local application open while Xylon verifies owned cleanup, then read this run again.",
            "run_id": run_id,
        }) from exc


@router.post("/timing/runs/{run_id}/cancel")
async def cancel_timing_run(run_id: str, request: Request) -> dict:
    _require_local_browser_origin(request)
    if len(run_id) != 32 or any(character not in "0123456789abcdef" for character in run_id):
        raise HTTPException(status_code=422, detail="Timing run identity is invalid")
    job = _active_timing_jobs().get(run_id)
    if job is None:
        state = await get_timing_run(run_id)
        if state.get("phase") in {"queued", "running", "candidate_queued", "candidate_running", "cancelling"}:
            raise HTTPException(status_code=503, detail={
                "error": "TimingRunRecoveryPending",
                "message": "The local API is recovering ownership of this timing run.",
                "recovery": "Keep Xylon open and retry stopping this same run after recovery finishes.",
                "run_id": run_id,
            })
        return state
    await _persist_operation(job, "cancelling")
    job.cancel_requested.set()
    if job.process is not None:
        _signal_timing_bridge(job, signal.SIGUSR1)
    try:
        await asyncio.wait_for(job.done.wait(), timeout=TIMING_CANCEL_WAIT_SECONDS)
    except TimeoutError:
        return {**job.public_state, "phase": "cancelling", "failure": None}
    assert job.result is not None
    return job.result


@router.post("/timing/runs/{run_id}/proposal")
async def create_timing_proposal(run_id: str, request: Request) -> dict:
    _require_local_browser_origin(request)
    return await _invoke_timing_bridge("propose", {"run_id": run_id})


@router.post("/timing/runs/{run_id}/confirmation")
async def confirm_timing_proposal(
    run_id: str,
    confirmation: TimingConfirmationRequest,
    request: Request,
) -> dict:
    _require_local_browser_origin(request)
    return await _invoke_timing_bridge("confirm", {"run_id": run_id, **confirmation.model_dump()})


@router.post("/timing/runs/{run_id}/candidate", status_code=202)
async def execute_timing_candidate(run_id: str, request: TimingCandidateRequest, browser_request: Request) -> dict:
    _require_local_browser_origin(browser_request)
    current = await get_timing_run(run_id)
    await _reject_nonretryable_timing_admission()
    job = await _start_timing_job(
        "execute",
        {"run_id": run_id, **request.model_dump()},
        current=current,
    )
    return job.public_state
