"""Durable pipeline artifact contract tests."""

import json
import stat
from unittest.mock import patch

import pytest

from agent.pipeline.artifacts import (
    ArtifactIntegrityError,
    load_rerun_manifest,
    persist_pipeline_artifacts,
    verify_artifact_manifest,
)
from agent.pipeline.models import (
    CoverageReport,
    PipelineConfig,
    PipelineOutcome,
    PipelineResult,
    RunMode,
    StepResult,
    StepStatus,
)


def _verified_result(pipeline_id: str = "run-123") -> PipelineResult:
    return PipelineResult(
        pipeline_id=pipeline_id,
        steps=[StepResult("simulate", StepStatus.PASSED, 0.2)],
        final_coverage=CoverageReport(
            line_coverage=None,
            toggle_coverage=0.91,
            branch_coverage=None,
            score=0.91,
            raw_output="Coverage Summary:\n  toggle : 91.0% (91/100)\n",
            metric_sources={
                "toggle_coverage": "verilator_summary",
                "score": "computed_verilator_point_counts",
            },
        ),
        iterations_used=1,
        total_duration_seconds=0.3,
        success=True,
        mode=RunMode.PROVIDED_TESTBENCH,
        outcome=PipelineOutcome.VERIFIED,
    )


def test_persisted_manifest_is_complete_integrity_checked_and_rerunnable(tmp_path):
    result = _verified_result()
    config = PipelineConfig(coverage_target=0.9, artifact_root=str(tmp_path))

    bundle = persist_pipeline_artifacts(
        result=result,
        rtl_code="module adder; endmodule\n",
        testbench_code='int main() { puts("PASS"); }\n',
        config=config,
    )

    run_dir = tmp_path / result.pipeline_id
    manifest_path = run_dir / "manifest.json"
    checksums_path = run_dir / "checksums.sha256"
    assert bundle.run_directory == result.pipeline_id
    assert bundle.manifest_path == "manifest.json"
    assert bundle.checksums_path == "checksums.sha256"
    assert manifest_path.is_file()
    assert checksums_path.is_file()
    assert not list(tmp_path.glob(".*.staging-*"))

    manifest = json.loads(manifest_path.read_text())
    assert str(tmp_path.resolve()) not in manifest_path.read_text()
    assert manifest["schema_version"] == 1
    assert manifest["result"] == result.to_dict()
    assert manifest["result"]["outcome"] == "verified"
    assert manifest["config"]["coverage_target"] == 0.9
    assert manifest["rerun"]["replay_kind"] == "frozen_inputs"
    assert manifest["rerun"]["argv"] == [
        "agent/venv/bin/python", "-m", "agent.cli", "rerun", "manifest.json",
    ]

    roles = {item["role"] for item in manifest["artifacts"]}
    assert roles == {
        "rtl_input",
        "testbench_input",
        "step_log",
        "coverage_report",
    }
    verify_artifact_manifest(manifest_path)

    assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o700
    assert stat.S_IMODE(run_dir.stat().st_mode) == 0o700
    for path in run_dir.rglob("*"):
        expected_mode = 0o700 if path.is_dir() else 0o600
        assert stat.S_IMODE(path.stat().st_mode) == expected_mode

    replay = load_rerun_manifest(manifest_path)
    assert replay.rtl_code == "module adder; endmodule\n"
    assert replay.testbench_code == 'int main() { puts("PASS"); }\n'
    assert replay.config.coverage_target == 0.9
    assert replay.expected_outcome == PipelineOutcome.VERIFIED


def test_manifest_verification_detects_modified_frozen_input(tmp_path):
    result = _verified_result()
    manifest = persist_pipeline_artifacts(
        result=result,
        rtl_code="module original; endmodule\n",
        testbench_code="PASS\n",
        config=PipelineConfig(artifact_root=str(tmp_path)),
    )
    manifest_path = tmp_path / result.pipeline_id / manifest.manifest_path
    (manifest_path.parent / "inputs" / "design.v").write_text(
        "module modified; endmodule\n"
    )

    with pytest.raises(ArtifactIntegrityError, match="inputs/design.v"):
        verify_artifact_manifest(manifest_path)


def test_persistence_fails_closed_when_final_readback_cannot_be_verified(tmp_path):
    result = _verified_result("readback-failure")

    with patch(
        "agent.pipeline.artifacts.verify_artifact_manifest",
        side_effect=ArtifactIntegrityError("seeded final readback failure"),
    ):
        with pytest.raises(
            ArtifactIntegrityError,
            match="seeded final readback failure",
        ):
            persist_pipeline_artifacts(
                result=result,
                rtl_code="module original; endmodule\n",
                testbench_code="PASS\n",
                config=PipelineConfig(artifact_root=str(tmp_path)),
            )

    assert result.artifacts is None
    assert not (tmp_path / result.pipeline_id).exists()
    assert not list(tmp_path.glob(".*.staging-*"))


def test_publish_race_preserves_a_bundle_created_by_another_owner(tmp_path):
    result = _verified_result("concurrent-run")
    final_dir = tmp_path / result.pipeline_id

    def create_competing_bundle_and_fail(_source, _destination):
        final_dir.mkdir()
        (final_dir / "existing-evidence.txt").write_text(
            "preserve me\n",
            encoding="utf-8",
        )
        raise FileExistsError("seeded concurrent publisher")

    with patch(
        "agent.pipeline.artifacts.os.replace",
        side_effect=create_competing_bundle_and_fail,
    ):
        with pytest.raises(FileExistsError, match="seeded concurrent publisher"):
            persist_pipeline_artifacts(
                result=result,
                rtl_code="module replacement; endmodule\n",
                testbench_code="PASS\n",
                config=PipelineConfig(artifact_root=str(tmp_path)),
            )

    assert result.artifacts is None
    assert (final_dir / "existing-evidence.txt").read_text(encoding="utf-8") == "preserve me\n"
    assert not list(tmp_path.glob(".*.staging-*"))


@pytest.mark.parametrize("pipeline_id", ["../escape", "nested/run", "..", "."])
def test_pipeline_id_cannot_escape_artifact_root(tmp_path, pipeline_id):
    with pytest.raises(ValueError, match="pipeline_id"):
        persist_pipeline_artifacts(
            result=_verified_result(pipeline_id),
            rtl_code="module safe; endmodule\n",
            testbench_code=None,
            config=PipelineConfig(artifact_root=str(tmp_path)),
        )
