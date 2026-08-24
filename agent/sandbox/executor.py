"""
Sandbox Executor.

Executes commands in isolated Docker containers with:
- Timeout enforcement
- Output capture
- Resource monitoring
- Security validation
"""

import logging
import os
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

logger = logging.getLogger(__name__)


# ==================== Exceptions ====================


class ExecutionError(Exception):
    """Raised when sandbox execution fails."""

    def __init__(
        self,
        message: str,
        stdout: str = "",
        stderr: str = "",
        exit_code: int = -1,
        failure_kind: str = "infrastructure",
    ):
        self.message = message
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code
        self.failure_kind = failure_kind
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
    failure_kind: str | None = None
    timestamp: str | None = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.now(UTC).isoformat()


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
    _READ_CHUNK_SIZE = 64 * 1024
    _TRUNCATION_MARKER = b"\n[OUTPUT TRUNCATED]\n"
    _CLEANUP_TIMEOUT = 10

    _INFRASTRUCTURE_PATTERNS = (
        "error response from daemon",
        "cannot connect to the docker daemon",
        "container is not running",
        "is not running",
        "no such container",
        "executable file not found in $path",
        "permission denied while trying to connect to the docker daemon",
        "sandbox process-group cleanup failed",
    )

    def __init__(self, container_name: str):
        """
        Initialize executor.

        Args:
            container_name: Docker container to execute commands in
        """
        self.container_name = container_name

    @classmethod
    def _classify_failure(cls, stderr: str) -> str | None:
        """Classify only explicit host/container/toolchain failures."""
        normalized = stderr.lower()
        if any(pattern in normalized for pattern in cls._INFRASTRUCTURE_PATTERNS):
            return "infrastructure"
        return None

    @classmethod
    def _drain_bounded(cls, pipe, sink: bytearray, truncated: list[bool]) -> None:
        """Drain one subprocess pipe while retaining at most MAX_OUTPUT_SIZE bytes."""
        try:
            while True:
                chunk = pipe.read(cls._READ_CHUNK_SIZE)
                if not chunk:
                    break
                remaining = cls.MAX_OUTPUT_SIZE - len(sink)
                if remaining > 0:
                    sink.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    truncated[0] = True
        finally:
            pipe.close()

    @classmethod
    def _decode_bounded(cls, content: bytearray, truncated: bool) -> str:
        """Decode bounded bytes and keep the truncation marker within the byte cap."""
        rendered = bytes(content)
        if truncated:
            marker = cls._TRUNCATION_MARKER[: cls.MAX_OUTPUT_SIZE]
            payload_limit = max(0, cls.MAX_OUTPUT_SIZE - len(marker))
            rendered = rendered[:payload_limit] + marker
        return rendered.decode("utf-8", errors="replace")

    @staticmethod
    def _stop_host_process(process: subprocess.Popen) -> None:
        """Bound termination of the local docker CLI after its wait timed out."""
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)

    def _terminate_container_execution(self, state_file: str) -> tuple[bool, str]:
        """Terminate and verify the exact process group recorded for one docker exec."""
        cleanup_script = r'''
state_file="$1"
if [ ! -s "$state_file" ]; then
    echo "execution state was not established" >&2
    exit 20
fi
state=$(cat "$state_file")
case "$state" in
    done:*) rm -f "$state_file"; exit 0 ;;
    running:*) pid=${state#running:} ;;
    *) echo "invalid execution state: $state" >&2; exit 21 ;;
esac
case "$pid" in
    ''|*[!0-9]*) echo "invalid execution pid" >&2; exit 22 ;;
esac
if kill -0 "-$pid" 2>/dev/null; then
    kill -TERM "-$pid" 2>/dev/null || true
fi
i=0
while kill -0 "-$pid" 2>/dev/null && [ "$i" -lt 20 ]; do
    sleep 0.1
    i=$((i + 1))
done
if kill -0 "-$pid" 2>/dev/null; then
    kill -KILL "-$pid" 2>/dev/null || true
fi
i=0
while kill -0 "-$pid" 2>/dev/null && [ "$i" -lt 20 ]; do
    sleep 0.1
    i=$((i + 1))
done
if kill -0 "-$pid" 2>/dev/null; then
    echo "process group $pid is still running" >&2
    exit 23
fi
rm -f "$state_file"
echo "process group $pid terminated"
'''.strip()
        try:
            result = subprocess.run(
                [
                    "docker",
                    "exec",
                    self.container_name,
                    "sh",
                    "-c",
                    cleanup_script,
                    "xylon-timeout-cleanup",
                    state_file,
                ],
                capture_output=True,
                timeout=self._CLEANUP_TIMEOUT,
                check=False,
            )
        except Exception as error:
            return False, str(error)

        detail = (result.stdout or result.stderr).decode(
            "utf-8", errors="replace"
        ).strip()
        return result.returncode == 0, detail or "cleanup returned no evidence"

    def _remove_container_state(self, state_file: str) -> None:
        """Best-effort removal of the small execution state file after normal exit."""
        try:
            subprocess.run(
                ["docker", "exec", self.container_name, "rm", "-f", state_file],
                capture_output=True,
                timeout=5,
                check=False,
            )
        except Exception:
            logger.warning("Could not remove sandbox execution state file")

    def _stop_container_and_verify(self) -> tuple[bool, str]:
        """Fail-safe fallback when exact process-group cleanup cannot be proven."""
        try:
            stop = subprocess.run(
                ["docker", "stop", "--time", "2", self.container_name],
                capture_output=True,
                timeout=5,
                check=False,
            )
            inspect = subprocess.run(
                [
                    "docker",
                    "inspect",
                    "-f",
                    "{{.State.Running}}",
                    self.container_name,
                ],
                capture_output=True,
                timeout=5,
                check=False,
            )
        except Exception as error:
            return False, str(error)

        observed = inspect.stdout.decode("utf-8", errors="replace").strip()
        if inspect.returncode == 0 and observed == "false":
            return True, f"container {self.container_name} stop verified"

        stop_error = stop.stderr.decode("utf-8", errors="replace").strip()
        inspect_error = inspect.stderr.decode("utf-8", errors="replace").strip()
        detail = inspect_error or stop_error or f"observed running={observed or 'unknown'}"
        return False, detail

    def _cleanup_interrupted_execution(self, state_file: str) -> tuple[bool, str]:
        """Clean an interrupted exec, falling back to a verified container stop."""
        cleanup_verified, cleanup_detail = self._terminate_container_execution(
            state_file
        )
        if cleanup_verified:
            return True, cleanup_detail

        container_stopped, stop_detail = self._stop_container_and_verify()
        if container_stopped:
            return (
                True,
                f"process cleanup unverified ({cleanup_detail}); {stop_detail}",
            )
        return (
            False,
            f"process cleanup unverified ({cleanup_detail}); "
            f"container stop unverified ({stop_detail})",
        )

    def execute(
        self,
        command: list[str],
        timeout: int | float | None = None,
        workdir: str | None = None,
        env: dict | None = None,
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

        state_file = f"/tmp/xylon-exec-{uuid.uuid4().hex}.state"
        wrapper = r'''
state_file="$1"
shift
printf 'starting\n' > "$state_file"
python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@" &
task_pid=$!
printf 'running:%s\n' "$task_pid" > "$state_file"
set +e
wait "$task_pid"
status=$?
if kill -0 "-$task_pid" 2>/dev/null; then
    kill -TERM "-$task_pid" 2>/dev/null || true
    i=0
    while kill -0 "-$task_pid" 2>/dev/null && [ "$i" -lt 20 ]; do
        sleep 0.1
        i=$((i + 1))
    done
fi
if kill -0 "-$task_pid" 2>/dev/null; then
    kill -KILL "-$task_pid" 2>/dev/null || true
    i=0
    while kill -0 "-$task_pid" 2>/dev/null && [ "$i" -lt 20 ]; do
        sleep 0.1
        i=$((i + 1))
    done
fi
if kill -0 "-$task_pid" 2>/dev/null; then
    printf 'cleanup-failed:%s\n' "$task_pid" > "$state_file"
    echo "sandbox process-group cleanup failed for $task_pid" >&2
    exit 125
fi
printf 'done:%s:%s\n' "$task_pid" "$status" > "$state_file"
exit "$status"
'''.strip()
        docker_cmd.extend(
            [
                self.container_name,
                "sh",
                "-c",
                wrapper,
                "xylon-exec-wrapper",
                state_file,
                *command,
            ]
        )

        # Log command (sanitized)
        logger.info(f"Executing in {self.container_name}: {' '.join(command[:3])}")

        start_time = time.monotonic()
        process = None
        stdout_bytes = bytearray()
        stderr_bytes = bytearray()
        stdout_truncated = [False]
        stderr_truncated = [False]
        readers: list[threading.Thread] = []

        try:
            process = subprocess.Popen(
                docker_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            assert process.stdout is not None
            assert process.stderr is not None
            readers = [
                threading.Thread(
                    target=self._drain_bounded,
                    args=(process.stdout, stdout_bytes, stdout_truncated),
                    daemon=True,
                ),
                threading.Thread(
                    target=self._drain_bounded,
                    args=(process.stderr, stderr_bytes, stderr_truncated),
                    daemon=True,
                ),
            ]
            for reader in readers:
                reader.start()

            process.wait(timeout=timeout)
            for reader in readers:
                reader.join(timeout=2)

            duration = time.monotonic() - start_time
            stdout = self._decode_bounded(stdout_bytes, stdout_truncated[0])
            stderr = self._decode_bounded(stderr_bytes, stderr_truncated[0])
            if stdout_truncated[0]:
                logger.warning("stdout exceeded the bounded capture limit")
            if stderr_truncated[0]:
                logger.warning("stderr exceeded the bounded capture limit")

            success = process.returncode == 0

            if not success:
                logger.warning(
                    f"Command failed with exit code {process.returncode}: "
                    f"{stderr[:200]}"
                )

            self._remove_container_state(state_file)
            return ExecutionResult(
                success=success,
                stdout=stdout,
                stderr=stderr,
                exit_code=process.returncode,
                duration_seconds=duration,
                failure_kind=None if success else self._classify_failure(stderr),
            )

        except subprocess.TimeoutExpired as error:
            if process is not None:
                self._stop_host_process(process)
            for reader in readers:
                reader.join(timeout=2)
            stdout = self._decode_bounded(stdout_bytes, stdout_truncated[0])
            stderr = self._decode_bounded(stderr_bytes, stderr_truncated[0])
            cleanup_verified, cleanup_detail = self._cleanup_interrupted_execution(
                state_file
            )
            cleanup_status = (
                f"cleanup verified: {cleanup_detail}"
                if cleanup_verified
                else f"cleanup NOT verified: {cleanup_detail}"
            )
            error_msg = f"Execution timeout ({timeout}s exceeded); {cleanup_status}"
            logger.error(error_msg)

            raise ExecutionError(
                message=error_msg,
                stdout=stdout,
                stderr=stderr,
                exit_code=-1,
                failure_kind="infrastructure",
            ) from error

        except Exception as e:
            cleanup_status = ""
            if process is not None and process.returncode is None:
                try:
                    self._stop_host_process(process)
                    cleanup_verified, cleanup_detail = (
                        self._cleanup_interrupted_execution(state_file)
                    )
                    cleanup_status = (
                        f"; cleanup verified: {cleanup_detail}"
                        if cleanup_verified
                        else f"; cleanup NOT verified: {cleanup_detail}"
                    )
                except Exception as cleanup_error:
                    cleanup_status = f"; cleanup NOT verified: {cleanup_error}"
            logger.error(f"Execution failed: {e}")
            raise ExecutionError(
                message=f"Execution failed: {str(e)}{cleanup_status}",
                stdout="",
                stderr=str(e),
                exit_code=-1,
            ) from e

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
    with open(file_path, encoding='utf-8', errors='replace') as f:
        content = f.read(10000)  # Read first 10KB for inspection

        # Check for system tasks that could leak info
        dangerous_tasks = ['$system', '$fopen', '$fwrite', '$readmem']
        for task in dangerous_tasks:
            if task in content:
                raise ValueError(f"Dangerous system task detected: {task}")

    return True
