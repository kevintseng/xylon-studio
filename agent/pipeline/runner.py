"""
Pipeline Runner.

Sequential verification pipeline that orchestrates:
lint -> test_plan -> testbench_gen -> simulate -> coverage -> iterate.

Phase A: No LLM steps. Testbench must be provided externally.
Phase B: LLM-driven test plan, testbench generation, and coverage-driven iteration.

Inspired by UVM2 (arXiv:2504.19959) iterative verification methodology.
"""

import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from typing import Awaitable, Callable, Optional

from agent.pipeline.models import (
    CoverageReport,
    PipelineConfig,
    PipelineResult,
    StepResult,
    StepStatus,
    TestPlan,
)
from agent.pipeline.steps.lint import run_lint_step_from_string
from agent.pipeline.steps.simulate import run_simulate_step
from agent.pipeline.steps.coverage import run_coverage_step
from agent.pipeline.steps.test_plan import run_test_plan_step
from agent.pipeline.steps.testbench_gen import (
    run_testbench_gen_step,
    run_testbench_improve_step,
)
from agent.pipeline.steps.synthesis import run_synthesis_step
from agent.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)

# Callback type: called after each step with (pipeline_id, step_result, step_index, total_steps_estimate)
StepCallback = Callable[[str, StepResult, int, int], Awaitable[None]]


