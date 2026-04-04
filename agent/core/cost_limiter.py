"""
Cost Limiter for XylonStudio.

Tracks and enforces user spending limits to prevent cost attacks.

Features:
- Daily budget limits ($10/day per user by default)
- Real-time cost tracking
- Automatic reset at midnight UTC
- Cost estimation before task execution
- Budget alerts (80%, 90%, 100%)

Architecture:
- Redis stores user quota and spending data
- TTL-based automatic reset (24 hours)
- Atomic increment operations (thread-safe)

Usage:
    from agent.core.cost_limiter import (
        check_user_budget,
        record_llm_cost,
        get_user_spending_summary
    )

    # Before starting workflow
    try:
        check_user_budget(user_id="user-123", estimated_cost_usd=0.05)
    except QuotaExceededError as e:
        return {"error": str(e), "status": 402}

    # After LLM call
    record_llm_cost(
        user_id="user-123",
        workflow_id="wf-456",
        cost_usd=0.0352,
        model="qwen2.5-coder-32b",
        input_tokens=1500,
        output_tokens=800
    )
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)


# ==================== Exceptions ====================


class QuotaExceededError(Exception):
    """Raised when user exceeds spending limit."""

    def __init__(
        self,
        message: str,
        user_id: str,
        spent_usd: float,
        budget_usd: float,
        remaining_usd: float,
    ):
        self.message = message
        self.user_id = user_id
        self.spent_usd = spent_usd
        self.budget_usd = budget_usd
        self.remaining_usd = remaining_usd
        super().__init__(self.message)


# ==================== Data Models ====================


@dataclass
class UserQuota:
    """
    User spending quota and limits.

    Attributes:
        user_id: User identifier
        daily_budget_usd: Daily spending limit (default $10)
        spent_today_usd: Amount spent today
        request_count_today: Number of requests today
        last_reset_date: Date of last quota reset (YYYY-MM-DD)
        alert_sent_80: Whether 80% alert was sent
        alert_sent_90: Whether 90% alert was sent
        alert_sent_100: Whether 100% alert was sent
    """

    user_id: str
    daily_budget_usd: float = 10.0
    spent_today_usd: float = 0.0
    request_count_today: int = 0
    last_reset_date: str = field(default_factory=lambda: datetime.utcnow().strftime('%Y-%m-%d'))
    alert_sent_80: bool = False
    alert_sent_90: bool = False
    alert_sent_100: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for Redis storage."""
        return {
            'user_id': self.user_id,
            'daily_budget_usd': self.daily_budget_usd,
            'spent_today_usd': self.spent_today_usd,
            'request_count_today': self.request_count_today,
            'last_reset_date': self.last_reset_date,
            'alert_sent_80': self.alert_sent_80,
            'alert_sent_90': self.alert_sent_90,
            'alert_sent_100': self.alert_sent_100,
        }

    def to_json(self) -> str:
        """Serialize to JSON."""
        return json.dumps(self.to_dict())

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> 'UserQuota':
        """Create from dictionary."""
        return cls(**data)

    @classmethod
    def from_json(cls, json_str: str) -> 'UserQuota':
        """Deserialize from JSON."""
        data = json.loads(json_str)
        return cls.from_dict(data)

    def remaining_budget_usd(self) -> float:
        """Calculate remaining budget."""
        return max(0.0, self.daily_budget_usd - self.spent_today_usd)

    def usage_percentage(self) -> float:
        """Calculate usage percentage (0-100)."""
        if self.daily_budget_usd == 0:
            return 0.0
        return (self.spent_today_usd / self.daily_budget_usd) * 100

    def needs_reset(self) -> bool:
        """Check if quota needs to be reset (new day)."""
        today = datetime.utcnow().strftime('%Y-%m-%d')
        return self.last_reset_date != today

    def reset(self):
        """Reset quota for new day."""
        self.spent_today_usd = 0.0
        self.request_count_today = 0
        self.last_reset_date = datetime.utcnow().strftime('%Y-%m-%d')
        self.alert_sent_80 = False
        self.alert_sent_90 = False
        self.alert_sent_100 = False


