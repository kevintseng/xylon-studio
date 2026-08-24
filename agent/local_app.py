"""Safe local lifecycle entry point for XylonStudio."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from agent.sandbox.runtime import runtime_project_name as runtime_project_name

REPO_ROOT = Path(__file__).resolve().parents[1]
MINIMUM_PYTHON_VERSION = (3, 11, 0)
MINIMUM_NODE_VERSION = (20, 9, 0)


def _is_valid_port(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 65_535


def _parse_port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("port must be an integer") from exc
    if not _is_valid_port(port):
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def _parse_runtime_version(output: str) -> tuple[int, int, int] | None:
    match = re.search(r"(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?", output)
    if match is None:
        return None
    return tuple(int(part or 0) for part in match.groups())


def _format_runtime_version(version: tuple[int, int, int]) -> str:
    return ".".join(str(part) for part in version)


def evaluate_runtime_version_preflight(
    python_output: str,
    node_output: str,
) -> list[str]:
    blockers: list[str] = []
    checks = (
        ("Python", python_output, MINIMUM_PYTHON_VERSION),
        ("Node.js", node_output, MINIMUM_NODE_VERSION),
    )
    for label, output, minimum in checks:
        observed = _parse_runtime_version(output)
        if observed is None:
            blockers.append(f"could not determine the {label} version")
        elif observed < minimum:
            blockers.append(
                f"{label} {_format_runtime_version(observed)} is below the required "
                f"{_format_runtime_version(minimum)}"
            )
    return blockers


def _read_command_version(command: str) -> str:
    try:
        result = subprocess.run(
            [command, "--version"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return ""
    if result.returncode != 0:
        return ""
    return f"{result.stdout}\n{result.stderr}".strip()


@dataclass(frozen=True)
class ManagedProcess:
    name: str
    pid: int
    command_marker: str
    log_path: str


@dataclass(frozen=True)
class ResourceSnapshot:
    logical_cpus: int
    load_one_minute: float
    memory_free_percent: int | None
    disk_free_bytes: int


def evaluate_resource_preflight(snapshot: ResourceSnapshot) -> list[str]:
    blockers: list[str] = []
    if snapshot.load_one_minute >= snapshot.logical_cpus:
        blockers.append(
            f"CPU load {snapshot.load_one_minute:.2f} has reached "
            f"{snapshot.logical_cpus} logical CPUs"
        )
    if (
        snapshot.memory_free_percent is not None
        and snapshot.memory_free_percent < 20
    ):
        blockers.append(
            f"memory free {snapshot.memory_free_percent}% is below the 20% safety floor"
        )
    disk_free_gib = snapshot.disk_free_bytes / 1024**3
    if disk_free_gib < 10:
        blockers.append(
            f"workspace disk free {disk_free_gib:.1f} GiB is below the 10.0 GiB safety floor"
        )
    return blockers


def collect_resource_snapshot(repo_root: Path) -> ResourceSnapshot:
    logical_cpus = max(os.cpu_count() or 1, 1)
    try:
        load_one_minute = os.getloadavg()[0]
    except (AttributeError, OSError):
        load_one_minute = 0.0

    memory_free_percent: int | None = None
    memory_pressure = shutil.which("memory_pressure")
    if memory_pressure is not None:
        result = subprocess.run(
            [memory_pressure, "-Q"],
            capture_output=True,
            text=True,
            check=False,
        )
        match = re.search(
            r"System-wide memory free percentage:\s*(\d+)%",
            f"{result.stdout}\n{result.stderr}",
        )
        if result.returncode == 0 and match is not None:
            memory_free_percent = int(match.group(1))

    return ResourceSnapshot(
        logical_cpus=logical_cpus,
        load_one_minute=load_one_minute,
        memory_free_percent=memory_free_percent,
        disk_free_bytes=shutil.disk_usage(repo_root).free,
    )


@dataclass(frozen=True)
class LocalState:
    schema_version: int
    runtime_owned: bool
    api_port: int
    web_port: int
    api: ManagedProcess
    web: ManagedProcess

    @classmethod
    def from_dict(cls, payload: object) -> LocalState:
        if not isinstance(payload, dict) or payload.get("schema_version") != 2:
            raise ValueError("unsupported or invalid local state")
        try:
            api = ManagedProcess(**payload["api"])
            web = ManagedProcess(**payload["web"])
            runtime_owned = payload["runtime_owned"]
            api_port = payload["api_port"]
            web_port = payload["web_port"]
        except (KeyError, TypeError) as exc:
            raise ValueError("incomplete local state") from exc
        if not isinstance(runtime_owned, bool):
            raise ValueError("runtime_owned must be boolean")
        if not _is_valid_port(api_port) or not _is_valid_port(web_port):
            raise ValueError("local ports must be between 1 and 65535")
        if api_port == web_port:
            raise ValueError("API and Web ports must be different")
        return cls(
            schema_version=2,
            runtime_owned=runtime_owned,
            api_port=api_port,
            web_port=web_port,
            api=api,
            web=web,
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "runtime_owned": self.runtime_owned,
            "api_port": self.api_port,
            "web_port": self.web_port,
            "api": self.api.__dict__,
            "web": self.web.__dict__,
        }


class RuntimeController(Protocol):
    def is_running(self) -> bool: ...

    def run(self, action: str, *, timeout: float) -> bool: ...


class EdaRuntime:
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root

    def is_running(self) -> bool:
        try:
            result = subprocess.run(
                [str(self.repo_root / "scripts" / "eda-runtime"), "verify"],
                cwd=self.repo_root,
                check=False,
                timeout=30,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        return result.returncode == 0

    def run(self, action: str, *, timeout: float) -> bool:
        try:
            result = subprocess.run(
                [str(self.repo_root / "scripts" / "eda-runtime"), action],
                cwd=self.repo_root,
                check=False,
                timeout=timeout,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            print(f"ERROR: EDA runtime {action} failed: {exc}")
            return False
        return result.returncode == 0


def _process_state(pid: int) -> str | None:
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "stat="],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _process_command(pid: int) -> str | None:
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _process_is_running(pid: int) -> bool:
    state = _process_state(pid)
    return state is not None and not state.startswith("Z")


def _pid_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def terminate_managed_process(
    process: ManagedProcess,
    *,
    grace_seconds: float = 5.0,
) -> str:
    if not _pid_exists(process.pid):
        return "not_running"
    command = _process_command(process.pid)
    state = _process_state(process.pid)
    if command is None or state is None:
        return "identity_unavailable"
    if state.startswith("Z"):
        return "not_running"
    if process.command_marker not in command:
        return "identity_mismatch"

    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return "not_running"

    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        if not _process_is_running(process.pid):
            return "stopped"
        time.sleep(0.05)

    if _process_is_running(process.pid):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return "stopped"


class LocalApplication:
    def __init__(
        self,
        *,
        repo_root: Path = REPO_ROOT,
        state_dir: Path | None = None,
        api_port: int = 5001,
        web_port: int = 3000,
        api_command: list[str] | None = None,
        web_command: list[str] | None = None,
        api_command_marker: str = "agent.api.main:app",
        web_command_marker: str = "next-server",
        api_cwd: Path | None = None,
        web_cwd: Path | None = None,
        runtime: RuntimeController | None = None,
        resource_probe: Callable[[], ResourceSnapshot] | None = None,
    ) -> None:
        if not _is_valid_port(api_port) or not _is_valid_port(web_port):
            raise ValueError("local ports must be between 1 and 65535")
        if api_port == web_port:
            raise ValueError("API and Web ports must be different")
        self.repo_root = repo_root.resolve()
        self.state_dir = state_dir or self.repo_root / ".xylon" / "local"
        self.state_path = self.state_dir / "state.json"
        self.api_port = api_port
        self.web_port = web_port
        self.api_url = f"http://127.0.0.1:{api_port}"
        self.web_url = f"http://127.0.0.1:{web_port}"
        self.api_command = api_command or [
            str(self.repo_root / "agent" / "venv" / "bin" / "uvicorn"),
            "agent.api.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(api_port),
            "--workers",
            "1",
        ]
        self.web_command = web_command or [
            shutil.which("node") or "node",
            ".next/standalone/server.js",
        ]
        self.api_command_marker = api_command_marker
        self.web_command_marker = web_command_marker
        self.api_cwd = (api_cwd or self.repo_root).resolve()
        self.web_cwd = (web_cwd or self.repo_root / "web").resolve()
        self.runtime = runtime or EdaRuntime(self.repo_root)
        self.resource_probe = resource_probe or (
            lambda: collect_resource_snapshot(self.repo_root)
        )

    def _load_state(self) -> LocalState | None:
        if not self.state_path.exists():
            return None
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
            return LocalState.from_dict(payload)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            raise RuntimeError(
                f"cannot safely read {self.state_path}: {exc}"
            ) from exc

    def _write_state(self, state: LocalState) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(state.to_dict(), indent=2) + "\n",
            encoding="utf-8",
        )
        temporary.replace(self.state_path)

    def _spawn(
        self,
        command: list[str],
        log_path: Path,
        *,
        cwd: Path,
        environment: dict[str, str] | None = None,
    ) -> subprocess.Popen[bytes]:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_handle = log_path.open("wb", buffering=0)
        try:
            return subprocess.Popen(
                command,
                cwd=cwd,
                env=environment,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
        finally:
            log_handle.close()

    @staticmethod
    def _http_matches(url: str, expected: bytes, *, json_status: bool = False) -> bool:
        try:
            with urlopen(url, timeout=0.5) as response:
                body = response.read(1_000_000)
                if response.status != 200:
                    return False
        except (HTTPError, URLError, OSError):
            return False
        if json_status:
            try:
                return json.loads(body).get("status") == "healthy"
            except (json.JSONDecodeError, AttributeError):
                return False
        return expected in body

    def _wait_for_health(
        self,
        process: subprocess.Popen[bytes],
        url: str,
        expected: bytes,
        *,
        timeout: float,
        json_status: bool = False,
    ) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process.poll() is not None:
                return False
            if self._http_matches(url, expected, json_status=json_status):
                return True
            time.sleep(0.05)
        return False

    def _rollback(self, state: LocalState, *, grace_seconds: float = 1.0) -> None:
        for process in (state.web, state.api):
            terminate_managed_process(process, grace_seconds=grace_seconds)
        if state.runtime_owned:
            self.runtime.run("down", timeout=60)
        self.state_path.unlink(missing_ok=True)

    def start(self, *, health_timeout: float = 15.0) -> int:
        try:
            existing = self._load_state()
        except RuntimeError as exc:
            print(f"ERROR: {exc}")
            return 1
        if existing is not None:
            if self.status() == 0:
                print(
                    "ALREADY RUNNING: XylonStudio "
                    f"http://127.0.0.1:{existing.web_port}/pipeline"
                )
                return 0
            print(f"ERROR: launcher state already exists at {self.state_path}")
            print("RECOVERY: run scripts/xylon status, then scripts/xylon stop")
            return 1
        if _port_is_open(self.api_port) or _port_is_open(self.web_port):
            print("ERROR: API or Web port is already in use")
            print(f"RECOVERY: free 127.0.0.1:{self.api_port} and 127.0.0.1:{self.web_port}")
            return 1

        resource_blockers = evaluate_resource_preflight(self.resource_probe())
        if resource_blockers:
            for blocker in resource_blockers:
                print(f"RESOURCE BLOCKED: {blocker}")
            print("RECOVERY: wait for load to fall or free local capacity, then rerun start")
            return 1

        runtime_owned = not self.runtime.is_running()
        if runtime_owned and not self.runtime.run("up", timeout=900):
            return 1
        if not self.runtime.run("verify", timeout=60):
            if runtime_owned:
                self.runtime.run("down", timeout=60)
            return 1

        api_log = self.state_dir / "api.log"
        web_log = self.state_dir / "web.log"
        api_process: subprocess.Popen[bytes] | None = None
        web_process: subprocess.Popen[bytes] | None = None
        state: LocalState | None = None
        try:
            api_environment = os.environ.copy()
            api_environment["XYLON_WEB_PORT"] = str(self.web_port)
            api_process = self._spawn(
                self.api_command,
                api_log,
                cwd=self.api_cwd,
                environment=api_environment,
            )
            if not self._wait_for_health(
                api_process,
                f"{self.api_url}/health",
                b"healthy",
                timeout=health_timeout,
                json_status=True,
            ):
                raise RuntimeError(f"API did not become healthy; inspect {api_log}")

            web_environment = os.environ.copy()
            web_environment.update({"HOSTNAME": "127.0.0.1", "PORT": str(self.web_port)})
            web_process = self._spawn(
                self.web_command,
                web_log,
                cwd=self.web_cwd,
                environment=web_environment,
            )
            state = LocalState(
                schema_version=2,
                runtime_owned=runtime_owned,
                api_port=self.api_port,
                web_port=self.web_port,
                api=ManagedProcess("api", api_process.pid, self.api_command_marker, str(api_log)),
                web=ManagedProcess("web", web_process.pid, self.web_command_marker, str(web_log)),
            )
            self._write_state(state)
            if not self._wait_for_health(
                web_process,
                f"{self.web_url}/pipeline",
                b"XylonStudio",
                timeout=health_timeout,
            ):
                raise RuntimeError(f"Web did not become healthy; inspect {web_log}")
        except (OSError, RuntimeError, KeyboardInterrupt) as exc:
            print(f"ERROR: local start failed: {exc}")
            if state is None:
                state = LocalState(
                    schema_version=2,
                    runtime_owned=runtime_owned,
                    api_port=self.api_port,
                    web_port=self.web_port,
                    api=ManagedProcess("api", api_process.pid if api_process else -1, self.api_command_marker, str(api_log)),
                    web=ManagedProcess("web", web_process.pid if web_process else -1, self.web_command_marker, str(web_log)),
                )
            self._rollback(state)
            return 1

        print(f"READY: XylonStudio {self.web_url}/pipeline")
        print(f"HEALTHY: API {self.api_url}/health")
        print(f"LOGS: {self.state_dir}")
        return 0

    def status(self) -> int:
        try:
            state = self._load_state()
        except RuntimeError as exc:
            print(f"ERROR: {exc}")
            return 1
        if state is None:
            print("STOPPED: no launcher-owned local services")
            return 1

        api_owned = self.api_command_marker in (_process_command(state.api.pid) or "")
        web_owned = self.web_command_marker in (_process_command(state.web.pid) or "")
        api_url = f"http://127.0.0.1:{state.api_port}"
        web_url = f"http://127.0.0.1:{state.web_port}"
        api_healthy = api_owned and self._http_matches(
            f"{api_url}/health", b"healthy", json_status=True
        )
        web_healthy = web_owned and self._http_matches(
            f"{web_url}/pipeline", b"XylonStudio"
        )
        print(f"{'HEALTHY' if api_healthy else 'UNHEALTHY'}: API {api_url}")
        print(f"{'HEALTHY' if web_healthy else 'UNHEALTHY'}: Web {web_url}")
        runtime_healthy = self.runtime.is_running()
        print(f"{'HEALTHY' if runtime_healthy else 'UNHEALTHY'}: pinned EDA runtime")
        return 0 if api_healthy and web_healthy and runtime_healthy else 1

    def logs(self, *, tail: int = 80) -> int:
        if tail < 1 or tail > 1_000:
            print("ERROR: --tail must be between 1 and 1000")
            return 2

        found = False
        for name in ("api", "web"):
            path = self.state_dir / f"{name}.log"
            print(f"== {name.upper()} {path} ==")
            if not path.exists():
                print("No log file available")
                continue
            found = True
            try:
                with path.open(encoding="utf-8", errors="replace") as handle:
                    lines = deque(handle, maxlen=tail)
            except OSError as exc:
                print(f"ERROR: cannot read log: {exc}")
                continue
            print("".join(lines), end="" if lines and lines[-1].endswith("\n") else "\n")
        return 0 if found else 1

    def stop(self, *, grace_seconds: float = 5.0) -> int:
        try:
            state = self._load_state()
        except RuntimeError as exc:
            print(f"ERROR: {exc}")
            return 1

        if state is None:
            print("STOPPED: no launcher-owned local services")
            return 0

        unresolved = False
        for process in (state.web, state.api):
            outcome = terminate_managed_process(
                process,
                grace_seconds=grace_seconds,
            )
            print(f"{process.name}: {outcome}")
            unresolved = unresolved or outcome in {
                "identity_mismatch",
                "identity_unavailable",
            }

        if state.runtime_owned and not self.runtime.run("down", timeout=60):
            unresolved = True

        if unresolved:
            print(f"RECOVERY: inspect ownership state at {self.state_path}")
            return 1

        self.state_path.unlink(missing_ok=True)
        print("STOPPED: launcher-owned local services")
        return 0


def _port_is_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def doctor(*, api_port: int = 5001, web_port: int = 3000) -> int:
    required_paths = {
        "Python API environment": REPO_ROOT / "agent" / "venv" / "bin" / "python",
        "Uvicorn": REPO_ROOT / "agent" / "venv" / "bin" / "uvicorn",
        "Production Web build": REPO_ROOT / "web" / ".next" / "BUILD_ID",
        "Standalone Web server": REPO_ROOT / "web" / ".next" / "standalone" / "server.js",
        "Standalone public assets": REPO_ROOT / "web" / ".next" / "standalone" / "public",
        "Standalone static assets": (
            REPO_ROOT / "web" / ".next" / "standalone" / ".next" / "static"
        ),
    }
    missing = [label for label, path in required_paths.items() if not path.exists()]
    node_path = shutil.which("node")
    if node_path is None:
        missing.append("Node.js")
    if shutil.which("docker") is None:
        missing.append("Docker CLI")

    if missing:
        for label in missing:
            print(f"MISSING: {label}")
        print("RECOVERY: install dependencies and build the Web UI before starting Xylon")
        return 1

    version_blockers = evaluate_runtime_version_preflight(
        _read_command_version(str(required_paths["Python API environment"])),
        _read_command_version(node_path),
    )
    if version_blockers:
        for blocker in version_blockers:
            print(f"INCOMPATIBLE: {blocker}")
        print(
            "RECOVERY: install Python 3.11+ and Node.js 20.9+, "
            "then recreate dependencies and the Web build"
        )
        return 1

    print("READY: local prerequisites are available")
    resources = collect_resource_snapshot(REPO_ROOT)
    resource_blockers = evaluate_resource_preflight(resources)
    if resource_blockers:
        for blocker in resource_blockers:
            print(f"RESOURCE BLOCKED: {blocker}")
    else:
        memory = (
            f"{resources.memory_free_percent}%"
            if resources.memory_free_percent is not None
            else "Unavailable"
        )
        print(
            "RESOURCE READY: "
            f"load={resources.load_one_minute:.2f}/{resources.logical_cpus} CPUs "
            f"memory_free={memory} "
            f"disk_free={resources.disk_free_bytes / 1024**3:.1f} GiB"
        )
    api_url = f"http://127.0.0.1:{api_port}"
    web_url = f"http://127.0.0.1:{web_port}"
    api_state = "LISTENING" if _port_is_open(api_port) else "STOPPED"
    web_state = "LISTENING" if _port_is_open(web_port) else "STOPPED"
    print(f"{api_state}: API {api_url}")
    print(f"{web_state}: Web {web_url}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage the local XylonStudio application")
    parser.add_argument("command", choices=("doctor", "start", "status", "logs", "stop"))
    parser.add_argument("--tail", type=int, default=80, help="lines per service for logs")
    parser.add_argument(
        "--web-port",
        type=_parse_port,
        default=3000,
        help="localhost Web port (default: 3000)",
    )
    args = parser.parse_args()

    if args.command == "doctor":
        return doctor(web_port=args.web_port)
    app = LocalApplication(web_port=args.web_port)
    if args.command == "start":
        if doctor(web_port=args.web_port) != 0:
            return 1
        return app.start()
    if args.command == "status":
        return app.status()
    if args.command == "logs":
        return app.logs(tail=args.tail)
    if args.command == "stop":
        return app.stop()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
