"""Atomic, portable evidence bundles for terminal pipeline runs."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path

from agent.pipeline.limits import validate_pipeline_inputs
from agent.pipeline.models import (
    ArtifactBundle,
    ArtifactFile,
    PipelineConfig,
    PipelineOutcome,
    PipelineResult,
)

SCHEMA_VERSION = 1
_SAFE_RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


class ArtifactIntegrityError(ValueError):
    """Raised when a saved bundle is incomplete or no longer authentic."""


@dataclass(frozen=True)
class RerunRequest:
    """Frozen inputs and execution settings loaded from a verified manifest."""

    rtl_code: str
    testbench_code: str | None
    config: PipelineConfig
    expected_outcome: PipelineOutcome
    source_pipeline_id: str


def _validate_pipeline_id(pipeline_id: str) -> None:
    if (
        not _SAFE_RUN_ID.fullmatch(pipeline_id)
        or pipeline_id in {".", ".."}
    ):
        raise ValueError(f"Unsafe pipeline_id for artifact path: {pipeline_id!r}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _atomic_write_text(path: Path, content: str) -> None:
    """Publish a complete file without exposing a partial write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{uuid.uuid4().hex}")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_json(path: Path, value: object) -> None:
    _atomic_write_text(
        path,
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
    )


def _descriptor(run_dir: Path, role: str, relative_path: str, media_type: str) -> ArtifactFile:
    path = run_dir / relative_path
    return ArtifactFile(
        role=role,
        path=relative_path,
        sha256=_sha256(path),
        size_bytes=path.stat().st_size,
        media_type=media_type,
    )


def _portable_config(config: PipelineConfig) -> dict:
    """Persist the complete supported deterministic replay settings."""
    return {
        "coverage_target": config.coverage_target,
        "lint_enabled": config.lint_enabled,
        "simulation_timeout": config.simulation_timeout,
        "synthesis_enabled": config.synthesis_enabled,
        "runtime_check_enabled": config.runtime_check_enabled,
    }


