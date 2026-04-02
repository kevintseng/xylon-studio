"""
Input Validator for XylonStudio.

Protects against:
1. Prompt Injection attacks
2. RTL code injection (malicious Verilog)
3. Resource exhaustion attacks
4. Invalid design specifications

Defense Layers:
- Blacklist pattern matching (known attack vectors)
- Input length limits
- Character whitelist for identifiers
- Syntax validation for design constraints

Usage:
    from agent.core.input_validator import validate_design_spec, InputValidationError

    try:
        validate_design_spec(design_spec)
    except InputValidationError as e:
        return {"error": str(e), "status": 400}
"""

import re
import regex  # pip install regex - for timeout support
import logging
from typing import Dict, Any, List
from pydantic import BaseModel, Field, validator

from agent.config import REGEX_TIMEOUT_MS

logger = logging.getLogger(__name__)


# ==================== Exceptions ====================


class InputValidationError(Exception):
    """Raised when input validation fails."""

    def __init__(self, message: str, field: str = None, pattern: str = None):
        self.message = message
        self.field = field
        self.pattern = pattern
        super().__init__(self.message)


# ==================== Regex Helper with Timeout ====================


def safe_regex_search(pattern: str, text: str, flags=0) -> bool:
    """
    Perform regex search with timeout to prevent ReDoS attacks.

    Args:
        pattern: Regex pattern to search
        text: Text to search in
        flags: Regex flags (e.g., regex.IGNORECASE)

    Returns:
        True if pattern found, False otherwise

    Raises:
        InputValidationError: If regex timeout (potential ReDoS attack)
    """
    try:
        timeout_seconds = REGEX_TIMEOUT_MS / 1000.0
        match = regex.search(pattern, text, flags=flags, timeout=timeout_seconds)
        return match is not None
    except TimeoutError:
        # Treat timeout as potential ReDoS attack
        logger.warning(
            f"Regex timeout detected (pattern: {pattern[:50]}..., "
            f"text_length: {len(text)}) - possible ReDoS attack"
        )
        raise InputValidationError(
            message="Input validation timeout - text too complex or potential attack",
            field="unknown",
            pattern=pattern
        )


# ==================== Attack Pattern Blacklist ====================

# Prompt injection patterns (case-insensitive)
PROMPT_INJECTION_PATTERNS = [
    # Direct instruction override
    r"ignore\s+(all\s+)?(previous|prior|earlier)\s+(instruction|prompt|rule|context)",
    r"disregard\s+(all\s+)?(previous|prior|earlier)",
    r"forget\s+(everything|all|instructions|context)",
    r"new\s+instruction",
    r"system\s+prompt",

    # Role manipulation
    r"you\s+are\s+(now\s+)?a\s+(different|new|admin|root|superuser)",
    r"act\s+as\s+(if\s+you\s+are\s+)?(admin|root|developer|system)",
    r"pretend\s+(to\s+be|you\s+are)",

    # Data exfiltration
    r"(show|reveal|display|print)\s+(your\s+)?(api\s+key|secret|token|password|credential)",
    r"what\s+(is|are)\s+your\s+(api\s+key|secret|instruction)",

    # Command injection
    r"execute\s+(command|code|script|bash|shell)",
    r"run\s+(command|script|bash|python)",
    r"eval\s*\(",
    r"exec\s*\(",
    r"system\s*\(",
    r"subprocess\.",

    # Jailbreak attempts
    r"jailbreak",
    r"bypass\s+(safety|filter|restriction|validation)",
    r"hack\s+mode",
    r"developer\s+mode",

    # Encoding tricks
    r"base64",
    r"hex\s+encode",
    r"unicode\s+escape",

    # Delimiter confusion
    r"```\s*(python|bash|javascript|sql)",  # Code blocks in description
    r"<script",
    r"<iframe",
]

# RTL-specific malicious patterns
RTL_INJECTION_PATTERNS = [
    # Infinite loops
    r"while\s*\(\s*1\s*\)",
    r"always\s+@\s*\(\s*\*\s*\)",  # Combinational loop risk

    # Resource exhaustion
    r"generate\s+for.*1000000",  # Massive generate blocks
    r"reg\s+\[.*:.*\]\s+\w+\s*\[.*1000000.*\]",  # Huge arrays

    # System tasks (Verilog built-ins that could leak info)
    r"\$system\s*\(",
    r"\$fopen\s*\(",
    r"\$fwrite\s*\(",
    r"\$readmem",

    # Suspicious module names
    r"module\s+(exploit|hack|backdoor|trojan|malware)",
]


