"""
XylonStudio Agent Entry Point.

Starts the FastAPI server for Design and Verification Dragons.

Usage:
    python -m agent.main
"""

import uvicorn


def main():
    """Start the API server."""
    uvicorn.run(
        "agent.api.main:app",
        host="0.0.0.0",
        port=5000,
        reload=True,
    )


if __name__ == "__main__":
    main()
