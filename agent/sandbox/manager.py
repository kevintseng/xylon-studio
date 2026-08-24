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
import re
import subprocess
import sys
import time

from agent.sandbox.executor import ExecutionError, SandboxExecutor
from agent.sandbox.runtime import load_runtime_spec, runtime_container_name

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

_CONTAINER_WORKSPACE_PATTERN = re.compile(
    r"/(?:tmp/xylon(?:-synth)?|results/xylon)-[0-9a-f]{8}"
)
_CLEANUP_RECOVERY = (
    "Automatic continuation is blocked. Run ./scripts/eda-runtime down, "
    "then ./scripts/eda-runtime up, then ./scripts/eda-runtime verify before retrying."
)


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
        self.verilator_container = os.getenv(
            'VERILATOR_CONTAINER',
            runtime_container_name('verilator'),
        )
        self.yosys_container = os.getenv(
            'YOSYS_CONTAINER',
            runtime_container_name('yosys'),
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

            failure_kind = result.failure_kind
            if failure_kind and not errors:
                errors.append(result.stderr.strip() or "EDA toolchain unavailable")

            return {
                'success': result.success,
                'warnings': warnings,
                'errors': errors,
                'stdout': result.stdout,
                'stderr': result.stderr,
                'duration_seconds': result.duration_seconds,
                'failure_kind': failure_kind,
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
                'failure_kind': e.failure_kind,
            }

    def _write_to_container(self, container: str, container_path: str, content: str):
        """Write content to a file inside the container via docker exec + stdin."""
        container_dir = os.path.dirname(container_path)
        source_content = content if content.endswith("\n") else f"{content}\n"
        subprocess.run(
            ["docker", "exec", "-i", container, "sh", "-c",
             f"mkdir -p {container_dir} && cat > {container_path}"],
            input=source_content.encode("utf-8"),
            capture_output=True, timeout=10, check=True,
        )

    def _cleanup_container_dir(self, container: str, container_dir: str) -> None:
        """Remove only a launcher-owned job directory and verify the command."""
        owned_containers = {
            self.verilator_container,
            self.yosys_container,
        }
        if (
            container not in owned_containers
            or _CONTAINER_WORKSPACE_PATTERN.fullmatch(container_dir) is None
        ):
            raise ExecutionError(
                f"Refusing cleanup of unowned container workspace {container}:{container_dir}. "
                f"{_CLEANUP_RECOVERY}",
                failure_kind="infrastructure",
            )

        try:
            result = subprocess.run(
                ["docker", "exec", container, "rm", "-rf", container_dir],
                capture_output=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ExecutionError(
                f"Container workspace cleanup could not run: {error}. "
                f"{_CLEANUP_RECOVERY}",
                failure_kind="infrastructure",
            ) from error

        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        if result.returncode != 0:
            raise ExecutionError(
                "Container workspace cleanup failed "
                f"for {container_dir} (exit {result.returncode}): "
                f"{stderr or 'no diagnostic output'}. {_CLEANUP_RECOVERY}",
                stderr=stderr,
                exit_code=result.returncode,
                failure_kind="infrastructure",
            )

    @staticmethod
    def _merge_cleanup_failure(result: dict, cleanup_error: Exception) -> dict:
        """Preserve the primary result while making cleanup failure authoritative."""
        detail = getattr(cleanup_error, "message", str(cleanup_error))
        diagnostic = f"Container workspace cleanup failed: {detail}"
        if _CLEANUP_RECOVERY not in diagnostic:
            diagnostic = f"{diagnostic}. {_CLEANUP_RECOVERY}"
        merged = dict(result)
        primary_stderr = str(merged.get("stderr", "")).strip()
        merged["success"] = False
        merged["failure_kind"] = "infrastructure"
        merged["recovery_code"] = "repair_toolchain"
        merged["cleanup_error"] = diagnostic
        merged["stderr"] = "\n".join(
            part for part in (primary_stderr, diagnostic) if part
        )
        if isinstance(merged.get("errors"), list):
            merged["errors"] = [*merged["errors"], diagnostic]
        return merged

    def _finish_container_job(
        self,
        container: str,
        container_dir: str,
        result: dict,
    ) -> dict:
        try:
            self._cleanup_container_dir(container, container_dir)
        except Exception as cleanup_error:
            logger.error("Container workspace cleanup failed: %s", cleanup_error)
            return self._merge_cleanup_failure(result, cleanup_error)
        return result

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

        except Exception as e:
            logger.error(f"Lint string failed: {e}")
            result = {
                "success": False,
                "warnings": [],
                "errors": [str(e)],
                "stdout": "",
                "stderr": str(e),
                "duration_seconds": 0,
                "failure_kind": "infrastructure",
            }
        return self._finish_container_job(
            self.verilator_container,
            container_dir,
            result,
        )

    def synthesize_verilog(self, verilog_file: str, output_file: str = None) -> dict:
        """
        Synthesize Verilog using Yosys.

        Args:
            verilog_file: Path to .v file
            output_file: Output JSON file (optional)

        Returns:
            Raw Yosys success, stdout, stderr, duration, and failure classification.
            This function does not produce timing or mapped-gate evidence.

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

            return {
                'success': result.success,
                'stdout': result.stdout,
                'stderr': result.stderr,
                'duration_seconds': result.duration_seconds,
                'failure_kind': result.failure_kind,
            }

        except ExecutionError as e:
            logger.error(f"Synthesis failed: {e.message}")
            return {
                'success': False,
                'stdout': e.stdout,
                'stderr': e.stderr,
                'duration_seconds': 0,
                'failure_kind': e.failure_kind,
            }

    def synthesize_verilog_string(self, verilog_code: str) -> dict:
        """
        Synthesize Verilog from a code string using Yosys.

        Writes to /results inside the container via docker exec + stdin.

        Args:
            verilog_code: Verilog source code as a string

        Returns:
            Raw Yosys success, stdout, stderr, duration, and failure classification.
        """
        import uuid
        job_id = uuid.uuid4().hex[:8]
        module_name = self._extract_module_name(verilog_code)
        container_dir = f"/tmp/xylon-synth-{job_id}"
        container_path = f"{container_dir}/{module_name}.v"

        try:
            self._write_to_container(self.yosys_container, container_path, verilog_code)
            result = self.synthesize_verilog(container_path)

        except Exception as e:
            logger.error(f"Synthesis string failed: {e}")
            result = {
                "success": False,
                "stdout": "",
                "stderr": str(e),
                "duration_seconds": 0,
                "failure_kind": "infrastructure",
            }
        return self._finish_container_job(
            self.yosys_container,
            container_dir,
            result,
        )

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
            dict with simulation results and coverage_data if coverage=True.
            Waveform export is not implemented, so vcd_file is always None.

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
        deadline = time.monotonic() + timeout

        def remaining_timeout() -> float:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ExecutionError(
                    f"Simulation timeout ({timeout}s exceeded)",
                    failure_kind="infrastructure",
                )
            return remaining

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
                timeout=remaining_timeout(),
                workdir=workdir,
                env={"CCACHE_DISABLE": "1"},
            )

            # Verilator returns exit code 1 for warnings (not just errors).
            # Treat as failure only if stderr contains %Error.
            has_errors = '%Error' in verilate_result.stderr
            if verilate_result.failure_kind or (
                not verilate_result.success and has_errors
            ):
                return {
                    'success': False,
                    'stdout': verilate_result.stdout,
                    'stderr': verilate_result.stderr,
                    'vcd_file': None,
                    'coverage_data': None,
                    'duration_seconds': verilate_result.duration_seconds,
                    'failure_kind': verilate_result.failure_kind,
                }

            # Step 2: Run the simulation executable
            exe_path = f"./obj_dir/V{module_name}"
            run_result = self.verilator.execute(
                [exe_path],
                timeout=remaining_timeout(),
                workdir=workdir,
            )

            # Step 3: Collect coverage data if enabled
            coverage_data = None
            if coverage and run_result.success:
                coverage_data = self._collect_coverage_data(
                    module_name,
                    remaining_timeout,
                    workdir=workdir,
                )

            coverage_duration = (
                coverage_data.get("duration_seconds", 0)
                if coverage_data is not None
                else 0
            )

            return {
                'success': run_result.success,
                'stdout': run_result.stdout,
                'stderr': run_result.stderr,
                'vcd_file': None,
                'coverage_data': coverage_data,
                'duration_seconds': (
                    verilate_result.duration_seconds
                    + run_result.duration_seconds
                    + coverage_duration
                ),
                'failure_kind': run_result.failure_kind,
            }

        except ExecutionError as e:
            logger.error(f"Simulation failed: {e.message}")
            return {
                'success': False,
                'stdout': e.stdout,
                'stderr': e.stderr,
                'vcd_file': None,
                'coverage_data': None,
                'duration_seconds': 0,
                'failure_kind': e.failure_kind,
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

        except Exception as e:
            logger.error(f"Simulation string failed: {e}")
            result = {
                "success": False,
                "stdout": "",
                "stderr": str(e),
                "vcd_file": None,
                "coverage_data": None,
                "duration_seconds": 0,
                "failure_kind": "infrastructure",
            }
        return self._finish_container_job(
            self.verilator_container,
            container_dir,
            result,
        )

    def _collect_coverage_data(self, module_name: str, remaining_timeout, workdir: str = None) -> dict:
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
                timeout=remaining_timeout(),
                workdir=workdir,
            )

            raw_report = cov_result.stdout + "\n" + cov_result.stderr

            # Read annotated source files for line-by-line coverage
            annotated_dir = "coverage_annotated" if not workdir else f"{workdir}/coverage_annotated"
            ann_result = self.verilator.execute(
                ["sh", "-c", f"cat {annotated_dir}/*.v 2>/dev/null || echo ''"],
                timeout=remaining_timeout(),
                workdir=workdir,
            )

            return {
                "raw_report": raw_report + "\n" + ann_result.stdout,
                "summary": cov_result.stderr,
                "success": True,
                "duration_seconds": (
                    cov_result.duration_seconds + ann_result.duration_seconds
                ),
            }

        except ExecutionError as e:
            logger.warning(f"Coverage collection failed: {e.message}")
            return {
                "raw_report": "",
                "summary": "",
                "success": False,
                "error": e.message,
                "failure_kind": e.failure_kind,
                "duration_seconds": 0,
            }

    @staticmethod
    def _inspect_container_image(container_name: str) -> tuple[str, str, str | None]:
        """Return configured image tag, immutable image ID, and an error."""
        try:
            result = subprocess.run(
                [
                    "docker",
                    "inspect",
                    "--format",
                    "{{.Config.Image}}|{{.Image}}",
                    container_name,
                ],
                capture_output=True,
                timeout=5,
                check=False,
            )
        except Exception as error:
            return "", "", str(error)

        stdout = result.stdout.decode("utf-8", errors="replace").strip()
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        if result.returncode != 0 or "|" not in stdout:
            return "", "", stderr or f"Unable to inspect {container_name}"
        image, image_id = stdout.split("|", 1)
        return image, image_id, None

    def get_tool_identity(self) -> dict:
        """Observe and verify the exact runtime used for pipeline execution."""
        spec = load_runtime_spec()
        errors: list[str] = []
        observed: dict[str, dict] = {}
        probes = (
            (
                "verilator",
                self.verilator_container,
                self.verilator,
                ["verilator", "--version"],
                f"Verilator {spec.verilator_version}",
            ),
            (
                "yosys",
                self.yosys_container,
                self.yosys,
                ["yosys", "-V"],
                f"Yosys {spec.yosys_version}",
            ),
        )

        for tool, container, executor, command, expected_version in probes:
            image, image_id, inspect_error = self._inspect_container_image(container)
            if inspect_error:
                errors.append(f"{container}: {inspect_error}")

            version_output = ""
            try:
                probe = executor.execute(command, timeout=10)
                version_output = (probe.stdout or probe.stderr).strip()
                if not probe.success:
                    errors.append(f"{tool} version probe failed")
            except ExecutionError as error:
                errors.append(f"{tool} version probe failed: {error.message}")

            if image and image != spec.image:
                errors.append(
                    f"{container} expected image {spec.image}, observed {image}"
                )
            if expected_version not in version_output:
                errors.append(
                    f"{expected_version} expected, observed "
                    f"{version_output or 'unavailable'}"
                )

            observed[tool] = {
                "container": container,
                "image": image or None,
                "image_id": image_id or None,
                "version_output": version_output or None,
            }

        return {
            "schema_version": 1,
            "verified": not errors,
            "expected": spec.to_dict(),
            "observed": observed,
            "errors": errors,
        }


def main() -> int:
    """Reject the unsupported standalone daemon entrypoint."""
    logger.error(
        "Standalone sandbox daemon is not implemented. "
        "Use the pipeline API or CLI, which invoke SandboxManager directly."
    )
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
