"""
Synthesis Report Step.

Runs Yosys synthesis on RTL to produce structural cell statistics.
This step is optional (controlled by config.synthesis_enabled).
"""

import logging
import re
import time

from agent.pipeline.models import FailureKind, StepResult, StepStatus

logger = logging.getLogger(__name__)

STEP_NAME = "synthesis"


async def run_synthesis_step(
    rtl_file: str,
    sandbox,
    timeout: int = 600,
) -> StepResult:
    """
    Run Yosys synthesis on RTL and produce a resource report.

    Args:
        rtl_file: Path to Verilog file (inside container)
        sandbox: SandboxManager instance
        timeout: Synthesis timeout in seconds

    Returns:
        StepResult with structural cell and wire counts. This is not timing evidence.
    """
    logger.info(f"Synthesis step starting: {rtl_file}")
    start = time.monotonic()

    try:
        import asyncio
        with open(rtl_file, encoding='utf-8') as f:
            rtl_code = f.read()

        result = await asyncio.to_thread(
            sandbox.synthesize_verilog_string,
            rtl_code,
        )
        duration = time.monotonic() - start

        if not result.get("success", False):
            errors = []
            stderr = result.get("stderr", "")
            raw_failure_kind = result.get("failure_kind")
            failure_kind = (
                FailureKind(raw_failure_kind)
                if raw_failure_kind
                else FailureKind.CONFIGURATION
            )
            recovery_code = (
                "repair_toolchain"
                if failure_kind == FailureKind.INFRASTRUCTURE
                else "correct_rtl"
            )
            if stderr:
                # Extract Yosys error lines
                for line in stderr.split("\n"):
                    if "ERROR" in line or "error" in line.lower():
                        errors.append(line.strip())
            if failure_kind == FailureKind.INFRASTRUCTURE and not errors and stderr:
                errors.append(stderr.strip())
            if not errors:
                errors = ["Synthesis failed (no specific error captured)"]

            return StepResult(
                step_name=STEP_NAME,
                status=StepStatus.FAILED,
                duration_seconds=duration,
                output={
                    "stdout": result.get("stdout", "")[:2000],
                    "stderr": stderr[:2000],
                },
                errors=errors,
                warnings=[],
                failure_kind=failure_kind,
                recovery_code=recovery_code,
            )

        # Parse detailed stats from Yosys output
        stdout = result.get("stdout", "")
        stats = _parse_yosys_stats(stdout)
        if not stats["statistics_found"]:
            return StepResult(
                step_name=STEP_NAME,
                status=StepStatus.FAILED,
                duration_seconds=duration,
                output={"stdout": stdout[-2000:]},
                errors=["Yosys completed without parseable module statistics"],
                warnings=[],
                failure_kind=FailureKind.INCONCLUSIVE,
                recovery_code="inspect_synthesis_report",
            )

        cell_count = stats["cell_count"]

        return StepResult(
            step_name=STEP_NAME,
            status=StepStatus.PASSED,
            duration_seconds=duration,
            output={
                "cell_count": cell_count,
                "cells": stats.get("cells", {}),
                "wires": stats.get("wires", 0),
                "wire_bits": stats.get("wire_bits", 0),
                "memories": stats.get("memories", 0),
                "memory_bits": stats.get("memory_bits", 0),
            },
            errors=[],
            warnings=_synthesis_warnings(cell_count, stats),
        )

    except Exception as e:
        duration = time.monotonic() - start
        logger.error(f"Synthesis step error: {e}")
        return StepResult(
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            duration_seconds=duration,
            output={},
            errors=[f"Synthesis error: {e}"],
            warnings=[],
            failure_kind=FailureKind.INFRASTRUCTURE,
            recovery_code="repair_toolchain",
        )


def _parse_yosys_stats(stdout: str) -> dict:
    """
    Parse Yosys 'stat' command output.

    Example Yosys stat output:
        Number of wires:              15
        Number of wire bits:          42
        Number of memories:            0
        Number of memory bits:         0
        Number of cells:              12
          $_AND_                        3
          $_NOT_                        2
          $_OR_                         4
          $_XOR_                        3
    """
    stats: dict = {
        "cells": {},
        "cell_count": 0,
        "wires": 0,
        "wire_bits": 0,
        "memories": 0,
        "memory_bits": 0,
        "statistics_found": False,
    }

    for raw_line in stdout.split("\n"):
        line = raw_line.strip()

        # Parse numeric stats
        wires_match = re.match(r"(\d+)\s+wires$", line)
        if wires_match:
            stats["wires"] = int(wires_match.group(1))

        wire_bits_match = re.match(r"(\d+)\s+wire bits$", line)
        if wire_bits_match:
            stats["wire_bits"] = int(wire_bits_match.group(1))

        mem_match = re.match(r"(\d+)\s+memories$", line)
        if mem_match:
            stats["memories"] = int(mem_match.group(1))

        mem_bits_match = re.match(r"(\d+)\s+memory bits$", line)
        if mem_bits_match:
            stats["memory_bits"] = int(mem_bits_match.group(1))

        cell_total_match = re.match(r"(\d+)\s+cells$", line)
        if cell_total_match:
            stats["cell_count"] = int(cell_total_match.group(1))
            stats["statistics_found"] = True

        # Yosys 0.65 emits cell rows as "36   $_AND_".
        cell_match = re.match(r"(\d+)\s+(\$\S+)$", line)
        if cell_match:
            cell_count = int(cell_match.group(1))
            cell_name = cell_match.group(2)
            stats["cells"][cell_name] = cell_count

    return stats


def _synthesis_warnings(cell_count: int, stats: dict) -> list[str]:
    """Generate warnings based on synthesis results."""
    warnings = []

    if cell_count == 0:
        warnings.append("Synthesis produced 0 cells — module may be empty or optimized away")

    if stats.get("memories", 0) > 0:
        warnings.append(
            f"Design contains {stats['memories']} memory blocks "
            f"({stats.get('memory_bits', 0)} bits) — ensure memory mapping is correct"
        )

    return warnings
