from agent.openroad.execution_adapter import (
    ADAPTER_SCHEMA_VERSION,
    PINNED_ORFS_IMAGE,
    SUPPORTED_PROFILE,
    AdapterContractError,
    AdapterRequest,
    build_adapter_plan,
    parse_adapter_request,
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
    assert plan.identity.schema_version == ADAPTER_SCHEMA_VERSION
    assert plan.identity.image == PINNED_ORFS_IMAGE
    assert plan.identity.profile == SUPPORTED_PROFILE
    assert plan.identity.execution_kind == "comparison_fixture"
    assert plan.identity.upstream_flow == "orfs"
    assert plan.identity.temporary is True
    assert plan.identity.recipe_version == "xylon-orfs-sky130hd-grt/v2"
    assert plan.command.launcher_path == "runtime/openroad/bin/orfs-timing"
    assert plan.resources.memory_gib == 8
    assert plan.stage.reports[0].relative_path.endswith("5_global_route.rpt")
    assert plan.stage.artifacts[0].relative_path.endswith("5_1_grt.odb")
    assert len(plan.plan_identity_sha256) == 64


def test_command_and_config_identity_are_stable_and_config_sensitive():
    first = build_adapter_plan(request())
    second = build_adapter_plan(request())
    changed = build_adapter_plan(request(config_sha256="b" * 64))

    assert first.command_identity_sha256 == second.command_identity_sha256
    assert first.config_identity_sha256 == second.config_identity_sha256
    assert first.command_identity_sha256 != first.config_identity_sha256
    assert first.config_identity_sha256 != changed.config_identity_sha256


def test_rejects_unknown_profile_platform_or_stage():
    for field, value in (("profile", "librelane-unpinned"), ("platform", "other"), ("stage", "route")):
        try:
            build_adapter_plan(request(**{field: value}))
        except AdapterContractError:
            pass
        else:
            raise AssertionError(f"{field} was accepted")


def test_request_parser_rejects_arbitrary_command_field():
    try:
        parse_adapter_request({**request().__dict__, "command": "rm -rf /"})
    except AdapterContractError as error:
        assert "arbitrary execution fields" in str(error)
        pass
    else:
        raise AssertionError("arbitrary command field was accepted")
