import json
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from agent.api import routes
from agent.api.main import app


def _payload() -> dict:
    return {
        "project_id": "counter-api",
        "top": "counter",
        "platform": "sky130hd",
        "rtl": ["rtl/counter.sv", "rtl/helper.sv"],
        "include_dirs": ["include"],
        "sdc": "constraints/counter.sdc",
        "clocks": [{"name": "clk", "port": "clk", "period_ns": 10}],
        "macros": [],
        "files": [
            {"path": "rtl/counter.sv", "content": '`include "defs.svh"\nmodule counter(input logic clk, output logic q); always_ff @(posedge clk) q <= `RESET_VALUE; endmodule\n'},
            {"path": "rtl/helper.sv", "content": "module helper(input logic a, output logic y); assign y = a; endmodule\n"},
            {"path": "include/defs.svh", "content": "`define RESET_VALUE 1'b0\n"},
            {"path": "constraints/counter.sdc", "content": "create_clock -name clk -period 10 [get_ports clk]\n"},
        ],
    }


def test_import_persists_ready_manifest_without_starting_eda(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(routes.openroad, "REPO_ROOT", tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/openroad/projects", json=_payload())
    assert response.status_code == 201
    result = response.json()
    assert result["preflight"]["state"] == "ready"
    manifest_path = tmp_path / ".xylon" / "projects" / "counter-api" / "manifest.json"
    persisted = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert persisted["state"] == "ready"
    assert persisted["manifest"]["source_revision"]


def test_project_timing_route_materializes_only_ready_imported_manifest(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(routes.openroad, "REPO_ROOT", tmp_path)
    with TestClient(app) as client:
        imported = client.post("/api/openroad/projects", json=_payload())
    assert imported.status_code == 201

    monkeypatch.setattr(routes.timing, "REPO_ROOT", tmp_path)
    async def no_admission_block():
        return None

    monkeypatch.setattr(routes.timing, "_reject_nonretryable_timing_admission", no_admission_block)

    async def fake_start(command, payload, **_kwargs):
        assert command == "analyze"
        assert payload["top_module"] == "counter"
        assert "`include" not in payload["rtl"]
        assert payload["source_revision"] == imported.json()["preflight"]["manifest"]["source_revision"]
        return SimpleNamespace(public_state={"phase": "queued", "run_id": payload["run_id"]})

    monkeypatch.setattr(routes.timing, "_start_timing_job", fake_start)
    with TestClient(app) as client:
        response = client.post("/api/timing/project-runs", json={
            "run_id": "a" * 32,
            "project_id": "counter-api",
        })
    assert response.status_code == 202
    assert response.json()["phase"] == "queued"


def test_project_timing_route_rejects_missing_import(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(routes.timing, "REPO_ROOT", tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/timing/project-runs", json={
            "run_id": "b" * 32,
            "project_id": "missing-project",
        })
    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "ProjectTimingInputInvalid"


def test_project_timing_route_revalidates_source_before_starting_eda(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(routes.openroad, "REPO_ROOT", tmp_path)
    with TestClient(app) as client:
        imported = client.post("/api/openroad/projects", json=_payload())
    assert imported.status_code == 201

    changed_rtl = tmp_path / ".xylon" / "projects" / "counter-api" / "rtl" / "counter.sv"
    changed_rtl.write_text(
        '`include "defs.svh"\nmodule counter(input logic clk, output logic q); always_ff @(posedge clk) q <= `RESET_VALUE; endmodule\n// changed after preflight\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(routes.timing, "REPO_ROOT", tmp_path)

    async def unexpected_start(*_args, **_kwargs):
        raise AssertionError("EDA must not start after the imported source revision changes")

    monkeypatch.setattr(routes.timing, "_start_timing_job", unexpected_start)
    with TestClient(app) as client:
        response = client.post("/api/timing/project-runs", json={
            "run_id": "c" * 32,
            "project_id": "counter-api",
        })
    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "ProjectTimingInputInvalid"
