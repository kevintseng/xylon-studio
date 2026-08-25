"""Local-only API routes for host readiness and resource admission."""

from fastapi import APIRouter

from agent.local_app import collect_local_readiness

router = APIRouter(tags=["local"])


@router.get("/local/readiness")
async def local_readiness():
    """Return the current local resource and runtime admission state."""
    return collect_local_readiness().to_dict()
