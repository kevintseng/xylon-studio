import hashlib
import json
import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

from agent.api import routes
from agent.api.main import app
from agent.openroad import librelane_adapter as adapter
from agent.openroad.librelane_adapter import LibreLaneProbe


def _payload() -> dict:
    return {
        "project_id": "counter-librelane",
        "top": "counter",
        "platform": "sky130hd",
        "rtl": ["rtl/counter.sv", "rtl/helper.sv"],
        "include_dirs": ["include"],
        "sdc": "constraints/counter.sdc",
        "clocks": [{"name": "clk", "port": "clk", "period_ns": 10}],
        "macros": [],
        "files": [
            {
                "path": "rtl/counter.sv",
                "content": '`include "defs.svh"\nmodule counter(input logic clk, output logic q); always_ff @(posedge clk) q <= `RESET_VALUE; endmodule\n',
            },
            {
                "path": "rtl/helper.sv",
                "content": "module helper(input logic a, output logic y); assign y = a; endmodule\n",
            },
            {"path": "include/defs.svh", "content": "`define RESET_VALUE 1'b0\n"},
            {
                "path": "constraints/counter.sdc",
                "content": "create_clock -name clk -period 10 [get_ports clk]\n",
            },
        ],
    }


def _import_project(tmp_path: Path, monkeypatch) -> dict:
    monkeypatch.setattr(routes.openroad, "REPO_ROOT", tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/openroad/projects", json=_payload())
    assert response.status_code == 201
    return response.json()


def test_librelane_project_route_prepares_owned_config_handoff(tmp_path: Path, monkeypatch) -> None:
    imported = _import_project(tmp_path, monkeypatch)
    monkeypatch.setattr(
        routes.openroad,
        "probe_librelane",
        lambda: LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
    )
    monkeypatch.setattr(
        routes.openroad,
        "collect_librelane_readiness",
        lambda _repo_root, probe=None: {
            "schema_version": "xylon-librelane-readiness/v1",
            "state": "ready",
            "backend": {"name": "LibreLane", "version": "3.0.10"},
            "checks": {"python": True, "docker": True, "image": True, "pdk": True, "resources": True},
            "resource_blockers": [],
            "blockers": [],
            "next_action": "Start one pinned LibreLane reference run from the imported project.",
        },
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/openroad/librelane-project-runs",
            json={"run_id": "run_1234", "project_id": "counter-librelane"},
        )

    assert response.status_code == 201
    result = response.json()
    assert result["state"] == "prepared"
    assert result["source_revision"] == imported["preflight"]["manifest"]["source_revision"]
    assert result["runtime_identity"]["backend"] == "librelane"
    assert result["preparation"]["config_path"] == "config.json"
    run_root = tmp_path / ".xylon" / "timing" / "runs" / "run_1234"
    config = json.loads((run_root / "config.json").read_text(encoding="utf-8"))
    assert config["DESIGN_NAME"] == "counter"
    assert config["VERILOG_FILES"] == [
        "dir::inputs/project/rtl/counter.sv",
        "dir::inputs/project/rtl/helper.sv",
    ]
    persisted = json.loads((run_root / "manifest.json").read_text(encoding="utf-8"))
    assert persisted["state"] == "prepared"
    assert persisted["preparation"]["runtime_identity_sha256"] == result["preparation"]["runtime_identity_sha256"]
    config_bytes = (run_root / "config.json").read_bytes()
    assert result["preparation"]["config_sha256"] == hashlib.sha256(config_bytes).hexdigest()


def test_librelane_project_route_stops_before_subprocess_when_readiness_is_blocked(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _import_project(tmp_path, monkeypatch)
    monkeypatch.setattr(
        routes.openroad,
        "probe_librelane",
        lambda: LibreLaneProbe("unavailable", None, None, "missing"),
    )
    monkeypatch.setattr(
        routes.openroad,
        "collect_librelane_readiness",
        lambda _repo_root, probe=None: {
            "schema_version": "xylon-librelane-readiness/v1",
            "state": "blocked",
            "backend": {"name": "LibreLane", "version": "3.0.10"},
            "checks": {"python": False, "docker": True, "image": False, "pdk": False, "resources": True},
            "resource_blockers": [],
            "blockers": [
                "LibreLane 3.0.10 is not available in the configured Python environment",
                "the pinned LibreLane image is not present locally",
            ],
            "next_action": "Resolve the first listed blocker, then check LibreLane readiness again.",
        },
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/openroad/librelane-project-runs",
            json={"run_id": "run_5678", "project_id": "counter-librelane"},
        )

    assert response.status_code == 201
    result = response.json()
    assert result["state"] == "blocked"
    assert result["failure"]["code"] == "LibreLaneReadinessBlocked"
    assert result["runtime_identity"] is None
    run_root = tmp_path / ".xylon" / "timing" / "runs" / "run_5678"
    assert (run_root / "config.json").is_file()
    persisted = json.loads((run_root / "manifest.json").read_text(encoding="utf-8"))
    assert persisted["failure"]["code"] == "LibreLaneReadinessBlocked"


def test_prepared_run_root_is_accepted_by_the_bounded_executor(tmp_path: Path, monkeypatch) -> None:
    imported = _import_project(tmp_path, monkeypatch)
    monkeypatch.setattr(
        routes.openroad,
        "probe_librelane",
        lambda: LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
    )
    monkeypatch.setattr(
        routes.openroad,
        "collect_librelane_readiness",
        lambda _repo_root, probe=None: {
            "schema_version": "xylon-librelane-readiness/v1",
            "state": "ready",
            "backend": {"name": "LibreLane", "version": "3.0.10"},
            "checks": {"python": True, "docker": True, "image": True, "pdk": True, "resources": True},
            "resource_blockers": [],
            "blockers": [],
            "next_action": "Start one pinned LibreLane reference run from the imported project.",
        },
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/openroad/librelane-project-runs",
            json={"run_id": "run_9012", "project_id": "counter-librelane"},
        )
    assert response.status_code == 201
    result = response.json()
    run_root = tmp_path / ".xylon" / "timing" / "runs" / "run_9012"
    launcher = tmp_path / "scripts" / "xylon-librelane"
    launcher.parent.mkdir()
    launcher.write_text("#!/bin/sh\n", encoding="utf-8")
    launcher.chmod(0o700)
    project = adapter.LibreLaneMaterializedProject(
        request=result["preparation"]["adapter_request"],
        top="counter",
        source_revision=imported["preflight"]["manifest"]["source_revision"],
        design_path="inputs/project/rtl/counter.sv",
        sdc_path="inputs/project/constraints/counter.sdc",
        config_path="config.json",
    )
    plan = adapter.build_execution_plan(
        LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
        run_dir=run_root,
        project=project,
    )

    def fake_runner(command, **kwargs):
        signoff = run_root / "signoff" / "counter" / "openlane-signoff"
        signoff.mkdir(parents=True)
        (signoff / "resolved.json").write_text(
            '{"PDK":"sky130A","STD_CELL_LIBRARY":"sky130_fd_sc_hd"}\n',
            encoding="utf-8",
        )
        (signoff.parent / "metrics.csv").write_text("Metric,Value\ntiming__setup__wns,0.1\n", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    result = adapter.execute_plan(tmp_path, run_dir=run_root, plan=plan, runner=fake_runner)
    assert result["state"] == "succeeded"


def test_execution_requires_explicit_approval(tmp_path: Path, monkeypatch) -> None:
    _import_project(tmp_path, monkeypatch)
    monkeypatch.setattr(
        routes.openroad,
        "probe_librelane",
        lambda: LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
    )
    monkeypatch.setattr(
        routes.openroad,
        "collect_librelane_readiness",
        lambda _repo_root, probe=None: {
            "schema_version": "xylon-librelane-readiness/v1",
            "state": "ready",
            "backend": {"name": "LibreLane", "version": "3.0.10"},
            "checks": {"python": True, "docker": True, "image": True, "pdk": True, "resources": True},
            "resource_blockers": [],
            "blockers": [],
            "next_action": "Start one pinned LibreLane reference run from the imported project.",
        },
    )
    with TestClient(app) as client:
        prepared = client.post(
            "/api/openroad/librelane-project-runs",
            json={"run_id": "run_approved", "project_id": "counter-librelane"},
        )
        assert prepared.status_code == 201
        response = client.post(
            "/api/openroad/librelane-project-runs/run_approved/execute",
            json={"approved": False},
        )
    assert response.status_code == 403
    assert response.json()["detail"]["error"] == "LibreLaneApprovalRequired"


def test_approved_execution_persists_native_result_and_state(tmp_path: Path, monkeypatch) -> None:
    imported = _import_project(tmp_path, monkeypatch)
    monkeypatch.setattr(
        routes.openroad,
        "probe_librelane",
        lambda: LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
    )
    ready = {
        "schema_version": "xylon-librelane-readiness/v1",
        "state": "ready",
        "backend": {"name": "LibreLane", "version": "3.0.10"},
        "checks": {"python": True, "docker": True, "image": True, "pdk": True, "resources": True},
        "resource_blockers": [],
        "blockers": [],
        "next_action": "Start one pinned LibreLane reference run from the imported project.",
    }
    monkeypatch.setattr(routes.openroad, "collect_librelane_readiness", lambda _repo_root, probe=None: ready)
    with TestClient(app) as client:
        prepared = client.post(
            "/api/openroad/librelane-project-runs",
            json={"run_id": "run_execute", "project_id": "counter-librelane"},
        )
        assert prepared.status_code == 201

        def fake_execute(_repo_root, *, run_dir, plan):
            assert plan.identity.version == "3.0.10"
            return {
                "state": "succeeded",
                "run_id": "run_execute",
                "readback": {
                    "resolved": {"PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hd"},
                    "metrics": {"timing__setup__wns": 0.1},
                    "paths": {"resolved": "signoff/counter/openlane-signoff/resolved.json", "metrics": "signoff/counter/metrics.csv"},
                },
            }

        monkeypatch.setattr(routes.openroad, "execute_plan", fake_execute)
        response = client.post(
            "/api/openroad/librelane-project-runs/run_execute/execute",
            json={"approved": True},
        )
    assert response.status_code == 200
    result = response.json()
    assert result["state"] == "succeeded"
    assert result["execution"]["approved"] is True
    assert result["execution"]["result"]["readback"]["metrics"]["timing__setup__wns"] == 0.1
    persisted = json.loads((tmp_path / ".xylon" / "timing" / "runs" / "run_execute" / "manifest.json").read_text())
    assert persisted["state"] == "succeeded"
    assert persisted["source_revision"] == imported["preflight"]["manifest"]["source_revision"]


def test_execute_time_readiness_block_is_persisted_as_retryable_blocked_state(tmp_path: Path, monkeypatch) -> None:
    _import_project(tmp_path, monkeypatch)
    monkeypatch.setattr(
        routes.openroad,
        "probe_librelane",
        lambda: LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
    )
    ready = {
        "schema_version": "xylon-librelane-readiness/v1",
        "state": "ready",
        "backend": {"name": "LibreLane", "version": "3.0.10"},
        "checks": {"python": True, "docker": True, "image": True, "pdk": True, "resources": True},
        "resource_blockers": [],
        "blockers": [],
        "next_action": "Start one pinned LibreLane reference run from the imported project.",
    }
    blocked = {
        **ready,
        "state": "blocked",
        "checks": {**ready["checks"], "resources": False},
        "resource_blockers": ["memory available is below the safety floor"],
        "blockers": ["memory available is below the safety floor"],
        "next_action": "Resolve the first listed blocker, then check LibreLane readiness again.",
    }
    readiness = ready
    monkeypatch.setattr(routes.openroad, "collect_librelane_readiness", lambda _repo_root, probe=None: readiness)
    with TestClient(app) as client:
        prepared = client.post(
            "/api/openroad/librelane-project-runs",
            json={"run_id": "run_retryable", "project_id": "counter-librelane"},
        )
        assert prepared.status_code == 201
        readiness = blocked
        response = client.post(
            "/api/openroad/librelane-project-runs/run_retryable/execute",
            json={"approved": True},
        )
    assert response.status_code == 409
    persisted_path = tmp_path / ".xylon" / "timing" / "runs" / "run_retryable" / "manifest.json"
    persisted = json.loads(persisted_path.read_text(encoding="utf-8"))
    assert persisted["state"] == "blocked"
    assert persisted["failure"]["code"] == "LibreLaneReadinessBlocked"

    readiness = ready
    with TestClient(app) as client:
        monkeypatch.setattr(routes.openroad, "execute_plan", lambda *_args, **_kwargs: {
            "state": "succeeded",
            "run_id": "run_retryable",
            "readback": {"metrics": {"timing__setup__wns": 0.1}},
        })
        retry = client.post(
            "/api/openroad/librelane-project-runs/run_retryable/execute",
            json={"approved": True},
        )
    assert retry.status_code == 200
    assert retry.json()["state"] == "succeeded"