def persist_pipeline_artifacts(
    *,
    result: PipelineResult,
    rtl_code: str,
    testbench_code: str | None,
    config: PipelineConfig,
) -> ArtifactBundle:
    """Atomically publish the frozen inputs and canonical terminal evidence."""
    validate_pipeline_inputs(rtl_code, testbench_code)
    _validate_pipeline_id(result.pipeline_id)

    root = Path(config.artifact_root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    final_dir = root / result.pipeline_id
    if final_dir.exists():
        raise FileExistsError(f"Artifact run already exists: {final_dir}")

    staging = Path(
        tempfile.mkdtemp(
            prefix=f".{result.pipeline_id}.staging-",
            dir=root,
        )
    )
    try:
        _atomic_write_text(staging / "inputs/design.v", rtl_code)
        files = [
            _descriptor(
                staging,
                "rtl_input",
                "inputs/design.v",
                "text/x-verilog",
            )
        ]

        if testbench_code is not None:
            _atomic_write_text(staging / "inputs/testbench.cpp", testbench_code)
            files.append(
                _descriptor(
                    staging,
                    "testbench_input",
                    "inputs/testbench.cpp",
                    "text/x-c++src",
                )
            )

        _write_json(
            staging / "logs/steps.json",
            [step.to_dict() for step in result.steps],
        )
        files.append(
            _descriptor(
                staging,
                "step_log",
                "logs/steps.json",
                "application/json",
            )
        )

        if result.final_coverage and result.final_coverage.raw_output:
            _atomic_write_text(
                staging / "reports/coverage.txt",
                result.final_coverage.raw_output,
            )
            files.append(
                _descriptor(
                    staging,
                    "coverage_report",
                    "reports/coverage.txt",
                    "text/plain",
                )
            )

        rerun_argv = [
            "agent/venv/bin/python",
            "-m",
            "agent.cli",
            "rerun",
            "manifest.json",
        ]
        bundle = ArtifactBundle(
            run_directory=result.pipeline_id,
            manifest_path="manifest.json",
            checksums_path="checksums.sha256",
            files=files,
            rerun_argv=rerun_argv,
        )
        result.artifacts = bundle

        manifest = {
            "schema_version": SCHEMA_VERSION,
            "pipeline_id": result.pipeline_id,
            "result": result.to_dict(),
            "config": _portable_config(config),
            "artifacts": [item.to_dict() for item in files],
            "rerun": {
                "replay_kind": "frozen_inputs",
                "working_directory": ".",
                "argv": rerun_argv,
            },
        }
        _write_json(staging / "manifest.json", manifest)

        checksum_paths = [item.path for item in files] + ["manifest.json"]
        checksum_text = "".join(
            f"{_sha256(staging / relative_path)}  {relative_path}\n"
            for relative_path in checksum_paths
        )
        _atomic_write_text(staging / "checksums.sha256", checksum_text)

        os.replace(staging, final_dir)
        return bundle
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        result.artifacts = None
        raise


def _safe_bundle_path(run_dir: Path, relative_path: str) -> Path:
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise ArtifactIntegrityError(f"Unsafe artifact path: {relative_path}")
    target = (run_dir / relative).resolve()
    try:
        target.relative_to(run_dir.resolve())
    except ValueError as exc:
        raise ArtifactIntegrityError(
            f"Artifact path escapes run directory: {relative_path}"
        ) from exc
    if target.is_symlink() or not target.is_file():
        raise ArtifactIntegrityError(f"Artifact is missing: {relative_path}")
    return target


def verify_artifact_manifest(manifest_path: str | Path) -> dict:
    """Verify schema, containment, declared digests, and checksum sidecar."""
    manifest_path = Path(manifest_path).expanduser().resolve()
    run_dir = manifest_path.parent
    if manifest_path.name != "manifest.json" or not manifest_path.is_file():
        raise ArtifactIntegrityError(f"Manifest is missing: {manifest_path}")

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ArtifactIntegrityError(f"Invalid artifact manifest: {exc}") from exc
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ArtifactIntegrityError(
            f"Unsupported artifact schema: {manifest.get('schema_version')}"
        )

    checksums_path = _safe_bundle_path(run_dir, "checksums.sha256")
    declared_checksums: dict[str, str] = {}
    for line in checksums_path.read_text(encoding="utf-8").splitlines():
        try:
            digest, relative_path = line.split("  ", 1)
        except ValueError as exc:
            raise ArtifactIntegrityError("Malformed checksums.sha256") from exc
        declared_checksums[relative_path] = digest

    for item in manifest.get("artifacts", []):
        relative_path = item.get("path", "")
        target = _safe_bundle_path(run_dir, relative_path)
        actual = _sha256(target)
        if not hmac.compare_digest(actual, item.get("sha256", "")):
            raise ArtifactIntegrityError(
                f"Artifact checksum mismatch: {relative_path}"
            )
        if not hmac.compare_digest(actual, declared_checksums.get(relative_path, "")):
            raise ArtifactIntegrityError(
                f"Checksum sidecar mismatch: {relative_path}"
            )
        if target.stat().st_size != item.get("size_bytes"):
            raise ArtifactIntegrityError(f"Artifact size mismatch: {relative_path}")

    manifest_digest = _sha256(manifest_path)
    if not hmac.compare_digest(
        manifest_digest,
        declared_checksums.get("manifest.json", ""),
    ):
        raise ArtifactIntegrityError("Checksum sidecar mismatch: manifest.json")
    return manifest


def load_rerun_manifest(manifest_path: str | Path) -> RerunRequest:
    """Load a replay request only after validating the complete evidence bundle."""
    manifest_path = Path(manifest_path).expanduser().resolve()
    manifest = verify_artifact_manifest(manifest_path)
    run_dir = manifest_path.parent
    role_paths = {
        item["role"]: item["path"]
        for item in manifest.get("artifacts", [])
    }
    rtl_path = role_paths.get("rtl_input")
    if rtl_path is None:
        raise ArtifactIntegrityError("Manifest has no rtl_input artifact")
    rtl_code = _safe_bundle_path(run_dir, rtl_path).read_text(encoding="utf-8")

    testbench_code = None
    testbench_path = role_paths.get("testbench_input")
    if testbench_path is not None:
        testbench_code = _safe_bundle_path(run_dir, testbench_path).read_text(
            encoding="utf-8"
        )

    config_data = manifest.get("config", {})
    config = PipelineConfig(
        coverage_target=config_data.get("coverage_target", 0.8),
        lint_enabled=config_data.get("lint_enabled", True),
        simulation_timeout=config_data.get("simulation_timeout", 300),
        synthesis_enabled=config_data.get("synthesis_enabled", False),
        runtime_check_enabled=config_data.get("runtime_check_enabled", True),
        artifact_root=str(run_dir.parent),
    )
    return RerunRequest(
        rtl_code=rtl_code,
        testbench_code=testbench_code,
        config=config,
        expected_outcome=PipelineOutcome(manifest["result"]["outcome"]),
        source_pipeline_id=manifest["pipeline_id"],
    )
