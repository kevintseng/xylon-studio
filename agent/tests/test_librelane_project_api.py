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


def _ready_payload() -> dict:
    return {
        "schema_version": "xylon-librelane-readiness/v1",
        "state": "ready",
        "backend": {"name": "LibreLane", "version": "3.0.10"},
        "checks": {"python": True, "docker": True, "image": True, "pdk": True, "resources": True},
        "resource_blockers": [],
        "blockers": [],
        "next_action": "Start one pinned LibreLane reference run from the imported project.",
    }


def _prepare_succeeded_baseline(tmp_path: Path, monkeypatch, *, run_id: str, wns: float) -> None:
    _import_project(tmp_path, monkeypatch)
    monkeypatch.setattr(
        routes.openroad,
        "probe_librelane",
        lambda: LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
    )
    ready = _ready_payload()
    monkeypatch.setattr(routes.openroad, "collect_librelane_readiness", lambda _repo_root, probe=None: ready)

    def fake_baseline_execute(_repo_root, *, run_dir, plan):
        return {
            "state": "succeeded",
            "run_id": run_id,
            "readback": {
                "resolved": {"PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hd"},
                "metrics": {"timing__setup__wns": wns, "timing__setup__tns": min(wns * 3, 0)},
                "paths": {"resolved": "resolved.json", "metrics": "metrics.csv"},
            },
        }

    monkeypatch.setattr(routes.openroad, "execute_plan", fake_baseline_execute)
    with TestClient(app) as client:
        prepared = client.post(
            "/api/openroad/librelane-project-runs",
            json={"run_id": run_id, "project_id": "counter-librelane"},
        )
        assert prepared.status_code == 201
        executed = client.post(
            f"/api/openroad/librelane-project-runs/{run_id}/execute",
            json={"approved": True},
        )
    assert executed.status_code == 200
    assert executed.json()["state"] == "succeeded"


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


def test_malformed_prepared_manifest_fails_closed_without_internal_error(tmp_path: Path, monkeypatch) -> None:
    _import_project(tmp_path, monkeypatch)
    monkeypatch.setattr(
        routes.openroad,
        "probe_librelane",
        lambda: LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
    )
    monkeypatch.setattr(routes.openroad, "collect_librelane_readiness", lambda _repo_root, probe=None: _ready_payload())
    with TestClient(app) as client:
        prepared = client.post(
            "/api/openroad/librelane-project-runs",
            json={"run_id": "run_bad_manifest", "project_id": "counter-librelane"},
        )
        assert prepared.status_code == 201
    manifest_path = tmp_path / ".xylon" / "timing" / "runs" / "run_bad_manifest" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["manifest"]["rtl"] = []
    manifest_path.write_text(json.dumps(manifest) + "\n")

    with TestClient(app) as client:
        response = client.post(
            "/api/openroad/librelane-project-runs/run_bad_manifest/execute",
            json={"approved": True},
        )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "LibreLaneExecutionFailed"
    persisted = json.loads(manifest_path.read_text())
    assert persisted["state"] == "failed"


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


def test_negative_wns_baseline_creates_bound_placement_density_proposal(tmp_path: Path, monkeypatch) -> None:
    _prepare_succeeded_baseline(tmp_path, monkeypatch, run_id="run_proposal", wns=-0.24)

    with TestClient(app) as client:
        response = client.post("/api/openroad/librelane-project-runs/run_proposal/proposal")

    assert response.status_code == 200
    result = response.json()
    assert result["state"] == "proposal_ready"
    proposal = result["proposal"]
    assert len(proposal["proposal_id"]) == 64
    assert proposal["state"] == "awaiting_approval"
    assert proposal["binding"]["baseline_wns"] == -0.24
    assert proposal["action"] == {
        "type": "librelane_flow_parameter",
        "parameter": "PL_TARGET_DENSITY",
        "from": 0.6,
        "to": 0.65,
        "scope": "one_candidate_librelane_rerun",
        "functional_inputs_unchanged": True,
    }
    persisted = json.loads(
        (tmp_path / ".xylon" / "timing" / "runs" / "run_proposal" / "manifest.json").read_text()
    )
    assert persisted["state"] == "proposal_ready"
    assert persisted["proposal"]["proposal_id"] == proposal["proposal_id"]


