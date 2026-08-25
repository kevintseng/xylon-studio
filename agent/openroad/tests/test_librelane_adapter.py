from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from agent.openroad import librelane_adapter as adapter


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
    assert adapter.probe_librelane().state == "unavailable"
    assert adapter.probe_librelane().python is None


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
