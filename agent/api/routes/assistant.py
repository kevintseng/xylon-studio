"""Natural-language setup-timing assistant over Xylon's typed timing tools."""

from __future__ import annotations

import secrets
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from agent.api.routes import timing as timing_routes
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


def _provider_http_status(code: str) -> int:
    if code == "TimingAgentIntentInvalid":
        return 422
    if code == "TimingAgentProviderUnavailable":
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
