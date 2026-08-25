"""
XylonStudio Agent Entry Point.

Starts the canonical local RTL verification API.

Usage:
    python -m agent.main
"""

import uvicorn


def main():
    """Start the API server."""
    uvicorn.run(
        "agent.api.main:app",
        host="127.0.0.1",
        port=5000,
        reload=False,
    )


if __name__ == "__main__":
    main()
