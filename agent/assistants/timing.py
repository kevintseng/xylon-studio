"""Provider-neutral timing assistant over deterministic semantic tools."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from agent.assistants.providers import OpenAICompatibleProvider, ProviderError

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_ROOT = REPO_ROOT / "agent" / "skills" / "openroad_timing" / "v1"
KNOWLEDGE_ROOT = REPO_ROOT / "agent" / "knowledge" / "openroad_timing" / "v1"
MAX_SKILL_BYTES = 32 * 1024
MAX_KNOWLEDGE_BYTES = 128 * 1024


class TimingIntent(BaseModel):
    """The complete and intentionally non-agentic model output surface."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["xylon-timing-intent/v1"]
    supported: bool
    intent: Literal["setup_timing_analysis", "unsupported"]
    normalized_goal: str = Field(min_length=1, max_length=500)
    needs: list[Literal["rtl", "sdc", "top_module", "timing_run"]] = Field(max_length=4)


@dataclass(frozen=True)
class TimingSkillPack:
    skill_id: str
    version: str
    digest: str
    prompt: str
    facts: tuple[dict, ...]

    @classmethod
    def load(cls) -> TimingSkillPack:
        manifest_path = SKILL_ROOT / "manifest.json"
        skill_path = SKILL_ROOT / "SKILL.md"
        knowledge_path = KNOWLEDGE_ROOT / "facts.jsonl"
        for path in (manifest_path, skill_path, knowledge_path):
            if path.is_symlink() or not path.is_file():
                raise RuntimeError(f"TimingAgentSkillUnavailable: {path.name} is unavailable")
        manifest_raw = manifest_path.read_bytes()
        skill_raw = skill_path.read_bytes()
        knowledge_raw = knowledge_path.read_bytes()
        if len(manifest_raw) > MAX_SKILL_BYTES or len(skill_raw) > MAX_SKILL_BYTES:
            raise RuntimeError("TimingAgentSkillInvalid: skill files exceed the bounded size")
        if len(knowledge_raw) > MAX_KNOWLEDGE_BYTES:
            raise RuntimeError("TimingAgentKnowledgeInvalid: knowledge exceeds the bounded size")
        manifest = json.loads(manifest_raw.decode("utf-8"))
        if manifest != {
            "schema_version": "xylon-product-skill/v1",
            "id": "openroad-setup-timing",
            "version": "1",
            "entrypoint": "SKILL.md",
            "knowledge": "facts.jsonl",
        }:
            raise RuntimeError("TimingAgentSkillInvalid: manifest contract is unsupported")
        facts = tuple(json.loads(line) for line in knowledge_raw.decode("utf-8").splitlines() if line)
        if not facts or any(
            set(fact) != {"id", "fact", "source_url", "claim_boundary"}
            or not all(isinstance(value, str) and value for value in fact.values())
            for fact in facts
        ):
            raise RuntimeError("TimingAgentKnowledgeInvalid: facts do not match the product schema")
        digest = hashlib.sha256(manifest_raw + b"\0" + skill_raw + b"\0" + knowledge_raw).hexdigest()
        return cls(
            skill_id=manifest["id"],
            version=manifest["version"],
            digest=digest,
            prompt=skill_raw.decode("utf-8"),
            facts=facts,
        )

    def system_prompt(self, locale: str) -> str:
        knowledge = "\n".join(f"- {fact['id']}: {fact['fact']}" for fact in self.facts)
        return (
            f"{self.prompt}\n\nVersioned knowledge:\n{knowledge}\n\n"
            f"Reply locale: {locale}. Return only a JSON object with exactly: "
            "schema_version, supported, intent, normalized_goal, needs. "
            "Never output tool names, tool arguments, commands, Tcl, approval, WNS, TNS, slack, "
            "or any result. The only supported intent is setup_timing_analysis."
        )


@dataclass(frozen=True)
class TimingSemanticTools:
    analyze: Callable[[dict], Awaitable[dict]]
    status: Callable[[str], Awaitable[dict]]
    propose: Callable[[str], Awaitable[dict]]
    execute: Callable[[str, str, str], Awaitable[dict]]


def _public_observation(state: dict | None) -> dict | None:
    if state is None:
        return None
    observation = {
        "source": state.get("schema_version"),
        "timing_run_id": state.get("run_id"),
        "phase": state.get("phase"),
        "platform": state.get("platform"),
        "top_module": state.get("top_module"),
    }
    if isinstance(state.get("metrics"), dict):
        observation["metrics"] = state["metrics"]
    if isinstance(state.get("comparison"), dict):
        observation["comparison"] = state["comparison"]
    if isinstance(state.get("failure"), dict):
        observation["failure"] = state["failure"]
    return observation


