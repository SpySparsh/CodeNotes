"""Error codes, custom exceptions, and standardized error responses."""

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

# Standardized machine-readable error codes
ERR_INVALID_REQUEST = "INVALID_REQUEST"
ERR_UNAUTHORIZED = "UNAUTHORIZED"
ERR_CONFIG_ERROR = "CONFIG_ERROR"
ERR_RATE_LIMITED = "RATE_LIMITED"
ERR_TIMEOUT = "TIMEOUT"
ERR_MALFORMED_OUTPUT = "MALFORMED_OUTPUT"
ERR_UPSTREAM_ERROR = "UPSTREAM_ERROR"


class ServiceException(Exception):
    """Base exception for all service-level errors."""

    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = 500,
        headers: dict[str, str] | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.headers = headers or {}


class UnauthorizedException(ServiceException):
    """Raised when authentication credentials are missing or invalid."""

    def __init__(self, message: str = "Missing or invalid service authentication credentials."):
        super().__init__(
            code=ERR_UNAUTHORIZED,
            message=message,
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )


class ConfigErrorException(ServiceException):
    """Raised when server-side configuration is missing or invalid."""

    def __init__(self, message: str = "AI generation service is not properly configured."):
        super().__init__(
            code=ERR_CONFIG_ERROR,
            message=message,
            status_code=503,
        )


class RateLimitedException(ServiceException):
    """Raised when upstream Gemini API rate limits or resource quotas are exhausted."""

    def __init__(
        self,
        message: str = "AI generation service is temporarily busy. Retrying later is recommended.",
        retry_after: int | None = None,
    ):
        headers = {"Retry-After": str(retry_after)} if retry_after else {}
        super().__init__(
            code=ERR_RATE_LIMITED,
            message=message,
            status_code=429,
            headers=headers,
        )


class TimeoutException(ServiceException):
    """Raised when upstream Gemini API call times out."""

    def __init__(self, timeout_seconds: int = 75):
        super().__init__(
            code=ERR_TIMEOUT,
            message=f"AI generation timed out after {timeout_seconds} seconds.",
            status_code=504,
        )


class MalformedOutputException(ServiceException):
    """Raised when Gemini returns unparseable or schema-violating output."""

    def __init__(self, message: str = "The AI model output could not be parsed into notes format."):
        super().__init__(
            code=ERR_MALFORMED_OUTPUT,
            message=message,
            status_code=502,
        )


class UpstreamErrorException(ServiceException):
    """Raised when Gemini API returns an unhandled 5xx or server-side failure."""

    def __init__(self, message: str = "Upstream AI provider error occurred."):
        super().__init__(
            code=ERR_UPSTREAM_ERROR,
            message=message,
            status_code=502,
        )


def service_exception_handler(_request: Request, exc: ServiceException) -> JSONResponse:
    """Handle custom ServiceException and return sanitized error response."""
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
        headers=exc.headers,
    )


def validation_exception_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """Handle request validation errors and return sanitized 422 response."""
    # Build clean sanitized field-level error messages without exposing internals
    details: list[str] = []
    for err in exc.errors():
        loc = " -> ".join(str(item) for item in err.get("loc", []) if item != "body")
        msg = err.get("msg", "Invalid value")
        details.append(f"{loc}: {msg}" if loc else msg)

    summary_message = "; ".join(details) if details else "Invalid request payload."
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": ERR_INVALID_REQUEST,
                "message": summary_message,
            }
        },
    )


def unhandled_exception_handler(_request: Request, _exc: Exception) -> JSONResponse:
    """Catch-all handler for unexpected internal exceptions. Never leaks stack traces."""
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "INTERNAL_SERVER_ERROR",
                "message": "An unexpected internal server error occurred.",
            }
        },
    )
