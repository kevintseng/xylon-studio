"""Sequential pipeline runner."""

import asyncio
import logging
import tempfile
import uuid
from typing import Awaitable, Callable, Optional

from agent.core.llm_provider import LLMProvider, LLMProviderError, create_llm_provider
from agent.pipeline.models import PipelineConfig, PipelineResult, StepStatus
from agent.pipeline.steps.coverage import run_coverage_step
from agent.pipeline.steps.improve import improve_testbench_step
from agent.pipeline.steps.lint import run_lint_step
from agent.pipeline.steps.simulate import run_simulate_step
from agent.pipeline.steps.test_plan import run_test_plan_step
from agent.pipeline.steps.testbench_gen import run_testbench_gen_step
from agent.sandbox.manager import SandboxManager

logger = logging.getLogger(__name__)


StepCallback = Optional[Callable[["StepResult"], Awaitable[None]]]


async def run_pipeline(
    rtl_code: str,
    testbench_code: Optional[str] = None,
    config: Optional[PipelineConfig] = None,
    llm_provider: Optional[LLMProvider] = None,
    on_step_complete: StepCallback = None,
) -> PipelineResult:
    """
    Run verification pipeline sequentially.

    Phase A (lint → simulate → coverage):
    - Requires pre-provided testbench
    - Single pass simulation

    Phase B (lint → test_plan → testbench_gen → iterate → coverage):
    - Generates testbench from RTL via LLM
    - Iterates if coverage below target
    - Improves testbench based on coverage gaps

    Args:
        rtl_code: Verilog RTL code as string
        testbench_code: Optional testbench code as string (Phase A)
        config: Pipeline configuration (uses defaults if None)
        llm_provider: Optional LLM provider (Phase B)
        on_step_complete: Optional async callback invoked after each step

    Returns:
        PipelineResult with all step results
    """
    if config is None:
        config = PipelineConfig()

    pipeline_id = str(uuid.uuid4())
    logger.info(f"[PIPELINE-{pipeline_id}] Starting pipeline execution")

    # Create temp directory for files
    work_dir = tempfile.mkdtemp(prefix="xylon-pipeline-")
    rtl_file = f"{work_dir}/design.v"
    tb_file = f"{work_dir}/testbench.sv"

    steps = []
    final_coverage = None
    test_plan = None
    iterations_used = 0
    start_time = None
    current_testbench = testbench_code

    async def _emit(step_result):
        if on_step_complete:
            await on_step_complete(step_result)

    try:
        # Write RTL to temp file
        with open(rtl_file, 'w', encoding='utf-8') as f:
            f.write(rtl_code)
        logger.info(f"[PIPELINE-{pipeline_id}] RTL file created: {rtl_file}")

        # Initialize sandbox
        sandbox = SandboxManager()

        # Step 1: Lint
        start_time = asyncio.get_event_loop().time()
        logger.info(f"[PIPELINE-{pipeline_id}] Running lint step...")
        lint_result = await run_lint_step(rtl_file, sandbox)
        steps.append(lint_result)
        await _emit(lint_result)

        # Check if lint passed
        if lint_result.status != StepStatus.PASSED:
            logger.warning(
                f"[PIPELINE-{pipeline_id}] Lint failed, exiting"
            )
            return _finalize_result(
                pipeline_id,
                steps,
                final_coverage,
                start_time,
                test_plan,
                iterations_used,
            )

        # Phase B: LLM-driven testbench generation and iteration
        if config.generate_testbench:
            logger.info(f"[PIPELINE-{pipeline_id}] Starting Phase B (LLM-driven flow)")

            # Validate LLM config
            if not config.llm_provider:
                logger.error(f"[PIPELINE-{pipeline_id}] Phase B enabled but llm_provider not configured")
                return _finalize_result(
                    pipeline_id,
                    steps,
                    final_coverage,
                    start_time,
                    test_plan,
                    iterations_used,
                    error="llm_provider required for Phase B",
                )

            try:
                # Use injected LLM provider if available, otherwise create from config
                if llm_provider is None:
                    llm_provider_config = config.llm_provider
                    llm_type = llm_provider_config.get("type", "vllm")

                    logger.info(f"[PIPELINE-{pipeline_id}] Initializing LLM provider: {llm_type}")
                    llm_provider = create_llm_provider(llm_provider_config)
                    logger.info(f"[PIPELINE-{pipeline_id}] LLM provider initialized: {llm_type}")
                else:
                    logger.info(f"[PIPELINE-{pipeline_id}] Using injected LLM provider")

            except Exception as e:
                logger.error(f"[PIPELINE-{pipeline_id}] LLM initialization failed: {e}")
                return _finalize_result(
                    pipeline_id,
                    steps,
                    final_coverage,
                    start_time,
                    test_plan,
                    iterations_used,
                    error=str(e),
                )

            # Step 2: Test Plan Generation
            logger.info(f"[PIPELINE-{pipeline_id}] Running test plan generation...")
            lint_warnings = lint_result.output.get("warnings", []) if lint_result.output else []
            test_plan_result, test_plan = await run_test_plan_step(
                rtl_code=rtl_code,
                llm_gateway=llm_provider,
                lint_warnings=lint_warnings,
            )
            steps.append(test_plan_result)
            await _emit(test_plan_result)

            if test_plan_result.status != StepStatus.PASSED:
                logger.error(f"[PIPELINE-{pipeline_id}] Test plan generation failed")
                return _finalize_result(
                    pipeline_id,
                    steps,
                    final_coverage,
                    start_time,
                    test_plan,
                    iterations_used,
                )

            # Step 3: Testbench Generation
            logger.info(f"[PIPELINE-{pipeline_id}] Running testbench generation...")
            testbench_result, generated_testbench = await run_testbench_gen_step(
                rtl_code,
                test_plan,
                llm_provider,
            )
            steps.append(testbench_result)
            await _emit(testbench_result)

            if testbench_result.status != StepStatus.PASSED:
                logger.error(f"[PIPELINE-{pipeline_id}] Testbench generation failed")
                return _finalize_result(
                    pipeline_id,
                    steps,
                    final_coverage,
                    start_time,
                    test_plan,
                    iterations_used,
                )

            current_testbench = generated_testbench

            # Step 4: Coverage-driven iteration loop
            logger.info(f"[PIPELINE-{pipeline_id}] Starting iteration loop (max {config.max_iterations} iterations)")
            for iteration in range(config.max_iterations):
                iterations_used = iteration + 1
                logger.info(f"[PIPELINE-{pipeline_id}] Iteration {iterations_used}/{config.max_iterations}")

                # Write current testbench to file
                with open(tb_file, 'w', encoding='utf-8') as f:
                    f.write(current_testbench)

                # Run simulation
                logger.info(f"[PIPELINE-{pipeline_id}] Running simulation (iteration {iterations_used})...")
                simulate_result = await run_simulate_step(
                    rtl_file,
                    tb_file,
                    sandbox,
                    timeout=config.simulation_timeout,
                )
                steps.append(simulate_result)
                await _emit(simulate_result)

                if simulate_result.status != StepStatus.PASSED:
                    logger.warning(
                        f"[PIPELINE-{pipeline_id}] Simulation failed at iteration {iterations_used}"
                    )
                    break

                # Run coverage
                logger.info(f"[PIPELINE-{pipeline_id}] Running coverage (iteration {iterations_used})...")
                coverage_result, coverage_report = await run_coverage_step(
                    rtl_file,
                    tb_file,
                    sandbox,
                    timeout=config.simulation_timeout,
                )
                steps.append(coverage_result)
                await _emit(coverage_result)
                final_coverage = coverage_report

                logger.info(
                    f"[PIPELINE-{pipeline_id}] Coverage score (iter {iterations_used}): {coverage_report.score*100:.1f}%"
                )

                # Check if target met
                if coverage_report.score >= config.coverage_target:
                    logger.info(
                        f"[PIPELINE-{pipeline_id}] Coverage target {config.coverage_target*100:.1f}% met at iteration {iterations_used}"
                    )
                    break

                # If not met and iterations remaining, improve testbench
                if iteration < config.max_iterations - 1:
                    logger.info(
                        f"[PIPELINE-{pipeline_id}] Coverage {coverage_report.score*100:.1f}% below target {config.coverage_target*100:.1f}%, improving testbench..."
                    )
                    improve_result, improved_testbench = await improve_testbench_step(
                        rtl_code,
                        current_testbench,
                        coverage_report,
                        config.coverage_target,
                        test_plan.module_name,
                        llm=llm_provider,
                        iteration=iterations_used,
                    )
                    steps.append(improve_result)
                    await _emit(improve_result)

                    if improve_result.status != StepStatus.PASSED:
                        logger.error(
                            f"[PIPELINE-{pipeline_id}] Testbench improvement failed at iteration {iterations_used}"
                        )
                        break

                    current_testbench = improved_testbench
                else:
                    logger.warning(
                        f"[PIPELINE-{pipeline_id}] Max iterations reached, coverage {coverage_report.score*100:.1f}% below target"
                    )

        # Phase A: User-provided testbench (single pass)
        elif testbench_code:
            logger.info(f"[PIPELINE-{pipeline_id}] Starting Phase A (user-provided testbench)")
            iterations_used = 1

            # Write testbench to file
            with open(tb_file, 'w', encoding='utf-8') as f:
                f.write(testbench_code)
            logger.info(f"[PIPELINE-{pipeline_id}] Testbench file created: {tb_file}")

            # Step 2: Simulate
            logger.info(f"[PIPELINE-{pipeline_id}] Running simulation step...")
            simulate_result = await run_simulate_step(
                rtl_file,
                tb_file,
                sandbox,
                timeout=config.simulation_timeout,
            )
            steps.append(simulate_result)

            # Check if simulation passed
            if simulate_result.status != StepStatus.PASSED:
                logger.warning(
                    f"[PIPELINE-{pipeline_id}] Simulation failed, skipping coverage"
                )
                return _finalize_result(
                    pipeline_id,
                    steps,
                    final_coverage,
                    start_time,
                    test_plan,
                    iterations_used,
                )

            # Step 3: Coverage
            logger.info(f"[PIPELINE-{pipeline_id}] Running coverage step...")
            coverage_result, coverage_report = await run_coverage_step(
                rtl_file,
                tb_file,
                sandbox,
                timeout=config.simulation_timeout,
            )
            steps.append(coverage_result)
            final_coverage = coverage_report

            logger.info(
                f"[PIPELINE-{pipeline_id}] Coverage score: {coverage_report.score*100:.1f}%"
            )

        else:
            logger.info(f"[PIPELINE-{pipeline_id}] No testbench provided and Phase B not enabled, skipping simulate/coverage")

        return _finalize_result(
            pipeline_id,
            steps,
            final_coverage,
            start_time,
            test_plan,
            iterations_used,
        )

    except Exception as e:
        logger.error(f"[PIPELINE-{pipeline_id}] Fatal error: {e}")
        return _finalize_result(
            pipeline_id,
            steps,
            final_coverage,
            start_time,
            test_plan,
            iterations_used,
            error=str(e),
        )

    finally:
        # Cleanup temp files
        import shutil
        try:
            shutil.rmtree(work_dir, ignore_errors=True)
            logger.info(f"[PIPELINE-{pipeline_id}] Cleanup complete: {work_dir}")
        except Exception as e:
            logger.warning(f"[PIPELINE-{pipeline_id}] Cleanup failed: {e}")


