from agent.openroad.execution_adapter import (
    PINNED_ORFS_IMAGE,
    SUPPORTED_PROFILE,
    AdapterContractError,
    AdapterRequest,
    build_adapter_plan,
)


def request(**overrides):
    values = {
        "profile": SUPPORTED_PROFILE,
        "platform": "sky130hd",
        "stage": "grt",
        "run_id": "run-12345678",
        "repo_id": "repo-12345678",
        "config_sha256": "a" * 64,
    }
    values.update(overrides)
    return AdapterRequest(**values)


def test_builds_pinned_runtime_plan_with_stage_evidence_descriptors():
    plan = build_adapter_plan(request())
    assert plan.identity.image == PINNED_ORFS_IMAGE
    assert plan.identity.profile == SUPPORTED_PROFILE
    assert plan.identity.recipe_version == "xylon-orfs-sky130hd-grt/v2"
    assert plan.stage.reports[0].relative_path.endswith("5_global_route.rpt")
    assert plan.stage.artifacts[0].relative_path.endswith("5_1_grt.odb")
    assert len(plan.plan_identity_sha256) == 64


def test_identity_hash_is_stable_for_same_request():
    assert build_adapter_plan(request()).plan_identity_sha256 == build_adapter_plan(request()).plan_identity_sha256


def test_rejects_unknown_profile_platform_or_stage():
    for field, value in (("profile", "librelane-unpinned"), ("platform", "other"), ("stage", "route")):
        try:
            build_adapter_plan(request(**{field: value}))
        except AdapterContractError:
            pass
        else:
            raise AssertionError(f"{field} was accepted")


def test_request_has_no_arbitrary_command_field():
    try:
        AdapterRequest(**{**request().__dict__, "command": "rm -rf /"})
    except TypeError:
        pass
    else:
        raise AssertionError("arbitrary command field was accepted")
