"""Strict, low-load LibreLane runtime identity and readback checks."""

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

from agent.openroad.project_store import ProjectStoreError, materialize_timing_input

LIBRELANE_VERSION = "3.0.10"
ADAPTER_SCHEMA_VERSION = "xylon-librelane-runtime-adapter/v1"
SUPPORTED_PLATFORM = "sky130hd"
LIBRELANE_IMAGE = "ghcr.io/librelane/librelane@sha256:322b81f76d22053e5b92f9eaa6e4fb0440084fd02d77a4de0caa4ba7644c88c3"
LIBRELANE_CONTAINER_PLATFORM = "linux/arm64"
LIBRELANE_PDK = "sky130A"
LIBRELANE_SCL = "sky130_fd_sc_hd"
LIBRELANE_LAUNCHER = "scripts/xylon-librelane"
LIBRELANE_BASELINE_DENSITY = 0.60
REPO_ROOT = Path(__file__).resolve().parents[2]
LOCAL_LIBRELANE_PYTHON = REPO_ROOT / ".xylon" / "librelane" / "venv" / "bin" / "python"
MAX_EXECUTION_OUTPUT_BYTES = 64 * 1024
ALLOWED_REQUEST_FIELDS = frozenset({"platform", "run_id", "config_path"})
FORBIDDEN_EXECUTION_FIELDS = frozenset(
    {"argv", "command", "docker_args", "model", "prompt", "script", "shell", "tcl"}
)
IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$")
VERILOG_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,127}$")
SOURCE_REVISION_RE = re.compile(r"^[a-f0-9]{40}$|^[a-f0-9]{64}$")


class LibreLaneAdapterError(ValueError):
    """Raised when a LibreLane identity or request cannot be trusted."""


class LibreLaneExecutionError(LibreLaneAdapterError):
    """Raised when the fixed LibreLane launcher cannot produce verified output."""

    def __init__(self, message: str, *, evidence: dict[str, object] | None = None) -> None:
        super().__init__(message)
        self.evidence = evidence or None


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


@dataclass(frozen=True)
class LibreLaneMaterializedProject:
    request: dict[str, str]
    top: str
    source_revision: str
    design_path: str
    sdc_path: str
    config_path: str


@dataclass(frozen=True)
class LibreLaneCommand:
    launcher_path: str
    arguments: tuple[str, ...]
    env_contract: tuple[str, ...]


@dataclass(frozen=True)
class LibreLaneExecutionPlan:
    identity: LibreLaneIdentity
    project: LibreLaneMaterializedProject
    command: LibreLaneCommand
    config_identity_sha256: str
    plan_identity_sha256: str


