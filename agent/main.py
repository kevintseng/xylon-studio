"""
XylonStudio Agent Entry Point.

Starts the canonical local RTL verification API.

Usage:
    python -m agent.main
"""

import uvicorn

from agent.pipeline.limits import MAX_PIPELINE_WS_MESSAGE_BYTES


def main():
    """Start the API server."""
    uvicorn.run(
        "agent.api.main:app",
        host="127.0.0.1",
        port=5000,
        reload=False,
        ws_max_size=MAX_PIPELINE_WS_MESSAGE_BYTES,
    )


if __name__ == "__main__":
    main()
