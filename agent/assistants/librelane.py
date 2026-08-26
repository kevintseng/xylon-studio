"""Natural-language control plane for the canonical LibreLane project journey."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from agent.assistants.providers import OpenAICompatibleProvider, ProviderError
from agent.assistants.timing import TimingSkillPack


class LibreLaneIntent(BaseModel):
    """The deliberately small model output surface for the LibreLane assistant."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["xylon-librelane-intent/v1"]
    supported: bool
    intent: Literal[
        "inspect_project",
        "propose_repair",
        "review_comparison",
        "rerun_selected",
        "unsupported",
    ]
    normalized_goal: str = Field(min_length=1, max_length=500)
    needs: list[Literal["project_run", "approval"]] = Field(max_length=2)
    repair_strategy: Literal["density", "cts"] | None = None


@dataclass(frozen=True)
class LibreLaneSemanticTools:
    """Deterministic actions the model may select; the model never supplies arguments."""

    status: Callable[[str], Awaitable[dict]]
    propose: Callable[[str, Literal["density", "cts"]], Awaitable[dict]]
    comparison: Callable[[str], Awaitable[dict]]
    selected_execute: Callable[[str, bool], Awaitable[dict]]


def _system_prompt(locale: str) -> tuple[TimingSkillPack, str]:
    pack = TimingSkillPack.load()
    knowledge = "\n".join(f"- {fact['id']}: {fact['fact']}" for fact in pack.facts)
    prompt = (
        f"{pack.prompt}\n\nVersioned knowledge:\n{knowledge}\n\n"
        f"Reply locale: {locale}. Return only a JSON object with exactly: "
        "schema_version, supported, intent, normalized_goal, needs, repair_strategy. "
        "Use schema_version xylon-librelane-intent/v1. Classify only these actions: "
        "inspect_project for reading the current canonical LibreLane project state or metrics; "
        "propose_repair for requesting one bounded repair proposal from a measured negative-WNS baseline; "
        "review_comparison for reviewing an existing native baseline/candidate comparison; "
        "rerun_selected only when the user explicitly asks to execute the already selected configuration again. "
        "For propose_repair, set repair_strategy to cts when the request asks for CTS timing repair; otherwise set density. "
        "Never emit tool names, tool arguments, commands, Tcl, RTL, SDC, credentials, raw logs, timing metrics, "
        "approval claims, or execution claims. Ambiguous or unrelated requests must be unsupported. "
        "The deterministic runtime owns every action and measured fact."
    )
    return pack, prompt


def _assistant_state(intent: LibreLaneIntent, *, run: dict | None, approved: bool) -> tuple[str, dict]:
    if not intent.supported:
        return "unsupported", {"required": False, "action": "use_a_supported_librelane_project_request"}
    if run is None:
        return "waiting_for_project_run", {
            "required": True,
            "action": "import_and_prepare_a_librelane_project_first",
        }
    if intent.intent == "rerun_selected" and not approved:
        return "awaiting_human_approval", {
            "required": True,
            "action": "explicitly_approve_the_selected_librelane_rerun_in_the_workbench",
        }
    if intent.intent == "inspect_project":
        return "project_status_ready", {"required": False, "action": "review_the_current_librelane_evidence"}
    if intent.intent == "propose_repair":
        return "repair_proposal_ready", {"required": False, "action": "review_one_bounded_repair_before_approval"}
    if intent.intent == "review_comparison":
        return "comparison_ready", {"required": False, "action": "review_native_before_after_evidence"}
    return "selected_rerun_requested", {
        "required": False,
        "action": "inspect_the_selected_librelane_rerun_readback",
    }


async def run_librelane_assistant(
    *,
    provider: OpenAICompatibleProvider,
    message: str,
    locale: str,
    run_id: str | None,
    approved: bool,
    tools: LibreLaneSemanticTools,
) -> dict:
    """Classify one request, then advance only the canonical LibreLane state machine."""

    pack, prompt = _system_prompt(locale)
    raw_intent = await provider.complete_json(system_prompt=prompt, user_message=message)
    try:
        intent = LibreLaneIntent.model_validate(raw_intent)
    except ValidationError as exc:
        raise ProviderError(
            "LibreLaneAgentIntentInvalid",
            "The model returned an unsupported or malformed LibreLane project intent.",
            "Ask to inspect the current project, propose one bounded repair, review a comparison, or rerun a selected configuration.",
        ) from exc
    if intent.supported != (intent.intent != "unsupported"):
        raise ProviderError(
            "LibreLaneAgentIntentInvalid",
            "The model returned a contradictory LibreLane project intent.",
            "Use a model that follows the versioned Xylon LibreLane assistant contract.",
        )

    run: dict | None = None
    if intent.supported and run_id is not None:
        if intent.intent == "inspect_project":
            run = await tools.status(run_id)
        elif intent.intent == "propose_repair":
            run = await tools.propose(run_id, intent.repair_strategy or "density")
        elif intent.intent == "review_comparison":
            run = await tools.comparison(run_id)
        elif intent.intent == "rerun_selected" and approved:
            run = await tools.selected_execute(run_id, approved)
        elif intent.intent == "rerun_selected":
            run = await tools.status(run_id)

    assistant_state, handoff = _assistant_state(intent, run=run, approved=approved)
    return {
        "schema_version": "xylon-librelane-assistant/v1",
        "state": assistant_state,
        "intent": intent.model_dump(),
        "skill": {"id": pack.skill_id, "version": pack.version, "sha256": pack.digest},
        "egress": {
            "sent": ["user_message", "locale", "versioned_openroad_skill_and_knowledge"],
            "excluded": ["rtl", "sdc", "credentials", "raw_logs", "timing_metrics", "tool_arguments"],
        },
        "observed": run,
        "human_handoff": handoff,
    }
