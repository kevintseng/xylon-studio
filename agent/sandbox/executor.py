"""
Sandbox Executor.

Executes commands in isolated Docker containers with:
- Timeout enforcement
- Output capture
- Resource monitoring
- Security validation
"""

import subprocess
import logging
import os
from dataclasses import dataclass
from typing import Optional, List
from datetime import datetime

logger = logging.getLogger(__name__)


# ==================== Exceptions ====================


class ExecutionError(Exception):
    """Raised when sandbox execution fails."""

    def __init__(self, message: str, stdout: str = "", stderr: str = "", exit_code: int = -1):
        self.message = message
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code
        super().__init__(self.message)


# ==================== Data Models ====================


@dataclass
class ExecutionResult:
    """
    Result of sandbox execution.

    Attributes:
        success: Whether execution succeeded
        stdout: Standard output
        stderr: Standard error
        exit_code: Process exit code
        duration_seconds: Execution time
        timestamp: UTC timestamp
    """
    success: bool
    stdout: str
    stderr: str
    exit_code: int
    duration_seconds: float
    timestamp: str = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow().isoformat()


# ==================== Sandbox Executor ====================


class SandboxExecutor:
    """
    Executes commands in sandboxed Docker containers.

    Security:
    - Commands run in containers with network_mode=none
    - Timeout enforcement prevents runaway processes
    - Output size limits prevent memory exhaustion
    - Input validation prevents code injection
    """

    MAX_OUTPUT_SIZE = 10 * 1024 * 1024  # 10 MB
    DEFAULT_TIMEOUT = 60  # seconds

    def __init__(self, container_name: str):
        """
        Initialize executor.

        Args:
            container_name: Docker container to execute commands in
        """
        self.container_name = container_name

    def execute(
        self,
        command: List[str],
        timeout: Optional[int] = None,
        workdir: Optional[str] = None,
        env: Optional[dict] = None,
    ) -> ExecutionResult:
        """
        Execute command in sandbox container.

        Args:
            command: Command and arguments to execute
            timeout: Timeout in seconds (default: 60)
            workdir: Working directory (optional)

        Returns:
            ExecutionResult with stdout/stderr/exit_code

        Raises:
            ExecutionError: If execution fails or times out

        Example:
            executor = SandboxExecutor("xylon-verilator")
            result = executor.execute(
                ["verilator", "--lint-only", "/designs/adder.v"],
                timeout=30
            )
            if result.success:
                print(f"Lint passed: {result.stdout}")
        """
        if timeout is None:
            timeout = self.DEFAULT_TIMEOUT

        # Build docker exec command
        docker_cmd = ["docker", "exec"]

        if workdir:
            docker_cmd.extend(["-w", workdir])

        if env:
            for k, v in env.items():
                docker_cmd.extend(["-e", f"{k}={v}"])

        docker_cmd.append(self.container_name)
        docker_cmd.extend(command)

        # Log command (sanitized)
        logger.info(f"Executing in {self.container_name}: {' '.join(command[:3])}")

        start_time = datetime.utcnow()

        try:
            # Execute with timeout
            result = subprocess.run(
                docker_cmd,
                capture_output=True,
                timeout=timeout,
                check=False,  # Don't raise on non-zero exit
            )

            end_time = datetime.utcnow()
            duration = (end_time - start_time).total_seconds()

            # Decode output
            stdout = result.stdout.decode('utf-8', errors='replace')
            stderr = result.stderr.decode('utf-8', errors='replace')

            # Check output size limits
            if len(stdout) > self.MAX_OUTPUT_SIZE:
                logger.warning(f"stdout truncated (>{self.MAX_OUTPUT_SIZE} bytes)")
                stdout = stdout[:self.MAX_OUTPUT_SIZE] + "\n[OUTPUT TRUNCATED]"

            if len(stderr) > self.MAX_OUTPUT_SIZE:
                logger.warning(f"stderr truncated (>{self.MAX_OUTPUT_SIZE} bytes)")
                stderr = stderr[:self.MAX_OUTPUT_SIZE] + "\n[OUTPUT TRUNCATED]"

            success = result.returncode == 0

            if not success:
                logger.warning(
                    f"Command failed with exit code {result.returncode}: "
                    f"{stderr[:200]}"
                )

            return ExecutionResult(
                success=success,
                stdout=stdout,
                stderr=stderr,
                exit_code=result.returncode,
                duration_seconds=duration,
            )

        except subprocess.TimeoutExpired as e:
            duration = timeout

            # Try to get partial output
            stdout = e.stdout.decode('utf-8', errors='replace') if e.stdout else ""
            stderr = e.stderr.decode('utf-8', errors='replace') if e.stderr else ""

            error_msg = f"Execution timeout ({timeout}s exceeded)"
            logger.error(error_msg)

            raise ExecutionError(
                message=error_msg,
                stdout=stdout,
                stderr=stderr,
                exit_code=-1,
            )

        except Exception as e:
            logger.error(f"Execution failed: {e}")
            raise ExecutionError(
                message=f"Execution failed: {str(e)}",
                stdout="",
                stderr=str(e),
                exit_code=-1,
            )

    def verify_container_running(self) -> bool:
        """
        Verify that sandbox container is running.

        Returns:
            True if container is running and healthy
        """
        try:
            result = subprocess.run(
                ["docker", "inspect", "-f", "{{.State.Running}}", self.container_name],
                capture_output=True,
                timeout=5,
                check=False,
            )

            return result.stdout.decode().strip() == "true"

        except Exception as e:
            logger.error(f"Failed to verify container: {e}")
            return False


# ==================== Helper Functions ====================


def validate_verilog_file(file_path: str) -> bool:
    """
    Validate Verilog file before execution.

    Args:
        file_path: Path to .v file

    Returns:
        True if file is valid

    Raises:
        ValueError: If file is invalid or too large
    """
    # Check file exists
    if not os.path.isfile(file_path):
        raise ValueError(f"File not found: {file_path}")

    # Check file extension
    if not file_path.endswith('.v') and not file_path.endswith('.sv'):
        raise ValueError(f"Invalid file extension: {file_path}")

    # Check file size (max 1MB)
    max_size = int(os.getenv('MAX_DESIGN_SIZE', 1000000))  # 1MB default
    file_size = os.path.getsize(file_path)

    if file_size > max_size:
        raise ValueError(f"File too large: {file_size} bytes (max {max_size})")

    # Check for obviously malicious content (basic heuristics)
    with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read(10000)  # Read first 10KB for inspection

        # Check for system tasks that could leak info
        dangerous_tasks = ['$system', '$fopen', '$fwrite', '$readmem']
        for task in dangerous_tasks:
            if task in content:
                raise ValueError(f"Dangerous system task detected: {task}")

    return True
