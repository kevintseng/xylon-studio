"""Shared resource limits for every supported pipeline entry point."""

MAX_SOURCE_BYTES = 1024 * 1024
MAX_PIPELINE_BODY_BYTES = 2 * MAX_SOURCE_BYTES + 64 * 1024
MAX_PIPELINE_WS_MESSAGE_BYTES = MAX_PIPELINE_BODY_BYTES


def validate_source_text(field_name: str, value: str | None) -> None:
    """Reject source text that exceeds the local single-run byte budget."""
    if value is None:
        return
    size = len(value.encode("utf-8"))
    if size > MAX_SOURCE_BYTES:
        raise ValueError(
            f"{field_name} is {size} bytes and exceeds the "
            f"{MAX_SOURCE_BYTES}-byte limit"
        )


def validate_pipeline_inputs(rtl_code: str, testbench_code: str | None) -> None:
    """Apply the same byte budget at API, CLI, runner, and artifact boundaries."""
    validate_source_text("rtl_code", rtl_code)
    validate_source_text("testbench_code", testbench_code)
