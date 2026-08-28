"""Bounded local storage and materialization for imported timing projects."""

from __future__ import annotations

import re
import shutil
from collections.abc import Iterable
from pathlib import Path, PurePosixPath

PROJECT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
SUPPORTED_PROJECT_FILE_EXTENSIONS = {".v", ".sv", ".vh", ".svh", ".sdc"}
MAX_PROJECT_FILE_BYTES = 1024 * 1024
MAX_PROJECT_TOTAL_BYTES = 4 * 1024 * 1024
MAX_PROJECT_FILES = 32
INCLUDE_RE = re.compile(r'(?m)^\s*`include\s+"([^"\n]+)"')


class ProjectStoreError(ValueError):
    """A project cannot be safely stored or materialized."""


def _relative_path(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProjectStoreError(f"{field} must be a non-empty relative path")
    normalized = value.replace("\\", "/").strip()
    candidate = PurePosixPath(normalized)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        raise ProjectStoreError(f"{field} must stay inside the imported project")
    return candidate.as_posix()


def _project_root(repo_root: Path, project_id: str) -> tuple[Path, str]:
    if not isinstance(project_id, str) or not PROJECT_ID_RE.fullmatch(project_id):
        raise ProjectStoreError("project_id must be a lowercase local project identifier")
    workspace = (repo_root / ".xylon" / "projects").resolve()
    workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
    if workspace.is_symlink() or not workspace.is_relative_to(repo_root.resolve()):
        raise ProjectStoreError("project storage is outside the local workspace")
    root = workspace / project_id
    if root.exists() or root.is_symlink():
        raise ProjectStoreError("project_id already exists; choose a new local project identifier")
    return root, root.relative_to(repo_root.resolve()).as_posix()


def store_project_bundle(
    repo_root: Path,
    *,
    project_id: str,
    files: Iterable[tuple[str, str]],
) -> str:
    """Store a new bundle under the Xylon-owned project directory."""
    root, relative_root = _project_root(repo_root, project_id)
    materialized = list(files)
    if not materialized or len(materialized) > MAX_PROJECT_FILES:
        raise ProjectStoreError(f"project bundle must contain 1 to {MAX_PROJECT_FILES} files")
    total_bytes = 0
    seen: set[str] = set()
    try:
        root.mkdir(mode=0o700)
        for raw_path, content in materialized:
            relative = _relative_path(raw_path, "file path")
            if relative in seen:
                raise ProjectStoreError(f"duplicate project file: {relative}")
            seen.add(relative)
            suffix = Path(relative).suffix.lower()
            if suffix not in SUPPORTED_PROJECT_FILE_EXTENSIONS:
                raise ProjectStoreError(f"unsupported project file type: {suffix or relative}")
            if not isinstance(content, str) or not content:
                raise ProjectStoreError(f"project file {relative} must contain text")
            encoded = content.encode("utf-8")
            if len(encoded) > MAX_PROJECT_FILE_BYTES:
                raise ProjectStoreError(f"project file {relative} exceeds the 1 MiB limit")
            total_bytes += len(encoded)
            if total_bytes > MAX_PROJECT_TOTAL_BYTES:
                raise ProjectStoreError("project bundle exceeds the 4 MiB total limit")
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if destination.is_symlink() or destination.exists():
                raise ProjectStoreError(f"project file path is not available: {relative}")
            with destination.open("x", encoding="utf-8") as handle:
                handle.write(content)
            destination.chmod(0o600)
    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        raise
    return relative_root


def _safe_root(repo_root: Path, relative_root: str) -> Path:
    root = (repo_root / _relative_path(relative_root, "root")).resolve()
    repo = repo_root.resolve()
    if root.is_symlink() or not root.is_dir() or not root.is_relative_to(repo):
        raise ProjectStoreError("project root is not a local regular directory")
    return root


def _read_text(root: Path, relative: str) -> str:
    normalized = _relative_path(relative, "project file")
    candidate = (root / normalized).resolve()
    if candidate.is_symlink() or not candidate.is_file() or not candidate.is_relative_to(root):
        raise ProjectStoreError(f"project file is not a local regular file: {normalized}")
    content = candidate.read_text(encoding="utf-8")
    if len(content.encode("utf-8")) > MAX_PROJECT_FILE_BYTES:
        raise ProjectStoreError(f"project file exceeds the 1 MiB limit: {normalized}")
    return content


def materialize_timing_input(repo_root: Path, manifest: dict) -> dict[str, str]:
    """Expand a validated project into the existing self-contained timing contract."""
    root = _safe_root(repo_root, str(manifest.get("root", "")))
    rtl_files = manifest.get("rtl")
    include_dirs = manifest.get("include_dirs", [])
    if not isinstance(rtl_files, list) or not rtl_files:
        raise ProjectStoreError("project manifest has no RTL files")
    if not isinstance(include_dirs, list):
        raise ProjectStoreError("project manifest include_dirs is invalid")
    normalized_dirs = [_relative_path(str(value), "include_dirs") for value in include_dirs]
    active: set[str] = set()

    def expand(relative: str) -> str:
        normalized = _relative_path(relative, "RTL file")
        if normalized in active:
            raise ProjectStoreError(f"project include cycle detected at {normalized}")
        active.add(normalized)
        source = _read_text(root, normalized)
        source_dir = PurePosixPath(normalized).parent

        def replace(match: re.Match[str]) -> str:
            target = _relative_path(match.group(1), "include target")
            candidates = [source_dir / target, *[PurePosixPath(directory) / target for directory in normalized_dirs]]
            for candidate in candidates:
                candidate_path = candidate.as_posix()
                try:
                    _read_text(root, candidate_path)
                except (OSError, ProjectStoreError):
                    continue
                return expand(candidate_path)
            raise ProjectStoreError(f"included file was not found inside the project: {target}")

        expanded = INCLUDE_RE.sub(replace, source)
        active.remove(normalized)
        return expanded

    rtl = "\n".join(expand(str(relative)) for relative in rtl_files)
    sdc = _read_text(root, str(manifest.get("sdc", "")))
    return {
        "platform": str(manifest.get("platform", "")),
        "top_module": str(manifest.get("top", "")),
        "rtl": rtl,
        "sdc": sdc,
        "source_revision": str(manifest.get("source_revision", "")),
    }
