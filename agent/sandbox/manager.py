# Copyright (c) 2026 XylonStudio
# Licensed under the MIT License
# See LICENSE in the project root for license information

"""
Sandbox Manager.

Main entry point for EDA sandbox service.
Coordinates execution of Verilator, Yosys, and other EDA tools
in isolated Docker containers.

Usage:
    python -m agent.sandbox.manager
"""

import logging
import os
import sys
from agent.sandbox.executor import SandboxExecutor, ExecutionError

# Configure logging
# Environment-aware: use file logging in container, stdout-only in local dev
log_handlers = [logging.StreamHandler(sys.stdout)]

# Add file handler only if log directory exists (container environment)
log_dir = '/var/log/sandbox'
if os.path.exists(log_dir):
    log_handlers.append(logging.FileHandler(os.path.join(log_dir, 'manager.log')))

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=log_handlers
)

logger = logging.getLogger(__name__)


class SandboxManager:
    """
    Manages EDA tool execution in isolated containers.

    Responsibilities:
    - Validate input files
    - Execute tools with timeout
    - Collect results
    - Monitor resource usage
    """

    def __init__(self):
        """Initialize sandbox manager."""
        # Container names from environment
        self.verilator_container = os.getenv('VERILATOR_CONTAINER', 'xylon-verilator')
        self.yosys_container = os.getenv('YOSYS_CONTAINER', 'xylon-yosys')

        # Timeouts from environment
        self.lint_timeout = int(os.getenv('LINT_TIMEOUT', 60))
        self.simulation_timeout = int(os.getenv('SIMULATION_TIMEOUT', 300))
        self.synthesis_timeout = int(os.getenv('SYNTHESIS_TIMEOUT', 600))

        # Create executors
        self.verilator = SandboxExecutor(self.verilator_container)
        self.yosys = SandboxExecutor(self.yosys_container)

        logger.info("Sandbox Manager initialized")
        logger.info(f"Verilator container: {self.verilator_container}")
        logger.info(f"Yosys container: {self.yosys_container}")

    def lint_verilog(self, verilog_file: str) -> dict:
        """
        Lint Verilog file using Verilator.

        Args:
            verilog_file: Path to .v file (inside /designs/)

        Returns:
            dict with success, warnings, errors

        Example:
            manager = SandboxManager()
            result = manager.lint_verilog("/designs/adder.v")
            if result['success']:
                print("Lint passed")
        """
        logger.info(f"Linting: {verilog_file}")

        try:
            result = self.verilator.execute(
                ["verilator", "--lint-only", verilog_file],
                timeout=self.lint_timeout
            )

            # Parse Verilator output for warnings/errors
            warnings = []
            errors = []

            for line in result.stderr.split('\n'):
                if '%Warning' in line:
                    warnings.append(line)
                elif '%Error' in line:
                    errors.append(line)

            return {
                'success': result.success,
                'warnings': warnings,
                'errors': errors,
                'stdout': result.stdout,
                'stderr': result.stderr,
                'duration_seconds': result.duration_seconds,
            }

        except ExecutionError as e:
            logger.error(f"Lint failed: {e.message}")
            return {
                'success': False,
                'warnings': [],
                'errors': [e.message],
                'stdout': e.stdout,
                'stderr': e.stderr,
                'duration_seconds': 0,
            }

    def synthesize_verilog(self, verilog_file: str, output_file: str = None) -> dict:
        """
        Synthesize Verilog using Yosys.

        Args:
            verilog_file: Path to .v file
            output_file: Output JSON file (optional)

        Returns:
            dict with success, gate_count, critical_path

        Example:
            manager = SandboxManager()
            result = manager.synthesize_verilog(
                "/designs/adder.v",
                "/results/adder.json"
            )
        """
        logger.info(f"Synthesizing: {verilog_file}")

        # Build Yosys command
        yosys_script = f"""
        read_verilog {verilog_file};
        hierarchy -check;
        proc; opt; fsm; opt; memory; opt;
        techmap; opt;
        """

        if output_file:
            yosys_script += f"write_json {output_file};"

        yosys_script += "stat;"

        try:
            result = self.yosys.execute(
                ["yosys", "-p", yosys_script],
                timeout=self.synthesis_timeout
            )

            # Parse synthesis statistics
            gate_count = self._parse_gate_count(result.stdout)

            return {
                'success': result.success,
                'gate_count': gate_count,
                'stdout': result.stdout,
                'stderr': result.stderr,
                'duration_seconds': result.duration_seconds,
            }

        except ExecutionError as e:
            logger.error(f"Synthesis failed: {e.message}")
            return {
                'success': False,
                'gate_count': 0,
                'stdout': e.stdout,
                'stderr': e.stderr,
                'duration_seconds': 0,
            }

    def run_verilator_sim(self, rtl_file: str, tb_file: str, timeout: int = 60) -> dict:
        """
        Run Verilator simulation with testbench.

        Args:
            rtl_file: Path to RTL .v file
            tb_file: Path to testbench .sv file
            timeout: Simulation timeout in seconds

        Returns:
            dict with simulation results (stdout, stderr, vcd_file)

        Example:
            manager = SandboxManager()
            result = manager.run_verilator_sim(
                "/tmp/adder.v",
                "/tmp/tb_adder.sv"
            )
            if result['success']:
                print(result['stdout'])
        """
        logger.info(f"Running simulation: RTL={rtl_file}, TB={tb_file}")

        # Extract module name from RTL file
        import re
        module_name = os.path.splitext(os.path.basename(rtl_file))[0]

        # Build Verilator command for simulation
        # 1. Verilate to C++
        # 2. Compile with g++
        # 3. Run simulation
        try:
            # Step 1: Verilate
            verilate_result = self.verilator.execute(
                [
                    "verilator",
                    "--cc",              # Generate C++ files
                    "--exe",             # Build executable
                    "--build",           # Build automatically
                    "-Wall",             # All warnings
                    rtl_file,
                    tb_file
                ],
                timeout=timeout
            )

            if not verilate_result.success:
                return {
                    'success': False,
                    'stdout': verilate_result.stdout,
                    'stderr': verilate_result.stderr,
                    'vcd_file': None,
                    'duration_seconds': verilate_result.duration_seconds
                }

            # Step 2: Run the simulation executable
            exe_path = f"./obj_dir/V{module_name}"
            run_result = self.verilator.execute(
                [exe_path],
                timeout=timeout // 2
            )

            # Look for VCD file
            vcd_file = None
            vcd_pattern = f"{module_name}.vcd"
            if os.path.exists(vcd_pattern):
                vcd_file = vcd_pattern

            return {
                'success': run_result.success,
                'stdout': run_result.stdout,
                'stderr': run_result.stderr,
                'vcd_file': vcd_file,
                'duration_seconds': run_result.duration_seconds
            }

        except ExecutionError as e:
            logger.error(f"Simulation failed: {e.message}")
            return {
                'success': False,
                'stdout': e.stdout,
                'stderr': e.stderr,
                'vcd_file': None,
                'duration_seconds': 0
            }

    def _parse_gate_count(self, yosys_output: str) -> int:
        """
        Parse gate count from Yosys output.

        Args:
            yosys_output: stdout from Yosys

        Returns:
            Estimated gate count
        """
        # Look for "Number of cells:" line
        for line in yosys_output.split('\n'):
            if 'Number of cells:' in line:
                try:
                    return int(line.split(':')[1].strip())
                except:
                    pass

        return 0

    def health_check(self) -> dict:
        """
        Check health of sandbox containers.

        Returns:
            dict with status of each container
        """
        return {
            'verilator': self.verilator.verify_container_running(),
            'yosys': self.yosys.verify_container_running(),
        }


def main():
    """Main entry point."""
    logger.info("Starting Sandbox Manager...")

    manager = SandboxManager()

    # Health check (warning only - Docker Compose manages containers)
    try:
        health = manager.health_check()
        logger.info(f"Health check: {health}")

        if not all(health.values()):
            logger.warning("Health check failed - containers may not be ready yet")
            logger.warning("This is expected in Docker Compose environment")
            logger.warning("Docker Compose will manage container lifecycle")
    except Exception as e:
        logger.warning(f"Health check failed with error: {e}")
        logger.warning("Continuing anyway - assuming Docker Compose manages containers")

    logger.info("Sandbox Manager ready")

    # TODO: Connect to Redis and process tasks
    # For now, just run in idle mode
    import time
    while True:
        time.sleep(60)
        logger.debug("Sandbox Manager heartbeat")


if __name__ == '__main__':
    main()
