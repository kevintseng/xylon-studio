"""Contract tests for the OpenROAD snapshot API."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi.testclient import TestClient

from agent.api.main import app
from agent.api.routes import openroad as openroad_routes


def _configure_repo_root(monkeypatch, repo_root: Path) -> Path:
    monkeypatch.setattr(openroad_routes, "REPO_ROOT", repo_root.resolve())
    return repo_root / ".xylon" / "openroad" / "snapshot.json"


def test_openroad_snapshot_returns_stopped_state_when_snapshot_is_absent(
    tmp_path: Path,
    monkeypatch,
):
    snapshot_path = _configure_repo_root(monkeypatch, tmp_path)
    monkeypatch.delenv("XYLON_OPENROAD_SNAPSHOT_PATH", raising=False)

    with TestClient(app) as client:
        response = client.get("/api/openroad/snapshot")

    assert snapshot_path.exists() is False
    assert response.status_code == 200
    assert response.json() == {
        "schema_version": 1,
        "updated_at": None,
        "server": {"status": "stopped"},
        "sessions": [],
        "last_error": None,
    }


def test_librelane_readiness_is_truthful_and_does_not_start_a_flow(tmp_path, monkeypatch):
    _configure_repo_root(monkeypatch, tmp_path)
    monkeypatch.setattr(
        openroad_routes,
        "collect_librelane_readiness",
        lambda _repo_root: {
            "schema_version": "xylon-librelane-readiness/v1",
            "state": "blocked",
            "checks": {"python": True, "docker": True, "image": False, "pdk": False, "resources": False},
            "blockers": ["the pinned LibreLane image is not present locally"],
            "next_action": "Resolve the first listed blocker, then check LibreLane readiness again.",
        },
    )

    with TestClient(app) as client:
        response = client.get("/api/openroad/librelane-readiness")

    assert response.status_code == 200
    assert response.json()["state"] == "blocked"
    assert response.json()["checks"]["image"] is False
    assert response.json()["next_action"].startswith("Resolve the first listed blocker")


def test_openroad_snapshot_returns_the_canonical_snapshot_payload(
    tmp_path: Path,
    monkeypatch,
):
    snapshot_path = _configure_repo_root(monkeypatch, tmp_path)
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    snapshot_path.write_text(
        (
            '{"schema_version":1,"updated_at":"2026-08-24T12:00:00Z",'
            '"server":{"status":"running","pid":3210},'
            '"sessions":[{"id":"sess-1","design":"adder"}],'
            '"last_error":{"message":"stale warning"},'
            '"ignored":"extra"}'
        ),
        encoding="utf-8",
    )

    with TestClient(app) as client:
        response = client.get("/api/openroad/snapshot")

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": 1,
        "updated_at": "2026-08-24T12:00:00Z",
        "server": {"status": "running", "pid": 3210},
        "sessions": [{"id": "sess-1", "design": "adder"}],
        "last_error": {"message": "stale warning"},
    }


def test_openroad_snapshot_rejects_invalid_json_without_path_leakage(
    tmp_path: Path,
    monkeypatch,
):
    snapshot_path = _configure_repo_root(monkeypatch, tmp_path)
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    snapshot_path.write_text("{not-json", encoding="utf-8")

    with TestClient(app) as client:
        response = client.get("/api/openroad/snapshot")

    assert response.status_code == 500
    assert response.json() == {"detail": "OpenROAD snapshot contains invalid JSON"}
    assert str(snapshot_path) not in response.text
    assert str(tmp_path) not in response.text


def test_openroad_snapshot_rejects_oversized_files(
    tmp_path: Path,
    monkeypatch,
):
    snapshot_path = _configure_repo_root(monkeypatch, tmp_path)
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    snapshot_path.write_text("x" * (1024 * 1024 + 1), encoding="utf-8")

    with TestClient(app) as client:
        response = client.get("/api/openroad/snapshot")

    assert response.status_code == 500
    assert response.json() == {"detail": "OpenROAD snapshot exceeds the 1 MiB limit"}


def test_openroad_snapshot_rejects_escape_override_without_path_leakage(
    tmp_path: Path,
    monkeypatch,
):
    repo_root = tmp_path / "repo"
    outside_root = tmp_path / "outside"
    repo_root.mkdir()
    outside_root.mkdir()
    _configure_repo_root(monkeypatch, repo_root)
    outside_snapshot = outside_root / "snapshot.json"
    outside_snapshot.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("XYLON_OPENROAD_SNAPSHOT_PATH", str(outside_snapshot))

    with TestClient(app) as client:
        response = client.get("/api/openroad/snapshot")

    assert response.status_code == 500
    assert response.json() == {
        "detail": "OpenROAD snapshot path is outside the local workspace"
    }
    assert str(outside_snapshot) not in response.text
    assert str(repo_root) not in response.text


def test_openroad_snapshot_rejects_symlink_override_without_path_leakage(
    tmp_path: Path,
    monkeypatch,
):
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _configure_repo_root(monkeypatch, repo_root)
    linked_dir = repo_root / "linked"
    target_dir = tmp_path / "target"
    target_dir.mkdir()
    linked_dir.symlink_to(target_dir, target_is_directory=True)
    linked_snapshot = linked_dir / "snapshot.json"
    (target_dir / "snapshot.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv(
        "XYLON_OPENROAD_SNAPSHOT_PATH",
        os.fspath(Path("linked") / "snapshot.json"),
    )

    with TestClient(app) as client:
        response = client.get("/api/openroad/snapshot")

    assert response.status_code == 500
    assert response.json() == {
        "detail": "OpenROAD snapshot path must not use symlinks"
    }
    assert str(linked_snapshot) not in response.text
    assert str(target_dir) not in response.text


def test_openroad_snapshot_rejects_unsupported_schema_version(
    tmp_path: Path,
    monkeypatch,
):
    snapshot_path = _configure_repo_root(monkeypatch, tmp_path)
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    snapshot_path.write_text(
        '{"schema_version":2,"updated_at":null,"server":{},"sessions":[],"last_error":null}',
        encoding="utf-8",
    )

    with TestClient(app) as client:
        response = client.get("/api/openroad/snapshot")

    assert response.status_code == 500
    assert response.json() == {"detail": "OpenROAD snapshot schema is unsupported"}
