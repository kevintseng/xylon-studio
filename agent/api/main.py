"""
XylonStudio FastAPI Application.

Main API server for the reproducible RTL verification pipeline.

Run:
    uvicorn agent.api.main:app --host 127.0.0.1 --port 5001
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from agent.api import LOCAL_WEB_ORIGINS
from agent.api.routes import assistant, local, openroad, pipeline, timing
from agent.api.routes.timing import (
    MAX_TIMING_BODY_BYTES,
    cancel_active_timing_jobs,
    reconcile_interrupted_timing_jobs,
)
from agent.pipeline.limits import MAX_PIPELINE_BODY_BYTES

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not await reconcile_interrupted_timing_jobs():
        logger.error("Local API startup could not verify all interrupted timing job cleanup")
    yield
    if not await cancel_active_timing_jobs(shutdown=True):
        logger.error("Local API shutdown could not verify all timing job cleanup")


# Create FastAPI app
app = FastAPI(
    title="XylonStudio API",
    description="Local Verilator and Yosys verification with reproducible evidence",
    version="0.5.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
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
app.include_router(timing.router, prefix="/api", tags=["timing"])
app.include_router(assistant.router, prefix="/api", tags=["assistant"])


def _payload_too_large(label: str = "Pipeline") -> JSONResponse:
    return JSONResponse(
        status_code=413,
        content={"detail": f"{label} request body is too large"},
    )


@app.middleware("http")
async def bound_pipeline_request_body(request: Request, call_next):
    """Bound the live REST body before FastAPI allocates or validates JSON."""
    timing_request = request.method == "POST" and (
        request.url.path.startswith("/api/timing/")
        or request.url.path == "/api/assistant/timing"
    )
    project_import_request = request.method == "POST" and request.url.path == "/api/openroad/projects"
    pipeline_request = request.method == "POST" and request.url.path == "/api/pipeline/run"
    if pipeline_request or timing_request or project_import_request:
        body_limit = (
            openroad.MAX_PROJECT_IMPORT_BODY_BYTES
            if project_import_request
            else MAX_TIMING_BODY_BYTES
            if timing_request
            else MAX_PIPELINE_BODY_BYTES
        )
        label = "Project import" if project_import_request else "Timing" if timing_request else "Pipeline"
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > body_limit:
                    return _payload_too_large(label)
            except ValueError:
                return JSONResponse(
                    status_code=400,
                    content={"detail": "Invalid Content-Length header"},
                )

        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > body_limit:
                return _payload_too_large(label)
        request._body = bytes(body)

    return await call_next(request)


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "name": "XylonStudio API",
        "version": "0.5.0",
        "status": "running",
        "docs": "/docs"
    }


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "xylonstudio-api",
        "version": "0.5.0"
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
    uvicorn.run(app, host="127.0.0.1", port=5001)