@dataclass
class LLMCostRecord:
    """
    Record of a single LLM API call cost.

    Attributes:
        user_id: User identifier
        workflow_id: Workflow identifier
        timestamp: UTC timestamp
        cost_usd: Cost in USD
        model: LLM model name
        input_tokens: Number of input tokens
        output_tokens: Number of output tokens
        dragon_type: Which Dragon made the call (design, verification, etc.)
    """

    user_id: str
    workflow_id: str
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    cost_usd: float = 0.0
    model: str = 'unknown'
    input_tokens: int = 0
    output_tokens: int = 0
    dragon_type: str = 'unknown'

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            'user_id': self.user_id,
            'workflow_id': self.workflow_id,
            'timestamp': self.timestamp,
            'cost_usd': self.cost_usd,
            'model': self.model,
            'input_tokens': self.input_tokens,
            'output_tokens': self.output_tokens,
            'dragon_type': self.dragon_type,
        }

    def to_json(self) -> str:
        """Serialize to JSON."""
        return json.dumps(self.to_dict())


# ==================== Redis Key Helpers ====================


def _quota_key(user_id: str) -> str:
    """Generate Redis key for user quota."""
    return f"quota:{user_id}"


def _cost_history_key(user_id: str, date: str = None) -> str:
    """Generate Redis key for user cost history."""
    if date is None:
        date = datetime.utcnow().strftime('%Y-%m-%d')
    return f"cost_history:{user_id}:{date}"


# ==================== Quota Management Functions ====================


def get_user_quota(user_id: str, redis_client) -> UserQuota:
    """
    Get user quota from Redis (stored as hash).

    Creates default quota if not exists.

    Args:
        user_id: User identifier
        redis_client: Redis client instance

    Returns:
        UserQuota instance
    """
    key = _quota_key(user_id)
    quota_hash = redis_client.hgetall(key)

    if not quota_hash:
        # Create default quota
        quota = UserQuota(user_id=user_id)
        _save_user_quota(quota, redis_client)
        return quota

    # Parse hash fields
    # Handle both bytes and string responses (depends on decode_responses setting)
    def get_str(field, default=''):
        value = quota_hash.get(field, default)
        return value.decode() if isinstance(value, bytes) else value

    quota = UserQuota(
        user_id=get_str('user_id', user_id),
        daily_budget_usd=float(get_str('daily_budget_usd', '10.0')),
        spent_today_usd=float(get_str('spent_today_usd', '0.0')),
        request_count_today=int(get_str('request_count_today', '0')),
        last_reset_date=get_str('last_reset_date', ''),
        alert_sent_80=get_str('alert_sent_80', 'False') == 'True',
        alert_sent_90=get_str('alert_sent_90', 'False') == 'True',
        alert_sent_100=get_str('alert_sent_100', 'False') == 'True',
    )

    # Check if quota needs reset (new day)
    if quota.needs_reset():
        logger.info(f"Resetting quota for user {user_id} (new day)")
        quota.reset()
        _save_user_quota(quota, redis_client)

    return quota


def _save_user_quota(quota: UserQuota, redis_client):
    """
    Save user quota to Redis as hash with consistent TTL.

    Args:
        quota: UserQuota to save
        redis_client: Redis client instance
    """
    key = _quota_key(quota.user_id)

    # Use Redis hash for atomic field updates
    redis_client.hset(key, mapping={
        'user_id': quota.user_id,
        'daily_budget_usd': str(quota.daily_budget_usd),
        'spent_today_usd': str(quota.spent_today_usd),
        'request_count_today': str(quota.request_count_today),
        'last_reset_date': quota.last_reset_date,
        'alert_sent_80': str(quota.alert_sent_80),
        'alert_sent_90': str(quota.alert_sent_90),
        'alert_sent_100': str(quota.alert_sent_100),
    })

    # Set TTL: 7 days (604800 seconds)
    redis_client.expire(key, 604800)


