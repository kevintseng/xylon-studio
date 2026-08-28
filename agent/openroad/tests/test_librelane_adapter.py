from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from agent.openroad import librelane_adapter as adapter
from agent.openroad.project_manifest import build_project_manifest
from agent.openroad.project_store import store_project_bundle


def _project_files() -> list[tuple[str, str]]:
    return [
        ("rtl/helper.sv", "module helper(input logic a, output logic y); assign y = a; endmodule\n"),
        (
            "rtl/counter.sv",
            '`include "defs.svh"\nmodule counter(input logic clk, output logic q); always_ff @(posedge clk) q <= `RESET_VALUE; endmodule\n',
        ),
        ("rtl/defs.svh", "`define RESET_VALUE 1'b0\n"),
        ("constraints/counter.sdc", "create_clock -name clk -period 10 [get_ports clk]\n"),
    ]


def _project_manifest(root: str) -> dict[str, object]:
    return {
        "root": root,
        "top": "counter",
        "platform": "sky130hd",
        "rtl": ["rtl/counter.sv", "rtl/helper.sv"],
        "include_dirs": [],
        "sdc": "constraints/counter.sdc",
        "clocks": [{"name": "clk", "port": "clk", "period_ns": 10}],
        "macros": [],
    }


def test_parse_request_is_strict_and_allowlisted() -> None:
    request = adapter.parse_request(
        {"platform": "sky130hd", "run_id": "run_1234", "config_path": "config.yaml"}
    )
    assert request["platform"] == "sky130hd"
    with pytest.raises(adapter.LibreLaneAdapterError, match="arbitrary execution"):
        adapter.parse_request(
            {
                "platform": "sky130hd",
                "run_id": "run_1234",
                "config_path": "config.yaml",
                "command": "rm -rf /",
            }
        )


def test_probe_requires_exact_version_without_starting_a_flow(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    python = tmp_path / "python"
    python.write_text("#!/bin/sh\n", encoding="utf-8")
    python.chmod(0o700)
    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, stdout="3.0.10\n", stderr="")

    monkeypatch.setattr(adapter.subprocess, "run", fake_run)
    probe = adapter.probe_librelane(str(python))
    assert probe.state == "available"
    assert probe.version == "3.0.10"
    assert calls[0][0] == [str(python), "-m", "librelane", "--bare-version"]
    assert calls[0][1]["timeout"] == 5.0


def test_probe_does_not_trust_ambient_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XYLON_LIBRELANE_PYTHON", raising=False)
    monkeypatch.setattr(adapter, "LOCAL_LIBRELANE_PYTHON", Path("/missing/local/librelane/python"))
    assert adapter.probe_librelane().state == "unavailable"
    assert adapter.probe_librelane().python is None


def test_probe_uses_project_local_python_when_present(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    python = tmp_path / "python"
    python.write_text("#!/bin/sh\n", encoding="utf-8")
    python.chmod(0o700)
    monkeypatch.delenv("XYLON_LIBRELANE_PYTHON", raising=False)
    monkeypatch.setattr(adapter, "LOCAL_LIBRELANE_PYTHON", python)
    monkeypatch.setattr(
        adapter.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, stdout="3.0.10\n", stderr=""),
    )
    assert adapter.probe_librelane().state == "available"


def test_probe_rejects_version_mismatch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    python = tmp_path / "python"
    python.write_text("#!/bin/sh\n", encoding="utf-8")
    python.chmod(0o700)
    monkeypatch.setattr(
        adapter.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, stdout="3.0.11\n", stderr=""),
    )
    probe = adapter.probe_librelane(str(python))
    assert probe.state == "version_mismatch"
    assert probe.version == "3.0.11"
    with pytest.raises(adapter.LibreLaneAdapterError, match="not available"):
        adapter.build_identity(probe)


