"""Release version consistency across user-visible Xylon surfaces."""

import json
import re
from pathlib import Path

from fastapi.testclient import TestClient

import agent
import agent.api
from agent.api.main import app

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_release_version_is_consistent_across_runtime_surfaces():
    expected = (REPO_ROOT / "VERSION").read_text().strip().removeprefix("v")

    with TestClient(app) as client:
        assert app.version == expected
        assert client.get("/").json()["version"] == expected
        assert client.get("/health").json()["version"] == expected
        assert client.get("/openapi.json").json()["info"]["version"] == expected

    assert agent.__version__ == expected
    assert agent.api.__version__ == expected

    openroad_dir = REPO_ROOT / "agent" / "openroad"
    manifest = json.loads((openroad_dir / "package.json").read_text())
    lockfile = json.loads((openroad_dir / "package-lock.json").read_text())
    assert manifest["version"] == expected
    assert lockfile["version"] == expected
    assert lockfile["packages"][""]["version"] == expected

    server_source = (openroad_dir / "server.mjs").read_text()
    smoke_source = (openroad_dir / "smoke-client.mjs").read_text()
    assert re.search(rf"XYLON_VERSION = ['\"]{re.escape(expected)}['\"]", server_source)
    assert re.search(rf"XYLON_VERSION = ['\"]{re.escape(expected)}['\"]", smoke_source)
    assert "version: XYLON_VERSION" in smoke_source

    api_docs = (REPO_ROOT / "docs" / "API.md").read_text()
    assert f"Version: {expected}" in api_docs
    assert f'"version": "{expected}"' in api_docs
