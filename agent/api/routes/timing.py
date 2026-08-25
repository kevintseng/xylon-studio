"""Local API for the evidence-backed OpenROAD timing journey."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from agent.api import LOCAL_WEB_ORIGINS
from agent.api.execution import run_in_local_eda_slot

logger = logging.getLogger(__name__)
router = APIRouter(tags=["timing"])

REPO_ROOT = Path(__file__).resolve().parents[3]
TIMING_BRIDGE = REPO_ROOT / "agent" / "timing" / "api-bridge.mjs"
MAX_TIMING_RTL_BYTES = 1024 * 1024
MAX_TIMING_SDC_BYTES = 16 * 1024
MAX_TIMING_BODY_BYTES = MAX_TIMING_RTL_BYTES + MAX_TIMING_SDC_BYTES + 32 * 1024
MAX_BRIDGE_OUTPUT_BYTES = 2 * 1024 * 1024


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


async def _invoke_timing_bridge(command: str, payload: dict) -> dict:
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
        cwd=os.fspath(REPO_ROOT),
        env=_bridge_environment(),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
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


async def _run_heavy_timing(command: str, payload: dict) -> dict:
    return await run_in_local_eda_slot(lambda: _invoke_timing_bridge(command, payload))


@router.post("/timing/runs")
async def create_timing_run(request: TimingRunRequest) -> dict:
    logger.info("Timing analysis requested: top_module=%s platform=%s", request.top_module, request.platform)
    return await _run_heavy_timing("analyze", request.model_dump())


@router.get("/timing/runs/{run_id}")
async def get_timing_run(run_id: str) -> dict:
    if len(run_id) != 32 or any(character not in "0123456789abcdef" for character in run_id):
        raise HTTPException(status_code=422, detail="Timing run identity is invalid")
    return await _invoke_timing_bridge("status", {"run_id": run_id})


@router.post("/timing/runs/{run_id}/proposal")
async def create_timing_proposal(run_id: str) -> dict:
    return await _invoke_timing_bridge("propose", {"run_id": run_id})


@router.post("/timing/runs/{run_id}/confirmation")
async def confirm_timing_proposal(
    run_id: str,
    confirmation: TimingConfirmationRequest,
    request: Request,
) -> dict:
    _require_local_browser_origin(request)
    return await _invoke_timing_bridge("confirm", {"run_id": run_id, **confirmation.model_dump()})


@router.post("/timing/runs/{run_id}/candidate")
async def execute_timing_candidate(run_id: str, request: TimingCandidateRequest) -> dict:
    return await _run_heavy_timing("execute", {"run_id": run_id, **request.model_dump()})