def test_identity_is_deterministic() -> None:
    probe = adapter.LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok")
    identity = adapter.build_identity(probe)
    assert identity.backend == "librelane"
    assert identity.upstream_flow == "librelane"
    assert len(adapter.identity_sha256(identity)) == 64
    assert adapter.identity_sha256(identity) == adapter.identity_sha256(identity)


def test_identity_binds_official_arm64_image_and_sky130hd() -> None:
    identity = adapter.build_identity(
        adapter.LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok")
    )
    assert identity.image == "ghcr.io/librelane/librelane@sha256:322b81f76d22053e5b92f9eaa6e4fb0440084fd02d77a4de0caa4ba7644c88c3"
    assert identity.container_platform == "linux/arm64"
    assert identity.pdk == "sky130A"
    assert identity.standard_cell_library == "sky130_fd_sc_hd"


def test_build_config_is_deterministic_and_command_free() -> None:
    config = adapter.build_config(
        top="counter",
        rtl_paths=["rtl/counter.sv", "rtl/helper.sv"],
        sdc_path="constraints/counter.sdc",
        clock_port="clk",
        clock_period_ns=10,
        include_dirs=["include"],
    )
    assert config == {
        "DESIGN_NAME": "counter",
        "VERILOG_FILES": ["dir::rtl/counter.sv", "dir::rtl/helper.sv"],
        "CLOCK_PERIOD": 10,
        "CLOCK_PORT": "clk",
        "PNR_SDC_FILE": "dir::constraints/counter.sdc",
        "SIGNOFF_SDC_FILE": "dir::constraints/counter.sdc",
        "PDK": "sky130A",
        "STD_CELL_LIBRARY": "sky130_fd_sc_hd",
        "PL_TARGET_DENSITY": 0.60,
        "RUN_POST_CTS_RESIZER_TIMING": False,
        "VERILOG_INCLUDE_DIRS": ["dir::include"],
    }
    assert not any(key.lower() in {"command", "shell", "tcl"} for key in config)
    assert json.dumps(config, sort_keys=True)


def test_build_config_rejects_escape_and_invalid_period() -> None:
    with pytest.raises(adapter.LibreLaneAdapterError, match="relative path"):
        adapter.build_config(
            top="counter",
            rtl_paths=["../escape.sv"],
            sdc_path="constraints/counter.sdc",
            clock_port="clk",
            clock_period_ns=10,
        )
    with pytest.raises(adapter.LibreLaneAdapterError, match="positive"):
        adapter.build_config(
            top="counter",
            rtl_paths=["rtl/counter.sv"],
            sdc_path="constraints/counter.sdc",
            clock_port="clk",
            clock_period_ns=0,
        )


def test_materialize_project_writes_owned_inputs_and_strict_request(tmp_path: Path) -> None:
    relative_root = store_project_bundle(tmp_path, project_id="counter-librelane", files=_project_files())
    manifest = build_project_manifest(tmp_path, _project_manifest(relative_root))
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    project = adapter.materialize_project(
        tmp_path,
        manifest,
        run_dir=run_dir,
        run_id="abcd1234",
    )

    assert project.request == {
        "platform": "sky130hd",
        "run_id": "abcd1234",
        "config_path": "inputs/librelane/config.json",
    }
    assert project.top == "counter"
    assert project.source_revision == manifest["source_revision"]
    assert "`include" not in (run_dir / project.design_path).read_text(encoding="utf-8")
    assert "`define RESET_VALUE" in (run_dir / project.design_path).read_text(encoding="utf-8")
    assert (run_dir / project.sdc_path).read_text(encoding="utf-8").startswith("create_clock")
    config = json.loads((run_dir / project.config_path).read_text(encoding="utf-8"))
    assert config["DESIGN_NAME"] == "counter"
    assert config["VERILOG_FILES"] == ["dir::inputs/design.v"]
    assert config["PNR_SDC_FILE"] == "dir::inputs/design.sdc"
    assert "VERILOG_INCLUDE_DIRS" not in config


