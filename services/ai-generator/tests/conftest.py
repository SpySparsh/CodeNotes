"""Shared fixtures for AI Generator service tests."""

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings, get_settings
from app.main import app


@pytest.fixture(autouse=True)
def override_settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Provide deterministic test settings for all tests."""
    test_settings = Settings(
        gemini_api_key=SecretStr("mock-test-gemini-api-key"),
        gemini_model="gemini-2.5-flash",
        gemini_timeout_ms=75000,
        fastapi_service_secret=SecretStr("mock-test-service-secret"),
        host="127.0.0.1",
        port=8000,
        environment="test",
    )
    # Clear cache and override dependency
    get_settings.cache_clear()
    monkeypatch.setattr("app.config.get_settings", lambda: test_settings)
    monkeypatch.setattr("app.auth.get_settings", lambda: test_settings)
    monkeypatch.setattr("app.generator.get_settings", lambda: test_settings)
    monkeypatch.setattr("app.main.get_settings", lambda: test_settings)
    return test_settings


@pytest.fixture
def auth_headers() -> dict[str, str]:
    """Valid Bearer authorization headers matching mock-test-service-secret."""
    return {"Authorization": "Bearer mock-test-service-secret"}


@pytest.fixture
def client() -> TestClient:
    """Synchronous test client for FastAPI app."""
    return TestClient(app)


@pytest.fixture
def sample_valid_notes_dict() -> dict[str, Any]:
    """Sample valid generated technical notes matching output contract."""
    return {
        "overview": "A comprehensive overview of TypeScript interfaces, type aliases, and generic constraints.",
        "keyConcepts": [
            "Interfaces vs Type Aliases",
            "Generics and Type Parameters",
            "Type Constraints with extends",
        ],
        "detailedNotes": (
            "# Detailed Topics\n\n"
            "## 1. Generics\n\n"
            "Generics allow you to write reusable and type-safe code:\n\n"
            "```typescript\n"
            "function identity<T>(arg: T): T {\n"
            "  return arg;\n"
            "}\n"
            "```\n\n"
            "| Feature | Interface | Type Alias |\n"
            "|---|---|---|\n"
            "| Declaration Merging | Yes | No |\n"
            "| Primitives | No | Yes |\n"
        ),
        "shorthands": [
            "Use interfaces for public API contracts and declaration merging.",
            "Use type aliases for unions, primitives, and tuples.",
        ],
    }


@pytest.fixture
def mock_gemini_client():
    """Create a mock genai.Client with async generate_content."""
    mock_client = MagicMock()
    mock_aio_models = MagicMock()
    mock_aio_models.generate_content = AsyncMock()
    mock_client.aio.models = mock_aio_models
    return mock_client