async def run_pipeline(
    rtl_code: str,
    testbench_code: str | None = None,
    config: PipelineConfig | None = None,
    on_step_complete: Optional[StepCallback] = None,
    llm_gateway=None,
) -> PipelineResult:
    """
    Run the verification pipeline on RTL code.

    Phase A flow (no LLM):
    1. Lint RTL code (Verilator --lint-only)
    2. If testbench provided: simulate (Verilator --cc --exe --build)
    3. If simulation passed: collect coverage (Verilator --coverage)

    Phase B flow (with LLM, when config.llm_provider is set):
    1. Lint
    2. Generate test plan from RTL (LLM)
    3. Generate testbench from test plan (LLM)
    4. Simulate + coverage
    5. If coverage < target: iterate (improve testbench, re-simulate, re-coverage)

    Args:
        rtl_code: Verilog source code as a string
        testbench_code: Testbench source code (optional — if None and LLM configured, auto-generated)
        config: Pipeline configuration (uses defaults if None)
        on_step_complete: Async callback fired after each step finishes.
            Signature: (pipeline_id, step_result, step_index, total_steps_estimate)
            Enables real-time progress streaming (WebSocket/SSE).
        llm_gateway: LLMGateway instance for Phase B LLM steps (None = Phase A only)

    Returns:
        PipelineResult with all step results and final coverage
    """
    if config is None:
        config = PipelineConfig()

    pipeline_id = f"pipe-{uuid.uuid4().hex[:12]}"
    logger.info(f"Pipeline {pipeline_id}: starting (mode={config.mode})")
    pipeline_start = time.monotonic()

    sandbox = SandboxManager()
    steps: list[StepResult] = []
    final_coverage: CoverageReport | None = None
    step_index = 0

    # Estimate total steps based on config and inputs
    total_estimate = _estimate_total_steps(config, testbench_code is not None)

    async def _notify(result: StepResult) -> None:
        """Fire the step callback if registered."""
        nonlocal step_index
        step_index += 1
        if on_step_complete:
            try:
                await on_step_complete(pipeline_id, result, step_index, total_estimate)
            except Exception as cb_err:
                logger.warning(f"Step callback error: {cb_err}")

    # Prepare temp working directory for file-based steps
    work_dir = tempfile.mkdtemp(prefix="xylon-pipeline-")
    container_work_dir = f"/tmp/xylon-pipeline/{pipeline_id}"

    try:
        # Parse module name from RTL to use as filename.
        # Verilator names the executable after the top module (V<module>),
        # so the filename must match for the sandbox to find the binary.
        rtl_filename = _extract_module_filename(rtl_code)

        # Write files to local temp dir
        rtl_file_local = os.path.join(work_dir, rtl_filename)
        with open(rtl_file_local, "w", encoding="utf-8") as f:
            f.write(rtl_code)

        tb_file_local = None
        if testbench_code:
            tb_file_local = os.path.join(work_dir, "testbench.sv")
            with open(tb_file_local, "w", encoding="utf-8") as f:
                f.write(testbench_code)

        # Copy files into container
        container_rtl = f"{container_work_dir}/{rtl_filename}"
        container_tb = f"{container_work_dir}/testbench.sv" if tb_file_local else None
        _copy_to_container(sandbox.verilator_container, work_dir, container_work_dir)

        # Collect lint warnings for Phase B test plan context
        lint_warnings: list[str] = []

        # ── Step 1: Lint ──
        if config.lint_enabled:
            lint_result = await run_lint_step_from_string(rtl_code, sandbox)
            steps.append(lint_result)
            await _notify(lint_result)
            lint_warnings = lint_result.warnings
            logger.info(
                f"Pipeline {pipeline_id}: lint {lint_result.status.value} "
                f"({lint_result.duration_seconds:.2f}s)"
            )

            # Early exit if lint has hard errors
            if lint_result.status == StepStatus.FAILED:
                return _build_result(
                    pipeline_id, steps, final_coverage,
                    0, pipeline_start, success=False,
                )

        # ── Phase B: LLM-driven test plan + testbench generation ──
        test_plan: TestPlan | None = None
        iterations_used = 0

        if config.llm_provider and llm_gateway is not None and testbench_code is None:
            # Step B1: Generate test plan
            tp_result, test_plan = await run_test_plan_step(
                rtl_code, llm_gateway, lint_warnings=lint_warnings or None,
            )
            steps.append(tp_result)
            await _notify(tp_result)
            logger.info(
                f"Pipeline {pipeline_id}: test_plan {tp_result.status.value} "
                f"({tp_result.duration_seconds:.2f}s)"
            )

            if tp_result.status != StepStatus.PASSED or test_plan is None:
                return _build_result(
                    pipeline_id, steps, final_coverage,
                    0, pipeline_start, success=False,
                )

            # Step B2: Generate testbench
            tb_result, generated_tb = await run_testbench_gen_step(
                rtl_code, test_plan, llm_gateway,
            )
            steps.append(tb_result)
            await _notify(tb_result)
            logger.info(
                f"Pipeline {pipeline_id}: testbench_gen {tb_result.status.value} "
                f"({tb_result.duration_seconds:.2f}s)"
            )

            if tb_result.status != StepStatus.PASSED or generated_tb is None:
                return _build_result(
                    pipeline_id, steps, final_coverage,
                    0, pipeline_start, success=False,
                )

            # Write generated testbench to container
            testbench_code = generated_tb
            tb_file_local = os.path.join(work_dir, "testbench.sv")
            with open(tb_file_local, "w", encoding="utf-8") as f:
                f.write(testbench_code)
            container_tb = f"{container_work_dir}/testbench.sv"
            _copy_to_container(sandbox.verilator_container, work_dir, container_work_dir)

        # ── Step 2: Simulate ──
        if testbench_code and container_tb:
            sim_result = await run_simulate_step(
                container_rtl, container_tb, sandbox,
                timeout=config.simulation_timeout,
            )
            steps.append(sim_result)
            await _notify(sim_result)
            logger.info(
                f"Pipeline {pipeline_id}: simulate {sim_result.status.value} "
                f"({sim_result.duration_seconds:.2f}s)"
            )

            if sim_result.status in (StepStatus.FAILED, StepStatus.ERROR):
                return _build_result(
                    pipeline_id, steps, final_coverage,
                    0, pipeline_start, success=False,
                )

            # ── Step 3: Coverage ──
            cov_result, coverage_report = await run_coverage_step(
                container_rtl, container_tb, sandbox,
                timeout=config.simulation_timeout,
            )
            steps.append(cov_result)
            final_coverage = coverage_report
            await _notify(cov_result)
            cov_score = f"{coverage_report.score:.2%}" if coverage_report else "N/A"
            logger.info(
                f"Pipeline {pipeline_id}: coverage {cov_result.status.value} "
                f"(score={cov_score}) ({cov_result.duration_seconds:.2f}s)"
            )

            # ── Phase B: Coverage-Driven Iteration Loop (UVM2-inspired) ──
            if (
                config.llm_provider
                and llm_gateway is not None
                and test_plan is not None
                and coverage_report is not None
                and coverage_report.score < config.coverage_target
            ):
                iterations_used = await _run_coverage_iteration_loop(
                    pipeline_id=pipeline_id,
                    rtl_code=rtl_code,
                    testbench_code=testbench_code,
                    coverage_report=coverage_report,
                    coverage_goals=test_plan.coverage_goals,
                    config=config,
                    llm_gateway=llm_gateway,
                    sandbox=sandbox,
                    work_dir=work_dir,
                    container_work_dir=container_work_dir,
                    container_rtl=container_rtl,
                    steps=steps,
                    notify=_notify,
                )
                # Update final coverage to the latest
                final_coverage = _latest_coverage(steps)
        else:
            # No testbench — skip simulation and coverage
            skip_result = StepResult(
                step_name="simulate",
                status=StepStatus.SKIPPED,
                duration_seconds=0.0,
                output={"reason": "No testbench provided"},
                errors=[],
                warnings=["Simulation skipped: no testbench provided"],
            )
            steps.append(skip_result)
            await _notify(skip_result)

        # ── Optional: Synthesis Report (Yosys) ──
        if config.synthesis_enabled:
            synth_result = await run_synthesis_step(
                container_rtl, sandbox,
            )
            steps.append(synth_result)
            await _notify(synth_result)
            logger.info(
                f"Pipeline {pipeline_id}: synthesis {synth_result.status.value} "
                f"(gates={synth_result.output.get('gate_count', 'N/A')}) "
                f"({synth_result.duration_seconds:.2f}s)"
            )

        # Determine overall success
        all_passed = all(
            s.status in (StepStatus.PASSED, StepStatus.SKIPPED) for s in steps
        )

        return _build_result(
            pipeline_id, steps, final_coverage,
            iterations_used, pipeline_start, success=all_passed,
        )

    except Exception as e:
        logger.error(f"Pipeline {pipeline_id} failed: {e}")
        error_result = StepResult(
            step_name="pipeline",
            status=StepStatus.ERROR,
            duration_seconds=time.monotonic() - pipeline_start,
            output={},
            errors=[f"Pipeline error: {e}"],
            warnings=[],
        )
        steps.append(error_result)
        await _notify(error_result)
        return _build_result(
            pipeline_id, steps, final_coverage,
            0, pipeline_start, success=False,
        )

    finally:
        # Clean up local temp dir
        shutil.rmtree(work_dir, ignore_errors=True)
        # Clean up container temp dir
        try:
            subprocess.run(
                ["docker", "exec", sandbox.verilator_container,
                 "rm", "-rf", container_work_dir],
                capture_output=True, timeout=10, check=False,
            )
        except Exception:
            pass