def test_materialize_project_rejects_missing_clock_or_invalid_source_revision(tmp_path: Path) -> None:
    relative_root = store_project_bundle(tmp_path, project_id="counter-bad", files=_project_files())
    manifest = build_project_manifest(tmp_path, _project_manifest(relative_root))
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    with pytest.raises(adapter.LibreLaneAdapterError, match="at least one clock"):
        adapter.materialize_project(
            tmp_path,
            {**manifest, "clocks": []},
            run_dir=run_dir,
            run_id="abcd1234",
        )
    with pytest.raises(adapter.LibreLaneAdapterError, match="source_revision"):
        adapter.materialize_project(
            tmp_path,
            {**manifest, "source_revision": "not-a-revision"},
            run_dir=run_dir,
            run_id="abcd1234",
        )


def test_materialize_project_rejects_symlink_run_dir(tmp_path: Path) -> None:
    relative_root = store_project_bundle(tmp_path, project_id="counter-symlink", files=_project_files())
    manifest = build_project_manifest(tmp_path, _project_manifest(relative_root))
    target_dir = tmp_path / "target-run"
    target_dir.mkdir()
    run_link = tmp_path / "run-link"
    run_link.symlink_to(target_dir, target_is_directory=True)

    with pytest.raises(adapter.LibreLaneAdapterError, match="run directory must not be a symbolic link"):
        adapter.materialize_project(
            tmp_path,
            manifest,
            run_dir=run_link,
            run_id="abcd1234",
        )


def test_execution_plan_binds_fixed_launcher_and_config_identity(tmp_path: Path) -> None:
    relative_root = store_project_bundle(tmp_path, project_id="counter-plan", files=_project_files())
    manifest = build_project_manifest(tmp_path, _project_manifest(relative_root))
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    project = adapter.materialize_project(
        tmp_path,
        manifest,
        run_dir=run_dir,
        run_id="abcd1234",
    )

    plan = adapter.build_execution_plan(
        adapter.LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
        run_dir=run_dir,
        project=project,
    )

    assert plan.identity.backend == "librelane"
    assert plan.command.launcher_path == "scripts/xylon-librelane"
    assert plan.command.arguments == ("run", str(run_dir.resolve()), "inputs/librelane/config.json")
    assert plan.command.env_contract == ("XYLON_LIBRELANE_PYTHON", "XYLON_LIBRELANE_PDK_ROOT")
    assert len(plan.config_identity_sha256) == 64
    assert len(plan.plan_identity_sha256) == 64

    config_path = run_dir / project.config_path
    original = json.loads(config_path.read_text(encoding="utf-8"))
    changed = dict(original)
    changed["CLOCK_PERIOD"] = 12
    config_path.write_text(json.dumps(changed, sort_keys=True) + "\n", encoding="utf-8")
    second = adapter.build_execution_plan(
        adapter.LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
        run_dir=run_dir,
        project=project,
    )
    assert second.config_identity_sha256 != plan.config_identity_sha256
    assert second.plan_identity_sha256 != plan.plan_identity_sha256