def check_user_budget(
    user_id: str,
    estimated_cost_usd: float,
    redis_client,
) -> UserQuota:
    """
    Check if user has enough budget for estimated cost.

    Args:
        user_id: User identifier
        estimated_cost_usd: Estimated cost in USD
        redis_client: Redis client instance

    Returns:
        Current UserQuota

    Raises:
        QuotaExceededError: If budget would be exceeded

    Example:
        try:
            check_user_budget("user-123", estimated_cost_usd=0.05, redis_client=redis)
        except QuotaExceededError as e:
            return {"error": e.message, "status": 402}
    """
    quota = get_user_quota(user_id, redis_client)

    projected_spend = quota.spent_today_usd + estimated_cost_usd

    if projected_spend > quota.daily_budget_usd:
        raise QuotaExceededError(
            message=(
                f"Daily budget exceeded. "
                f"Spent: ${quota.spent_today_usd:.4f}, "
                f"Budget: ${quota.daily_budget_usd:.2f}, "
                f"Remaining: ${quota.remaining_budget_usd():.4f}"
            ),
            user_id=user_id,
            spent_usd=quota.spent_today_usd,
            budget_usd=quota.daily_budget_usd,
            remaining_usd=quota.remaining_budget_usd(),
        )

    return quota


def record_llm_cost(
    user_id: str,
    workflow_id: str,
    cost_usd: float,
    model: str,
    input_tokens: int,
    output_tokens: int,
    dragon_type: str,
    redis_client,
) -> UserQuota:
    """
    Record LLM API call cost and update user quota.

    Args:
        user_id: User identifier
        workflow_id: Workflow identifier
        cost_usd: Actual cost in USD
        model: LLM model name
        input_tokens: Number of input tokens
        output_tokens: Number of output tokens
        dragon_type: Dragon that made the call
        redis_client: Redis client instance

    Returns:
        Updated UserQuota

    Example:
        quota = record_llm_cost(
            user_id="user-123",
            workflow_id="wf-456",
            cost_usd=0.0352,
            model="qwen2.5-coder-32b",
            input_tokens=1500,
            output_tokens=800,
            dragon_type="design",
            redis_client=redis
        )

        print(f"Remaining budget: ${quota.remaining_budget_usd():.4f}")
    """
    quota_key = _quota_key(user_id)

    # Ensure quota exists (create if missing)
    if not redis_client.exists(quota_key):
        default_quota = UserQuota(user_id=user_id)
        _save_user_quota(default_quota, redis_client)

    # Atomic increment using Redis hash operations
    pipe = redis_client.pipeline()
    pipe.hincrbyfloat(quota_key, 'spent_today_usd', cost_usd)
    pipe.hincrby(quota_key, 'request_count_today', 1)
    pipe.hget(quota_key, 'daily_budget_usd')
    pipe.hget(quota_key, 'alert_sent_80')
    pipe.hget(quota_key, 'alert_sent_90')
    pipe.hget(quota_key, 'alert_sent_100')
    results = pipe.execute()

    # Extract results (handle both bytes and string responses)
    def decode_if_bytes(value):
        return value.decode() if isinstance(value, bytes) else value

    new_spent_usd = results[0]  # Updated spent_today_usd (float from HINCRBYFLOAT)
    results[1]  # Updated request_count_today (int from HINCRBY)
    daily_budget_usd = float(decode_if_bytes(results[2]))
    alert_sent_80 = decode_if_bytes(results[3]) == 'True' if results[3] else False
    alert_sent_90 = decode_if_bytes(results[4]) == 'True' if results[4] else False
    alert_sent_100 = decode_if_bytes(results[5]) == 'True' if results[5] else False

    # Check for budget alerts
    usage_pct = (new_spent_usd / daily_budget_usd) * 100 if daily_budget_usd > 0 else 0

    if usage_pct >= 100 and not alert_sent_100:
        logger.warning(
            f"User {user_id} exceeded daily budget: "
            f"${new_spent_usd:.4f} / ${daily_budget_usd:.2f}"
        )
        redis_client.hset(quota_key, 'alert_sent_100', 'True')
        # TODO: Send notification to user

    elif usage_pct >= 90 and not alert_sent_90:
        logger.warning(
            f"User {user_id} at 90% of daily budget: "
            f"${new_spent_usd:.4f} / ${daily_budget_usd:.2f}"
        )
        redis_client.hset(quota_key, 'alert_sent_90', 'True')
        # TODO: Send notification to user

    elif usage_pct >= 80 and not alert_sent_80:
        logger.info(
            f"User {user_id} at 80% of daily budget: "
            f"${new_spent_usd:.4f} / ${daily_budget_usd:.2f}"
        )
        redis_client.hset(quota_key, 'alert_sent_80', 'True')
        # TODO: Send notification to user

    # Ensure TTL is refreshed (7 days)
    redis_client.expire(quota_key, 604800)

    # Read updated quota for return value
    quota = get_user_quota(user_id, redis_client)

    # Record cost history
    cost_record = LLMCostRecord(
        user_id=user_id,
        workflow_id=workflow_id,
        cost_usd=cost_usd,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        dragon_type=dragon_type,
    )

    history_key = _cost_history_key(user_id)
    # Append to list (right push)
    redis_client.rpush(history_key, cost_record.to_json())
    # Set TTL: 30 days (2592000 seconds)
    redis_client.expire(history_key, 2592000)

    logger.info(
        f"Recorded LLM cost: user={user_id}, workflow={workflow_id}, "
        f"cost=${cost_usd:.4f}, remaining=${quota.remaining_budget_usd():.4f}"
    )

    return quota


