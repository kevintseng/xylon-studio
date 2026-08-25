from pathlib import Path
from types import SimpleNamespace

from agent.local_app import ResourceSnapshot
from agent.openroad.librelane_readiness import collect_librelane_readiness


def _snapshot() -> ResourceSnapshot:
    return ResourceSnapshot(
        logical_cpus=12,
        load_one_minute=1.0,
        memory_free_percent=60,
        disk_free_bytes=40 * 1024**3,
        memory_available_bytes=12 * 1024**3,
    )


def test_readiness_reports_all_missing_runtime_inputs_without_starting_a_flow(
    tmp_path: Path,
    monkeypatch,
):
    monkeypatch.delenv("XYLON_LIBRELANE_PDK_ROOT", raising=False)
    result = collect_librelane_readiness(
        tmp_path,
        snapshot=_snapshot(),
        probe=SimpleNamespace(state="unavailable"),
        docker="",
        image_present=False,
    )

    assert result["state"] == "blocked"
    assert result["checks"] == {
        "python": False,
        "docker": False,
        "image": False,
        "pdk": False,
        "resources": True,
    }
    assert result["resource_blockers"] == []
    assert result["blockers"] == [
        "LibreLane 3.0.10 is not available in the configured Python environment",
        "Docker is unavailable",
        "the configured sky130A PDK root is unavailable",
    ]


def test_readiness_becomes_ready_only_when_every_boundary_is_measured(
    tmp_path: Path,
    monkeypatch,
):
    pdk = tmp_path / "sky130A"
    pdk.mkdir()
    monkeypatch.setenv("XYLON_LIBRELANE_PDK_ROOT", str(pdk))
    result = collect_librelane_readiness(
        tmp_path,
        snapshot=_snapshot(),
        probe=SimpleNamespace(state="available"),
        docker="/usr/bin/docker",
        image_present=True,
    )

    assert result["state"] == "ready"
    assert result["checks"] == {
        "python": True,
        "docker": True,
        "image": True,
        "pdk": True,
        "resources": True,
    }
    assert result["blockers"] == []


def test_readiness_uses_project_local_pdk_when_environment_is_unset(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("XYLON_LIBRELANE_PDK_ROOT", raising=False)
    (tmp_path / ".xylon" / "librelane" / "pdk").mkdir(parents=True)
    result = collect_librelane_readiness(
        tmp_path,
        snapshot=_snapshot(),
        probe=SimpleNamespace(state="available"),
        docker="/usr/bin/docker",
        image_present=True,
    )
    assert result["checks"]["pdk"] is True
