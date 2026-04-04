"""
XylonStudio Data Models.

Shared data models used across Dragons, API routes, and workflows.
"""

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class DesignSpec:
    """
    Design specification for RTL generation.

    Attributes:
        description: Natural language description of the design
        target_freq: Target clock frequency (e.g., "2 GHz")
        module_name: Desired Verilog module name (optional)
        max_area: Maximum area constraint (e.g., "10000 um²")
        max_power: Maximum power constraint (e.g., "15 mW")
    """
    description: str
    target_freq: str
    module_name: str | None = None
    max_area: str | None = None
    max_power: str | None = None


@dataclass
class RTLCode:
    """
    Generated RTL code with metadata.

    Attributes:
        module_name: Verilog module name
        file_path: Path to saved .v file
        code: Verilog source code
        lines_of_code: Number of lines
        quality_score: Quality score (0.0-1.0)
        lint_warnings: Verilator lint warnings
        estimated_area: Estimated area in um² (optional)
        estimated_power: Estimated power in mW (optional)
        generated_at: Generation timestamp
    """
    module_name: str
    file_path: str
    code: str
    lines_of_code: int
    quality_score: float
    lint_warnings: list[str] = field(default_factory=list)
    estimated_area: float | None = None
    estimated_power: float | None = None
    generated_at: datetime = field(default_factory=datetime.utcnow)


@dataclass
class TestReport:
    """
    Verification test report.

    Attributes:
        testbench_file_path: Path to generated testbench
        test_cases_passed: Number of passed test cases
        test_cases_failed: Number of failed test cases
        code_coverage: Code coverage (0.0-1.0)
        waveform_file_path: Path to VCD waveform file (optional)
        errors: List of error messages
        generated_at: Verification timestamp
    """
    testbench_file_path: str
    test_cases_passed: int
    test_cases_failed: int
    code_coverage: float
    waveform_file_path: str | None = None
    errors: list[str] = field(default_factory=list)
    generated_at: datetime = field(default_factory=datetime.utcnow)
