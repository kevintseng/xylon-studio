"""Allowlisted execution metadata for the local OpenROAD comparison flow.

This is deliberately a contract seam, not a second flow engine. The current
adapter describes the pinned ORFS timing comparison profile; a future LibreLane
adapter must satisfy the same typed boundary before it can become user-facing.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal

PINNED_ORFS_IMAGE = "openroad/orfs@sha256:305f9bb42a714a37d287f9755e6f9eae1f82007a54f488a87cd663caf9900422"
SUPPORTED_PROFILE = "orfs-sky130hd-timing-v1"
SUPPORTED_PLATFORM = "sky130hd"
SUPPORTED_STAGES = ("grt",)


class AdapterContractError(ValueError):
    """Raised when an adapter request is outside the allowlisted contract."""


@dataclass(frozen=True)
class RuntimeIdentity:
    backend: Literal["openroad"]
    profile: str
    image: str
    platform: str
    recipe_version: str


@dataclass(frozen=True)
class AdapterRequest:
    profile: str
    platform: str
    stage: str
    run_id: str
    repo_id: str
    config_hash: str


@dataclass(frozen=True)
class StageDescriptor:
    name: str
    report_names: tuple[str, ...]
    checkpoint_names: tuple[str, ...]


@dataclass(frozen=True)
class AdapterPlan:
    identity: RuntimeIdentity
    request: AdapterRequest
    stage: StageDescriptor
    identity_hash: str


def _hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_adapter_plan(request: AdapterRequest) -> AdapterPlan:
    """Build a deterministic plan from typed fields; no command string is accepted."""

    if request.profile != SUPPORTED_PROFILE:
        raise AdapterContractError(f"unsupported execution profile: {request.profile}")
    if request.platform != SUPPORTED_PLATFORM:
        raise AdapterContractError(f"unsupported execution platform: {request.platform}")
    if request.stage not in SUPPORTED_STAGES:
        raise AdapterContractError(f"unsupported execution stage: {request.stage}")
    for field_name in ("run_id", "repo_id", "config_hash"):
        value = getattr(request, field_name)
        if not value or any(character.isspace() for character in value):
            raise AdapterContractError(f"invalid {field_name}")
    identity = RuntimeIdentity(
        backend="openroad",
        profile=SUPPORTED_PROFILE,
        image=PINNED_ORFS_IMAGE,
        platform=SUPPORTED_PLATFORM,
        recipe_version="xylon-orfs-sky130hd-grt/v1",
    )
    stage = StageDescriptor(
        name="grt",
        report_names=("5_global_route.rpt",),
        checkpoint_names=("5_1_grt.odb",),
    )
    identity_hash = _hash({"identity": identity.__dict__, "stage": stage.__dict__})
    return AdapterPlan(identity=identity, request=request, stage=stage, identity_hash=identity_hash)

