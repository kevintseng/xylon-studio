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
import shutil
import subprocess
import sys
import tempfile
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

        # Host path that maps to /results inside containers (writable bind mount)
        self.host_results_dir = os.getenv(
            'SANDBOX_RESULTS_DIR',
            os.path.expanduser('~/Documents/Obsidian-Vault/Projects/AI-Chip-Design-Research/xylon/results'),
        )

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

    def _write_to_container(self, container: str, container_path: str, content: str):
        """Write content to a file inside the container via docker exec + stdin."""
        container_dir = os.path.dirname(container_path)
        subprocess.run(
            ["docker", "exec", "-i", container, "sh", "-c",
             f"mkdir -p {container_dir} && cat > {container_path}"],
            input=content.encode("utf-8"),
            capture_output=True, timeout=10, check=True,
        )

    def _cleanup_container_dir(self, container: str, container_dir: str):
        """Remove a directory inside the container."""
        subprocess.run(
            ["docker", "exec", container, "rm", "-rf", container_dir],
            capture_output=True, timeout=10, check=False,
        )

    def lint_verilog_string(self, verilog_code: str) -> dict:
        """
        Lint Verilog from a code string.

        Writes to /tmp inside the container via docker exec + stdin,
        runs lint, and cleans up.

        Args:
            verilog_code: Verilog source code as a string

        Returns:
            dict with success, warnings, errors (same as lint_verilog)
        """
        import uuid
        job_id = uuid.uuid4().hex[:8]
        container_dir = f"/tmp/xylon-{job_id}"
        module_name = self._extract_module_name(verilog_code)
        container_path = f"{container_dir}/{module_name}.v"

        try:
            self._write_to_container(self.verilator_container, container_path, verilog_code)
            result = self.lint_verilog(container_path)
            return result

        except Exception as e:
            logger.error(f"Lint string failed: {e}")
            return {
                "success": False,
                "warnings": [],
                "errors": [str(e)],
                "stdout": "",
                "stderr": str(e),
                "duration_seconds": 0,
            }
        finally:
            self._cleanup_container_dir(self.verilator_container, container_dir)

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
        read_verilog "{verilog_file}";
        hierarchy -check;
        proc; opt; fsm; opt; memory; opt;
        techmap; opt;
        """

        if output_file:
            yosys_script += f'write_json "{output_file}";'

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

    def synthesize_verilog_string(self, verilog_code: str) -> dict:
        """
        Synthesize Verilog from a code string using Yosys.

        Writes to /results inside the container via docker exec + stdin.

        Args:
            verilog_code: Verilog source code as a string

        Returns:
            dict with success, gate_count, stdout, stderr, duration_seconds
        """
        import uuid
        job_id = uuid.uuid4().hex[:8]
        module_name = self._extract_module_name(verilog_code)
        container_dir = f"/tmp/xylon-synth-{job_id}"
        container_path = f"{container_dir}/{module_name}.v"

        try:
            self._write_to_container(self.yosys_container, container_path, verilog_code)
            result = self.synthesize_verilog(container_path)
            return result

        except Exception as e:
            logger.error(f"Synthesis string failed: {e}")
            return {
                "success": False,
                "gate_count": 0,
                "stdout": "",
                "stderr": str(e),
                "duration_seconds": 0,
            }
        finally:
            self._cleanup_container_dir(self.yosys_container, container_dir)

    def run_verilator_sim(
        self, rtl_file: str, tb_file: str,
        timeout: int = 60, coverage: bool = False,
        workdir: str = None,
    ) -> dict:
        """
        Run Verilator simulation with testbench.

        Args:
            rtl_file: Path to RTL .v file
            tb_file: Path to testbench .sv file
            timeout: Simulation timeout in seconds
            coverage: Enable Verilator coverage collection (--coverage)

        Returns:
            dict with simulation results (stdout, stderr, vcd_file,
            and coverage_data if coverage=True)

        Example:
            manager = SandboxManager()
            result = manager.run_verilator_sim(
                "/tmp/adder.v",
                "/tmp/tb_adder.sv",
                coverage=True
            )
            if result['success']:
                print(result['coverage_data'])
        """
        logger.info(f"Running simulation: RTL={rtl_file}, TB={tb_file}, coverage={coverage}")

        # Extract module name from RTL file
        module_name = os.path.splitext(os.path.basename(rtl_file))[0]

        # Build Verilator command for simulation
        try:
            # Step 1: Verilate
            verilate_cmd = [
                "verilator",
                "--cc",              # Generate C++ files
                "--exe",             # Build executable
                "--build",           # Build automatically
                "-Wall",             # All warnings
            ]
            if coverage:
                verilate_cmd.append("--coverage")

            verilate_cmd.extend([rtl_file, tb_file])

            verilate_result = self.verilator.execute(
                verilate_cmd,
                timeout=timeout,
                workdir=workdir,
                env={"CCACHE_DISABLE": "1"},
            )

            # Verilator returns exit code 1 for warnings (not just errors).
            # Treat as failure only if stderr contains %Error.
            has_errors = '%Error' in verilate_result.stderr
            if not verilate_result.success and has_errors:
                return {
                    'success': False,
                    'stdout': verilate_result.stdout,
                    'stderr': verilate_result.stderr,
                    'vcd_file': None,
                    'coverage_data': None,
                    'duration_seconds': verilate_result.duration_seconds
                }

            # Step 2: Run the simulation executable
            exe_path = f"./obj_dir/V{module_name}"
            run_result = self.verilator.execute(
                [exe_path],
                timeout=timeout // 2,
                workdir=workdir,
            )

            # Look for VCD file
            vcd_file = None
            vcd_pattern = f"{module_name}.vcd"
            if os.path.exists(vcd_pattern):
                vcd_file = vcd_pattern

            # Step 3: Collect coverage data if enabled
            coverage_data = None
            if coverage and run_result.success:
                coverage_data = self._collect_coverage_data(module_name, timeout, workdir=workdir)

            return {
                'success': run_result.success,
                'stdout': run_result.stdout,
                'stderr': run_result.stderr,
                'vcd_file': vcd_file,
                'coverage_data': coverage_data,
                'duration_seconds': run_result.duration_seconds
            }

        except ExecutionError as e:
            logger.error(f"Simulation failed: {e.message}")
            return {
                'success': False,
                'stdout': e.stdout,
                'stderr': e.stderr,
                'vcd_file': None,
                'coverage_data': None,
                'duration_seconds': 0
            }

    @staticmethod
    def _extract_module_name(rtl_code: str) -> str:
        """Extract top module name from Verilog source code."""
        import re
        match = re.search(r'module\s+(\w+)', rtl_code)
        return match.group(1) if match else "design"

    def run_verilator_sim_string(
        self, rtl_code: str, tb_code: str,
        timeout: int = 60, coverage: bool = False,
    ) -> dict:
        """
        Run Verilator simulation from code strings.

        Writes to /tmp inside the container via docker exec + stdin,
        runs simulation, and cleans up.

        Args:
            rtl_code: Verilog RTL source code
            tb_code: Testbench source code (C++ or SystemVerilog)
            timeout: Simulation timeout in seconds
            coverage: Enable coverage collection

        Returns:
            dict with simulation results (same as run_verilator_sim)
        """
        import uuid
        job_id = uuid.uuid4().hex[:8]
        container_dir = f"/results/xylon-{job_id}"

        # Name RTL file after the module so Verilator's executable matches
        module_name = self._extract_module_name(rtl_code)

        try:
            self._write_to_container(
                self.verilator_container,
                f"{container_dir}/{module_name}.v",
                rtl_code,
            )
            self._write_to_container(
                self.verilator_container,
                f"{container_dir}/testbench.cpp",
                tb_code,
            )

            result = self.run_verilator_sim(
                f"{container_dir}/{module_name}.v",
                f"{container_dir}/testbench.cpp",
                timeout=timeout,
                coverage=coverage,
                workdir=container_dir,
            )
            return result

        except Exception as e:
            logger.error(f"Simulation string failed: {e}")
            return {
                "success": False,
                "stdout": "",
                "stderr": str(e),
                "vcd_file": None,
                "coverage_data": None,
                "duration_seconds": 0,
            }
        finally:
            self._cleanup_container_dir(self.verilator_container, container_dir)

    def _collect_coverage_data(self, module_name: str, timeout: int, workdir: str = None) -> dict:
        """
        Collect and parse Verilator coverage data after simulation.

        Verilator writes coverage to ./coverage.dat by default.
        We use verilator_coverage to generate a human-readable report.

        Args:
            module_name: Module name for file lookup
            timeout: Timeout for coverage collection commands
            workdir: Working directory where coverage.dat was written

        Returns:
            dict with line_coverage, toggle_coverage, branch_coverage, raw_report
        """
        try:
            # Run verilator_coverage in the same workdir where simulation ran
            cov_result = self.verilator.execute(
                ["verilator_coverage", "--annotate", "coverage_annotated",
                 "coverage.dat"],
                timeout=timeout // 4,
                workdir=workdir,
            )

            raw_report = cov_result.stdout + "\n" + cov_result.stderr

            # Read annotated source files for line-by-line coverage
            annotated_dir = "coverage_annotated" if not workdir else f"{workdir}/coverage_annotated"
            ann_result = self.verilator.execute(
                ["sh", "-c", f"cat {annotated_dir}/*.v 2>/dev/null || echo ''"],
                timeout=timeout // 4,
                workdir=workdir,
            )

            return {
                "raw_report": raw_report + "\n" + ann_result.stdout,
                "summary": cov_result.stderr,
                "success": True,
            }

        except ExecutionError as e:
            logger.warning(f"Coverage collection failed: {e.message}")
            return {
                "raw_report": "",
                "summary": "",
                "success": False,
                "error": e.message,
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
