from pathlib import Path

from agent.openroad.project_manifest import (
    preflight_project_manifest,
)


def _project(tmp_path: Path) -> tuple[Path, dict]:
    root = tmp_path / "counter"
    (root / "rtl").mkdir(parents=True)
    (root / "constraints").mkdir()
    (root / "include").mkdir()
    (root / "include" / "defs.svh").write_text(
        "`define RESET_VALUE 1'b0\n", encoding="utf-8"
    )
    (root / "rtl" / "counter.sv").write_text(
        '`include "defs.svh"\nmodule counter(input logic clk, output logic q); always_ff @(posedge clk) q <= `RESET_VALUE; endmodule\n',
        encoding="utf-8",
    )
    (root / "rtl" / "helper.sv").write_text(
        "module helper(input logic a, output logic y); assign y = a; endmodule\n",
        encoding="utf-8",
    )
    (root / "constraints" / "counter.sdc").write_text(
        "create_clock -name clk -period 10 [get_ports clk]\n",
        encoding="utf-8",
    )
    return root, {
        "root": "counter",
        "top": "counter",
        "platform": "sky130hd",
        "rtl": ["rtl/counter.sv", "rtl/helper.sv"],
        "include_dirs": ["include"],
        "sdc": "constraints/counter.sdc",
        "clocks": [{"name": "clk", "port": "clk", "period_ns": 10}],
        "macros": [],
    }


def test_valid_multifile_manifest_is_ready_and_hashed(tmp_path: Path):
    root, payload = _project(tmp_path)
    result = preflight_project_manifest(tmp_path, payload)
    assert result["state"] == "ready"
    assert result["manifest"]["schema"] == "xylon-project/v1"
    assert len(result["manifest"]["source_revision"]) == 64
    assert result["failure"] is None


def test_path_escape_fails_before_heavy_work(tmp_path: Path):
    _root, payload = _project(tmp_path)
    payload["rtl"] = ["../outside.sv"]
    result = preflight_project_manifest(tmp_path, payload)
    assert result["state"] in {"needs_correction", "cannot_run"}
    assert result["failure"]["code"] == "PATH_ESCAPE"


def test_symlink_escape_fails_closed(tmp_path: Path):
    root, payload = _project(tmp_path)
    outside = tmp_path / "outside.sv"
    outside.write_text("module counter(input clk, output q); endmodule\n", encoding="utf-8")
    (root / "rtl" / "escape.sv").symlink_to(outside)
    payload["rtl"] = ["rtl/escape.sv"]
    result = preflight_project_manifest(tmp_path, payload)
    assert result["failure"]["code"] == "SYMLINK_ESCAPE"


def test_missing_clock_is_actionable(tmp_path: Path):
    _root, payload = _project(tmp_path)
    payload["clocks"] = []
    result = preflight_project_manifest(tmp_path, payload)
    assert result["failure"]["code"] == "MISSING_CLOCK"
    assert result["failure"]["action"]


def test_invalid_sdc_units_fail_before_execution(tmp_path: Path):
    root, payload = _project(tmp_path)
    (root / "constraints" / "counter.sdc").write_text(
        "create_clock -name clk -period 10ps [get_ports clk]\n", encoding="utf-8"
    )
    result = preflight_project_manifest(tmp_path, payload)
    assert result["failure"]["code"] == "INVALID_SDC_UNIT"


def test_manifest_clock_must_match_sdc_declaration(tmp_path: Path):
    _root, payload = _project(tmp_path)
    payload["clocks"] = [{"name": "clk", "port": "clk", "period_ns": 5}]
    result = preflight_project_manifest(tmp_path, payload)
    assert result["failure"]["code"] == "CLOCK_MISMATCH"


def test_clock_port_must_be_a_top_level_input(tmp_path: Path):
    root, payload = _project(tmp_path)
    (root / "constraints" / "counter.sdc").write_text(
        "create_clock -name data -period 10 [get_ports q]\n", encoding="utf-8"
    )
    payload["clocks"] = [{"name": "data", "port": "q", "period_ns": 10}]
    result = preflight_project_manifest(tmp_path, payload)
    assert result["failure"]["code"] == "CLOCK_PORT_NOT_INPUT"


def test_duplicate_top_fails(tmp_path: Path):
    root, payload = _project(tmp_path)
    (root / "rtl" / "duplicate.sv").write_text(
        "module counter(input logic clk, output logic q); endmodule\n", encoding="utf-8"
    )
    payload["rtl"].append("rtl/duplicate.sv")
    result = preflight_project_manifest(tmp_path, payload)
    assert result["failure"]["code"] == "TOP_MODULE_COUNT"


def test_unsupported_platform_fails_before_execution(tmp_path: Path):
    _root, payload = _project(tmp_path)
    payload["platform"] = "unsupported"
    result = preflight_project_manifest(tmp_path, payload)
    assert result["failure"]["code"] == "UNSUPPORTED_PLATFORM"


def test_undeclared_macro_is_actionable(tmp_path: Path):
    root, payload = _project(tmp_path)
    (root / "rtl" / "counter.sv").write_text(
        "module counter(input logic clk, output logic q); assign q = `UNDECLARED; endmodule\n",
        encoding="utf-8",
    )
    result = preflight_project_manifest(tmp_path, payload)
    assert result["failure"]["code"] == "UNDECLARED_MACRO"
