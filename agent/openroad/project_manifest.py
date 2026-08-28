"""Deterministic project manifest and preflight validation for M1 imports."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

SUPPORTED_PROJECT_SCHEMA = "xylon-project/v1"
SUPPORTED_PREFLIGHT_SCHEMA = "xylon-project-preflight/v1"
SUPPORTED_PLATFORM = "sky130hd"
SUPPORTED_RTL_EXTENSIONS = {".v", ".sv"}
SUPPORTED_INCLUDE_EXTENSIONS = {".vh", ".svh", ".v", ".sv"}
MAX_SOURCE_BYTES = 1024 * 1024
MAX_SDC_BYTES = 256 * 1024
IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,127}$")
MODULE_RE = re.compile(r"\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)\b")
CREATE_CLOCK_NAME_FIRST_RE = re.compile(
    r"^create_clock\s+-name\s+([A-Za-z_][A-Za-z0-9_$]*)\s+-period\s+([0-9]+(?:\.[0-9]+)?)\s+\[get_ports\s+(?:\{([A-Za-z_][A-Za-z0-9_$]*)\}|([A-Za-z_][A-Za-z0-9_$]*))\]$"
)
CREATE_CLOCK_PERIOD_FIRST_RE = re.compile(
    r"^create_clock\s+-period\s+([0-9]+(?:\.[0-9]+)?)\s+-name\s+([A-Za-z_][A-Za-z0-9_$]*)\s+\[get_ports\s+(?:\{([A-Za-z_][A-Za-z0-9_$]*)\}|([A-Za-z_][A-Za-z0-9_$]*))\]$"
)
MACRO_TOKEN_RE = re.compile(r"`([A-Za-z_][A-Za-z0-9_$]*)")
MACRO_DEFINE_RE = re.compile(r"(?m)^\s*`define\s+([A-Za-z_][A-Za-z0-9_$]*)\b")
MACRO_CONDITIONAL_RE = re.compile(
    r"(?m)^\s*`(?:ifdef|ifndef|elsif)\s+([A-Za-z_][A-Za-z0-9_$]*)\b"
)
INCLUDE_RE = re.compile(r'(?m)^\s*`include\s+"([^"\n]+)"')
UNSAFE_UNIT_RE = re.compile(r"(?<![A-Za-z_])\d+(?:\.\d+)?\s*(?:ps|fs|us|ms|s)\b", re.IGNORECASE)
PREPROCESSOR_DIRECTIVES = {
    "begin_keywords",
    "celldefine",
    "default_nettype",
    "define",
    "else",
    "elsif",
    "end_keywords",
    "endcelldefine",
    "endif",
    "ifdef",
    "ifndef",
    "include",
    "line",
    "nounconnected_drive",
    "pragma",
    "resetall",
    "timescale",
    "unconnected_drive",
    "undef",
    "undefineall",
}
BUILTIN_MACROS = {"__FILE__", "__LINE__"}


@dataclass(frozen=True)
class ProjectPreflightError(Exception):
    code: str
    message: str
    field: str | None
    state: str
    action: str

    def __str__(self) -> str:
        return self.message


def _fail(
    code: str,
    message: str,
    *,
    field: str | None = None,
    state: str = "needs_correction",
    action: str,
) -> None:
    raise ProjectPreflightError(code, message, field, state, action)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalize_relative_path(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        _fail(
            "EMPTY_PATH",
            f"{field} must be a non-empty relative path",
            field=field,
            action="Set the field to a relative path inside the imported project workspace.",
        )
    normalized = value.replace("\\", "/").strip()
    path = PurePosixPath(normalized)
    if path.is_absolute() or any(part == ".." for part in path.parts):
        _fail(
            "PATH_ESCAPE",
            f"{field} must stay inside the imported project workspace",
            field=field,
            state="cannot_run",
            action="Choose a relative path that stays inside the imported project workspace.",
        )
    collapsed = path.as_posix()
    if collapsed in {"", "."}:
        _fail(
            "EMPTY_PATH",
            f"{field} must name a specific path",
            field=field,
            action="Choose a specific file or directory path inside the imported project workspace.",
        )
    return collapsed


def _normalize_identifier(value: str, field: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER_RE.fullmatch(value):
        _fail(
            "INVALID_IDENTIFIER",
            f"{field} must be a simple Verilog identifier",
            field=field,
            action=f"Set {field} to a valid Verilog identifier such as clk or top_level.",
        )
    return value


def _resolve_root(repo_root: Path, root: str) -> tuple[str, Path]:
    normalized = _normalize_relative_path(root, "root")
    declared = repo_root / normalized
    if not declared.exists() or not declared.is_dir():
        _fail(
            "ROOT_NOT_FOUND",
            "root must reference an existing project directory",
            field="root",
            action="Point root to an existing imported project directory inside the local workspace.",
        )
    resolved = declared.resolve(strict=True)
    repo_resolved = repo_root.resolve()
    if not resolved.is_relative_to(repo_resolved):
        _fail(
            "SYMLINK_ESCAPE",
            "root resolves outside the local workspace",
            field="root",
            state="cannot_run",
            action="Import or copy the project into the local workspace instead of following an external symlink.",
        )
    return normalized, resolved


def _resolve_workspace_path(
    root_path: Path,
    relative: str,
    *,
    field: str,
    expect_directory: bool = False,
) -> tuple[str, Path]:
    normalized = _normalize_relative_path(relative, field)
    declared = root_path / normalized
    if not declared.exists():
        _fail(
            "FILE_NOT_FOUND" if not expect_directory else "DIRECTORY_NOT_FOUND",
            f"{field} does not exist inside the imported project workspace",
            field=field,
            action="Fix the manifest path so it points to an existing workspace file or directory.",
        )
    resolved = declared.resolve(strict=True)
    if not resolved.is_relative_to(root_path):
        _fail(
            "SYMLINK_ESCAPE",
            f"{field} resolves outside the imported project workspace",
            field=field,
            state="cannot_run",
            action="Replace the escaping symlink with a file or directory stored directly inside the imported project workspace.",
        )
    if expect_directory and not resolved.is_dir():
        _fail(
            "DIRECTORY_NOT_FOUND",
            f"{field} must reference a directory",
            field=field,
            action="Set the field to a directory inside the imported project workspace.",
        )
    if not expect_directory and not resolved.is_file():
        _fail(
            "FILE_NOT_FOUND",
            f"{field} must reference a regular file",
            field=field,
            action="Set the field to a regular file inside the imported project workspace.",
        )
    return normalized, resolved


def _read_bounded_text(path: Path, *, field: str, maximum_bytes: int) -> str:
    payload = path.read_text(encoding="utf-8")
    if len(payload.encode("utf-8")) > maximum_bytes:
        _fail(
            "FILE_TOO_LARGE",
            f"{field} exceeds the {maximum_bytes}-byte limit",
            field=field,
            action="Reduce the imported source or split it into smaller files before preflight.",
        )
    return payload


def _strip_verilog_comments(source: str) -> str:
    output: list[str] = []
    index = 0
    state = "code"
    while index < len(source):
        character = source[index]
        nxt = source[index + 1] if index + 1 < len(source) else ""
        if state == "line-comment":
            if character == "\n":
                output.append("\n")
                state = "code"
            else:
                output.append(" ")
            index += 1
            continue
        if state == "block-comment":
            if character == "*" and nxt == "/":
                output.extend((" ", " "))
                state = "code"
                index += 2
            else:
                output.append("\n" if character == "\n" else " ")
                index += 1
            continue
        if state == "string":
            output.append(character)
            if character == "\\" and nxt:
                output.append(nxt)
                index += 2
                continue
            if character == '"':
                state = "code"
            index += 1
            continue
        if character == "/" and nxt == "/":
            output.extend((" ", " "))
            state = "line-comment"
            index += 2
            continue
        if character == "/" and nxt == "*":
            output.extend((" ", " "))
            state = "block-comment"
            index += 2
            continue
        output.append(character)
        if character == '"':
            state = "string"
        index += 1
    if state == "block-comment":
        _fail(
            "MALFORMED_RTL",
            "RTL contains an unterminated block comment",
            field="rtl",
            action="Fix the unterminated comment before rerunning preflight.",
        )
    if state == "string":
        _fail(
            "MALFORMED_RTL",
            "RTL contains an unterminated string",
            field="rtl",
            action="Fix the unterminated string literal before rerunning preflight.",
        )
    return "".join(output)


def _extract_balanced_parentheses(source: str, opening_index: int) -> tuple[str, int]:
    depth = 0
    for index in range(opening_index, len(source)):
        if source[index] == "(":
            depth += 1
        elif source[index] == ")":
            depth -= 1
            if depth == 0:
                return source[opening_index + 1 : index], index
    _fail(
        "MALFORMED_RTL",
        "top module declaration has unbalanced parentheses",
        field="top",
        action="Fix the top module port declaration before rerunning preflight.",
    )


def _top_module_source(rtl_without_comments: str, top: str) -> str:
    declarations = list(re.finditer(rf"\bmodule\s+{re.escape(top)}\b", rtl_without_comments))
    if len(declarations) != 1:
        _fail(
            "TOP_MODULE_COUNT",
            f"RTL must contain exactly one module declaration named {top}; found {len(declarations)}",
            field="top",
            action="Set top to the single synthesizable top module, or remove the duplicate declaration.",
        )
    start = declarations[0].start()
    end_match = re.search(r"\bendmodule\b", rtl_without_comments[start:])
    if end_match is None:
        _fail(
            "MALFORMED_RTL",
            f"module {top} has no matching endmodule",
            field="top",
            action="Fix the top module declaration before rerunning preflight.",
        )
    end = start + end_match.end()
    return rtl_without_comments[start:end]


def _module_port_list(module_source: str, top: str) -> tuple[str, int]:
    match = re.search(rf"\bmodule\s+{re.escape(top)}\b", module_source)
    assert match is not None
    cursor = match.end()
    while cursor < len(module_source) and module_source[cursor].isspace():
        cursor += 1
    if cursor < len(module_source) and module_source[cursor] == "#":
        cursor += 1
        while cursor < len(module_source) and module_source[cursor].isspace():
            cursor += 1
        if cursor >= len(module_source) or module_source[cursor] != "(":
            _fail(
                "MALFORMED_RTL",
                "parameterized top module has a malformed parameter list",
                field="top",
                action="Fix the top module parameter list before rerunning preflight.",
            )
        _, cursor = _extract_balanced_parentheses(module_source, cursor)
        cursor += 1
        while cursor < len(module_source) and module_source[cursor].isspace():
            cursor += 1
    if cursor >= len(module_source) or module_source[cursor] != "(":
        _fail(
            "MALFORMED_RTL",
            "top module must declare an explicit port list",
            field="top",
            action="Add an explicit port list to the top module before rerunning preflight.",
        )
    return _extract_balanced_parentheses(module_source, cursor)


def _clock_is_input_port(module_source: str, top: str, clock_port: str) -> bool:
    port_list, port_list_end = _module_port_list(module_source, top)
    port_token = re.compile(rf"\b{re.escape(clock_port)}\b")
    direction: str | None = None
    for item in port_list.split(","):
        direction_match = re.search(r"\b(input|output|inout)\b", item)
        if direction_match:
            direction = direction_match.group(1)
        if direction == "input" and port_token.search(item):
            return True
    if not port_token.search(port_list):
        return False
    body_after_header = module_source[port_list_end + 1 :]
    for declaration in re.finditer(r"\binput\b([^;]*);", body_after_header):
        if port_token.search(declaration.group(1)):
            return True
    return False


def _parse_manifest_clock(clock: dict[str, Any], index: int) -> dict[str, Any]:
    if not isinstance(clock, dict):
        _fail(
            "INVALID_CLOCK",
            "each clocks entry must be an object",
            field=f"clocks[{index}]",
            action="Set clocks to objects with name, port, and period_ns.",
        )
    name = _normalize_identifier(clock.get("name"), f"clocks[{index}].name")
    port = _normalize_identifier(clock.get("port"), f"clocks[{index}].port")
    period = clock.get("period_ns")
    if not isinstance(period, (int, float)) or isinstance(period, bool) or period <= 0 or period > 1000:
        _fail(
            "INVALID_CLOCK_PERIOD",
            "clock period_ns must be a positive number no greater than 1000 ns",
            field=f"clocks[{index}].period_ns",
            action="Set each clock period_ns to a plain positive nanosecond value.",
        )
    normalized_period = float(period)
    return {"name": name, "port": port, "period_ns": int(normalized_period) if normalized_period.is_integer() else normalized_period}


def _parse_create_clock(line: str) -> dict[str, Any] | None:
    first = CREATE_CLOCK_NAME_FIRST_RE.fullmatch(line)
    second = CREATE_CLOCK_PERIOD_FIRST_RE.fullmatch(line)
    if first is None and second is None:
        return None
    if first is not None:
        name = first.group(1)
        period_text = first.group(2)
        port = first.group(3) or first.group(4)
    else:
        assert second is not None
        period_text = second.group(1)
        name = second.group(2)
        port = second.group(3) or second.group(4)
    period = float(period_text)
    return {"name": name, "port": port, "period_ns": int(period) if period.is_integer() else period}


def _parse_sdc_clocks(sdc_text: str) -> list[dict[str, Any]]:
    if len(sdc_text.encode("utf-8")) > MAX_SDC_BYTES:
        _fail(
            "FILE_TOO_LARGE",
            f"sdc exceeds the {MAX_SDC_BYTES}-byte limit",
            field="sdc",
            action="Reduce the SDC file size before rerunning preflight.",
        )
    if re.search(r"(?m)^\s*set_units\b", sdc_text):
        _fail(
            "INVALID_SDC_UNIT",
            "SDC set_units is not supported; clock periods must be plain nanosecond decimals",
            field="sdc",
            action="Rewrite the SDC to use plain nanosecond decimals in create_clock commands.",
        )
    if UNSAFE_UNIT_RE.search(sdc_text):
        _fail(
            "INVALID_SDC_UNIT",
            "SDC time values must use plain nanosecond decimals without unit suffixes",
            field="sdc",
            action="Replace unit-suffixed SDC values such as 10ps with plain nanosecond decimals.",
        )
    clocks: list[dict[str, Any]] = []
    for raw_line in sdc_text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parsed = _parse_create_clock(line)
        if parsed is not None:
            clocks.append(parsed)
        elif re.match(r"^create_clock\b", line):
            _fail(
                "UNSUPPORTED_CREATE_CLOCK",
                "every create_clock command must use one -name, one -period, and one get_ports target",
                field="sdc",
                action="Rewrite every create_clock command using the supported named-clock form before rerunning preflight.",
            )
    if not clocks:
        _fail(
            "MISSING_CLOCK",
            "SDC must declare at least one create_clock command",
            field="sdc",
            action="Add create_clock constraints to the SDC before rerunning preflight.",
        )
    return clocks


def _collect_macros_from_source(rtl_text: str) -> set[str]:
    stripped = _strip_verilog_comments(rtl_text)
    declared = set(MACRO_DEFINE_RE.findall(stripped))
    for match in MACRO_CONDITIONAL_RE.findall(stripped):
        declared.add(match)
    return declared


def _verify_macros(
    file_texts: dict[str, str],
    *,
    manifest_macros: set[str],
) -> None:
    declared = set(manifest_macros)
    for text in file_texts.values():
        declared.update(_collect_macros_from_source(text))
    allowed = declared | PREPROCESSOR_DIRECTIVES | BUILTIN_MACROS
    for relative_path, text in file_texts.items():
        stripped = _strip_verilog_comments(text)
        for macro in MACRO_CONDITIONAL_RE.findall(stripped):
            if macro not in allowed:
                _fail(
                    "UNDECLARED_MACRO",
                    f"macro `{macro}` is used in {relative_path} but not declared in manifest.macros or source defines",
                    field="macros",
                    action=f"Declare macro {macro} in manifest.macros or define it in a source file before preflight.",
                )
        for macro in MACRO_TOKEN_RE.findall(stripped):
            if macro not in allowed:
                _fail(
                    "UNDECLARED_MACRO",
                    f"macro `{macro}` is used in {relative_path} but not declared in manifest.macros or source defines",
                    field="macros",
                    action=f"Declare macro {macro} in manifest.macros or define it in a source file before preflight.",
                )


def _resolve_include_path(
    include_target: str,
    *,
    from_relative: str,
    from_absolute: Path,
    root_path: Path,
    include_dirs: list[tuple[str, Path]],
) -> tuple[str, Path]:
    normalized = _normalize_relative_path(include_target, f"include in {from_relative}")
    search_roots = [(str(PurePosixPath(from_relative).parent), from_absolute.parent), *include_dirs]
    for _label, base_dir in search_roots:
        candidate = base_dir / normalized
        if not candidate.exists():
            continue
        resolved = candidate.resolve(strict=True)
        if not resolved.is_relative_to(root_path):
            _fail(
                "SYMLINK_ESCAPE",
                f"include {include_target} from {from_relative} resolves outside the imported project workspace",
                field="include_dirs",
                state="cannot_run",
                action="Move the included file into the imported project workspace or adjust include_dirs to stay inside it.",
            )
        if resolved.suffix.lower() not in SUPPORTED_INCLUDE_EXTENSIONS:
            _fail(
                "UNSUPPORTED_HDL",
                f"include {include_target} uses an unsupported HDL extension",
                field="include_dirs",
                state="cannot_run",
                action="Use .vh, .svh, .v, or .sv include files for this bounded import path.",
            )
        relative = resolved.relative_to(root_path).as_posix()
        return relative, resolved
    _fail(
        "FILE_NOT_FOUND",
        f"include {include_target} from {from_relative} was not found in the source directory or include_dirs",
        field="include_dirs",
        action="Add the missing include file or extend include_dirs so the include resolves inside the project workspace.",
    )


def _collect_project_sources(
    *,
    root_path: Path,
    rtl_files: list[tuple[str, Path]],
    include_dirs: list[tuple[str, Path]],
) -> dict[str, str]:
    collected: dict[str, str] = {}
    pending = list(rtl_files)
    while pending:
        relative, absolute = pending.pop()
        if relative in collected:
            continue
        text = _read_bounded_text(absolute, field="rtl", maximum_bytes=MAX_SOURCE_BYTES)
        collected[relative] = text
        stripped = _strip_verilog_comments(text)
        for include_target in INCLUDE_RE.findall(stripped):
            include_relative, include_absolute = _resolve_include_path(
                include_target,
                from_relative=relative,
                from_absolute=absolute,
                root_path=root_path,
                include_dirs=include_dirs,
            )
            if include_relative not in collected:
                pending.append((include_relative, include_absolute))
    return collected


def _build_source_revision(
    *,
    root: str,
    top: str,
    platform: str,
    rtl: list[str],
    include_dirs: list[str],
    sdc: str,
    clocks: list[dict[str, Any]],
    macros: list[str],
    file_texts: dict[str, str],
    sdc_text: str,
) -> str:
    payload = {
        "schema": SUPPORTED_PROJECT_SCHEMA,
        "root": root,
        "top": top,
        "platform": platform,
        "rtl": rtl,
        "include_dirs": include_dirs,
        "sdc": sdc,
        "clocks": clocks,
        "macros": macros,
        "files": [
            {"path": relative, "sha256": _sha256_text(text)}
            for relative, text in sorted(file_texts.items())
        ]
        + [{"path": sdc, "sha256": _sha256_text(sdc_text)}],
    }
    return _sha256_text(_canonical_json(payload))


def build_project_manifest(repo_root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    platform = payload.get("platform")
    if platform != SUPPORTED_PLATFORM:
        _fail(
            "UNSUPPORTED_PLATFORM",
            f"platform must be exactly {SUPPORTED_PLATFORM}",
            field="platform",
            state="cannot_run",
            action=f"Set platform to {SUPPORTED_PLATFORM} for the bounded v0.6 import path.",
        )
    root, root_path = _resolve_root(repo_root, payload.get("root"))
    top = _normalize_identifier(payload.get("top"), "top")

    raw_rtl = payload.get("rtl")
    if not isinstance(raw_rtl, list) or not raw_rtl:
        _fail(
            "MISSING_RTL",
            "rtl must list at least one Verilog or SystemVerilog source file",
            field="rtl",
            action="Add one or more .v or .sv source files to rtl before rerunning preflight.",
        )
    rtl_files: list[tuple[str, Path]] = []
    rtl_paths: list[str] = []
    for index, entry in enumerate(raw_rtl):
        normalized, resolved = _resolve_workspace_path(root_path, entry, field=f"rtl[{index}]")
        if resolved.suffix.lower() not in SUPPORTED_RTL_EXTENSIONS:
            _fail(
                "UNSUPPORTED_HDL",
                f"rtl[{index}] must use a supported HDL extension (.v or .sv)",
                field=f"rtl[{index}]",
                state="cannot_run",
                action="Restrict rtl files to .v or .sv for this bounded import path.",
            )
        rtl_files.append((normalized, resolved))
        rtl_paths.append(normalized)

    raw_include_dirs = payload.get("include_dirs", [])
    if not isinstance(raw_include_dirs, list):
        _fail(
            "INVALID_INCLUDE_DIRS",
            "include_dirs must be an array of relative directories",
            field="include_dirs",
            action="Set include_dirs to an array of directories inside the imported project workspace.",
        )
    include_dirs: list[tuple[str, Path]] = []
    include_dir_paths: list[str] = []
    for index, entry in enumerate(raw_include_dirs):
        normalized, resolved = _resolve_workspace_path(
            root_path,
            entry,
            field=f"include_dirs[{index}]",
            expect_directory=True,
        )
        include_dirs.append((normalized, resolved))
        include_dir_paths.append(normalized)

    sdc_relative, sdc_path = _resolve_workspace_path(root_path, payload.get("sdc"), field="sdc")
    sdc_text = _read_bounded_text(sdc_path, field="sdc", maximum_bytes=MAX_SDC_BYTES)
    parsed_sdc_clocks = _parse_sdc_clocks(sdc_text)

    raw_clocks = payload.get("clocks")
    if not isinstance(raw_clocks, list) or not raw_clocks:
        _fail(
            "MISSING_CLOCK",
            "clocks must declare at least one clock before heavy work starts",
            field="clocks",
            action="Add the imported design clocks to manifest.clocks before rerunning preflight.",
        )
    manifest_clocks = [_parse_manifest_clock(clock, index) for index, clock in enumerate(raw_clocks)]
    if manifest_clocks != parsed_sdc_clocks:
        _fail(
            "CLOCK_MISMATCH",
            "clocks must match the create_clock declarations in the SDC exactly",
            field="clocks",
            action="Align manifest.clocks with the SDC create_clock declarations before rerunning preflight.",
        )

    raw_macros = payload.get("macros", [])
    if not isinstance(raw_macros, list):
        _fail(
            "INVALID_MACROS",
            "macros must be an array of Verilog macro names",
            field="macros",
            action="Set macros to an array of simple Verilog macro identifiers.",
        )
    macros: list[str] = []
    for index, macro in enumerate(raw_macros):
        macros.append(_normalize_identifier(macro, f"macros[{index}]"))

    file_texts = _collect_project_sources(root_path=root_path, rtl_files=rtl_files, include_dirs=include_dirs)
    _verify_macros(file_texts, manifest_macros=set(macros))

    aggregate_rtl = "\n".join(file_texts[path] for path in rtl_paths if path in file_texts)
    stripped = _strip_verilog_comments(aggregate_rtl)
    top_module = _top_module_source(stripped, top)
    for clock in manifest_clocks:
        if not _clock_is_input_port(top_module, top, clock["port"]):
            _fail(
                "CLOCK_PORT_NOT_INPUT",
                f"{clock['port']} must be an input port of top module {top}",
                field="clocks",
                action=f"Fix top module {top} so clock port {clock['port']} is an input, or correct the clock definition.",
            )

    source_revision = _build_source_revision(
        root=root,
        top=top,
        platform=platform,
        rtl=rtl_paths,
        include_dirs=include_dir_paths,
        sdc=sdc_relative,
        clocks=manifest_clocks,
        macros=macros,
        file_texts=file_texts,
        sdc_text=sdc_text,
    )
    return {
        "schema": SUPPORTED_PROJECT_SCHEMA,
        "project_id": source_revision[:32],
        "root": root,
        "top": top,
        "platform": SUPPORTED_PLATFORM,
        "rtl": rtl_paths,
        "include_dirs": include_dir_paths,
        "sdc": sdc_relative,
        "clocks": manifest_clocks,
        "macros": macros,
        "source_revision": source_revision,
    }


def preflight_project_manifest(repo_root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        manifest = build_project_manifest(repo_root, payload)
    except ProjectPreflightError as error:
        return {
            "schema_version": SUPPORTED_PREFLIGHT_SCHEMA,
            "state": error.state,
            "manifest": None,
            "failure": {
                "code": error.code,
                "field": error.field,
                "message": error.message,
                "action": error.action,
            },
        }
    return {
        "schema_version": SUPPORTED_PREFLIGHT_SCHEMA,
        "state": "ready",
        "manifest": manifest,
        "failure": None,
    }
