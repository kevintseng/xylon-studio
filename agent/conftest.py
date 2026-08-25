"""Shared isolation for agent tests."""

import pytest


@pytest.fixture(autouse=True)
def isolate_default_pipeline_artifacts(tmp_path, monkeypatch):
    """Keep default run evidence out of the repository during tests."""
    monkeypatch.setenv("XYLON_ARTIFACT_ROOT", str(tmp_path / "xylon-runs"))
    monkeypatch.setenv("XYLON_SKIP_RUNTIME_CHECK", "1")
