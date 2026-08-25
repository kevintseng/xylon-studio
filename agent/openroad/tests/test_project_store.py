from pathlib import Path

import pytest

from agent.openroad.project_manifest import build_project_manifest
from agent.openroad.project_store import (
    ProjectStoreError,
    materialize_timing_input,
    store_project_bundle,
)


def _files() -> list[tuple[str, str]]:
    return [
        ("rtl/helper.sv", "module helper(input logic a, output logic y); assign y = a; endmodule\n"),
        ("rtl/counter.sv", '`include "defs.svh"\nmodule counter(input logic clk, output logic q); always_ff @(posedge clk) q <= `RESET_VALUE; endmodule\n'),
        ("include/defs.svh", "`define RESET_VALUE 1'b0\n"),
        ("constraints/counter.sdc", "create_clock -name clk -period 10 [get_ports clk]\n"),
    ]


def _manifest(root: str) -> dict:
    return {
        "root": root,
        "top": "counter",
        "platform": "sky130hd",
        "rtl": ["rtl/counter.sv", "rtl/helper.sv"],
        "include_dirs": ["include"],
        "sdc": "constraints/counter.sdc",
        "clocks": [{"name": "clk", "port": "clk", "period_ns": 10}],
        "macros": [],
    }


def test_store_and_materialize_multifile_bundle(tmp_path: Path):
    relative_root = store_project_bundle(tmp_path, project_id="counter-demo", files=_files())
    result = build_project_manifest(tmp_path, _manifest(relative_root))
    timing_input = materialize_timing_input(tmp_path, result)
    assert timing_input["top_module"] == "counter"
    assert "`include" not in timing_input["rtl"]
    assert "`define RESET_VALUE" in timing_input["rtl"]
    assert "module helper" in timing_input["rtl"]
    assert timing_input["sdc"].startswith("create_clock")


def test_store_rejects_escape_and_unsupported_files(tmp_path: Path):
    with pytest.raises(ProjectStoreError, match="inside"):
        store_project_bundle(tmp_path, project_id="escape-demo", files=[("../x.v", "module x; endmodule")])
    with pytest.raises(ProjectStoreError, match="unsupported"):
        store_project_bundle(tmp_path, project_id="bad-demo", files=[("rtl/x.tcl", "puts hi")])


def test_materialize_rejects_include_cycles(tmp_path: Path):
    relative_root = store_project_bundle(tmp_path, project_id="cycle-demo", files=[
        ("rtl/top.sv", '`include "a.svh"\nmodule top(input clk); endmodule\n'),
        ("rtl/a.svh", '`include "b.svh"\n'),
        ("rtl/b.svh", '`include "a.svh"\n'),
        ("constraints/top.sdc", "create_clock -name clk -period 10 [get_ports clk]\n"),
    ])
    manifest = _manifest(relative_root)
    manifest.update({"top": "top", "rtl": ["rtl/top.sv"], "include_dirs": [], "sdc": "constraints/top.sdc"})
    result = build_project_manifest(tmp_path, manifest)
    with pytest.raises(ProjectStoreError, match="cycle"):
        materialize_timing_input(tmp_path, result)
