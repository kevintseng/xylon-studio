"""
XylonStudio Configuration Constants.

Centralized configuration for timeouts, rate limiting, and other constants
to ensure consistency across the codebase.
"""

# ==================== Rate Limiting Configuration ====================

# Rate limit: 10 requests per minute per user
RATE_LIMIT_MAX_REQUESTS = 10
RATE_LIMIT_WINDOW_SECONDS = 60

# ==================== LLM Configuration ====================

# LLM request timeout (seconds)
LLM_REQUEST_TIMEOUT_SECONDS = 300

# Max retries for LLM requests
LLM_MAX_RETRIES = 3

# ==================== Regex Security ====================

# Regex timeout to prevent ReDoS attacks (milliseconds)
REGEX_TIMEOUT_MS = 100

# ==================== Budget Defaults ====================

# Default daily budget for new users (USD)
DEFAULT_DAILY_BUDGET_USD = 10.0

# Budget alert thresholds (percentage)
BUDGET_ALERT_THRESHOLD_80 = 80
BUDGET_ALERT_THRESHOLD_90 = 90
BUDGET_ALERT_THRESHOLD_100 = 100