def test_repair_proposal_rejects_timing_clean_baseline(tmp_path: Path, monkeypatch) -> None:
    _prepare_succeeded_baseline(tmp_path, monkeypatch, run_id="run_clean_timing", wns=0.02)

    with TestClient(app) as client:
        response = client.post("/api/openroad/librelane-project-runs/run_clean_timing/proposal")

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "LibreLaneRepairProposalInvalid"
    persisted = json.loads(
        (tmp_path / ".xylon" / "timing" / "runs" / "run_clean_timing" / "manifest.json").read_text()
    )
    assert persisted["state"] == "succeeded"
    assert "proposal" not in persisted


def test_repair_requires_explicit_exact_proposal_approval(tmp_path: Path, monkeypatch) -> None:
    _prepare_succeeded_baseline(tmp_path, monkeypatch, run_id="run_repair_approval", wns=-0.1)
    with TestClient(app) as client:
        proposal_response = client.post(
            "/api/openroad/librelane-project-runs/run_repair_approval/proposal"
        )
        assert proposal_response.status_code == 200
        proposal_id = proposal_response.json()["proposal"]["proposal_id"]
        denied = client.post(
            "/api/openroad/librelane-project-runs/run_repair_approval/repair",
            json={"approved": False, "proposal_id": proposal_id},
        )
        mismatched = client.post(
            "/api/openroad/librelane-project-runs/run_repair_approval/repair",
            json={"approved": True, "proposal_id": "0" * 64},
        )

    assert denied.status_code == 403
    assert denied.json()["detail"]["error"] == "LibreLaneRepairApprovalRequired"
    assert mismatched.status_code == 422
    assert mismatched.json()["detail"]["error"] == "LibreLaneRepairApprovalInvalid"
    persisted = json.loads(
        (tmp_path / ".xylon" / "timing" / "runs" / "run_repair_approval" / "manifest.json").read_text()
    )
    assert persisted["state"] == "proposal_ready"
    assert persisted["proposal"]["state"] == "awaiting_approval"
    assert "candidate" not in persisted


def test_expired_repair_proposal_is_rejected_without_candidate(tmp_path: Path, monkeypatch) -> None:
    _prepare_succeeded_baseline(tmp_path, monkeypatch, run_id="run_repair_expired", wns=-0.1)
    run_root = tmp_path / ".xylon" / "timing" / "runs" / "run_repair_expired"
    with TestClient(app) as client:
        proposal_response = client.post("/api/openroad/librelane-project-runs/run_repair_expired/proposal")
        assert proposal_response.status_code == 200
        proposal_id = proposal_response.json()["proposal"]["proposal_id"]
    persisted = json.loads((run_root / "manifest.json").read_text())
    persisted["proposal"]["expires_at"] = "2000-01-01T00:00:00+00:00"
    (run_root / "manifest.json").write_text(json.dumps(persisted) + "\n")

    with TestClient(app) as client:
        response = client.post(
            "/api/openroad/librelane-project-runs/run_repair_expired/repair",
            json={"approved": True, "proposal_id": proposal_id},
        )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "LibreLaneRepairApprovalInvalid"
    persisted = json.loads((run_root / "manifest.json").read_text())
    assert persisted["state"] == "proposal_ready"
    assert "candidate" not in persisted


