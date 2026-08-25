"""Strict, low-load LibreLane runtime identity checks.

This module deliberately does not execute a LibreLane flow.  The current product
runner is still the pinned ORFS/OpenROAD comparison fixture.  The adapter exists
to make the next backend boundary explicit and to fail closed until a real
LibreLane installation, PDK root, and output readback contract are available.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from pathlib import Path

LIBRELANE_VERSION = "3.0.10"
ADAPTER_SCHEMA_VERSION = "xylon-librelane-runtime-adapter/v1"
SUPPORTED_PLATFORM = "sky130hd"
ALLOWED_REQUEST_FIELDS = frozenset({"platform", "run_id", "config_path"})
FORBIDDEN_EXECUTION_FIELDS = frozenset(
    {"argv", "command", "docker_args", "model", "prompt", "script", "shell", "tcl"}
)
IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$")


class LibreLaneAdapterError(ValueError):
    """Raised when a LibreLane identity or request cannot be trusted."""


@dataclass(frozen=True)
class LibreLaneProbe:
    state: str
    python: str | None
    version: str | None
    detail: str


@dataclass(frozen=True)
class LibreLaneIdentity:
    schema_version: str
    backend: str
    upstream_flow: str
    version: str
    platform: str
    invocation: str
    temporary: bool


def _bounded(value: object, maximum: int = 512) -> str:
    return " ".join(str(value).split())[:maximum]


def _python_candidate(value: str | None) -> str | None:
    candidate = value or os.environ.get("XYLON_LIBRELANE_PYTHON")
    if candidate:
        path = Path(candidate).expanduser()
        resolved = path.resolve()
        if path.is_file() and resolved.is_file() and os.access(resolved, os.X_OK):
            # Preserve a venv launcher path; resolving it would bypass the venv's
            # site-packages and silently probe the system Python instead.
            return str(path)
        return None
    return None


def probe_librelane(python: str | None = None, timeout_seconds: float = 5.0) -> LibreLaneProbe:
    """Read only the exact LibreLane version; never starts Docker or a flow."""

    executable = _python_candidate(python)
    if executable is None:
        return LibreLaneProbe("unavailable", None, None, "No trusted Python executable was configured.")
    try:
        result = subprocess.run(
            [executable, "-m", "librelane", "--bare-version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return LibreLaneProbe("unavailable", executable, None, _bounded(error))
    version = _bounded(result.stdout).strip()
    if result.returncode != 0:
        return LibreLaneProbe("unavailable", executable, None, _bounded(result.stderr or result.stdout))
    if version != LIBRELANE_VERSION:
        return LibreLaneProbe("version_mismatch", executable, version, f"Expected LibreLane {LIBRELANE_VERSION}.")
    return LibreLaneProbe("available", executable, version, "Exact LibreLane version is available.")


def parse_request(payload: Mapping[str, object]) -> dict[str, str]:
    """Validate the only inputs accepted by the future LibreLane adapter."""

    if not isinstance(payload, Mapping):
        raise LibreLaneAdapterError("LibreLane request must be a mapping")
    forbidden = sorted(key for key in FORBIDDEN_EXECUTION_FIELDS if key in payload)
    if forbidden:
        raise LibreLaneAdapterError(f"arbitrary execution fields are not allowed: {', '.join(forbidden)}")
    unexpected = sorted(str(key) for key in payload if key not in ALLOWED_REQUEST_FIELDS)
    if unexpected:
        raise LibreLaneAdapterError(f"unexpected LibreLane request fields: {', '.join(unexpected)}")
    platform = payload.get("platform")
    run_id = payload.get("run_id")
    config_path = payload.get("config_path")
    if platform != SUPPORTED_PLATFORM:
        raise LibreLaneAdapterError(f"unsupported LibreLane platform: {platform}")
    if not isinstance(run_id, str) or not IDENTITY_RE.fullmatch(run_id):
        raise LibreLaneAdapterError("invalid LibreLane run_id")
    if not isinstance(config_path, str) or not config_path:
        raise LibreLaneAdapterError("config_path is required")
    return {"platform": platform, "run_id": run_id, "config_path": config_path}


def build_identity(probe: LibreLaneProbe, platform: str = SUPPORTED_PLATFORM) -> LibreLaneIdentity:
    if probe.state != "available" or probe.version != LIBRELANE_VERSION:
        raise LibreLaneAdapterError("LibreLane 3.0.10 is not available")
    if platform != SUPPORTED_PLATFORM:
        raise LibreLaneAdapterError(f"unsupported LibreLane platform: {platform}")
    return LibreLaneIdentity(
        schema_version=ADAPTER_SCHEMA_VERSION,
        backend="librelane",
        upstream_flow="librelane",
        version=LIBRELANE_VERSION,
        platform=platform,
        invocation="python -m librelane --dockerized <validated-config>",
        temporary=True,
    )


def identity_sha256(identity: LibreLaneIdentity) -> str:
    payload = json.dumps(asdict(identity), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def validate_config_path(config_path: str, run_dir: Path) -> Path:
    """Keep the future config inside the Xylon-owned run directory."""

    root = run_dir.resolve()
    declared = root / config_path
    if declared.is_symlink():
        raise LibreLaneAdapterError("LibreLane config must not be a symbolic link")
    candidate = declared.resolve()
    if not candidate.is_file() or not candidate.is_relative_to(root):
        raise LibreLaneAdapterError("LibreLane config must be a regular file inside the owned run directory")
    if candidate.suffix not in {".json", ".yaml", ".yml"}:
        raise LibreLaneAdapterError("LibreLane config must be JSON or YAML")
    return candidate
