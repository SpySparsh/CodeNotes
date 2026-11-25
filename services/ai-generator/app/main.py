"""FastAPI application entrypoint for CodeNotes AI generator service."""

import itertools
import json
import logging
import re
import sys
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

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
    ChunkGeneratedNotes,
    ChunkGenerateRequest,
    ErrorResponse,
    GeneratedNotes,
    GenerateNotesRequest,
    HealthResponse,
    SynthesizedNotes,
    SynthesizeRequest,
)
from app.supervisor import execute_chunk_supervised

# Explicitly allowlisted diagnostic and operational fields for JSON logging
ALLOWLISTED_LOG_FIELDS = frozenset(
    {
        # Diagnostic error fields
        "status_code",
        "grpc_status",
        "error_message",
        "quota_failures",
        "error_info",
        "retry_delay",
        "retry_after_header",
        # Request & execution context
        "request_id",
        "model",
        "chunk_index",
        "total_chunks",
        "timeout_ms",
        "duration_ms",
        # Operational telemetry & token accounting
        "prompt_tokens",
        "candidate_tokens",
        "thoughts_tokens",
        "total_tokens",
        "finish_reason",
        "transcript_chars",
        "output_chars",
    }
)

SENSITIVE_KEY_PATTERN = re.compile(r"(AIza[0-9A-Za-z-_]{35}|Bearer\s+[A-Za-z0-9_\-\.]+)", re.IGNORECASE)


def _sanitize_log_value(val: Any, max_depth: int = 5) -> Any:
    """Recursively sanitize allowlisted log values, redacting credentials and bounding size."""
    if max_depth <= 0:
        return "[DEPTH_EXCEEDED]"

    if isinstance(val, str):
        sanitized = SENSITIVE_KEY_PATTERN.sub("[REDACTED]", val.strip())
        if len(sanitized) > 1000:
            return sanitized[:1000] + "...[TRUNCATED]"
        return sanitized

    if isinstance(val, (int, float, bool)) or val is None:
        return val

    if isinstance(val, dict):
        cleaned_dict: dict[str, Any] = {}
        for k, v in itertools.islice(val.items(), 25):
            clean_k = _sanitize_log_value(str(k), max_depth=max_depth - 1)
            cleaned_dict[str(clean_k)] = _sanitize_log_value(v, max_depth=max_depth - 1)
        return cleaned_dict

    if isinstance(val, (list, tuple, set)):
        return [_sanitize_log_value(item, max_depth=max_depth - 1) for item in itertools.islice(val, 25)]

    try:
        raw_str = str(val)
        return _sanitize_log_value(raw_str, max_depth=max_depth - 1)
    except Exception:
        return "[UNSERIALIZABLE]"


class SafeJsonFormatter(logging.Formatter):
    """Structured JSON log formatter that explicitly allowlists and sanitizes diagnostic fields.

    Preserves standard fields: timestamp, level, logger, message.
    Explicitly includes only allowlisted fields from extra.
    Prevents leakage of transcripts, prompts, credentials, and raw exception objects.
    """

    def format(self, record: logging.LogRecord) -> str:
        try:
            try:
                raw_msg = record.getMessage()
                clean_msg = _sanitize_log_value(raw_msg)
            except Exception:
                clean_msg = "[UNSERIALIZABLE]"

            log_entry: dict[str, Any] = {
                "timestamp": self.formatTime(record, self.datefmt),
                "level": getattr(record, "levelname", "UNKNOWN"),
                "logger": getattr(record, "name", "root"),
                "message": clean_msg if clean_msg is not None else "",
            }

            for field in ALLOWLISTED_LOG_FIELDS:
                if hasattr(record, field):
                    val = getattr(record, field)
                    if val is not None:
                        sanitized = _sanitize_log_value(val)
                        if sanitized is not None:
                            log_entry[field] = sanitized

            return json.dumps(log_entry, default=str)
        except Exception:
            try:
                try:
                    ts = self.formatTime(record, self.datefmt)
                except Exception:
                    ts = None

                try:
                    lvl = str(getattr(record, "levelname", "UNKNOWN"))
                except Exception:
                    lvl = "UNKNOWN"

                try:
                    log_name = str(getattr(record, "name", "root"))
                except Exception:
                    log_name = "root"

                try:
                    raw_msg = record.getMessage()
                    clean_msg = _sanitize_log_value(raw_msg)
                except Exception:
                    clean_msg = "[UNSERIALIZABLE]"

                fallback: dict[str, Any] = {
                    "level": lvl,
                    "logger": log_name,
                    "message": clean_msg if clean_msg is not None else "",
                }
                if ts is not None:
                    fallback["timestamp"] = ts

                return json.dumps(fallback, default=str)
            except Exception:
                return '{"level":"ERROR","message":"[LOG_FORMATTING_FATAL_ERROR]"}'


def setup_logging(level: int = logging.INFO) -> None:
    """Configure root logger with SafeJsonFormatter emitting to stdout."""
    root = logging.getLogger()
    root.setLevel(level)

    has_safe_formatter = False
    for handler in list(root.handlers):
        if isinstance(handler, logging.StreamHandler):
            handler.setFormatter(SafeJsonFormatter())
            handler.setStream(sys.stdout)
            has_safe_formatter = True

    if not has_safe_formatter:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(SafeJsonFormatter())
        root.addHandler(handler)


setup_logging()
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
        response_model_exclude_none=True,
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

    @app.post(
        "/api/v1/generate-chunk",
        response_model=ChunkGeneratedNotes,
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
            499: {
                "model": ErrorResponse,
                "description": "Client Closed Request - Disconnect Observed",
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
        summary="Generate Structured Technical Study Notes for a Transcript Chunk",
        description="Generates notes for a specific transcript chunk with detailed usage metadata including thoughts tokens.",
    )
    async def generate_chunk_endpoint(
        payload: ChunkGenerateRequest,
        request: Request,
        _auth: str = Depends(verify_service_token),
        generator: GeminiNoteGenerator = Depends(get_generator),
        x_request_id: str | None = Header(None),
    ) -> ChunkGeneratedNotes:
        req_id = getattr(request.state, "request_id", None) or sanitize_request_id(x_request_id)
        return await execute_chunk_supervised(
            generator=generator,
            request=request,
            chunk_text=payload.chunk_text,
            video_title=payload.video_title,
            chunk_index=payload.chunk_index,
            total_chunks=payload.total_chunks,
            request_id=req_id,
        )

    @app.post(
        "/api/v1/synthesize",
        response_model=SynthesizedNotes,
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
        summary="Synthesize Master Technical Guide from Chunk Summaries",
        description="Synthesizes multiple chunk summaries into a cohesive executive overview, key concepts, and table of contents.",
    )
    async def synthesize_endpoint(
        payload: SynthesizeRequest,
        request: Request,
        _auth: str = Depends(verify_service_token),
        generator: GeminiNoteGenerator = Depends(get_generator),
        x_request_id: str | None = Header(None),
    ) -> SynthesizedNotes:
        req_id = getattr(request.state, "request_id", None) or sanitize_request_id(x_request_id)
        return await generator.synthesize(
            chunk_summaries=payload.chunk_summaries,
            video_title=payload.video_title,
            request_id=req_id,
        )

    return app


app = create_app()