def test_expired_repair_proposal_can_be_regenerated_from_same_baseline(tmp_path: Path, monkeypatch) -> None:
    _prepare_succeeded_baseline(tmp_path, monkeypatch, run_id="run_repair_regenerate", wns=-0.1)
    run_root = tmp_path / ".xylon" / "timing" / "runs" / "run_repair_regenerate"
    with TestClient(app) as client:
        first = client.post("/api/openroad/librelane-project-runs/run_repair_regenerate/proposal")
        assert first.status_code == 200
    persisted = json.loads((run_root / "manifest.json").read_text())
    persisted["proposal"]["expires_at"] = "2000-01-01T00:00:00+00:00"
    (run_root / "manifest.json").write_text(json.dumps(persisted) + "\n")

    with TestClient(app) as client:
        regenerated = client.post("/api/openroad/librelane-project-runs/run_repair_regenerate/proposal")

    assert regenerated.status_code == 200
    assert regenerated.json()["proposal"]["proposal_id"] == first.json()["proposal"]["proposal_id"]
    assert regenerated.json()["proposal"]["state"] == "awaiting_approval"


def test_baseline_drift_invalidates_repair_proposal_without_candidate(tmp_path: Path, monkeypatch) -> None:
    _prepare_succeeded_baseline(tmp_path, monkeypatch, run_id="run_repair_drift", wns=-0.1)
    run_root = tmp_path / ".xylon" / "timing" / "runs" / "run_repair_drift"
    with TestClient(app) as client:
        proposal_response = client.post("/api/openroad/librelane-project-runs/run_repair_drift/proposal")
        assert proposal_response.status_code == 200
        proposal_id = proposal_response.json()["proposal"]["proposal_id"]
    config_path = run_root / "config.json"
    config = json.loads(config_path.read_text())
    config["PL_TARGET_DENSITY"] = 0.61
    config_path.write_text(json.dumps(config) + "\n")

    with TestClient(app) as client:
        response = client.post(
            "/api/openroad/librelane-project-runs/run_repair_drift/repair",
            json={"approved": True, "proposal_id": proposal_id},
        )

    assert response.status_code == 422
    assert response.json()["detail"]["error"] == "LibreLaneRepairApprovalInvalid"
    persisted = json.loads((run_root / "manifest.json").read_text())
    assert persisted["state"] == "proposal_ready"
    assert "candidate" not in persisted


