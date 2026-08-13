"""
XylonStudio CLI.

Run verification pipeline from the command line.

Usage:
    python -m agent.cli run examples/adder/adder_8bit.v
    python -m agent.cli run design.v --testbench tb.cpp
    python -m agent.cli run design.v --synthesis
"""

import argparse
import asyncio
from pathlib import Path
import shlex
import sys
import time

from agent.pipeline.artifacts import ArtifactIntegrityError, load_rerun_manifest
from agent.pipeline.models import PipelineConfig
from agent.pipeline.runner import run_pipeline


def _format_coverage_value(value: float | None) -> str:
    """Render unavailable evidence distinctly from a measured zero."""
    return f"{value:.0%}" if value is not None else "Unavailable"


RECOVERY_GUIDANCE = {
    "collect_coverage_evidence": "Collect parseable coverage evidence and rerun.",
    "start_pinned_runtime": "Start and verify the pinned local EDA runtime.",
    "repair_toolchain": "Repair the local EDA toolchain, then rerun.",
    "correct_testbench": "Correct the testbench build or execution error.",
    "correct_rtl": "Correct the RTL error reported by the failing gate.",
    "inspect_failing_check": "Inspect the failing self-check and simulator output.",
    "inspect_synthesis_report": "Inspect the raw Yosys report for format or tool drift.",
    "repair_artifact_storage": "Repair artifact storage permissions or capacity.",
    "rerun_when_ready": "Rerun when you are ready.",
}


def main():
    parser = argparse.ArgumentParser(
        prog="xylon",
        description="XylonStudio Chip Verification Pipeline",
    )
    sub = parser.add_subparsers(dest="command")

    # run command
    run_parser = sub.add_parser("run", help="Run verification pipeline on RTL file")
    run_parser.add_argument("rtl_file", help="Path to Verilog RTL file")
    run_parser.add_argument("--testbench", "-t", help="Path to C++ testbench file")
    run_parser.add_argument("--coverage-target", type=float, default=0.80, help="Coverage target (0.0-1.0)")
    run_parser.add_argument("--synthesis", action="store_true", help="Run Yosys synthesis after verification")
    run_parser.add_argument("--timeout", type=int, default=300, help="Simulation timeout in seconds")

    rerun_parser = sub.add_parser(
        "rerun",
        help="Reproduce a saved pipeline run from its integrity-checked manifest",
    )
    rerun_parser.add_argument(
        "manifest",
        help="Path to a saved manifest.json",
    )

    args = parser.parse_args()

    if args.command == "run":
        asyncio.run(run_command(args))
    elif args.command == "rerun":
        asyncio.run(rerun_command(args))
    else:
        parser.print_help()
        sys.exit(1)


async def run_command(args):
    # Read RTL file
    try:
        with open(args.rtl_file, encoding='utf-8') as f:
            rtl_code = f.read()
    except FileNotFoundError:
        print(f"Error: RTL file not found: {args.rtl_file}")
        sys.exit(1)

    # Read testbench if provided
    testbench_code = None
    if args.testbench:
        try:
            with open(args.testbench, encoding='utf-8') as f:
                testbench_code = f.read()
        except FileNotFoundError:
            print(f"Error: Testbench file not found: {args.testbench}")
            sys.exit(1)

    # Build config
    config = PipelineConfig(
        coverage_target=args.coverage_target,
        simulation_timeout=args.timeout,
        synthesis_enabled=args.synthesis,
    )

    # Progress callback
    async def on_step_started(step_name: str):
        print(f"  [{step_name}] running...", end="", flush=True)

    async def on_step_complete(step):
        status = step.status.value.upper()
        duration = f"{step.duration_seconds:.1f}s"
        print(f"\r  [{step.step_name}] {status} ({duration})")

        # Show extra info for key steps
        if step.step_name == "coverage" and step.output:
            print(
                "    "
                f"line={_format_coverage_value(step.output.get('line_coverage'))} "
                f"score={_format_coverage_value(step.output.get('score'))}"
            )
        elif step.step_name == "synthesis" and step.output:
            cells = step.output.get("cells", {})
            total = step.output.get("gate_count")
            print(f"    {total} cells, {step.output.get('wires', '?')} wires")

    # Run pipeline
    start = time.monotonic()
    requested_mode = "provided_testbench" if testbench_code else "lint_only"
    print(f"XylonStudio Pipeline: {args.rtl_file}")
    print(f"  requested mode: {requested_mode}")
    print()

    result = await run_pipeline(
        rtl_code=rtl_code,
        testbench_code=testbench_code,
        config=config,
        on_step_complete=on_step_complete,
        on_step_started=on_step_started,
    )

    # Summary
    total = time.monotonic() - start
    print()
    print(f"outcome: {result.outcome.value}")
    print(f"  mode: {result.mode.value}")
    print(f"  duration: {total:.1f}s ({result.iterations_used} iterations)")

    if result.final_coverage:
        c = result.final_coverage
        print(
            "  coverage: "
            f"line={_format_coverage_value(c.line_coverage)} "
            f"toggle={_format_coverage_value(c.toggle_coverage)} "
            f"branch={_format_coverage_value(c.branch_coverage)} "
            f"score={_format_coverage_value(c.score)}"
        )

    failed_step = next(
        (
            step
            for step in result.steps
            if step.status.value in {"failed", "error"}
        ),
        None,
    )
    if failed_step is not None:
        if failed_step.errors:
            print(f"  reason: {failed_step.errors[0]}")
        if failed_step.recovery_code:
            guidance = RECOVERY_GUIDANCE.get(
                failed_step.recovery_code,
                "Follow the recovery action and rerun.",
            )
            print(f"  next action: {failed_step.recovery_code} — {guidance}")

    if result.artifacts is not None:
        manifest = (
            Path(config.artifact_root)
            / result.artifacts.run_directory
            / result.artifacts.manifest_path
        )
        print(f"  artifacts: {manifest}")
        rerun = [
            *result.artifacts.rerun_argv[:-1],
            str(manifest),
        ]
        print(f"  rerun: {shlex.join(rerun)}")

    sys.exit(0 if result.success else 1)


async def rerun_command(args):
    """Verify a bundle, replay its frozen inputs, and detect outcome drift."""
    try:
        replay = load_rerun_manifest(args.manifest)
    except (ArtifactIntegrityError, OSError, ValueError) as error:
        print(f"Artifact verification failed: {error}")
        sys.exit(1)

    print(f"XylonStudio Replay: {replay.source_pipeline_id}")
    print(f"  expected outcome: {replay.expected_outcome.value}")
    result = await run_pipeline(
        rtl_code=replay.rtl_code,
        testbench_code=replay.testbench_code,
        config=replay.config,
    )

    if result.outcome == replay.expected_outcome:
        print(
            f"REPRODUCED source={replay.source_pipeline_id} "
            f"replay={result.pipeline_id} outcome={result.outcome.value}"
        )
        sys.exit(0)

    print(
        f"DRIFTED source={replay.source_pipeline_id} "
        f"replay={result.pipeline_id} expected={replay.expected_outcome.value} "
        f"actual={result.outcome.value}"
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