# ==================== Validation Constraints ====================

class DesignConstraints:
    """Maximum allowed values to prevent resource exhaustion."""

    MAX_DESCRIPTION_LENGTH = 5000  # characters
    MAX_MODULE_NAME_LENGTH = 128
    MAX_TARGET_FREQ_LENGTH = 50
    MAX_CONSTRAINT_VALUE_LENGTH = 100

    # Identifier whitelist (module names, signal names)
    VALID_IDENTIFIER_PATTERN = r'^[a-zA-Z_][a-zA-Z0-9_]*$'

    # Frequency format: "2 GHz", "100 MHz", "500 KHz"
    VALID_FREQUENCY_PATTERN = r'^\d+(\.\d+)?\s*(GHz|MHz|KHz|Hz)$'

    # Area format: "10000 um²", "1.5 mm²"
    VALID_AREA_PATTERN = r'^\d+(\.\d+)?\s*(um²|mm²|μm²)$'

    # Power format: "500 mW", "1.2 W"
    VALID_POWER_PATTERN = r'^\d+(\.\d+)?\s*(mW|W)$'


# ==================== Pydantic Models ====================


class DesignSpec(BaseModel):
    """
    Validated design specification.

    All fields are sanitized and checked against attack patterns.
    """

    description: str = Field(..., min_length=10, max_length=DesignConstraints.MAX_DESCRIPTION_LENGTH)
    target_freq: str = Field(..., max_length=DesignConstraints.MAX_TARGET_FREQ_LENGTH)
    module_name: str = Field(None, max_length=DesignConstraints.MAX_MODULE_NAME_LENGTH)
    max_area: str = Field(None, max_length=DesignConstraints.MAX_CONSTRAINT_VALUE_LENGTH)
    max_power: str = Field(None, max_length=DesignConstraints.MAX_CONSTRAINT_VALUE_LENGTH)

    @validator('description')
    def validate_description(cls, v):
        """Check description for prompt injection patterns."""
        v_lower = v.lower()

        for pattern in PROMPT_INJECTION_PATTERNS:
            if safe_regex_search(pattern, v_lower, flags=regex.IGNORECASE):
                raise InputValidationError(
                    message=f"Potentially malicious input detected",
                    field="description",
                    pattern=pattern
                )

        # Check for RTL injection patterns
        for pattern in RTL_INJECTION_PATTERNS:
            if safe_regex_search(pattern, v, flags=regex.IGNORECASE):
                raise InputValidationError(
                    message=f"Potentially malicious RTL pattern detected",
                    field="description",
                    pattern=pattern
                )

        return v

    @validator('target_freq')
    def validate_target_freq(cls, v):
        """Validate frequency format."""
        if not re.match(DesignConstraints.VALID_FREQUENCY_PATTERN, v, re.IGNORECASE):
            raise InputValidationError(
                message=f"Invalid frequency format: '{v}'. Expected format: '2 GHz', '100 MHz'",
                field="target_freq"
            )
        return v

    @validator('module_name')
    def validate_module_name(cls, v):
        """Validate module name is a valid Verilog identifier."""
        if v is None:
            return v

        if not re.match(DesignConstraints.VALID_IDENTIFIER_PATTERN, v):
            raise InputValidationError(
                message=f"Invalid module name: '{v}'. Must be a valid Verilog identifier",
                field="module_name"
            )
        return v

    @validator('max_area')
    def validate_max_area(cls, v):
        """Validate area format."""
        if v is None:
            return v

        if not re.match(DesignConstraints.VALID_AREA_PATTERN, v, re.IGNORECASE):
            raise InputValidationError(
                message=f"Invalid area format: '{v}'. Expected format: '10000 um²', '1.5 mm²'",
                field="max_area"
            )
        return v

    @validator('max_power')
    def validate_max_power(cls, v):
        """Validate power format."""
        if v is None:
            return v

        if not re.match(DesignConstraints.VALID_POWER_PATTERN, v, re.IGNORECASE):
            raise InputValidationError(
                message=f"Invalid power format: '{v}'. Expected format: '500 mW', '1.2 W'",
                field="max_power"
            )
        return v


