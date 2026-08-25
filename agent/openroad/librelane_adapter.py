"""Strict, low-load LibreLane runtime identity checks.

This module deliberately does not execute a LibreLane flow.  The current product
runner is still the pinned ORFS/OpenROAD comparison fixture.  The adapter exists
to make the next backend boundary explicit and to fail closed until a real
LibreLane installation, PDK root, and output readback contract are available.
"""

from __future__ import annotations

import csv
import hashlib
import io
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
LIBRELANE_IMAGE = "ghcr.io/librelane/librelane@sha256:322b81f76d22053e5b92f9eaa6e4fb0440084fd02d77a4de0caa4ba7644c88c3"
LIBRELANE_CONTAINER_PLATFORM = "linux/arm64"
LIBRELANE_PDK = "sky130A"
LIBRELANE_SCL = "sky130_fd_sc_hd"
ALLOWED_REQUEST_FIELDS = frozenset({"platform", "run_id", "config_path"})
FORBIDDEN_EXECUTION_FIELDS = frozenset(
    {"argv", "command", "docker_args", "model", "prompt", "script", "shell", "tcl"}
)
IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$")
VERILOG_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,127}$")


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
    image: str
    container_platform: str
    pdk: str
    standard_cell_library: str
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
        image=LIBRELANE_IMAGE,
        container_platform=LIBRELANE_CONTAINER_PLATFORM,
        pdk=LIBRELANE_PDK,
        standard_cell_library=LIBRELANE_SCL,
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


def _relative_file(value: str, field: str) -> str:
    candidate = Path(value)
    if not value or candidate.is_absolute() or ".." in candidate.parts:
        raise LibreLaneAdapterError(f"{field} must be a relative path inside the run directory")
    if candidate.name in {"", "."}:
        raise LibreLaneAdapterError(f"{field} must name a file")
    return candidate.as_posix()


def build_config(
    *,
    top: str,
    rtl_paths: list[str],
    sdc_path: str,
    clock_port: str,
    clock_period_ns: float | int,
    include_dirs: list[str] | None = None,
) -> dict[str, object]:
    """Build a deterministic LibreLane config without accepting tool commands."""

    if not VERILOG_IDENTIFIER_RE.fullmatch(top):
        raise LibreLaneAdapterError("top must be a valid Verilog identifier")
    if not rtl_paths:
        raise LibreLaneAdapterError("at least one RTL path is required")
    if not VERILOG_IDENTIFIER_RE.fullmatch(clock_port):
        raise LibreLaneAdapterError("clock_port must be a valid Verilog identifier")
    try:
        period = float(clock_period_ns)
    except (TypeError, ValueError) as error:
        raise LibreLaneAdapterError("clock_period_ns must be a positive number") from error
    if period <= 0:
        raise LibreLaneAdapterError("clock_period_ns must be a positive number")
    config: dict[str, object] = {
        "DESIGN_NAME": top,
        "VERILOG_FILES": [f"dir::{_relative_file(path, 'rtl_paths')}" for path in rtl_paths],
        "CLOCK_PERIOD": int(period) if period.is_integer() else period,
        "CLOCK_PORT": clock_port,
        "PNR_SDC_FILE": f"dir::{_relative_file(sdc_path, 'sdc_path')}",
        "SIGNOFF_SDC_FILE": f"dir::{_relative_file(sdc_path, 'sdc_path')}",
        "PDK": LIBRELANE_PDK,
        "STD_CELL_LIBRARY": LIBRELANE_SCL,
    }
    if include_dirs:
        config["VERILOG_INCLUDE_DIRS"] = [
            f"dir::{_relative_file(directory, 'include_dirs')}" for directory in include_dirs
        ]
    return config


def _read_regular(path: Path, label: str) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise LibreLaneAdapterError(f"LibreLane {label} is missing")
    try:
        content = path.read_bytes()
    except OSError as error:
        raise LibreLaneAdapterError(f"LibreLane {label} cannot be read") from error
    if len(content) > 4 * 1024 * 1024:
        raise LibreLaneAdapterError(f"LibreLane {label} exceeds the bounded readback limit")
    return content


def _metrics_csv(content: bytes) -> dict[str, object]:
    metrics: dict[str, object] = {}
    for row in csv.reader(io.StringIO(content.decode("utf-8"))):
        if len(row) != 2 or row[0] == "Metric":
            continue
        key, value = row
        try:
            metrics[key] = float(value)
        except ValueError:
            metrics[key] = value
    if not metrics:
        raise LibreLaneAdapterError("LibreLane metrics.csv contains no measured metrics")
    return metrics


def readback_artifacts(
    run_dir: Path,
    design_name: str | None = None,
    identity: LibreLaneIdentity | None = None,
) -> dict[str, object]:
    """Read LibreLane's native resolved config and signoff/final metrics artifacts."""

    root = run_dir.resolve()
    candidates: list[tuple[Path, Path, str, str]] = []
    if design_name is not None:
        if not VERILOG_IDENTIFIER_RE.fullmatch(design_name):
            raise LibreLaneAdapterError("design_name must be a valid Verilog identifier")
        candidates.append(
            (
                root / "signoff" / design_name / "openlane-signoff" / "resolved.json",
                root / "signoff" / design_name / "metrics.csv",
                f"signoff/{design_name}/openlane-signoff/resolved.json",
                f"signoff/{design_name}/metrics.csv",
            )
        )
    candidates.append(
        (root / "final" / "resolved.json", root / "final" / "metrics.json", "final/resolved.json", "final/metrics.json")
    )
    for resolved, metrics, resolved_rel, metrics_rel in candidates:
        if not resolved.is_file() or not metrics.is_file():
            continue
        try:
            resolved_payload = json.loads(_read_regular(resolved, resolved_rel).decode("utf-8"))
            metrics_content = _read_regular(metrics, metrics_rel)
            if metrics.suffix == ".csv":
                metrics_payload = _metrics_csv(metrics_content)
            else:
                metrics_payload = json.loads(metrics_content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, csv.Error) as error:
            raise LibreLaneAdapterError("LibreLane output readback is malformed") from error
        if not isinstance(resolved_payload, dict) or not isinstance(metrics_payload, dict) or not metrics_payload:
            raise LibreLaneAdapterError("LibreLane output readback must contain objects")
        expected_pdk = identity.pdk if identity else LIBRELANE_PDK
        expected_scl = identity.standard_cell_library if identity else LIBRELANE_SCL
        if resolved_payload.get("PDK") != expected_pdk or resolved_payload.get("STD_CELL_LIBRARY") != expected_scl:
            raise LibreLaneAdapterError("LibreLane output identity does not match the pinned PDK and standard-cell library")
        return {
            "resolved": resolved_payload,
            "metrics": metrics_payload,
            "paths": {"resolved": resolved_rel, "metrics": metrics_rel},
        }
    raise LibreLaneAdapterError("LibreLane resolved config and native metrics artifacts are missing")