def _finalize_result(
    pipeline_id: str,
    steps: list,
    final_coverage,
    start_time: Optional[float],
    test_plan=None,
    iterations_used: int = 1,
    error: Optional[str] = None,
) -> PipelineResult:
    """
    Finalize pipeline result.

    Args:
        pipeline_id: Pipeline execution ID
        steps: List of StepResult objects
        final_coverage: Final CoverageReport or None
        start_time: Pipeline start time
        test_plan: Generated TestPlan from Phase B (or None for Phase A)
        iterations_used: Number of iterations completed
        error: Optional error message

    Returns:
        Completed PipelineResult
    """
    end_time = asyncio.get_event_loop().time()
    duration = (end_time - start_time) if start_time else 0

    # Determine overall success
    success = all(s.status == StepStatus.PASSED for s in steps) and error is None

    if error:
        logger.error(f"[PIPELINE-{pipeline_id}] Pipeline failed: {error}")
    else:
        logger.info(
            f"[PIPELINE-{pipeline_id}] Pipeline complete: "
            f"success={success}, duration={duration:.2f}s, iterations={iterations_used}"
        )

    return PipelineResult(
        pipeline_id=pipeline_id,
        steps=steps,
        final_coverage=final_coverage,
        test_plan=test_plan,
        iterations_used=iterations_used,
        total_duration_seconds=duration,
        success=success,
    )
