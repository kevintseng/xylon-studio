#!/usr/bin/env python3
"""
XylonStudio Complete Workflow Example.

Demonstrates the full chip design flow:
1. Design Dragon: Generate RTL from specification
2. Verification Dragon: Generate testbench and verify
3. Results analysis

Usage:
    python3 examples/full_workflow_example.py
"""

import sys
import os

# Add project root to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from agent.models import DesignSpec
from agent.dragons import DesignDragon, VerificationDragon


def main():
    """Run complete workflow."""

    print("=" * 70)
    print("XylonStudio Complete Workflow Example")
    print("=" * 70)

    # Configuration
    llm_endpoint = os.getenv('LLM_ENDPOINT', 'http://localhost:8000')

    print(f"\nLLM Endpoint: {llm_endpoint}")
    print()

    # ========== Step 1: Design Dragon ==========
    print("[Step 1/2] Design Dragon - RTL Generation")
    print("-" * 70)

    # Create design specification
    spec = DesignSpec(
        description="8-bit ripple carry adder with overflow detection",
        target_freq="100 MHz",
        module_name="adder_8bit",
        max_area="1000 um²",
        max_power="10 mW"
    )

    print(f"Specification:")
    print(f"  Description: {spec.description}")
    print(f"  Target Freq: {spec.target_freq}")
    print(f"  Module Name: {spec.module_name}")
    print()

    try:
        # Initialize Design Dragon
        design_dragon = DesignDragon(llm_endpoint=llm_endpoint)
        print("Generating RTL...")

        # Generate RTL
        rtl = design_dragon.breathe_rtl(spec)

        # Display results
        print(f"\n✓ RTL Generated Successfully!")
        print(f"  Module: {rtl.module_name}")
        print(f"  Lines of Code: {rtl.lines_of_code}")
        print(f"  Quality Score: {rtl.quality_score:.2f}")
        print(f"  File: {rtl.file_path}")

        if rtl.lint_warnings:
            print(f"  Warnings: {len(rtl.lint_warnings)}")
        else:
            print("  Warnings: None")

        # Show RTL preview
        print(f"\nRTL Preview:")
        print("-" * 70)
        rtl_lines = rtl.code.split('\n')
        for i, line in enumerate(rtl_lines[:20], 1):  # First 20 lines
            print(f"{i:3d} | {line}")
        if len(rtl_lines) > 20:
            print(f"... ({len(rtl_lines) - 20} more lines)")
        print("-" * 70)

        # Get Design Dragon metrics
        design_metrics = design_dragon.get_metrics()
        print(f"\nDesign Dragon Metrics:")
        print(f"  Duration: {design_metrics.duration_seconds:.2f}s")
        print(f"  LLM Calls: {design_metrics.llm_calls}")
        print(f"  Tokens Used: {design_metrics.llm_total_tokens}")

    except Exception as e:
        print(f"\n✗ Design Dragon failed: {e}")
        return 1

    # ========== Step 2: Verification Dragon ==========
    print("\n" + "=" * 70)
    print("[Step 2/2] Verification Dragon - Testbench & Verification")
    print("-" * 70)

    try:
        # Initialize Verification Dragon
        verification_dragon = VerificationDragon(llm_endpoint=llm_endpoint)
        print("Generating testbench and running verification...")

        # Run verification
        report = verification_dragon.verify(rtl)

        # Display results
        print(f"\n✓ Verification Complete!")
        print(f"  Testbench: {report.testbench_file_path}")
        print(f"  Tests Passed: {report.test_cases_passed}")
        print(f"  Tests Failed: {report.test_cases_failed}")
        print(f"  Code Coverage: {report.code_coverage * 100:.1f}%")

        if report.waveform_file_path:
            print(f"  Waveform: {report.waveform_file_path}")

        if report.errors:
            print(f"\n  Errors Found:")
            for error in report.errors[:5]:  # First 5 errors
                print(f"    - {error}")

        # Get Verification Dragon metrics
        verification_metrics = verification_dragon.get_metrics()
        print(f"\nVerification Dragon Metrics:")
        print(f"  Duration: {verification_metrics.duration_seconds:.2f}s")
        print(f"  LLM Calls: {verification_metrics.llm_calls}")
        print(f"  Quality Score: {verification_metrics.quality_score:.2f}")

    except Exception as e:
        print(f"\n✗ Verification Dragon failed: {e}")
        return 1

    # ========== Summary ==========
    print("\n" + "=" * 70)
    print("WORKFLOW SUMMARY")
    print("=" * 70)

    total_time = design_metrics.duration_seconds + verification_metrics.duration_seconds
    total_llm_calls = design_metrics.llm_calls + verification_metrics.llm_calls
    total_tokens = design_metrics.llm_total_tokens + verification_metrics.llm_total_tokens

    print(f"\nModule: {rtl.module_name}")
    print(f"  RTL Quality:    {rtl.quality_score:.2f}")
    print(f"  Test Coverage:  {report.code_coverage * 100:.1f}%")
    print(f"  Tests Passed:   {report.test_cases_passed}")
    print(f"  Tests Failed:   {report.test_cases_failed}")

    print(f"\nPerformance:")
    print(f"  Total Time:     {total_time:.2f}s")
    print(f"  LLM Calls:      {total_llm_calls}")
    print(f"  Tokens Used:    {total_tokens}")

    # Overall status
    all_tests_passed = report.test_cases_failed == 0
    good_coverage = report.code_coverage >= 0.8
    high_quality = rtl.quality_score >= 0.8

    print(f"\nOverall Status:")
    print(f"  RTL Quality:    {'✓ Pass' if high_quality else '✗ Needs Improvement'}")
    print(f"  Test Coverage:  {'✓ Pass' if good_coverage else '✗ Needs Improvement'}")
    print(f"  All Tests:      {'✓ Pass' if all_tests_passed else '✗ Failed'}")

    if all_tests_passed and good_coverage and high_quality:
        print(f"\n🎉 SUCCESS: Design ready for next stage (Optimization Dragon)")
        return 0
    else:
        print(f"\n⚠️  WARNING: Design needs improvement before continuing")
        return 1

    print("=" * 70)


if __name__ == '__main__':
    try:
        exit_code = main()
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\n\nWorkflow interrupted by user.")
        sys.exit(1)
    except Exception as e:
        print(f"\n✗ Workflow failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
