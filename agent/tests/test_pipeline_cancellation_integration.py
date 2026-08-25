"""Real runtime proof for interrupting one checkout-owned EDA operation."""

import asyncio
import threading
import time
from unittest.mock import patch

import pytest

from agent.api.execution import run_in_local_eda_slot
from agent.local_app import ResourceSnapshot
from agent.pipeline.models import PipelineConfig, StepStatus
from agent.pipeline.runner import run_pipeline
from agent.sandbox.executor import ExecutionError, SandboxExecutor
from agent.sandbox.runtime import runtime_container_name

_SIMPLE_RTL = """\
module first_run_adder (
    input  [7:0] a,
    input  [7:0] b,
    output [8:0] sum
);
    assign sum = a + b;
endmodule
"""

_LONG_RUNNING_TESTBENCH = """\
#include "Vfirst_run_adder.h"
#include "verilated.h"

int main(int argc, char** argv) {
    Verilated::commandArgs(argc, argv);
    Vfirst_run_adder dut;
    while (true) {
        dut.eval();
    }
}
"""


@pytest.mark.integration
@pytest.mark.asyncio
async def test_fresh_artifact_root_reaches_real_lint_with_admitted_resources(
    tmp_path,
):
    artifact_root = tmp_path / ".xylon" / "runs"
    assert artifact_root.exists() is False
    admitted = ResourceSnapshot(
        logical_cpus=12,
        load_one_minute=1.0,
        memory_free_percent=80,
        disk_free_bytes=100 * 1024**3,
        memory_available_bytes=16 * 1024**3,
    )

    def collect_from_existing_path(probe_path):
        assert probe_path == tmp_path
        assert probe_path.exists()
        return admitted

    with patch(
        "agent.local_app.collect_resource_snapshot",
        side_effect=collect_from_existing_path,
    ):
        result = await run_pipeline(
            _SIMPLE_RTL,
            config=PipelineConfig(
                artifact_root=str(artifact_root),
                resource_check_enabled=True,
                runtime_check_enabled=True,
            ),
        )

    assert result.outcome.value == "lint_only"
    assert result.get_step("resource").status == StepStatus.PASSED
    assert result.get_step("runtime").status == StepStatus.PASSED
    assert result.get_step("lint").status == StepStatus.PASSED
    assert result.get_step("artifacts").status == StepStatus.PASSED
    assert artifact_root.joinpath(result.pipeline_id, "manifest.json").is_file()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_pipeline_cancels_active_eda_and_releases_local_slot(tmp_path):
    cancellation = asyncio.Event()
    simulation_started = asyncio.Event()

    async def on_step_started(step_name: str) -> None:
        if step_name == "simulate":
            simulation_started.set()

    async def long_operation():
        return await run_pipeline(
            _SIMPLE_RTL,
            testbench_code=_LONG_RUNNING_TESTBENCH,
            config=PipelineConfig(
                artifact_root=str(tmp_path / "cancelled"),
                runtime_check_enabled=True,
                simulation_timeout=35,
            ),
            on_step_started=on_step_started,
            cancellation_event=cancellation,
        )

    first = asyncio.create_task(run_in_local_eda_slot(long_operation))
    await asyncio.wait_for(simulation_started.wait(), timeout=10)
    await asyncio.sleep(0.3)
    cancellation.set()
    cancelled = await asyncio.wait_for(first, timeout=10)

    assert cancelled.outcome.value == "cancelled"
    assert cancelled.get_step("simulate").status == StepStatus.SKIPPED

    async def follow_up_operation():
        return await run_pipeline(
            _SIMPLE_RTL,
            config=PipelineConfig(
                artifact_root=str(tmp_path / "follow-up"),
                runtime_check_enabled=True,
            ),
        )

    follow_up = await asyncio.wait_for(
        run_in_local_eda_slot(follow_up_operation),
        timeout=10,
    )
    assert follow_up.outcome.value == "lint_only"
    assert follow_up.get_step("lint").status == StepStatus.PASSED


@pytest.mark.integration
def test_active_eda_cancellation_cleans_up_and_accepts_the_next_operation():
    executor = SandboxExecutor(runtime_container_name("verilator"))
    cancellation = threading.Event()
    timer = threading.Timer(0.5, cancellation.set)

    started = time.monotonic()
    timer.start()
    try:
        with pytest.raises(ExecutionError) as caught:
            executor.execute(
                [
                    "sh",
                    "-c",
                    "verilator --version >/dev/null && exec sleep 30",
                ],
                timeout=35,
                cancel_requested=cancellation.is_set,
            )
    finally:
        timer.cancel()

    assert time.monotonic() - started < 10
    assert caught.value.failure_kind == "cancellation"
    assert "container cleanup verified" in str(caught.value)
    assert "process group" in str(caught.value)

    follow_up = executor.execute(["verilator", "--version"], timeout=10)
    assert follow_up.success is True
    assert "Verilator" in follow_up.stdout
