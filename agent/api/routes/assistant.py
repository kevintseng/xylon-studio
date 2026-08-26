"""Natural-language setup-timing assistant over Xylon's typed timing tools."""

from __future__ import annotations

import secrets
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from agent.api.routes import openroad as openroad_routes
from agent.api.routes import timing as timing_routes
from agent.assistants.librelane import LibreLaneSemanticTools, run_librelane_assistant
from agent.assistants.providers import OpenAICompatibleProvider, ProviderConfig, ProviderError
from agent.assistants.timing import TimingSemanticTools, run_timing_assistant

router = APIRouter(tags=["assistant"])


class TimingAssistantDesign(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rtl: str = Field(min_length=1, max_length=timing_routes.MAX_TIMING_RTL_BYTES)
    sdc: str = Field(min_length=1, max_length=timing_routes.MAX_TIMING_SDC_BYTES)
    top_module: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z_][A-Za-z0-9_$]*$")
    platform: Literal["sky130hd"] = "sky130hd"


class TimingAssistantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["xylon-timing-assistant-request/v1"]
    message: str = Field(min_length=3, max_length=2000)
    locale: Literal["zh-TW", "en"] = "zh-TW"
    provider: ProviderConfig
    design: TimingAssistantDesign | None = None
    timing_run_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")

    @model_validator(mode="after")
    def exactly_one_timing_context(self) -> TimingAssistantRequest:
        if self.design is not None and self.timing_run_id is not None:
            raise ValueError("provide either a new design or an existing timing_run_id, not both")
        return self


class LibreLaneAssistantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["xylon-librelane-assistant-request/v1"]
    message: str = Field(min_length=3, max_length=2000)
    locale: Literal["zh-TW", "en"] = "zh-TW"
    provider: ProviderConfig
    project_run_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$")
    approved: bool = False


async def _analyze_design(design: dict) -> dict:
    payload = timing_routes.TimingRunRequest.model_validate({
        **design,
        "run_id": secrets.token_hex(16),
    }).model_dump()
    return await timing_routes._run_heavy_timing("analyze", payload)


async def _status(run_id: str) -> dict:
    return await timing_routes._invoke_timing_bridge("status", {"run_id": run_id})


async def _propose(run_id: str) -> dict:
    return await timing_routes._invoke_timing_bridge("propose", {"run_id": run_id})


async def _execute(run_id: str, proposal_id: str, confirmation_id: str) -> dict:
    payload = timing_routes.TimingCandidateRequest.model_validate({
        "proposal_id": proposal_id,
        "confirmation_id": confirmation_id,
    }).model_dump()
    return await timing_routes._run_heavy_timing("execute", {"run_id": run_id, **payload})


TIMING_TOOLS = TimingSemanticTools(
    analyze=_analyze_design,
    status=_status,
    propose=_propose,
    execute=_execute,
)


def _public_librelane_run(payload: dict) -> dict:
    """Return state/evidence summaries without re-emitting project source files."""
    failure = payload.get("failure")
    public_failure = None
    if isinstance(failure, dict):
        public_failure = {
            key: failure.get(key)
            for key in ("code", "message", "recovery")
            if isinstance(failure.get(key), str)
        }
    observed = {
        "run_id": payload.get("run_id"),
        "project_id": payload.get("project_id"),
        "state": payload.get("state"),
        "source_revision": payload.get("source_revision"),
        "next_action": payload.get("next_action"),
        "failure": public_failure,
    }
    readiness = payload.get("readiness")
    if isinstance(readiness, dict):
        observed["readiness"] = {
            key: readiness.get(key)
            for key in ("state", "blockers", "checks", "next_action")
            if key in readiness
        }
    comparison = payload.get("comparison")
    if isinstance(comparison, dict):
        setup_wns = comparison.get("setup_wns")
        baseline_metrics = comparison.get("baseline_metrics")
        candidate_metrics = comparison.get("candidate_metrics")
        observed["comparison"] = {
            "schema_version": comparison.get("schema_version"),
            "setup_wns": setup_wns,
            "baseline_metrics": {
                metric: baseline_metrics[metric]
                for metric in ("timing__setup__wns", "timing__setup__tns")
                if isinstance(baseline_metrics, dict) and metric in baseline_metrics
            },
            "candidate_metrics": {
                metric: candidate_metrics[metric]
                for metric in ("timing__setup__wns", "timing__setup__tns")
                if isinstance(candidate_metrics, dict) and metric in candidate_metrics
            },
        }
    decision = payload.get("decision")
    if isinstance(decision, dict):
        observed["decision"] = {
            key: decision.get(key)
            for key in (
                "state", "choice", "proposal_id", "source_revision",
                "selected_config_path", "selected_config_sha256", "selected_inputs_sha256",
            )
            if key in decision
        }
    for key in ("execution", "candidate", "selected_execution"):
        value = payload.get(key)
        if not isinstance(value, dict):
            continue
        summary = {
            field: value.get(field)
            for field in (
                "state",
                "attempt",
                "proposal_id",
                "decision_choice",
                "root",
                "started_at",
                "finished_at",
                "runtime_identity",
                "plan_identity_sha256",
                "selected_config_sha256",
                "selected_inputs_sha256",
            )
            if field in value
        }
        result = value.get("result")
        readback = result.get("readback") if isinstance(result, dict) else None
        metrics = readback.get("metrics") if isinstance(readback, dict) else None
        if isinstance(metrics, dict):
            summary["metrics"] = {
                metric: metrics[metric]
                for metric in ("timing__setup__wns", "timing__setup__tns", "timing__hold__wns", "timing__hold__tns")
                if metric in metrics
            }
        observed[key] = summary
    return observed


