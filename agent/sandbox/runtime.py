"""Single-source pinned EDA runtime specification."""

from __future__ import annotations

import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path

_VERSIONS_FILE = Path(__file__).resolve().parents[2] / "runtime" / "versions.env"
_REQUIRED_KEYS = {
    "XYLON_EDA_IMAGE",
    "BASE_IMAGE",
    "VERILATOR_VERSION",
    "VERILATOR_COMMIT",
    "YOSYS_VERSION",
    "YOSYS_COMMIT",
}


def runtime_project_name(repo_root: str | Path | None = None) -> str:
    """Return a stable Compose project identity unique to this checkout."""
    root = (
        Path(repo_root).expanduser().resolve()
        if repo_root is not None
        else Path(__file__).resolve().parents[2]
    )
    digest = hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:12]
    return f"xylon-{digest}"


def runtime_container_name(service: str, repo_root: str | Path | None = None) -> str:
    """Return the Compose v2 container name for one checkout-owned service."""
    if service not in {"verilator", "yosys"}:
        raise ValueError(f"Unsupported EDA service: {service}")
    return f"{runtime_project_name(repo_root)}-{service}-1"


@dataclass(frozen=True)
class RuntimeSpec:
    """Immutable expected identity of the local EDA execution image."""

    image: str
    base_image: str
    verilator_version: str
    verilator_commit: str
    yosys_version: str
    yosys_commit: str

    def to_dict(self) -> dict:
        return {
            "image": self.image,
            "base_image": self.base_image,
            "verilator": {
                "version": self.verilator_version,
                "commit": self.verilator_commit,
            },
            "yosys": {
                "version": self.yosys_version,
                "commit": self.yosys_commit,
            },
        }


def load_runtime_spec(path: str | Path = _VERSIONS_FILE) -> RuntimeSpec:
    """Load the checked-in runtime pins without accepting shell syntax."""
    values: dict[str, str] = {}
    for raw_line in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"Malformed runtime version line: {raw_line!r}")
        key, value = line.split("=", 1)
        if not key or not value:
            raise ValueError(f"Malformed runtime version line: {raw_line!r}")
        values[key] = value

    missing = sorted(_REQUIRED_KEYS - values.keys())
    if missing:
        raise ValueError(f"Runtime version file is missing: {', '.join(missing)}")

    return RuntimeSpec(
        image=values["XYLON_EDA_IMAGE"],
        base_image=values["BASE_IMAGE"],
        verilator_version=values["VERILATOR_VERSION"],
        verilator_commit=values["VERILATOR_COMMIT"],
        yosys_version=values["YOSYS_VERSION"],
        yosys_commit=values["YOSYS_COMMIT"],
    )


def main() -> None:
    """Print observed runtime identity and fail when it differs from the pins."""
    if sys.argv[1:] == ["--project-name"]:
        print(runtime_project_name())
        return
    from agent.sandbox.manager import SandboxManager

    identity = SandboxManager().get_tool_identity()
    print(json.dumps(identity, indent=2, sort_keys=True))
    if not identity["verified"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
