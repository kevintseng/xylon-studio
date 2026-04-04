"""
XylonStudio CLI.

Run verification pipeline from the command line.

Usage:
    python -m agent.cli run examples/adder/adder_8bit.v
    python -m agent.cli run design.v --testbench tb.cpp
    python -m agent.cli run design.v --llm ollama --model qwen2.5-coder:32b
    python -m agent.cli run design.v --synthesis
"""

import argparse
import asyncio
import sys
import time

from agent.pipeline.models import PipelineConfig
from agent.pipeline.runner import run_pipeline


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
    run_parser.add_argument("--max-iterations", type=int, default=3, help="Max coverage improvement iterations")
    run_parser.add_argument("--synthesis", action="store_true", help="Run Yosys synthesis after verification")
    run_parser.add_argument("--llm", help="LLM provider type (ollama, vllm)")
    run_parser.add_argument("--llm-endpoint", default="http://localhost:11434", help="LLM endpoint URL")
    run_parser.add_argument("--model", default="qwen2.5-coder:32b", help="LLM model name")
    run_parser.add_argument("--timeout", type=int, default=300, help="LLM timeout in seconds")

    args = parser.parse_args()

    if args.command != "run":
        parser.print_help()
        sys.exit(1)

    asyncio.run(run_command(args))


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
    llm_config = None
    llm_provider = None
    generate_llm = False

    if args.llm:
        from agent.core.llm_provider import create_llm_provider
        llm_config = {
            "type": args.llm,
            "endpoint": args.llm_endpoint,
            "model": args.model,
            "timeout": args.timeout,
        }
        llm_provider = create_llm_provider(llm_config)
        generate_llm = True

    config = PipelineConfig(
        coverage_target=args.coverage_target,
        max_iterations=args.max_iterations,
        synthesis_enabled=args.synthesis,
        llm_provider=llm_config,
        generate_testbench=generate_llm,
        generate_test_plan=generate_llm,
    )

    # Progress callback
    async def on_step_started(step_name: str):
        print(f"  [{step_name}] running...", end="", flush=True)

    async def on_step_complete(step):
        status = step.status.value.upper()
        duration = f"{step.duration_seconds:.1f}s"
        print(f"\r  [{step.step_name}] {status} ({duration})")

        # Show extra info for key steps
        if step.step_name == "test_plan" and step.output:
            count = step.output.get("scenario_count", "?")
            print(f"    {count} test scenarios generated")
        elif step.step_name == "coverage" and step.output:
            print(f"    line={step.output.get('line_coverage', '?')} score={step.output.get('score', '?')}")
        elif step.step_name == "synthesis" and step.output:
            cells = step.output.get("cells", {})
            total = sum(cells.values()) if isinstance(cells, dict) else cells
            print(f"    {total} gates, {step.output.get('wires', '?')} wires")
        elif step.step_name == "debug" and step.output:
            print(f"    {step.output.get('summary', '')}")
            fixes = step.output.get("fix_suggestions", [])
            if isinstance(fixes, list):
                for fix in fixes[:2]:
                    print(f"    -> {fix}")

    # Run pipeline
    start = time.monotonic()
    print(f"XylonStudio Pipeline: {args.rtl_file}")
    print(f"  mode: {'Phase B (LLM)' if generate_llm else 'Phase A (user testbench)' if testbench_code else 'lint only'}")
    print()

    result = await run_pipeline(
        rtl_code=rtl_code,
        testbench_code=testbench_code,
        config=config,
        llm_provider=llm_provider,
        on_step_complete=on_step_complete,
        on_step_started=on_step_started,
    )

    # Summary
    total = time.monotonic() - start
    print()
    if result.success:
        print(f"PASSED ({total:.1f}s, {result.iterations_used} iterations)")
    else:
        print(f"FAILED ({total:.1f}s, {result.iterations_used} iterations)")

    if result.final_coverage:
        c = result.final_coverage
        print(f"  coverage: line={c.line_coverage:.0%} toggle={c.toggle_coverage:.0%} branch={c.branch_coverage:.0%} score={c.score:.0%}")

    sys.exit(0 if result.success else 1)


if __name__ == "__main__":
    main()
