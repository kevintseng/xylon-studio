"""Allowlisted execution metadata for the local OpenROAD comparison flow.

This module is a typed seam, not a second execution engine. Today it only
describes the pinned ORFS timing comparison fixture that already exists in this
repository. It must not be presented as a LibreLane implementation until a real
LibreLane runtime, immutable identity, and artifact readback are wired in.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Any, Literal

ADAPTER_SCHEMA_VERSION = "xylon-openroad-execution-adapter/v1"
PINNED_ORFS_IMAGE = "openroad/orfs@sha256:305f9bb42a714a37d287f9755e6f9eae1f82007a54f488a87cd663caf9900422"
SUPPORTED_PROFILE = "xylon-orfs-sky130hd-grt-comparison/v1"
SUPPORTED_PLATFORM = "sky130hd"
SUPPORTED_STAGE = "grt"
RECIPE_VERSION = "xylon-orfs-sky130hd-grt/v2"
CONTAINER_PLATFORM = "linux/amd64"
IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
ALLOWED_REQUEST_FIELDS = frozenset(
    {"profile", "platform", "stage", "run_id", "repo_id", "config_sha256"}
)
FORBIDDEN_COMMAND_FIELDS = frozenset(
    {
        "argv",
        "bash",
        "command",
        "docker_args",
        "model",
        "model_command",
        "prompt",
        "script",
        "shell",
        "tcl",
        "tool_args",
    }
)


class AdapterContractError(ValueError):
    """Raised when an adapter request is outside the allowlisted contract."""


@dataclass(frozen=True)
class RuntimeIdentity:
    schema_version: str
    backend: Literal["openroad"]
    execution_kind: Literal["comparison_fixture"]
    upstream_flow: Literal["orfs"]
    profile: str
    design_platform: str
    container_platform: str
    image: str
    recipe_version: str
    stage: str
    temporary: bool


@dataclass(frozen=True)
class ResourceLimits:
    default_cpus: int
    maximum_cpus: int
    memory_gib: int
    network: Literal["none"]
    root_filesystem: Literal["read-only"]
    pids_limit: int
    nofile_limit: str


@dataclass(frozen=True)
class CommandDescriptor:
    launcher_path: str
    execution_mode: Literal["baseline"]
    design_config_path: str
    flow_variant: str
    target: str
    env_contract: tuple[str, ...]


@dataclass(frozen=True)
class ReportDescriptor:
    logical_name: str
    relative_path: str
    format: str
    required: bool


@dataclass(frozen=True)
class ArtifactDescriptor:
    logical_name: str
    relative_path: str
    format: str
    required: bool


@dataclass(frozen=True)
class StageDescriptor:
    name: str
    sequence: int
    reports: tuple[ReportDescriptor, ...]
    artifacts: tuple[ArtifactDescriptor, ...]


@dataclass(frozen=True)
class AdapterRequest:
    profile: str
    platform: str
    stage: str
    run_id: str
    repo_id: str
    config_sha256: str


@dataclass(frozen=True)
class AdapterPlan:
    identity: RuntimeIdentity
    request: AdapterRequest
    command: CommandDescriptor
    resources: ResourceLimits
    stage: StageDescriptor
    command_identity_sha256: str
    config_identity_sha256: str
    plan_identity_sha256: str


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _sha256_json(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _require_exact(value: str, expected: str, label: str) -> str:
    if value != expected:
        raise AdapterContractError(f"unsupported execution {label}: {value}")
    return value


def _require_identity(value: str, label: str) -> str:
    if not isinstance(value, str) or not IDENTITY_RE.fullmatch(value):
        raise AdapterContractError(f"invalid {label}")
    return value


def _require_sha256(value: str, label: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise AdapterContractError(f"invalid {label}")
    return value


def parse_adapter_request(payload: Mapping[str, object]) -> AdapterRequest:
    """Validate a raw adapter request without allowing arbitrary command fields."""

    if not isinstance(payload, Mapping):
        raise AdapterContractError("adapter request must be a mapping")
    forbidden = sorted(field for field in FORBIDDEN_COMMAND_FIELDS if field in payload)
    if forbidden:
        names = ", ".join(forbidden)
        raise AdapterContractError(
            f"arbitrary execution fields are not allowed in adapter requests: {names}"
        )
    unexpected = sorted(str(field) for field in payload if field not in ALLOWED_REQUEST_FIELDS)
    if unexpected:
        names = ", ".join(unexpected)
        raise AdapterContractError(f"unexpected adapter request fields: {names}")
    return AdapterRequest(
        profile=_require_exact(str(payload.get("profile")), SUPPORTED_PROFILE, "profile"),
        platform=_require_exact(
            str(payload.get("platform")), SUPPORTED_PLATFORM, "platform"
        ),
        stage=_require_exact(str(payload.get("stage")), SUPPORTED_STAGE, "stage"),
        run_id=_require_identity(str(payload.get("run_id")), "run_id"),
        repo_id=_require_identity(str(payload.get("repo_id")), "repo_id"),
        config_sha256=_require_sha256(
            str(payload.get("config_sha256")), "config_sha256"
        ),
    )


def local_comparison_adapter() -> tuple[
    RuntimeIdentity,
    CommandDescriptor,
    ResourceLimits,
    StageDescriptor,
]:
    """Return the only supported local comparison fixture.

    This is intentionally the current pinned ORFS comparison runner, not a
    LibreLane runtime.
    """

    identity = RuntimeIdentity(
        schema_version=ADAPTER_SCHEMA_VERSION,
        backend="openroad",
        execution_kind="comparison_fixture",
        upstream_flow="orfs",
        profile=SUPPORTED_PROFILE,
        design_platform=SUPPORTED_PLATFORM,
        container_platform=CONTAINER_PLATFORM,
        image=PINNED_ORFS_IMAGE,
        recipe_version=RECIPE_VERSION,
        stage=SUPPORTED_STAGE,
        temporary=True,
    )
    command = CommandDescriptor(
        launcher_path="runtime/openroad/bin/orfs-timing",
        execution_mode="baseline",
        design_config_path="/work/design/config.mk",
        flow_variant="base",
        target="grt",
        env_contract=(
            "XYLON_REPO_ROOT",
            "XYLON_TIMING_RUN_DIR",
            "XYLON_TIMING_RUN_ID",
            "XYLON_TIMING_REPO_ID",
            "XYLON_TIMING_MODE",
            "XYLON_OPENROAD_CPUS",
        ),
    )
    resources = ResourceLimits(
        default_cpus=1,
        maximum_cpus=4,
        memory_gib=8,
        network="none",
        root_filesystem="read-only",
        pids_limit=256,
        nofile_limit="1024:1024",
    )
    stage = StageDescriptor(
        name=SUPPORTED_STAGE,
        sequence=5,
        reports=(
            ReportDescriptor(
                logical_name="global_route_report",
                relative_path="reports/sky130hd/<top>/base/5_global_route.rpt",
                format="orfs-report",
                required=True,
            ),
        ),
        artifacts=(
            ArtifactDescriptor(
                logical_name="global_route_database",
                relative_path="results/sky130hd/<top>/base/5_1_grt.odb",
                format="openroad-db",
                required=True,
            ),
            ArtifactDescriptor(
                logical_name="effective_sdc",
                relative_path="results/sky130hd/<top>/base/5_1_grt.sdc",
                format="sdc",
                required=True,
            ),
        ),
    )
    return identity, command, resources, stage


def build_adapter_plan(request: AdapterRequest) -> AdapterPlan:
    """Build a deterministic plan from typed fields; no raw command is accepted."""

    validated = parse_adapter_request(asdict(request))
    identity, command, resources, stage = local_comparison_adapter()
    command_identity_sha256 = _sha256_json(asdict(command))
    config_identity_sha256 = _sha256_json(
        {
            "profile": validated.profile,
            "platform": validated.platform,
            "stage": validated.stage,
            "config_sha256": validated.config_sha256,
        }
    )
    plan_identity_sha256 = _sha256_json(
        {
            "identity": asdict(identity),
            "command": asdict(command),
            "resources": asdict(resources),
            "stage": asdict(stage),
        }
    )
    return AdapterPlan(
        identity=identity,
        request=validated,
        command=command,
        resources=resources,
        stage=stage,
        command_identity_sha256=command_identity_sha256,
        config_identity_sha256=config_identity_sha256,
        plan_identity_sha256=plan_identity_sha256,
    )
