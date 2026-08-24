"""Sequential canonical RTL verification pipeline."""

import asyncio
import logging
import shutil
import tempfile
import uuid
from collections.abc import Awaitable, Callable

from agent.pipeline.artifacts import persist_pipeline_artifacts
from agent.pipeline.limits import validate_pipeline_inputs
from agent.pipeline.models import (
    FailureKind,
    PipelineConfig,
    PipelineOutcome,
    PipelineResult,
    RunMode,
    StepResult,
    StepStatus,
)
from agent.pipeline.steps.coverage import run_coverage_step
from agent.pipeline.steps.lint import run_lint_step
from agent.pipeline.steps.simulate import run_simulate_step_with_evidence
from agent.pipeline.steps.synthesis import run_synthesis_step
from agent.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)

StepCallback = Callable[[StepResult], Awaitable[None]] | None
StepStartCallback = Callable[[str], Awaitable[None]] | None


async def run_pipeline(
    rtl_code: str,
    testbench_code: str | None = None,
    config: PipelineConfig | None = None,
    on_step_complete: StepCallback = None,
    on_step_started: StepStartCallback = None,
    cancellation_event: asyncio.Event | None = None,
) -> PipelineResult:
    """Run the supported local flow and publish one canonical result."""
    validate_pipeline_inputs(rtl_code, testbench_code)
    config = config or PipelineConfig()
    mode = (
        RunMode.PROVIDED_TESTBENCH
        if testbench_code
        else RunMode.LINT_ONLY
    )
    pipeline_id = str(uuid.uuid4())
    work_dir = tempfile.mkdtemp(prefix="xylon-pipeline-")
    rtl_file = f"{work_dir}/design.v"
    tb_file = f"{work_dir}/testbench.cpp"
    steps: list[StepResult] = []
    final_coverage = None
    iterations_used = 0
    start_time = asyncio.get_event_loop().time()

    async def emit(step: StepResult) -> None:
        if on_step_complete:
            await on_step_complete(step)

    async def emit_start(step_name: str) -> None:
        if on_step_started:
            await on_step_started(step_name)

    async def finish(error: str | None = None) -> PipelineResult:
        result = _finalize_result(
            pipeline_id=pipeline_id,
            steps=steps,
            final_coverage=final_coverage,
            start_time=start_time,
            iterations_used=iterations_used,
            error=error,
            mode=mode,
            coverage_target=config.coverage_target,
        )
        artifact_step = StepResult(
            step_name="artifacts",
            status=StepStatus.PASSED,
            duration_seconds=0.0,
            output={
                "run_directory": pipeline_id,
                "manifest_path": "manifest.json",
                "checksums_path": "checksums.sha256",
            },
            required=True,
        )
        result.steps.append(artifact_step)
        try:
            await asyncio.to_thread(
                persist_pipeline_artifacts,
                result=result,
                rtl_code=rtl_code,
                testbench_code=testbench_code,
                config=config,
            )
        except Exception as artifact_error:
            logger.error(
                "[PIPELINE-%s] Artifact persistence failed: %s",
                pipeline_id,
                artifact_error,
            )
            artifact_step.status = StepStatus.ERROR
            artifact_step.output = {}
            artifact_step.errors = [str(artifact_error)]
            artifact_step.failure_kind = FailureKind.INFRASTRUCTURE
            artifact_step.recovery_code = "repair_artifact_storage"
            result.artifacts = None
            result.success = False
            result.outcome = PipelineOutcome.INFRASTRUCTURE_ERROR
        await emit(artifact_step)
        return result

    async def cancel_if_requested() -> PipelineResult | None:
        if cancellation_event is None or not cancellation_event.is_set():
            return None
        if not steps or steps[-1].failure_kind != FailureKind.CANCELLATION:
            cancelled_step = StepResult(
                step_name="cancelled",
                status=StepStatus.SKIPPED,
                duration_seconds=0.0,
                failure_kind=FailureKind.CANCELLATION,
                recovery_code="rerun_when_ready",
            )
            steps.append(cancelled_step)
            await emit(cancelled_step)
        return await finish()

    try:
        if mode == RunMode.LINT_ONLY and not config.lint_enabled:
            configuration_step = StepResult(
                step_name="configuration",
                status=StepStatus.ERROR,
                duration_seconds=0.0,
                errors=[
                    "A run without a testbench must keep lint enabled; "
                    "otherwise no verification evidence would be produced."
                ],
                failure_kind=FailureKind.CONFIGURATION,
                recovery_code="enable_lint_or_provide_testbench",
                required=True,
            )
            steps.append(configuration_step)
            await emit(configuration_step)
            return await finish()

        cancelled = await cancel_if_requested()
        if cancelled is not None:
            return cancelled

        with open(rtl_file, "w", encoding="utf-8") as handle:
            handle.write(rtl_code)

        sandbox = SandboxManager()
        if config.runtime_check_enabled:
            await emit_start("runtime")
            try:
                identity = await asyncio.to_thread(sandbox.get_tool_identity)
            except Exception as runtime_error:
                identity = {
                    "verified": False,
                    "expected": {},
                    "observed": {},
                    "errors": [str(runtime_error)],
                }
            verified = bool(identity.get("verified"))
            runtime_step = StepResult(
                step_name="runtime",
                status=StepStatus.PASSED if verified else StepStatus.ERROR,
                duration_seconds=0.0,
                output=identity,
                errors=list(identity.get("errors", [])),
                failure_kind=None if verified else FailureKind.INFRASTRUCTURE,
                recovery_code=None if verified else "start_pinned_runtime",
            )
            steps.append(runtime_step)
            await emit(runtime_step)
            if not verified:
                return await finish()

        if config.lint_enabled:
            await emit_start("lint")
            lint_result = await run_lint_step(rtl_file, sandbox)
            steps.append(lint_result)
            await emit(lint_result)
            cancelled = await cancel_if_requested()
            if cancelled is not None:
                return cancelled
            if lint_result.status != StepStatus.PASSED:
                return await finish()

        if testbench_code:
            iterations_used = 1
            with open(tb_file, "w", encoding="utf-8") as handle:
                handle.write(testbench_code)

            await emit_start("simulate")
            simulation_step, simulation_evidence = (
                await run_simulate_step_with_evidence(
                    rtl_file,
                    tb_file,
                    sandbox,
                    timeout=config.simulation_timeout,
                )
            )
            steps.append(simulation_step)
            await emit(simulation_step)
            cancelled = await cancel_if_requested()
            if cancelled is not None:
                return cancelled
            if simulation_step.status != StepStatus.PASSED:
                return await finish()

            await emit_start("coverage")
            coverage_step, final_coverage = await run_coverage_step(
                rtl_file,
                tb_file,
                sandbox,
                timeout=config.simulation_timeout,
                simulation_result=simulation_evidence,
            )
            steps.append(coverage_step)
            await emit(coverage_step)
            cancelled = await cancel_if_requested()
            if cancelled is not None:
                return cancelled

        if config.synthesis_enabled:
            cancelled = await cancel_if_requested()
            if cancelled is not None:
                return cancelled
            await emit_start("synthesis")
            synthesis_step = await run_synthesis_step(rtl_file, sandbox)
            steps.append(synthesis_step)
            await emit(synthesis_step)

        return await finish()
    except Exception as error:
        logger.error("[PIPELINE-%s] Fatal error: %s", pipeline_id, error)
        return await finish(error=str(error))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _finalize_result(
    pipeline_id: str,
    steps: list[StepResult],
    final_coverage,
    start_time: float | None,
    iterations_used: int = 1,
    error: str | None = None,
    mode: RunMode = RunMode.LINT_ONLY,
    coverage_target: float = 0.0,
) -> PipelineResult:
    """Derive the terminal outcome exclusively from canonical evidence."""
    end_time = asyncio.get_event_loop().time()
    duration = (end_time - start_time) if start_time else 0
    required_steps = [step for step in steps if step.required]
    steps_passed = bool(required_steps) and all(
        step.status == StepStatus.PASSED for step in required_steps
    )
    failure_kinds = {
        step.failure_kind
        for step in steps
        if step.failure_kind is not None
    }

    if FailureKind.CANCELLATION in failure_kinds:
        outcome = PipelineOutcome.CANCELLED
    elif FailureKind.INFRASTRUCTURE in failure_kinds:
        outcome = PipelineOutcome.INFRASTRUCTURE_ERROR
    elif FailureKind.UNSUPPORTED in failure_kinds:
        outcome = PipelineOutcome.UNSUPPORTED
    elif FailureKind.CONFIGURATION in failure_kinds or error is not None:
        outcome = PipelineOutcome.CONFIGURATION_ERROR
    elif mode == RunMode.LINT_ONLY and steps_passed:
        outcome = PipelineOutcome.LINT_ONLY
    elif FailureKind.INCONCLUSIVE in failure_kinds:
        outcome = PipelineOutcome.INCONCLUSIVE
    elif final_coverage is not None and final_coverage.score is None:
        outcome = PipelineOutcome.INCONCLUSIVE
    elif not steps_passed or final_coverage is None:
        outcome = PipelineOutcome.VERIFICATION_FAILED
    elif final_coverage.score < coverage_target:
        outcome = PipelineOutcome.TARGET_NOT_MET
    else:
        outcome = PipelineOutcome.VERIFIED

    return PipelineResult(
        pipeline_id=pipeline_id,
        steps=steps,
        final_coverage=final_coverage,
        iterations_used=iterations_used,
        total_duration_seconds=duration,
        success=outcome == PipelineOutcome.VERIFIED,
        mode=mode,
        outcome=outcome,
    )
