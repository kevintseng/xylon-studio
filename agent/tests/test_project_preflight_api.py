from pathlib import Path

from fastapi.testclient import TestClient

from agent.api import routes
from agent.api.main import app


def _fixture(root: Path) -> dict:
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
    return {
        "root": "counter",
        "top": "counter",
        "platform": "sky130hd",
        "rtl": ["rtl/counter.sv", "rtl/helper.sv"],
        "include_dirs": ["include"],
        "sdc": "constraints/counter.sdc",
        "clocks": [{"name": "clk", "port": "clk", "period_ns": 10}],
        "macros": [],
    }


def test_preflight_route_reads_manifest_without_starting_eda(tmp_path, monkeypatch):
    project_root = tmp_path / "counter"
    payload = _fixture(project_root)
    monkeypatch.setattr(routes.openroad, "REPO_ROOT", tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/openroad/project-preflight", json=payload)
    assert response.status_code == 200
    result = response.json()
    assert result["state"] == "ready"
    assert result["manifest"]["source_revision"]
    assert "heavy_execution" not in result


def test_preflight_route_rejects_escape_without_running_eda(tmp_path, monkeypatch):
    project_root = tmp_path / "counter"
    payload = _fixture(project_root)
    payload["rtl"] = ["../outside.sv"]
    monkeypatch.setattr(routes.openroad, "REPO_ROOT", tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/openroad/project-preflight", json=payload)
    assert response.status_code == 200
    result = response.json()
    assert result["state"] in {"needs_correction", "cannot_run"}
    assert result["failure"]["code"] == "PATH_ESCAPE"