def get_user_spending_summary(user_id: str, redis_client) -> dict[str, Any]:
    """
    Get user spending summary for today.

    Args:
        user_id: User identifier
        redis_client: Redis client instance

    Returns:
        Dictionary with spending statistics

    Example:
        summary = get_user_spending_summary("user-123", redis)
        print(f"Spent: ${summary['spent_usd']:.2f}")
        print(f"Requests: {summary['request_count']}")
        print(f"Avg cost per request: ${summary['avg_cost_per_request']:.4f}")
    """
    quota = get_user_quota(user_id, redis_client)

    return {
        'user_id': user_id,
        'date': quota.last_reset_date,
        'daily_budget_usd': quota.daily_budget_usd,
        'spent_usd': quota.spent_today_usd,
        'remaining_usd': quota.remaining_budget_usd(),
        'usage_percentage': quota.usage_percentage(),
        'request_count': quota.request_count_today,
        'avg_cost_per_request': (
            quota.spent_today_usd / quota.request_count_today
            if quota.request_count_today > 0
            else 0.0
        ),
    }


def get_cost_history(user_id: str, date: str, redis_client) -> list[LLMCostRecord]:
    """
    Get cost history for a specific date.

    Args:
        user_id: User identifier
        date: Date in YYYY-MM-DD format
        redis_client: Redis client instance

    Returns:
        List of LLMCostRecord objects

    Example:
        history = get_cost_history("user-123", "2026-04-01", redis)
        for record in history:
            print(f"{record.timestamp}: ${record.cost_usd:.4f} ({record.dragon_type})")
    """
    history_key = _cost_history_key(user_id, date)
    json_records = redis_client.lrange(history_key, 0, -1)  # Get all records

    records = []
    for json_str in json_records:
        data = json.loads(json_str)
        records.append(LLMCostRecord(**data))

    return records


def set_user_budget(
    user_id: str,
    daily_budget_usd: float,
    redis_client,
) -> UserQuota:
    """
    Update user's daily budget limit.

    Args:
        user_id: User identifier
        daily_budget_usd: New daily budget in USD
        redis_client: Redis client instance

    Returns:
        Updated UserQuota

    Example:
        # Give premium user higher budget
        quota = set_user_budget("user-123", daily_budget_usd=50.0, redis_client=redis)
    """
    quota = get_user_quota(user_id, redis_client)
    quota.daily_budget_usd = daily_budget_usd
    _save_user_quota(quota, redis_client)

    logger.info(f"Updated budget for user {user_id}: ${daily_budget_usd:.2f}/day")

    return quota
