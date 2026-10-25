"""FastAPI application entrypoint for CodeNotes AI generator service."""

import logging
import re
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, Request, Response
from fastapi.exceptions import RequestValidationError
from starlette.middleware.base import BaseHTTPMiddleware

from app.auth import verify_service_token
from app.config import get_settings
from app.errors import (
    ServiceException,
    service_exception_handler,
    unhandled_exception_handler,
    validation_exception_handler,
)
from app.generator import GeminiNoteGenerator
from app.schemas import (
    ErrorResponse,
    GeneratedNotes,
    GenerateNotesRequest,
    HealthResponse,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='{"timestamp":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","message":"%(message)s"}',
)
logger = logging.getLogger("ai_generator.main")

# Safe character set for request IDs (alphanumeric, hyphens, underscores, dots, 1-64 chars)
SAFE_REQUEST_ID_REGEX = re.compile(r"^[a-zA-Z0-9_\-\.]{1,64}$")


def sanitize_request_id(incoming: str | None) -> str:
    """Validate and sanitize caller-provided request ID.

    Accepts only alphanumeric characters, underscores, hyphens, and dots up to 64 characters.
    Replaces missing, malformed, excessively long, or control/injection characters with a UUID4.
    """
    if incoming and SAFE_REQUEST_ID_REGEX.match(incoming):
        return incoming
    return str(uuid.uuid4())


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Ensure every request has a validated, sanitized X-Request-ID header."""

    async def dispatch(self, request: Request, call_next):
        raw_header = request.headers.get("x-request-id")
        request_id = sanitize_request_id(raw_header)
        request.state.request_id = request_id
        response: Response = await call_next(request)
        response.headers["x-request-id"] = request_id
        return response


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage application process-scoped Gemini client lifecycle and cleanup."""
    settings = get_settings()
    generator = GeminiNoteGenerator(settings=settings)

    # Eagerly initialize client connection pool if credentials are configured
    if settings.is_gemini_configured:
        generator.get_client()

    app.state.generator = generator
    try:
        yield
    finally:
        logger.info("Closing application-scoped Gemini client connections.")
        await generator.aclose()


def get_generator(request: Request) -> GeminiNoteGenerator:
    """Application-scoped dependency providing the shared GeminiNoteGenerator."""
    generator = getattr(request.app.state, "generator", None)
    if generator is None:
        generator = GeminiNoteGenerator()
    return generator


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="CodeNotes AI Generator Service",
        description="Standalone AI technical study-notes generation service for CodeNotes",
        version="0.1.0",
        docs_url=None,  # Disabled for security by default
        redoc_url=None,
        lifespan=lifespan,
    )

    # Middleware
    app.add_middleware(RequestIdMiddleware)

    # Exception Handlers
    app.add_exception_handler(ServiceException, service_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)

    # Routes
    @app.get(
        "/health",
        response_model=HealthResponse,
        summary="Service Health Check",
        description="Returns minimal health status without calling AI APIs or exposing secrets.",
    )
    async def health_check() -> HealthResponse:
        return HealthResponse(status="healthy")

    @app.post(
        "/api/v1/generate",
        response_model=GeneratedNotes,
        response_model_by_alias=True,
        responses={
            400: {"model": ErrorResponse, "description": "Bad Request"},
            401: {"model": ErrorResponse, "description": "Unauthorized - Missing/Invalid Token"},
            422: {
                "model": ErrorResponse,
                "description": "Unprocessable Entity - Schema Validation Failure",
            },
            429: {
                "model": ErrorResponse,
                "description": "Too Many Requests - Upstream Rate Limited",
            },
            502: {
                "model": ErrorResponse,
                "description": "Bad Gateway - Malformed Model Output or Upstream Failure",
            },
            503: {
                "model": ErrorResponse,
                "description": "Service Unavailable - Unconfigured Server",
            },
            504: {"model": ErrorResponse, "description": "Gateway Timeout - Upstream Timeout"},
        },
        summary="Generate Structured Technical Study Notes",
        description="Generates premium structured technical study notes based on transcript and video title.",
    )
    async def generate_notes_endpoint(
        payload: GenerateNotesRequest,
        request: Request,
        _auth: str = Depends(verify_service_token),
        generator: GeminiNoteGenerator = Depends(get_generator),
        x_request_id: str | None = Header(None),
    ) -> GeneratedNotes:
        req_id = getattr(request.state, "request_id", None) or sanitize_request_id(x_request_id)
        return await generator.generate_notes(
            transcript=payload.transcript,
            video_title=payload.video_title,
            request_id=req_id,
        )

    return app


app = create_app()
