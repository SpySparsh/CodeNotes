"""Service-to-service authentication middleware and dependencies."""

import secrets

from fastapi import Header

from app.config import get_settings
from app.errors import ConfigErrorException, UnauthorizedException


async def verify_service_token(authorization: str | None = Header(None)) -> str:
    """Verify internal Bearer token authentication.

    Raises:
        ConfigErrorException: If FASTAPI_SERVICE_SECRET is not configured on server (fails closed).
        UnauthorizedException: If header is missing, malformed, or invalid.
    """
    settings = get_settings()

    # Fail closed: never allow unset secret to disable authentication
    if not settings.is_auth_configured:
        raise ConfigErrorException("Service authentication is not properly configured on the server.")

    expected_secret = settings.fastapi_service_secret.get_secret_value()  # type: ignore[union-attr]

    if not authorization:
        raise UnauthorizedException("Missing Authorization header.")

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise UnauthorizedException("Invalid Authorization header format. Expected 'Bearer <token>'.")

    provided_token = parts[1]

    # Use constant-time comparison to prevent timing attacks
    if not secrets.compare_digest(provided_token, expected_secret):
        raise UnauthorizedException("Invalid service authentication credentials.")

    return provided_token
