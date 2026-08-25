from __future__ import annotations

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
