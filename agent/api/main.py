"""
XylonStudio FastAPI Application.

Main API server for the reproducible RTL verification pipeline.

Run:
    uvicorn agent.api.main:app --host 127.0.0.1 --port 5000
"""

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from agent.api import LOCAL_WEB_ORIGINS
from agent.api.routes import local, openroad, pipeline
from agent.pipeline.limits import MAX_PIPELINE_BODY_BYTES

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(
    title="XylonStudio API",
    description="Local Verilator and Yosys verification with reproducible evidence",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(LOCAL_WEB_ORIGINS),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# Include routers
app.include_router(pipeline.router, prefix="/api", tags=["pipeline"])
app.include_router(local.router, prefix="/api", tags=["local"])
app.include_router(openroad.router, prefix="/api", tags=["openroad"])


def _payload_too_large() -> JSONResponse:
    return JSONResponse(
        status_code=413,
        content={"detail": "Pipeline request body is too large"},
    )


@app.middleware("http")
async def bound_pipeline_request_body(request: Request, call_next):
    """Bound the live REST body before FastAPI allocates or validates JSON."""
    if request.method == "POST" and request.url.path == "/api/pipeline/run":
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_PIPELINE_BODY_BYTES:
                    return _payload_too_large()
            except ValueError:
                return JSONResponse(
                    status_code=400,
                    content={"detail": "Invalid Content-Length header"},
                )

        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_PIPELINE_BODY_BYTES:
                return _payload_too_large()
        request._body = bytes(body)

    return await call_next(request)


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "name": "XylonStudio API",
        "version": "1.0.0",
        "status": "running",
        "docs": "/docs"
    }


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "xylonstudio-api",
        "version": "1.0.0"
    }


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    """Global exception handler."""
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error"},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=5000)
