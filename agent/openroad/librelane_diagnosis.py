"""Strict native LibreLane worst-path diagnosis readback."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

LIBRELANE_CTS_REPAIR_PARAMETER = "RUN_POST_CTS_RESIZER_TIMING"
MAX_REPORT_BYTES = 512 * 1024
MAX_CANDIDATE_REPORTS = 64
MAX_PATH_SECTION_BYTES = 32 * 1024
NUMBER = r"(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)"
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*m")
SETUP_STAGE_TOKENS = {
    "cts",
    "clock_tree_synthesis",
    "global_route",
    "global_routing",
    "grt",
    "route",
    "routing",
    "detailed_route",
    "detail_route",
    "signoff",
}


def _base_diagnosis() -> dict[str, Any]:
    return {
        "status": "unavailable",
        "unavailable_reason": "missing_report",
        "stage": None,
        "corner": None,
        "report": None,
        "startpoint": None,
        "endpoint": None,
        "path_group": None,
        "path_type": None,
        "arrival_ns": None,
        "required_ns": None,
        "slack_ns": None,
        "next_action": None,
    }


def _safe_file(root: Path, relative: str) -> Path | None:
    try:
        declared = root / relative
        resolved = declared.resolve()
    except OSError:
        return None
    if declared.is_symlink() or not resolved.is_file() or not resolved.is_relative_to(root.resolve()):
        return None
    return resolved


def _safe_dir(root: Path, candidate: Path) -> Path | None:
    try:
        resolved = candidate.resolve()
    except OSError:
        return None
    if candidate.is_symlink() or not resolved.is_dir() or not resolved.is_relative_to(root.resolve()):
        return None
    return resolved


def _report_search_roots(run_root: Path, readback: dict[str, Any]) -> list[Path]:
    roots: list[Path] = []
    paths = readback.get("paths")
    metrics_path = paths.get("metrics") if isinstance(paths, dict) else None
    if isinstance(metrics_path, str):
        metrics_file = _safe_file(run_root, metrics_path)
        if metrics_file is not None:
            if "runs/" in metrics_path:
                roots.append(metrics_file.parent.parent)
            else:
                roots.append(metrics_file.parent)
    for candidate in (run_root / "runs", run_root / "reports", run_root):
        safe = _safe_dir(run_root, candidate)
        if safe is not None and safe not in roots:
            roots.append(safe)
    return roots


def _candidate_reports(run_root: Path, readback: dict[str, Any]) -> list[Path]:
    roots = _report_search_roots(run_root, readback)
    max_reports: list[Path] = []
    fallback_reports: list[Path] = []
    for search_root in roots:
        for pattern, bucket in (
            ("**/max.rpt", max_reports),
            ("**/*global_route*.rpt", fallback_reports),
        ):
            for path in sorted(search_root.glob(pattern)):
                if len(max_reports) + len(fallback_reports) >= MAX_CANDIDATE_REPORTS:
                    return max_reports or fallback_reports
                relative = path.relative_to(run_root.resolve()).as_posix()
                safe = _safe_file(run_root, relative)
                if safe is None or safe in max_reports or safe in fallback_reports:
                    continue
                bucket.append(safe)
    return max_reports or fallback_reports


def _read_report(run_root: Path, report_path: Path) -> tuple[str, dict[str, Any]]:
    relative = report_path.relative_to(run_root.resolve()).as_posix()
    content = report_path.read_bytes()
    if len(content) > MAX_REPORT_BYTES:
        raise ValueError("report_exceeds_bounded_limit")
    return content.decode("utf-8"), {
        "path": relative,
        "sha256": hashlib.sha256(content).hexdigest(),
        "bytes": len(content),
    }


def _field(text: str, name: str) -> str | None:
    match = re.search(rf"^\s*{re.escape(name)}:\s*(.+?)\s*$", text, re.MULTILINE | re.IGNORECASE)
    return match.group(1).strip() if match else None


def _metric(text: str, label: str) -> float | None:
    values: list[float] = []
    leading = re.compile(rf"^\s*{NUMBER}\s+{re.escape(label)}\s*$", re.MULTILINE | re.IGNORECASE)
    values.extend(float(match.group(1)) for match in leading.finditer(text))
    trailing = re.compile(rf"^\s*{re.escape(label)}\s*[:=]?\s*{NUMBER}\s*$", re.MULTILINE | re.IGNORECASE)
    values.extend(float(match.group(1)) for match in trailing.finditer(text))
    if not values:
        return None
    non_negative = [value for value in values if value >= 0]
    return non_negative[-1] if non_negative else values[-1]


def _max_path_section(report: str) -> tuple[str, str]:
    header = re.search(r"^.*\breport_checks[ \t]+-path_delay[ \t]+max(?:[ \t]+[^\r\n]*)?$", report, re.MULTILINE | re.IGNORECASE)
    if header is None:
        raise ValueError("missing_max_path_section")
    return header.group(0).strip(), report[header.end() :]


def _normalized_stage_from_path(report_path: Path) -> str | None:
    if report_path.name == "max.rpt" and len(report_path.parents) >= 2:
        stage_name = re.sub(r"^\d+-?", "", report_path.parents[1].name.lower())
        stage = re.sub(r"[^a-z0-9]+", "_", stage_name).strip("_")
        if stage:
            return stage
    stem = re.sub(r"^\d+_?", "", report_path.stem.lower())
    stage = re.sub(r"[^a-z0-9]+", "_", stem).strip("_")
    return stage or None


def _stage_order(report_path: Path) -> int:
    if report_path.name != "max.rpt" or len(report_path.parents) < 2:
        return 0
    match = re.match(r"^(\d+)-", report_path.parents[1].name)
    return int(match.group(1)) if match else 0


def _corner_from_context(report_path: Path, section: str) -> str | None:
    banner = re.search(r"=+\s*([A-Za-z0-9_.-]+)\s+Corner\s*=+", section, re.IGNORECASE)
    if banner:
        return banner.group(1).strip()
    if report_path.name == "max.rpt":
        corner = report_path.parent.name.strip()
        if corner and corner != "max":
            return corner
    return None


def _parse_report_candidate(run_root: Path, report_path: Path) -> dict[str, Any]:
    raw_report, report = _read_report(run_root, report_path)
    clean_report = ANSI_ESCAPE_RE.sub("", raw_report)
    _, section = _max_path_section(clean_report)
    startpoint_match = re.search(r"^\s*Startpoint:\s*", section, re.MULTILINE | re.IGNORECASE)
    if startpoint_match is None:
        raise ValueError("missing_startpoint")
    tail = section[startpoint_match.start() :]
    slack_match = None
    for pattern in (
        re.compile(rf"^\s*{NUMBER}\s+slack(?:\s+\([^)]*\))?\s*$", re.MULTILINE | re.IGNORECASE),
        re.compile(rf"^\s*slack(?:\s+\([^)]*\))?\s+{NUMBER}\s*$", re.MULTILINE | re.IGNORECASE),
    ):
        slack_match = pattern.search(tail)
        if slack_match:
            break
    if slack_match is None:
        raise ValueError("missing_slack")
    bounded = tail[: min(slack_match.end(), MAX_PATH_SECTION_BYTES)]
    startpoint = _field(bounded, "Startpoint")
    endpoint = _field(bounded, "Endpoint")
    path_type = _field(bounded, "Path Type")
    required_ns = _metric(bounded, "data required time")
    arrival_ns = _metric(bounded, "data arrival time")
    if not startpoint or not endpoint or not path_type or not re.search(r"\bmax\b", path_type, re.IGNORECASE):
        raise ValueError("incomplete_path_identity")
    if required_ns is None or arrival_ns is None:
        raise ValueError("missing_arrival_or_required")
    return {
        "status": "available",
        "unavailable_reason": None,
        "stage": _normalized_stage_from_path(report_path),
        "corner": _corner_from_context(report_path, section),
        "report": report,
        "startpoint": startpoint,
        "endpoint": endpoint,
        "path_group": _field(bounded, "Path Group"),
        "path_type": path_type,
        "arrival_ns": arrival_ns,
        "required_ns": required_ns,
        "slack_ns": float(slack_match.group(1)),
        "next_action": None,
        "_stage_order": _stage_order(report_path),
    }


def _stage_supports_cts(stage: str | None) -> bool:
    return isinstance(stage, str) and (stage in SETUP_STAGE_TOKENS or stage.startswith("openroad_sta"))


def _proposal_like_action(diagnosis: dict[str, Any], config: dict[str, Any] | None) -> dict[str, Any] | None:
    if diagnosis.get("status") != "available" or not isinstance(config, dict):
        return None
    slack = diagnosis.get("slack_ns")
    if not isinstance(slack, (int, float)) or slack >= 0:
        return None
    if not _stage_supports_cts(diagnosis.get("stage")):
        return None
    if config.get(LIBRELANE_CTS_REPAIR_PARAMETER, False) is not False:
        return None
    return {
        "strategy": "cts",
        "parameter": LIBRELANE_CTS_REPAIR_PARAMETER,
        "from": 0,
        "to": 1,
        "rationale": "Measured negative setup slack on a native max-path report; request one bounded CTS timing-repair rerun.",
    }


def build_librelane_diagnosis(
    run_root: Path,
    readback: dict[str, Any] | None,
    *,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    diagnosis = _base_diagnosis()
    if not isinstance(readback, dict):
        return diagnosis
    aggregate_wns = None
    metrics = readback.get("metrics")
    if isinstance(metrics, dict):
        metric_wns = metrics.get("timing__setup__wns")
        if isinstance(metric_wns, (int, float)) and not isinstance(metric_wns, bool):
            aggregate_wns = float(metric_wns)
    candidates: list[dict[str, Any]] = []
    first_error: str | None = None
    for report_path in _candidate_reports(run_root.resolve(), readback):
        try:
            candidate = _parse_report_candidate(run_root.resolve(), report_path)
        except (OSError, UnicodeDecodeError):
            if first_error is None:
                first_error = "report_unreadable"
            continue
        except ValueError as error:
            if first_error is None:
                first_error = str(error)
            continue
        candidates.append(candidate)
    if not candidates:
        diagnosis["unavailable_reason"] = first_error or "missing_report"
        return diagnosis
    if aggregate_wns is not None:
        matching = [candidate for candidate in candidates if abs(candidate["slack_ns"] - aggregate_wns) <= 0.01]
        if matching:
            best = max(matching, key=lambda candidate: (candidate["_stage_order"], -candidate["slack_ns"]))
        else:
            latest_stage = max(candidate["_stage_order"] for candidate in candidates)
            latest = [candidate for candidate in candidates if candidate["_stage_order"] == latest_stage]
            best = min(latest, key=lambda candidate: candidate["slack_ns"])
    else:
        latest_stage = max(candidate["_stage_order"] for candidate in candidates)
        latest = [candidate for candidate in candidates if candidate["_stage_order"] == latest_stage]
        best = min(latest, key=lambda candidate: candidate["slack_ns"])
    best["next_action"] = _proposal_like_action(best, config)
    best.pop("_stage_order", None)
    return best


def diagnosis_binding(diagnosis: dict[str, Any] | None) -> dict[str, Any]:
    if (
        not isinstance(diagnosis, dict)
        or diagnosis.get("status") != "available"
        or not isinstance(diagnosis.get("report"), dict)
    ):
        return {}
    report = diagnosis["report"]
    if not isinstance(report.get("path"), str) or not isinstance(report.get("sha256"), str):
        return {}
    return {
        "diagnosis_stage": diagnosis.get("stage"),
        "diagnosis_report_path": report["path"],
        "diagnosis_report_sha256": report["sha256"],
        "diagnosis_slack_ns": diagnosis.get("slack_ns"),
    }


def load_json_config(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None