def _extract_module_filename(rtl_code: str) -> str:
    """
    Parse the top module name from Verilog RTL and return a matching filename.

    Verilator names the compiled executable after the top module (V<module>),
    so the RTL filename must match for the sandbox to find the binary.
    Falls back to 'design.v' if no module declaration is found.
    """
    match = re.search(r"^\s*module\s+(\w+)", rtl_code, re.MULTILINE)
    if match:
        return f"{match.group(1)}.v"
    return "design.v"


def _estimate_total_steps(config: PipelineConfig, has_testbench: bool) -> int:
    """Estimate total pipeline steps for progress reporting."""
    count = 0
    if config.lint_enabled:
        count += 1  # lint
    if config.llm_provider and not has_testbench:
        count += 2  # test_plan + testbench_gen
        count += 2  # simulate + coverage (from generated testbench)
        # Estimate iteration steps (3 steps per iteration: improve + sim + cov)
        count += config.max_iterations * 3
    elif has_testbench:
        count += 2  # simulate + coverage
    else:
        count += 1  # skipped simulate
    if config.synthesis_enabled:
        count += 1  # synthesis
    return max(count, 1)


def _copy_to_container(
    container_name: str, local_dir: str, container_dir: str
) -> None:
    """Copy local directory contents into a Docker container."""
    subprocess.run(
        ["docker", "exec", container_name, "mkdir", "-p", container_dir],
        capture_output=True, timeout=10, check=False,
    )
    # docker cp copies directory contents
    subprocess.run(
        ["docker", "cp", f"{local_dir}/.", f"{container_name}:{container_dir}/"],
        capture_output=True, timeout=30, check=True,
    )