def _assistant_state(state: dict | None) -> tuple[str, dict]:
    if state is None:
        return "waiting_for_input", {
            "required": False,
            "action": "provide_rtl_sdc_and_top_module",
        }
    phase = state.get("phase")
    metrics = state.get("metrics") if isinstance(state.get("metrics"), dict) else {}
    if phase == "proposal_ready":
        proposal = state.get("proposal") if isinstance(state.get("proposal"), dict) else {}
        expires_at = proposal.get("expires_at")
        try:
            deadline = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
        except ValueError:
            deadline = datetime.min.replace(tzinfo=UTC)
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=UTC)
        if deadline <= datetime.now(UTC):
            return "proposal_expired", {
                "required": False,
                "action": "start_new_baseline_and_review_new_proposal",
            }
        return "awaiting_human_confirmation", {
            "required": True,
            "action": "confirm_existing_timing_proposal_in_local_workbench",
        }
    if phase == "comparison_ready":
        return "comparison_ready", {"required": False, "action": "review_before_after_evidence"}
    if phase == "diagnosis_ready" and metrics.get("violations") is False:
        return "setup_clean_at_reported_boundary", {
            "required": False,
            "action": "review_reported_boundary_and_remaining_signoff_limits",
        }
    if phase == "blocked":
        return "flow_failed", {"required": False, "action": "follow_failure_recovery"}
    return "timing_state_ready", {"required": False, "action": "review_timing_evidence"}


async def run_timing_assistant(
    *,
    provider: OpenAICompatibleProvider,
    message: str,
    locale: str,
    design: dict | None,
    run_id: str | None,
    tools: TimingSemanticTools,
) -> dict:
    """Interpret one request, then advance only the deterministic timing state machine."""

    pack = TimingSkillPack.load()
    raw_intent = await provider.complete_json(
        system_prompt=pack.system_prompt(locale),
        user_message=message,
    )
    try:
        intent = TimingIntent.model_validate(raw_intent)
    except ValidationError as exc:
        raise ProviderError(
            "TimingAgentIntentInvalid",
            "The model attempted an unsupported or malformed timing action.",
            "Rephrase the request as setup timing analysis; no EDA action was started.",
        ) from exc
    if intent.supported != (intent.intent == "setup_timing_analysis"):
        raise ProviderError(
            "TimingAgentIntentInvalid",
            "The model returned a contradictory timing intent.",
            "Use a model that follows the versioned Xylon timing skill.",
        )

    timing_state: dict | None = None
    if intent.supported:
        if design is not None:
            timing_state = await tools.analyze(design)
            run_id = timing_state.get("run_id")
        elif run_id is not None:
            timing_state = await tools.status(run_id)

        if timing_state is not None:
            phase = timing_state.get("phase")
            metrics = timing_state.get("metrics") if isinstance(timing_state.get("metrics"), dict) else {}
            if phase == "diagnosis_ready" and metrics.get("violations") is True:
                timing_state = await tools.propose(str(run_id))
            elif phase == "confirmed":
                proposal = timing_state.get("proposal")
                confirmation = timing_state.get("confirmation")
                if not isinstance(proposal, dict) or not isinstance(confirmation, dict):
                    raise RuntimeError("TimingAgentStateInvalid: confirmed state lacks exact identities")
                timing_state = await tools.execute(
                    str(run_id),
                    str(proposal.get("proposal_id", "")),
                    str(confirmation.get("confirmation_id", "")),
                )

    assistant_state, handoff = _assistant_state(timing_state)
    if not intent.supported:
        assistant_state = "unsupported"
        handoff = {"required": False, "action": "use_a_supported_xylon_workflow"}
    return {
        "schema_version": "xylon-timing-assistant/v1",
        "state": assistant_state,
        "intent": intent.model_dump(),
        "skill": {"id": pack.skill_id, "version": pack.version, "sha256": pack.digest},
        "egress": {
            "sent": ["user_message", "locale", "versioned_timing_skill_and_knowledge"],
            "excluded": ["rtl", "sdc", "credentials", "raw_logs", "timing_metrics"],
        },
        "observed": _public_observation(timing_state),
        "timing": timing_state,
        "human_handoff": handoff,
    }