def test_readiness_block_keeps_proposal_retryable_then_returns_native_comparison(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _prepare_succeeded_baseline(tmp_path, monkeypatch, run_id="run_repair_retry", wns=-0.2)
    ready = _ready_payload()
    blocked = {
        **ready,
        "state": "blocked",
        "checks": {**ready["checks"], "resources": False},
        "resource_blockers": ["memory available is below the safety floor"],
        "blockers": ["memory available is below the safety floor"],
        "next_action": "Free memory, then check LibreLane readiness again.",
    }
    readiness = blocked
    monkeypatch.setattr(routes.openroad, "collect_librelane_readiness", lambda _repo_root, probe=None: readiness)
    executor_calls = 0

    def fake_candidate_execute(_repo_root, *, run_dir, plan):
        nonlocal executor_calls
        executor_calls += 1
        assert run_dir.name == plan.project.request["run_id"] or run_dir.parent.name == "candidate"
        return {
            "state": "succeeded",
            "run_id": "run_repair_retry",
            "readback": {
                "resolved": {"PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hd"},
                "metrics": {"timing__setup__wns": 0.05, "timing__setup__tns": 0.0},
                "paths": {"resolved": "resolved.json", "metrics": "metrics.csv"},
            },
        }

    monkeypatch.setattr(routes.openroad, "execute_plan", fake_candidate_execute)
    with TestClient(app) as client:
        proposal_response = client.post("/api/openroad/librelane-project-runs/run_repair_retry/proposal")
        assert proposal_response.status_code == 200
        proposal_id = proposal_response.json()["proposal"]["proposal_id"]
        blocked_response = client.post(
            "/api/openroad/librelane-project-runs/run_repair_retry/repair",
            json={"approved": True, "proposal_id": proposal_id},
        )
    assert blocked_response.status_code == 409
    assert executor_calls == 0
    run_root = tmp_path / ".xylon" / "timing" / "runs" / "run_repair_retry"
    blocked_manifest = json.loads((run_root / "manifest.json").read_text())
    assert blocked_manifest["state"] == "proposal_ready"
    assert blocked_manifest["proposal"]["state"] == "awaiting_approval"
    assert blocked_manifest["proposal"]["last_attempt"]["state"] == "blocked"
    assert not (run_root / "candidate").exists()

    readiness = ready
    with TestClient(app) as client:
        retry = client.post(
            "/api/openroad/librelane-project-runs/run_repair_retry/repair",
            json={"approved": True, "proposal_id": proposal_id},
        )
    assert retry.status_code == 200
    assert executor_calls == 1
    result = retry.json()
    assert result["state"] == "comparison_ready"
    assert result["proposal"]["state"] == "applied"
    assert result["comparison"]["setup_wns"] == {
        "baseline": -0.2,
        "candidate": 0.05,
        "delta": 0.25,
        "improved": True,
        "timing_met": True,
    }
    assert result["comparison"]["baseline_metrics"]["timing__setup__wns"] == -0.2
    assert result["comparison"]["candidate_metrics"]["timing__setup__wns"] == 0.05
    baseline_config = json.loads((run_root / "config.json").read_text())
    candidate_config = json.loads((run_root / result["candidate"]["root"] / "config.json").read_text())
    assert baseline_config["PL_TARGET_DENSITY"] == 0.6
    assert candidate_config["PL_TARGET_DENSITY"] == 0.65
    assert {key: value for key, value in candidate_config.items() if key != "PL_TARGET_DENSITY"} == {
        key: value for key, value in baseline_config.items() if key != "PL_TARGET_DENSITY"
    }
    persisted = json.loads((run_root / "manifest.json").read_text())
    assert persisted["state"] == "comparison_ready"
    assert persisted["candidate"]["state"] == "succeeded"
    assert persisted["candidate"]["proposal_id"] == proposal_id
    assert persisted["candidate"]["source_revision"] == persisted["source_revision"]


def test_candidate_execution_failure_is_persisted_without_changing_baseline(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _prepare_succeeded_baseline(tmp_path, monkeypatch, run_id="run_repair_failure", wns=-0.12)
    monkeypatch.setattr(
        routes.openroad,
        "collect_librelane_readiness",
        lambda _repo_root, probe=None: _ready_payload(),
    )

    def fail_candidate(_repo_root, *, run_dir, plan):
        raise adapter.LibreLaneExecutionError("bounded candidate failed")

    monkeypatch.setattr(routes.openroad, "execute_plan", fail_candidate)
    with TestClient(app) as client:
        proposal_response = client.post("/api/openroad/librelane-project-runs/run_repair_failure/proposal")
        assert proposal_response.status_code == 200
        proposal_id = proposal_response.json()["proposal"]["proposal_id"]
        response = client.post(
            "/api/openroad/librelane-project-runs/run_repair_failure/repair",
            json={"approved": True, "proposal_id": proposal_id},
        )

    assert response.status_code == 422
    run_root = tmp_path / ".xylon" / "timing" / "runs" / "run_repair_failure"
    persisted = json.loads((run_root / "manifest.json").read_text())
    assert persisted["state"] == "candidate_failed"
    assert persisted["candidate"]["state"] == "failed"
    assert persisted["candidate"]["proposal_id"] == proposal_id
    assert persisted["failure"]["code"] == "LibreLaneRepairExecutionFailed"
    baseline_config = json.loads((run_root / "config.json").read_text())
    candidate_config = json.loads((run_root / persisted["candidate"]["root"] / "config.json").read_text())
    assert baseline_config["PL_TARGET_DENSITY"] == 0.6
    assert candidate_config["PL_TARGET_DENSITY"] == 0.65
