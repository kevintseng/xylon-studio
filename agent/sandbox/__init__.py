"""
EDA Sandbox Module.

Provides secure, isolated execution environment for EDA tools:
- Verilator (linting, simulation)
- Yosys (synthesis)
- OpenROAD (place & route)

Security features:
- Network isolation (network_mode=none)
- Resource limits (CPU, memory, disk I/O)
- Timeout enforcement
- Input/output validation
- Read-only filesystem (except /tmp)
"""

from agent.sandbox.executor import ExecutionError, ExecutionResult, SandboxExecutor
from agent.sandbox.manager import SandboxManager

__all__ = [
    'SandboxExecutor',
    'ExecutionResult',
    'ExecutionError',
    'SandboxManager',
]
