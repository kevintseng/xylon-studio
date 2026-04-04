"""
XylonStudio Dragons - Base classes for AI agents.

Dragon System:
- Design Dragon: RTL generation
- Verification Dragon: Testbench + Coverage
- Optimization Dragon: Timing Closure
- Guardian Dragon: DRC/LVS Verification

All dragons must implement the Dragon base class interface.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Generic, TypeVar

# Type variables for generic Dragon
Input = TypeVar('Input')
Output = TypeVar('Output')


@dataclass
class DragonMetrics:
    """
    Performance metrics for Dragon execution.

    Attributes:
        start_time: UTC timestamp when Dragon started
        end_time: UTC timestamp when Dragon finished
        duration_seconds: Total execution time
        llm_calls: Number of LLM API calls made
        llm_total_tokens: Total tokens consumed
        success: Whether Dragon completed successfully
        quality_score: Output quality score (0.0-1.0)
    """
    start_time: datetime
    end_time: datetime
    duration_seconds: float
    llm_calls: int
    llm_total_tokens: int
    success: bool
    quality_score: float

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for logging."""
        return {
            'start_time': self.start_time.isoformat(),
            'end_time': self.end_time.isoformat(),
            'duration_seconds': self.duration_seconds,
            'llm_calls': self.llm_calls,
            'llm_total_tokens': self.llm_total_tokens,
            'success': self.success,
            'quality_score': self.quality_score,
        }


class DragonError(Exception):
    """Base exception for all Dragon errors."""
    pass


class Dragon(ABC, Generic[Input, Output]):
    """
    Base class for all XylonStudio dragons.

    Design Principles:
    1. Single Responsibility: Each dragon does ONE task only
    2. Idempotent: Same input → same output
    3. Fail-Safe: Errors don't corrupt existing work
    4. Observable: All actions are logged
    5. Testable: Unit + Integration + E2E tests

    Subclasses must implement:
    - process(): Main processing logic
    - validate_input(): Input validation
    - get_metrics(): Performance metrics
    """

    def __init__(self, llm_endpoint: str):
        """
        Initialize dragon with LLM endpoint.

        Args:
            llm_endpoint: URL of LLM API (e.g., "http://localhost:8000")
        """
        self.llm_endpoint = llm_endpoint
        self._metrics: DragonMetrics | None = None

    @abstractmethod
    def process(self, input_data: Input) -> Output:
        """
        Main processing method.

        This is the core Dragon logic that transforms input to output.
        Must be idempotent (same input → same output).

        Args:
            input_data: Dragon-specific input

        Returns:
            Dragon-specific output

        Raises:
            DragonError: If processing fails
        """
        pass

    @abstractmethod
    def validate_input(self, input_data: Input) -> bool:
        """
        Validate input before processing.

        Should check:
        - Required fields present
        - Data types correct
        - Values within valid ranges
        - No malicious patterns

        Args:
            input_data: Input to validate

        Returns:
            True if input is valid

        Raises:
            DragonError: If validation fails (with reason)
        """
        pass

    @abstractmethod
    def get_metrics(self) -> DragonMetrics:
        """
        Return performance metrics for last execution.

        Metrics include:
        - Execution time
        - LLM calls made
        - Tokens consumed
        - Success status
        - Quality score

        Returns:
            DragonMetrics instance

        Raises:
            DragonError: If no execution has occurred yet
        """
        pass


__all__ = [
    'Dragon',
    'DragonError',
    'DragonMetrics',
]

# Import dragons for convenience (re-exports)
try:
    from agent.dragons.design import DesignDragon, DesignDragonError  # noqa: F401
    from agent.dragons.verification import (  # noqa: F401
        VerificationDragon,
        VerificationDragonError,
    )

    __all__.extend([
        'DesignDragon',
        'DesignDragonError',
        'VerificationDragon',
        'VerificationDragonError',
    ])
except ImportError:
    # Dragons not yet implemented
    pass