# ==================== Validation Functions ====================


def validate_design_spec(spec_dict: Dict[str, Any]) -> DesignSpec:
    """
    Validate design specification against security rules.

    Args:
        spec_dict: Raw design specification dictionary

    Returns:
        Validated DesignSpec instance

    Raises:
        InputValidationError: If validation fails

    Example:
        spec = {
            "description": "8-bit ripple carry adder",
            "target_freq": "100 MHz",
            "max_area": "5000 um²"
        }

        try:
            validated = validate_design_spec(spec)
        except InputValidationError as e:
            print(f"Validation failed: {e.message}")
    """
    try:
        validated_spec = DesignSpec(**spec_dict)
        logger.info(f"Input validation passed: {validated_spec.description[:50]}...")
        return validated_spec

    except InputValidationError:
        # Re-raise InputValidationError as-is
        raise

    except Exception as e:
        # Wrap Pydantic validation errors
        logger.error(f"Input validation failed: {e}")
        raise InputValidationError(
            message=f"Invalid design specification: {str(e)}"
        ) from e


def sanitize_user_input(text: str, max_length: int = 5000) -> str:
    """
    Sanitize user input by removing potentially dangerous characters.

    Args:
        text: User input text
        max_length: Maximum allowed length

    Returns:
        Sanitized text

    Example:
        safe_text = sanitize_user_input("Hello <script>alert(1)</script>")
        # Returns: "Hello alert(1)"
    """
    # Truncate to max length
    text = text[:max_length]

    # Remove HTML tags
    text = re.sub(r'<[^>]+>', '', text)

    # Remove control characters (except newline, tab)
    text = re.sub(r'[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]', '', text)

    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text).strip()

    return text


def check_for_attack_patterns(text: str) -> List[str]:
    """
    Check text for known attack patterns.

    Args:
        text: Text to check

    Returns:
        List of matched patterns (empty if safe)

    Example:
        patterns = check_for_attack_patterns("Ignore all previous instructions")
        if patterns:
            print(f"Attack detected: {patterns}")
    """
    matched_patterns = []
    text_lower = text.lower()

    # Check prompt injection patterns
    for pattern in PROMPT_INJECTION_PATTERNS:
        if safe_regex_search(pattern, text_lower, flags=regex.IGNORECASE):
            matched_patterns.append(f"prompt_injection:{pattern}")

    # Check RTL injection patterns
    for pattern in RTL_INJECTION_PATTERNS:
        if safe_regex_search(pattern, text, flags=regex.IGNORECASE):
            matched_patterns.append(f"rtl_injection:{pattern}")

    if matched_patterns:
        logger.warning(
            f"Attack patterns detected: {matched_patterns}",
            extra={'text_preview': text[:100]}
        )

    return matched_patterns


# ==================== Rate Limiting Validator ====================

# Lua script for atomic rate limit check-and-increment
RATE_LIMIT_SCRIPT = """
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local current = redis.call('GET', key)

if current == false then
    -- First request in window
    redis.call('SETEX', key, ttl, 1)
    return 1
end

current = tonumber(current)

if current >= limit then
    -- Rate limit exceeded, return -1
    return -1
end

-- Increment and return new count
return redis.call('INCR', key)
"""


def validate_request_rate(user_id: str, redis_client) -> bool:
    """
    Check if user has exceeded rate limit using atomic Lua script.

    Rate limit: 10 requests per minute per user.

    Args:
        user_id: User identifier
        redis_client: Redis client instance

    Returns:
        True if request is allowed

    Raises:
        InputValidationError: If rate limit exceeded

    Example:
        try:
            validate_request_rate("user-123", redis_client)
        except InputValidationError:
            return {"error": "Rate limit exceeded", "status": 429}
    """
    from agent.config import RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS

    key = f"rate_limit:{user_id}"

    # Register and execute Lua script atomically
    rate_limit_lua = redis_client.register_script(RATE_LIMIT_SCRIPT)
    result = rate_limit_lua(keys=[key], args=[RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS])

    if result == -1:
        raise InputValidationError(
            message=f"Rate limit exceeded: {RATE_LIMIT_MAX_REQUESTS} requests per {RATE_LIMIT_WINDOW_SECONDS}s",
            field="rate_limit"
        )

    return True
