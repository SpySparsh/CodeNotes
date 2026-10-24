"""Mock test server for CodeNotes FastAPI cross-process boundary verification.

Runs a real uvicorn HTTP server with Gemini API calls mocked out, allowing
Node.js to verify real loopback HTTP communication, middleware, authentication,
schema validation, and error mappings without making live AI calls.
"""

import argparse
import asyncio
import os
import sys

# Ensure services/ai-generator is in sys.path when executed directly
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import uvicorn  # noqa: E402
from pydantic import SecretStr  # noqa: E402

from app.config import Settings, get_settings  # noqa: E402
from app.errors import RateLimitedException, TimeoutException  # noqa: E402
from app.generator import GeminiNoteGenerator  # noqa: E402
from app.main import create_app, get_generator  # noqa: E402
from app.schemas import GeneratedNotes  # noqa: E402

TEST_SERVICE_SECRET = "test-boundary-secret-key-12345"


class MockGenerator(GeminiNoteGenerator):
    """Mock generator simulating Gemini behaviors without network calls."""

    async def generate_notes(self, transcript: str, video_title: str, request_id: str) -> GeneratedNotes:
        # Simulate delay for timeout verification
        if "TRIGGER_TIMEOUT" in video_title:
            await asyncio.sleep(2.5)

        # Simulate upstream rate limit
        if "TRIGGER_RATE_LIMIT" in video_title:
            raise RateLimitedException(message="Upstream AI rate limit exceeded. Please retry.")

        # Simulate upstream timeout
        if "TRIGGER_UPSTREAM_TIMEOUT" in video_title:
            raise TimeoutException(timeout_seconds=75)

        # Default success response matching TypeScript GeneratedNotes contract
        return GeneratedNotes(
            overview=f"Automated cross-process verification overview for '{video_title}'.",
            key_concepts=["Cross-Process IPC", "FastAPI Loopback", "Zod Schema Parity"],
            detailed_notes=(
                f"# Real HTTP Boundary Verified\n\n"
                f"- Request ID: `{request_id}`\n"
                f"- Transcript Length: {len(transcript)} chars\n"
                f"- Status: Real loopback HTTP communication confirmed."
            ),
            shorthands=["Always sanitize correlation IDs", "Enforce HTTPS outside localhost"],
        )


def build_test_app(secret: str = TEST_SERVICE_SECRET):
    """Construct an application configured with deterministic test settings and mocked generator."""
    os.environ["FASTAPI_SERVICE_SECRET"] = secret
    os.environ["GEMINI_API_KEY"] = "mock-test-gemini-key"
    test_settings = Settings(
        gemini_api_key=SecretStr("mock-test-gemini-key"),
        gemini_model="gemini-2.5-flash",
        gemini_timeout_ms=75000,
        fastapi_service_secret=SecretStr(secret),
        host="127.0.0.1",
        port=18081,
        environment="test",
    )
    get_settings.cache_clear()

    app = create_app()
    mock_gen = MockGenerator()
    app.dependency_overrides[get_generator] = lambda: mock_gen
    app.dependency_overrides[get_settings] = lambda: test_settings
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CodeNotes FastAPI Mock Server")
    parser.add_argument("--port", type=int, default=18081)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--secret", type=str, default=TEST_SERVICE_SECRET)
    args = parser.parse_args()

    app = build_test_app(secret=args.secret)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