def test_config_path_stays_inside_owned_run_dir(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    config = run_dir / "config.yaml"
    config.write_text("DESIGN_NAME: spm\n", encoding="utf-8")
    assert adapter.validate_config_path("config.yaml", run_dir) == config
    outside = tmp_path / "outside.yaml"
    outside.write_text("DESIGN_NAME: escape\n", encoding="utf-8")
    (run_dir / "escape.yaml").symlink_to(outside)
    with pytest.raises(adapter.LibreLaneAdapterError, match="symbolic link"):
        adapter.validate_config_path("escape.yaml", run_dir)


def test_execute_plan_uses_only_fixed_launcher_and_requires_native_readback(tmp_path: Path) -> None:
    relative_root = store_project_bundle(tmp_path, project_id="counter-exec", files=_project_files())
    manifest = build_project_manifest(tmp_path, _project_manifest(relative_root))
    run_dir = tmp_path / ".xylon" / "timing" / "runs" / ("a" * 32)
    run_dir.mkdir(parents=True)
    project = adapter.materialize_project(tmp_path, manifest, run_dir=run_dir, run_id="a" * 32)
    launcher = tmp_path / "scripts" / "xylon-librelane"
    launcher.parent.mkdir()
    launcher.write_text("#!/bin/sh\n", encoding="utf-8")
    launcher.chmod(0o700)
    plan = adapter.build_execution_plan(
        adapter.LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
        run_dir=run_dir,
        project=project,
    )

    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_runner(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((command, kwargs))
        signoff = run_dir / "signoff" / "counter" / "openlane-signoff"
        signoff.mkdir(parents=True)
        (signoff / "resolved.json").write_text(
            '{"PDK":"sky130A","STD_CELL_LIBRARY":"sky130_fd_sc_hd"}\n',
            encoding="utf-8",
        )
        (signoff.parent / "metrics.csv").write_text("Metric,Value\ntiming__setup__wns,0.1\n", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, stdout="flow ok\n", stderr="")

    result = adapter.execute_plan(tmp_path, run_dir=run_dir, plan=plan, runner=fake_runner)
    assert result["state"] == "succeeded"
    assert result["readback"]["metrics"]["timing__setup__wns"] == 0.1
    assert calls[0][0] == [str(launcher), "run", str(run_dir.resolve()), "inputs/librelane/config.json"]
    assert calls[0][1]["cwd"] == tmp_path.resolve()


def test_bounded_runner_drains_large_output_without_retaining_it_all(tmp_path: Path) -> None:
    result = adapter._run_with_bounded_output(
        [
            sys.executable,
            "-c",
            "import sys; sys.stdout.write('o' * 200000); sys.stderr.write('e' * 200000)",
        ],
        cwd=tmp_path,
        env={},
        timeout=5.0,
    )

    assert result.returncode == 0
    assert result.stdout == "o" * adapter.MAX_EXECUTION_OUTPUT_BYTES
    assert result.stderr == "e" * adapter.MAX_EXECUTION_OUTPUT_BYTES


def test_bounded_runner_kills_timed_out_process_with_bounded_evidence(tmp_path: Path) -> None:
    with pytest.raises(subprocess.TimeoutExpired) as caught:
        adapter._run_with_bounded_output(
            [
                sys.executable,
                "-c",
                "import sys,time; sys.stdout.write('o' * 200000); sys.stdout.flush(); time.sleep(5)",
            ],
            cwd=tmp_path,
            env={},
            timeout=0.1,
        )

    assert len(caught.value.output or b"") <= adapter.MAX_EXECUTION_OUTPUT_BYTES


def test_bounded_runner_kills_descendants_that_keep_output_pipe_open(tmp_path: Path) -> None:
    started = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        adapter._run_with_bounded_output(
            [
                sys.executable,
                "-c",
                (
                    "import subprocess,sys,time; "
                    "subprocess.Popen([sys.executable,'-c','import time; time.sleep(5)']); "
                    "time.sleep(5)"
                ),
            ],
            cwd=tmp_path,
            env={},
            timeout=0.1,
        )

    assert time.monotonic() - started < 2.0


def test_execute_plan_preserves_native_readback_when_timing_violations_set_exit_code(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / ".xylon" / "timing" / "runs" / ("c" * 32)
    run_dir.mkdir(parents=True)
    config = run_dir / "inputs" / "librelane" / "config.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text("{}\n", encoding="utf-8")
    launcher = tmp_path / "scripts" / "xylon-librelane"
    launcher.parent.mkdir()
    launcher.write_text("#!/bin/sh\n", encoding="utf-8")
    launcher.chmod(0o700)
    project = adapter.LibreLaneMaterializedProject(
        request={"platform": "sky130hd", "run_id": "c" * 32, "config_path": "inputs/librelane/config.json"},
        top="counter",
        source_revision="a" * 40,
        design_path="inputs/design.v",
        sdc_path="inputs/design.sdc",
        config_path="inputs/librelane/config.json",
    )
    plan = adapter.build_execution_plan(
        adapter.LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
        run_dir=run_dir,
        project=project,
    )

    def fake_runner(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        native_run = run_dir / "runs" / "RUN_2026-08-26_00-00-00"
        (native_run / "final").mkdir(parents=True)
        (native_run / "resolved.json").write_text(
            '{"PDK":"sky130A","STD_CELL_LIBRARY":"sky130_fd_sc_hd"}\n',
            encoding="utf-8",
        )
        (native_run / "final" / "metrics.csv").write_text(
            "Metric,Value\ntiming__setup__wns,-4.2\n", encoding="utf-8"
        )
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="setup violations found")

    result = adapter.execute_plan(tmp_path, run_dir=run_dir, plan=plan, runner=fake_runner)
    assert result["state"] == "succeeded"
    assert result["flow_status"] == "completed_with_violations"
    assert result["tool_returncode"] == 1
    assert result["readback"]["metrics"]["timing__setup__wns"] == -4.2


def test_execute_plan_rejects_stale_native_readback_after_failed_launcher(tmp_path: Path) -> None:
    run_dir = tmp_path / ".xylon" / "timing" / "runs" / ("d" * 32)
    stale_run = run_dir / "runs" / "RUN_2026-08-25_00-00-00"
    (stale_run / "final").mkdir(parents=True)
    (stale_run / "resolved.json").write_text(
        '{"PDK":"sky130A","STD_CELL_LIBRARY":"sky130_fd_sc_hd"}\n',
        encoding="utf-8",
    )
    (stale_run / "final" / "metrics.csv").write_text(
        "Metric,Value\ntiming__setup__wns,-0.1\n", encoding="utf-8"
    )
    config = run_dir / "config.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text("{}\n", encoding="utf-8")
    launcher = tmp_path / "scripts" / "xylon-librelane"
    launcher.parent.mkdir()
    launcher.write_text("#!/bin/sh\n", encoding="utf-8")
    launcher.chmod(0o700)
    project = adapter.LibreLaneMaterializedProject(
        request={"platform": "sky130hd", "run_id": "d" * 32, "config_path": "config.json"},
        top="counter",
        source_revision="a" * 40,
        design_path="inputs/design.v",
        sdc_path="inputs/design.sdc",
        config_path="config.json",
    )
    plan = adapter.build_execution_plan(
        adapter.LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
        run_dir=run_dir,
        project=project,
    )
    with pytest.raises(adapter.LibreLaneExecutionError, match="execution failed") as caught:
        adapter.execute_plan(
            tmp_path,
            run_dir=run_dir,
            plan=plan,
            runner=lambda command, **kwargs: subprocess.CompletedProcess(
                command, 1, stdout="", stderr="native flow stopped before readback"
            ),
        )
    assert caught.value.evidence["stage"] == "native_readback"
    assert caught.value.evidence["first_error_line"] == "native flow stopped before readback"
    assert caught.value.evidence["stderr_excerpt"] == "native flow stopped before readback"
    assert caught.value.evidence["tool_returncode"] == 1
    assert caught.value.evidence["config_identity_sha256"] == plan.config_identity_sha256
    assert caught.value.evidence["plan_identity_sha256"] == plan.plan_identity_sha256


def test_execute_plan_rejects_missing_readback_after_launcher_success(tmp_path: Path) -> None:
    run_dir = tmp_path / ".xylon" / "timing" / "runs" / ("b" * 32)
    run_dir.mkdir(parents=True)
    config = run_dir / "config.json"
    config.write_text("{}\n", encoding="utf-8")
    launcher = tmp_path / "scripts" / "xylon-librelane"
    launcher.parent.mkdir()
    launcher.write_text("#!/bin/sh\n", encoding="utf-8")
    launcher.chmod(0o700)
    project = adapter.LibreLaneMaterializedProject(
        request={"platform": "sky130hd", "run_id": "b" * 32, "config_path": "config.json"},
        top="counter",
        source_revision="a" * 40,
        design_path="inputs/design.v",
        sdc_path="inputs/design.sdc",
        config_path="config.json",
    )
    plan = adapter.build_execution_plan(
        adapter.LibreLaneProbe("available", "/opt/librelane/python", "3.0.10", "ok"),
        run_dir=run_dir,
        project=project,
    )
    with pytest.raises(adapter.LibreLaneExecutionError, match="native metrics") as caught:
        adapter.execute_plan(
            tmp_path,
            run_dir=run_dir,
            plan=plan,
            runner=lambda command, **kwargs: subprocess.CompletedProcess(command, 0, stdout="", stderr=""),
        )
    assert caught.value.evidence["stage"] == "native_readback"
    assert caught.value.evidence["first_error_line"] == (
        "LibreLane resolved config and native metrics artifacts are missing"
    )
    assert caught.value.evidence["tool_returncode"] == 0


def test_first_error_line_prefers_tool_blocker_over_preflight_banner() -> None:
    line = adapter._first_error_line(
        "",
        '{"status":"ready","resource":{"memory_free_percent":92}}\n'
        "[IFP-0002] standard-cell instance does not fit in the core area",
    )
    assert line == "[IFP-0002] standard-cell instance does not fit in the core area"


def test_readback_requires_native_librelane_outputs(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    signoff = run_dir / "signoff" / "counter" / "openlane-signoff"
    signoff.mkdir(parents=True)
    (signoff / "resolved.json").write_text(
        '{"PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hd"}\n',
        encoding="utf-8",
    )
    metrics = signoff.parent / "metrics.csv"
    metrics.write_text("Metric,Value\ntiming__setup__wns,0.1\n", encoding="utf-8")
    result = adapter.readback_artifacts(run_dir, "counter")
    assert result["paths"] == {
        "resolved": "signoff/counter/openlane-signoff/resolved.json",
        "metrics": "signoff/counter/metrics.csv",
    }
    assert result["artifacts"]["resolved"]["path"] == "signoff/counter/openlane-signoff/resolved.json"
    assert result["artifacts"]["resolved"]["bytes"] > 0
    assert len(result["artifacts"]["resolved"]["sha256"]) == 64
    assert result["artifacts"]["metrics"]["path"] == "signoff/counter/metrics.csv"
    assert result["artifacts"]["metrics"]["bytes"] > 0
    assert len(result["artifacts"]["metrics"]["sha256"]) == 64
    assert result["metrics"]["timing__setup__wns"] == 0.1
    (signoff / "resolved.json").write_text(
        '{"PDK": "gf180mcuC", "STD_CELL_LIBRARY": "gf180mcu_fd_sc_mcu9t5v0"}\n',
        encoding="utf-8",
    )
    metrics.write_text("Metric,Value\ntiming__setup__wns,0.1\n", encoding="utf-8")
    with pytest.raises(adapter.LibreLaneAdapterError, match="identity"):
        adapter.readback_artifacts(run_dir, "counter")
    (signoff / "resolved.json").write_text(
        '{"PDK": "sky130A", "STD_CELL_LIBRARY": "sky130_fd_sc_hd"}\n',
        encoding="utf-8",
    )
    metrics.write_text("Metric,Value\n", encoding="utf-8")
    with pytest.raises(adapter.LibreLaneAdapterError, match="no measured metrics"):
        adapter.readback_artifacts(run_dir, "counter")
    metrics.unlink()
    with pytest.raises(adapter.LibreLaneAdapterError, match="native metrics"):
        adapter.readback_artifacts(run_dir, "counter")