async def _run_coverage_iteration_loop(
    *,
    pipeline_id: str,
    rtl_code: str,
    testbench_code: str,
    coverage_report: CoverageReport,
    coverage_goals: dict[str, float],
    config: PipelineConfig,
    llm_gateway,
    sandbox: SandboxManager,
    work_dir: str,
    container_work_dir: str,
    container_rtl: str,
    steps: list[StepResult],
    notify,
) -> int:
    """
    UVM2-inspired coverage-driven iteration loop.

    Repeatedly improves testbench based on coverage gaps until:
    - Coverage target is met, OR
    - Max iterations reached, OR
    - Coverage stops improving (stall detection)

    Returns number of iterations completed.
    """
    current_tb = testbench_code
    current_cov = coverage_report
    container_tb = f"{container_work_dir}/testbench.sv"

    for iteration in range(1, config.max_iterations + 1):
        logger.info(
            f"Pipeline {pipeline_id}: iteration {iteration}/{config.max_iterations} "
            f"(current coverage: {current_cov.score:.2%}, target: {config.coverage_target:.2%})"
        )

        # Improve testbench based on coverage gaps
        improve_result, improved_tb = await run_testbench_improve_step(
            rtl_code, current_tb, current_cov, coverage_goals, llm_gateway,
        )
        steps.append(improve_result)
        await notify(improve_result)

        if improve_result.status != StepStatus.PASSED or improved_tb is None:
            logger.warning(f"Pipeline {pipeline_id}: testbench improvement failed at iteration {iteration}")
            return iteration

        # Write improved testbench to container
        current_tb = improved_tb
        tb_file_local = os.path.join(work_dir, "testbench.sv")
        with open(tb_file_local, "w", encoding="utf-8") as f:
            f.write(current_tb)
        _copy_to_container(sandbox.verilator_container, work_dir, container_work_dir)

        # Re-simulate
        sim_result = await run_simulate_step(
            container_rtl, container_tb, sandbox,
            timeout=config.simulation_timeout,
        )
        steps.append(sim_result)
        await notify(sim_result)

        if sim_result.status in (StepStatus.FAILED, StepStatus.ERROR):
            logger.warning(f"Pipeline {pipeline_id}: simulation failed at iteration {iteration}")
            return iteration

        # Re-measure coverage
        cov_result, new_cov = await run_coverage_step(
            container_rtl, container_tb, sandbox,
            timeout=config.simulation_timeout,
        )
        steps.append(cov_result)
        await notify(cov_result)

        if new_cov is None:
            logger.warning(f"Pipeline {pipeline_id}: coverage measurement failed at iteration {iteration}")
            return iteration

        prev_score = current_cov.score
        current_cov = new_cov

        logger.info(
            f"Pipeline {pipeline_id}: iteration {iteration} coverage "
            f"{prev_score:.2%} -> {current_cov.score:.2%}"
        )

        # Check if target met
        if current_cov.score >= config.coverage_target:
            logger.info(
                f"Pipeline {pipeline_id}: coverage target met at iteration {iteration} "
                f"({current_cov.score:.2%} >= {config.coverage_target:.2%})"
            )
            return iteration

        # Stall detection: if coverage didn't improve by at least 1%, stop
        if current_cov.score <= prev_score + 0.01:
            logger.info(
                f"Pipeline {pipeline_id}: coverage stalled at iteration {iteration} "
                f"({prev_score:.2%} -> {current_cov.score:.2%})"
            )
            stall_result = StepResult(
                step_name="iteration_stall",
                status=StepStatus.PASSED,
                duration_seconds=0.0,
                output={
                    "reason": "Coverage improvement stalled",
                    "prev_score": prev_score,
                    "current_score": current_cov.score,
                    "iteration": iteration,
                },
                errors=[],
                warnings=[f"Coverage stalled at {current_cov.score:.2%} after {iteration} iterations"],
            )
            steps.append(stall_result)
            await notify(stall_result)
            return iteration

    return config.max_iterations


def _latest_coverage(steps: list[StepResult]) -> CoverageReport | None:
    """Extract the latest CoverageReport from step outputs."""
    for step in reversed(steps):
        if step.step_name == "coverage" and step.status == StepStatus.PASSED:
            output = step.output
            if "line_coverage" in output:
                return CoverageReport(
                    line_coverage=output["line_coverage"],
                    toggle_coverage=output["toggle_coverage"],
                    branch_coverage=output["branch_coverage"],
                    score=output.get("coverage_score", 0.0),
                    uncovered_lines=output.get("uncovered_lines", []),
                    raw_output=output.get("raw_output", ""),
                )
    return None


def _build_result(
    pipeline_id: str,
    steps: list[StepResult],
    final_coverage: CoverageReport | None,
    iterations: int,
    start_time: float,
    success: bool,
) -> PipelineResult:
    """Build the final PipelineResult."""
    return PipelineResult(
        pipeline_id=pipeline_id,
        steps=steps,
        final_coverage=final_coverage,
        iterations_used=iterations,
        total_duration_seconds=time.monotonic() - start_time,
        success=success,
    )