async def _librelane_status(run_id: str) -> dict:
    _, payload = openroad_routes._load_librelane_run(run_id)
    return _public_librelane_run(payload)


async def _librelane_propose(run_id: str, strategy: Literal["density", "cts"]) -> dict:
    run_root, payload = openroad_routes._load_librelane_run(run_id)
    proposal = openroad_routes._create_librelane_proposal(
        run_root,
        payload,
        strategy,
    )
    return _public_librelane_run(payload) | {"proposal": proposal}


async def _librelane_comparison(run_id: str) -> dict:
    _, payload = openroad_routes._load_librelane_run(run_id)
    return _public_librelane_run(payload)


async def _librelane_selected_execute(run_id: str, approved: bool) -> dict:
    return _public_librelane_run(
        await openroad_routes.post_librelane_selected_execution(
            run_id,
            openroad_routes.LibreLaneExecutionRequest(approved=approved),
        )
    )


LIBRELANE_TOOLS = LibreLaneSemanticTools(
    status=_librelane_status,
    propose=_librelane_propose,
    comparison=_librelane_comparison,
    selected_execute=_librelane_selected_execute,
)


def _provider_http_status(code: str) -> int:
    if code in {"TimingAgentIntentInvalid", "LibreLaneAgentIntentInvalid"}:
        return 422
    if code in {"TimingAgentProviderUnavailable", "LibreLaneAgentProviderUnavailable"}:
        return 503
    return 502


@router.post("/assistant/timing")
async def timing_assistant(request: TimingAssistantRequest) -> dict:
    """Interpret one sentence and advance only the supported setup-timing state machine."""

    try:
        return await run_timing_assistant(
            provider=OpenAICompatibleProvider(request.provider),
            message=request.message,
            locale=request.locale,
            design=request.design.model_dump() if request.design else None,
            run_id=request.timing_run_id,
            tools=TIMING_TOOLS,
        )
    except ProviderError as exc:
        raise HTTPException(
            status_code=_provider_http_status(exc.code),
            detail={"error": exc.code, "message": exc.message, "recovery": exc.recovery},
        ) from exc
    except RuntimeError as exc:
        code, _, message = str(exc).partition(": ")
        if not code.startswith("TimingAgent"):
            code = "TimingAgentRuntimeInvalid"
            message = "The timing assistant could not read its bounded runtime state."
        raise HTTPException(
            status_code=500,
            detail={
                "error": code,
                "message": message,
                "recovery": "Restore the versioned timing skill and start a new assistant request.",
            },
        ) from exc


@router.post("/assistant/librelane")
async def librelane_assistant(request: LibreLaneAssistantRequest) -> dict:
    """Interpret one sentence and advance only the canonical LibreLane project journey."""

    try:
        return await run_librelane_assistant(
            provider=OpenAICompatibleProvider(request.provider),
            message=request.message,
            locale=request.locale,
            run_id=request.project_run_id,
            approved=request.approved,
            tools=LIBRELANE_TOOLS,
        )
    except ProviderError as exc:
        raise HTTPException(
            status_code=_provider_http_status(exc.code),
            detail={"error": exc.code, "message": exc.message, "recovery": exc.recovery},
        ) from exc
    except HTTPException:
        raise
    except (OSError, KeyError, ValueError, RuntimeError) as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "LibreLaneAgentStateInvalid",
                "message": "The assistant could not read or advance the saved LibreLane project state.",
                "recovery": "Open the primary OpenROAD journey, refresh the run, and retry the supported request.",
            },
        ) from exc