def _bounded(value: object, maximum: int = 512) -> str:
    return " ".join(str(value).split())[:maximum]


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _sha256_json(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _owned_run_root(run_dir: Path) -> Path:
    declared = Path(run_dir)
    if declared.exists() and declared.is_symlink():
        raise LibreLaneAdapterError("run directory must not be a symbolic link")
    if declared.exists() and not declared.is_dir():
        raise LibreLaneAdapterError("run directory must be a regular directory")
    declared.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = declared.resolve()
    if not root.is_dir():
        raise LibreLaneAdapterError("run directory must be a regular directory")
    return root


def _python_candidate(value: str | None) -> str | None:
    candidate = value or os.environ.get("XYLON_LIBRELANE_PYTHON")
    if not candidate and LOCAL_LIBRELANE_PYTHON.is_file():
        candidate = str(LOCAL_LIBRELANE_PYTHON)
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
    return _sha256_json(asdict(identity))


def validate_config_path(config_path: str, run_dir: Path) -> Path:
    """Keep the future config inside the Xylon-owned run directory."""

    root = _owned_run_root(run_dir)
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


def _write_owned_text(run_dir: Path, relative: str, content: str) -> str:
    root = _owned_run_root(run_dir)
    destination = root / _relative_file(relative, "run file")
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    resolved_parent = destination.parent.resolve()
    if not resolved_parent.is_relative_to(root):
        raise LibreLaneAdapterError("run file must stay inside the owned run directory")
    if destination.exists() and destination.is_symlink():
        raise LibreLaneAdapterError("run file must not be a symbolic link")
    destination.write_text(content, encoding="utf-8")
    destination.chmod(0o600)
    return destination.relative_to(root).as_posix()


def _clock_from_manifest(manifest: Mapping[str, object]) -> tuple[str, float]:
    raw_clocks = manifest.get("clocks")
    if not isinstance(raw_clocks, list) or not raw_clocks:
        raise LibreLaneAdapterError("project manifest must declare at least one clock")
    first = raw_clocks[0]
    if not isinstance(first, Mapping):
        raise LibreLaneAdapterError("project manifest clock payload is invalid")
    clock_port = first.get("port")
    clock_period = first.get("period_ns")
    if not isinstance(clock_port, str) or not VERILOG_IDENTIFIER_RE.fullmatch(clock_port):
        raise LibreLaneAdapterError("project manifest clock port is invalid")
    try:
        period = float(clock_period)
    except (TypeError, ValueError) as error:
        raise LibreLaneAdapterError("project manifest clock period is invalid") from error
    if period <= 0:
        raise LibreLaneAdapterError("project manifest clock period is invalid")
    return clock_port, period


def _source_revision(manifest: Mapping[str, object]) -> str:
    value = manifest.get("source_revision")
    if not isinstance(value, str) or not SOURCE_REVISION_RE.fullmatch(value):
        raise LibreLaneAdapterError("project manifest source_revision is invalid")
    return value


def materialize_project(
    repo_root: Path,
    manifest: Mapping[str, object],
    *,
    run_dir: Path,
    run_id: str,
) -> LibreLaneMaterializedProject:
    """Write deterministic LibreLane-owned inputs from an imported Xylon project."""

    if not isinstance(run_id, str) or not IDENTITY_RE.fullmatch(run_id):
        raise LibreLaneAdapterError("invalid LibreLane run_id")
    if not isinstance(manifest, Mapping):
        raise LibreLaneAdapterError("project manifest must be a mapping")
    top = manifest.get("top")
    platform = manifest.get("platform")
    if not isinstance(top, str) or not VERILOG_IDENTIFIER_RE.fullmatch(top):
        raise LibreLaneAdapterError("project manifest top is invalid")
    if platform != SUPPORTED_PLATFORM:
        raise LibreLaneAdapterError(f"unsupported LibreLane platform: {platform}")
    clock_port, clock_period = _clock_from_manifest(manifest)
    source_revision = _source_revision(manifest)
    try:
        timing_input = materialize_timing_input(repo_root, dict(manifest))
    except ProjectStoreError as error:
        raise LibreLaneAdapterError(str(error)) from error

    design_path = _write_owned_text(run_dir, "inputs/design.v", timing_input["rtl"])
    sdc_path = _write_owned_text(run_dir, "inputs/design.sdc", timing_input["sdc"])
    config = build_config(
        top=top,
        rtl_paths=[design_path],
        sdc_path=sdc_path,
        clock_port=clock_port,
        clock_period_ns=clock_period,
    )
    config_path = _write_owned_text(run_dir, "inputs/librelane/config.json", _canonical_json(config) + "\n")
    request = parse_request(
        {"platform": SUPPORTED_PLATFORM, "run_id": run_id, "config_path": config_path}
    )
    return LibreLaneMaterializedProject(
        request=request,
        top=top,
        source_revision=source_revision,
        design_path=design_path,
        sdc_path=sdc_path,
        config_path=config_path,
    )


def build_execution_plan(
    probe: LibreLaneProbe,
    *,
    run_dir: Path,
    project: LibreLaneMaterializedProject,
) -> LibreLaneExecutionPlan:
    """Bind a materialized project to the fixed LibreLane launcher seam."""

    identity = build_identity(probe, project.request["platform"])
    config_path = validate_config_path(project.config_path, run_dir)
    command = LibreLaneCommand(
        launcher_path=LIBRELANE_LAUNCHER,
        arguments=(
            "run",
            str(run_dir.resolve()),
            project.config_path,
        ),
        env_contract=(
            "XYLON_LIBRELANE_PYTHON",
            "XYLON_LIBRELANE_PDK_ROOT",
        ),
    )
    config_identity_sha256 = hashlib.sha256(config_path.read_bytes()).hexdigest()
    plan_identity_sha256 = _sha256_json(
        {
            "identity": asdict(identity),
            "project": asdict(project),
            "command": asdict(command),
            "config_identity_sha256": config_identity_sha256,
        }
    )
    return LibreLaneExecutionPlan(
        identity=identity,
        project=project,
        command=command,
        config_identity_sha256=config_identity_sha256,
        plan_identity_sha256=plan_identity_sha256,
    )


def _bounded_output(value: str | None) -> str:
    text = value or ""
    return text if len(text) <= MAX_EXECUTION_OUTPUT_BYTES else text[:MAX_EXECUTION_OUTPUT_BYTES] + "…"


def _first_error_line(stderr: str, stdout: str) -> str | None:
    """Return the first actionable tool error, not a preflight/status banner."""

    fallback: str | None = None
    for stream in (stderr, stdout):
        for line in stream.splitlines():
            normalized = " ".join(line.split())
            if not normalized:
                continue
            fallback = fallback or normalized[:512]
            # LibreLane/OpenROAD diagnostics use both prose and coded forms such
            # as ``[IFP-0002]``.  Prefer those over resource JSON or informational
            # banners so the UI names the first actionable blocker.
            if re.search(r"\b(error|failed|failure|fatal|exception|traceback|violation)\b", normalized, re.IGNORECASE):
                return normalized[:512]
            if re.search(r"\[[A-Z][A-Z0-9_]*-\d{3,}\]", normalized):
                return normalized[:512]
    return fallback


def _failure_evidence(
    *,
    stage: str,
    plan: LibreLaneExecutionPlan,
    stdout: str = "",
    stderr: str = "",
    returncode: int | None = None,
    error: object | None = None,
) -> dict[str, object]:
    evidence: dict[str, object] = {
        "stage": stage,
        "config_identity_sha256": plan.config_identity_sha256,
        "plan_identity_sha256": plan.plan_identity_sha256,
    }
    first_error = _first_error_line(stderr, stdout) or (_bounded(error) if error is not None else None)
    if first_error:
        evidence["first_error_line"] = first_error
    if stdout:
        evidence["stdout_excerpt"] = _bounded(stdout)
    if stderr:
        evidence["stderr_excerpt"] = _bounded(stderr)
    if returncode is not None:
        evidence["tool_returncode"] = returncode
    if error is not None:
        evidence["adapter_error"] = _bounded(error)
    return evidence


def execute_plan(
    repo_root: Path,
    *,
    run_dir: Path,
    plan: LibreLaneExecutionPlan,
    timeout_seconds: float = 3600.0,
    runner=subprocess.run,
) -> dict[str, object]:
    """Execute only the fixed launcher, then require native LibreLane readback."""

    root = repo_root.resolve()
    runs_root = (root / ".xylon" / "timing" / "runs").resolve()
    owned_run = run_dir.resolve()
    if not owned_run.is_relative_to(runs_root) or owned_run == runs_root:
        raise LibreLaneExecutionError("LibreLane run directory is outside the Xylon-owned timing workspace")
    launcher = (root / plan.command.launcher_path).resolve()
    if launcher.is_symlink() or not launcher.is_file() or not os.access(launcher, os.X_OK):
        raise LibreLaneExecutionError("the pinned LibreLane launcher is unavailable")
    command = [str(launcher), *plan.command.arguments]
    environment = os.environ.copy()
    environment.setdefault("PYTHONUNBUFFERED", "1")
    native_runs_root = owned_run / "runs"
    existing_native_runs = {
        path.name for path in native_runs_root.iterdir() if path.is_dir()
    } if native_runs_root.is_dir() else set()
    try:
        result = runner(
            command,
            cwd=root,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise LibreLaneExecutionError(
            "LibreLane execution exceeded the bounded timeout",
            evidence=_failure_evidence(stage="execution_timeout", plan=plan, error=error),
        ) from error
    except OSError as error:
        raise LibreLaneExecutionError(
            "LibreLane launcher could not start",
            evidence=_failure_evidence(stage="launcher_start", plan=plan, error=error),
        ) from error
    stdout = _bounded_output(result.stdout)
    stderr = _bounded_output(result.stderr)
    try:
        fresh_native_runs = {
            path.name for path in native_runs_root.iterdir() if path.is_dir()
        } - existing_native_runs if native_runs_root.is_dir() else set()
        readback = readback_artifacts(
            owned_run,
            plan.project.top,
            plan.identity,
            fresh_native_runs=fresh_native_runs,
        )
    except LibreLaneAdapterError as error:
        if result.returncode != 0:
            detail = _bounded(stderr or stdout or "the pinned LibreLane launcher returned a failure")
            raise LibreLaneExecutionError(
                f"LibreLane execution failed: {detail}",
                evidence=_failure_evidence(
                    stage="native_readback",
                    plan=plan,
                    stdout=stdout,
                    stderr=stderr,
                    returncode=result.returncode,
                    error=error,
                ),
            ) from error
        raise LibreLaneExecutionError(
            str(error),
            evidence=_failure_evidence(
                stage="native_readback",
                plan=plan,
                stdout=stdout,
                stderr=stderr,
                returncode=result.returncode,
                error=error,
            ),
        ) from error
    flow_status = "completed" if result.returncode == 0 else "completed_with_violations"
    return {
        "state": "succeeded",
        "flow_status": flow_status,
        "tool_returncode": result.returncode,
        "run_id": plan.project.request["run_id"],
        "identity": asdict(plan.identity),
        "config_identity_sha256": plan.config_identity_sha256,
        "plan_identity_sha256": plan.plan_identity_sha256,
        "stdout": stdout,
        "stderr": stderr,
        "readback": readback,
    }


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
        "PL_TARGET_DENSITY": LIBRELANE_BASELINE_DENSITY,
        "RUN_POST_CTS_RESIZER_TIMING": False,
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
    fresh_native_runs: set[str] | None = None,
) -> dict[str, object]:
    """Read LibreLane's native resolved config and signoff/final metrics artifacts."""

    root = run_dir.resolve()
    candidates: list[tuple[Path, Path, str, str]] = []
    native_runs_root = root / "runs"
    if native_runs_root.is_dir():
        for native_run in sorted(native_runs_root.glob("RUN_*"), reverse=True):
            if not native_run.is_dir() or (
                fresh_native_runs is not None and native_run.name not in fresh_native_runs
            ):
                continue
            for metrics_name in ("metrics.csv", "metrics.json"):
                candidates.append(
                    (
                        native_run / "resolved.json",
                        native_run / "final" / metrics_name,
                        f"runs/{native_run.name}/resolved.json",
                        f"runs/{native_run.name}/final/{metrics_name}",
                    )
                )
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
            resolved_content = _read_regular(resolved, resolved_rel)
            metrics_content = _read_regular(metrics, metrics_rel)
            resolved_payload = json.loads(resolved_content.decode("utf-8"))
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
            "artifacts": {
                "resolved": {
                    "path": resolved_rel,
                    "sha256": hashlib.sha256(resolved_content).hexdigest(),
                    "bytes": len(resolved_content),
                },
                "metrics": {
                    "path": metrics_rel,
                    "sha256": hashlib.sha256(metrics_content).hexdigest(),
                    "bytes": len(metrics_content),
                },
            },
        }
    raise LibreLaneAdapterError("LibreLane resolved config and native metrics artifacts are missing")
