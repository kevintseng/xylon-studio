"""XylonStudio reproducible local RTL verification API."""

import os

__version__ = "0.6.0"


def local_web_origins(web_port: int) -> tuple[str, str]:
    """Return the only browser origins trusted by the local API."""
    if isinstance(web_port, bool) or not 1 <= web_port <= 65_535:
        raise ValueError("web port must be between 1 and 65535")
    return (
        f"http://127.0.0.1:{web_port}",
        f"http://localhost:{web_port}",
    )


def _configured_web_port() -> int:
    raw_port = os.environ.get("XYLON_WEB_PORT", "3000")
    try:
        return int(raw_port)
    except ValueError as exc:
        raise RuntimeError("XYLON_WEB_PORT must be an integer") from exc


LOCAL_WEB_ORIGINS = local_web_origins(_configured_web_port())
