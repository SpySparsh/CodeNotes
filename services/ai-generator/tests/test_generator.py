"""Unit tests for prompt construction, Gemini invocation, and response parsing."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from google.genai import errors as genai_errors
from pydantic import SecretStr

from app.config import Settings
from app.errors import (
    ConfigErrorException,
    MalformedOutputException,
    RateLimitedException,
    TimeoutException,
    UpstreamErrorException,
)
from app.generator import (
    GeminiNoteGenerator,
    build_prompt,
    parse_and_validate_notes,
)


def test_build_prompt_preserves_exact_requirements():
    """Prompt must include Technical Content Architect persona and all three functional requirements."""
    prompt = build_prompt(transcript="Tutorial content on React hooks", video_title="React Hooks Masterclass")

    assert 'titled "React Hooks Masterclass"' in prompt
    assert "Senior Full-Stack Engineer and Technical Content Architect" in prompt
    assert "1. **Structure First:**" in prompt
    assert "2. **Contextual Code Mapping:**" in prompt
    assert "3. **Comparison Tables:**" in prompt
    assert "Tutorial content on React hooks" in prompt
    assert "==================" in prompt


def test_parse_and_validate_clean_json(sample_valid_notes_dict: dict):
    """Parses clean JSON string into GeneratedNotes."""
    raw = json.dumps(sample_valid_notes_dict)
    notes = parse_and_validate_notes(raw)
    assert notes.overview == sample_valid_notes_dict["overview"]
    assert len(notes.key_concepts) == 3


def test_parse_and_validate_strips_markdown_json_fences(sample_valid_notes_dict: dict):
    """Strips ```json markdown fences before parsing."""
    raw = f"```json\n{json.dumps(sample_valid_notes_dict)}\n```"
    notes = parse_and_validate_notes(raw)
    assert notes.overview == sample_valid_notes_dict["overview"]


def test_parse_and_validate_strips_generic_fences(sample_valid_notes_dict: dict):
    """Strips ``` markdown fences without json prefix."""
    raw = f"```\n{json.dumps(sample_valid_notes_dict)}\n```"
    notes = parse_and_validate_notes(raw)
    assert notes.overview == sample_valid_notes_dict["overview"]


def test_parse_and_validate_rejects_unparseable_json():
    """Throws MalformedOutputException when output is not valid JSON."""
    raw = "NOT_A_VALID_JSON_STRING"
    with pytest.raises(MalformedOutputException) as exc_info:
        parse_and_validate_notes(raw)
    assert "malformed" in exc_info.value.message.lower()


def test_parse_and_validate_rejects_non_dict_json():
    """Throws MalformedOutputException when JSON is an array rather than object."""
    raw = json.dumps(["overview", "keyConcepts"])
    with pytest.raises(MalformedOutputException) as exc_info:
        parse_and_validate_notes(raw)
    assert "non-object" in exc_info.value.message.lower()


def test_parse_and_validate_rejects_missing_schema_fields():
    """Throws MalformedOutputException when required schema fields are missing."""
    raw = json.dumps({"overview": "Only overview provided"})
    with pytest.raises(MalformedOutputException) as exc_info:
        parse_and_validate_notes(raw)
    assert "could not be parsed" in exc_info.value.message.lower()


@pytest.mark.asyncio
async def test_generator_raises_config_error_when_api_key_missing():
    """GeminiNoteGenerator must raise ConfigErrorException if GEMINI_API_KEY is unset."""
    unconfigured_settings = Settings(
        gemini_api_key=None,
        fastapi_service_secret=SecretStr("valid-secret"),
    )
    generator = GeminiNoteGenerator(settings=unconfigured_settings)
    with pytest.raises(ConfigErrorException) as exc_info:
        await generator.generate_notes(transcript="test transcript", video_title="test title")
    assert "API key is missing" in exc_info.value.message


@pytest.mark.asyncio
async def test_generator_success_with_mock_client(mock_gemini_client, sample_valid_notes_dict: dict):
    """Successful generation returns validated GeneratedNotes."""
    mock_response = MagicMock()
    mock_response.text = json.dumps(sample_valid_notes_dict)
    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    notes = await generator.generate_notes(
        transcript="In this tutorial we learn interfaces and generics.",
        video_title="TypeScript Generics",
        request_id="req-test-123",
    )

    assert notes.overview == sample_valid_notes_dict["overview"]
    assert len(notes.key_concepts) == 3
    assert len(notes.shorthands) == 2


@pytest.mark.asyncio
async def test_generator_maps_429_rate_limit(mock_gemini_client):
    """Upstream 429 / RESOURCE_EXHAUSTED must map to RateLimitedException."""
    api_error = genai_errors.APIError(
        code=429,
        response_json={"error": {"message": "[429 Too Many Requests] RESOURCE_EXHAUSTED"}},
    )
    mock_gemini_client.aio.models.generate_content.side_effect = api_error

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with pytest.raises(RateLimitedException) as exc_info:
        await generator.generate_notes(transcript="Valid transcript", video_title="Title")

    assert exc_info.value.status_code == 429
    assert exc_info.value.code == "RATE_LIMITED"


@pytest.mark.asyncio
async def test_generator_maps_timeout(mock_gemini_client):
    """Timeout during generation must map to TimeoutException (HTTP 504)."""
    mock_gemini_client.aio.models.generate_content.side_effect = TimeoutError("Deadline exceeded")

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with pytest.raises(TimeoutException) as exc_info:
        await generator.generate_notes(transcript="Valid transcript", video_title="Title")

    assert exc_info.value.status_code == 504
    assert exc_info.value.code == "TIMEOUT"
    assert "timed out after 75 seconds" in exc_info.value.message


@pytest.mark.asyncio
async def test_generator_maps_503_upstream_failure(mock_gemini_client):
    """Upstream 503 service failure must map to UpstreamErrorException (HTTP 502)."""
    api_error = genai_errors.APIError(
        code=503,
        response_json={"error": {"message": "[503 Service Unavailable] Backend temporarily overloaded"}},
    )
    mock_gemini_client.aio.models.generate_content.side_effect = api_error

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with pytest.raises(UpstreamErrorException) as exc_info:
        await generator.generate_notes(transcript="Valid transcript", video_title="Title")

    assert exc_info.value.status_code == 502
    assert exc_info.value.code == "UPSTREAM_ERROR"


def test_generator_client_reuse_across_calls():
    """GeminiNoteGenerator.get_client reuses the same cached client instance."""
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = MagicMock()
        mock_client_cls.return_value = mock_instance

        generator = GeminiNoteGenerator()
        client1 = generator.get_client()
        client2 = generator.get_client()

        assert client1 is client2
        assert client1 is mock_instance
        # genai.Client constructor should have been called exactly once
        mock_client_cls.assert_called_once()


@pytest.mark.asyncio
async def test_generator_aclose_cleans_up_connections():
    """aclose() closes async and sync sessions and resets cached client to None."""
    mock_client = MagicMock()
    mock_client.aio.aclose = AsyncMock()
    mock_client.close = MagicMock()

    generator = GeminiNoteGenerator(client=mock_client)
    assert generator._client is not None

    await generator.aclose()

    mock_client.aio.aclose.assert_awaited_once()
    mock_client.close.assert_called_once()
    assert generator._client is None


@pytest.mark.asyncio
async def test_generator_aclose_safe_when_no_client():
    """aclose() is safe to call when client is None (no-op)."""
    generator = GeminiNoteGenerator(client=None)
    await generator.aclose()
    assert generator._client is None


@pytest.mark.asyncio
async def test_fastapi_lifespan_manages_generator_lifecycle():
    """FastAPI lifespan context manager initializes and closes generator."""
    from app.main import create_app, lifespan

    app = create_app()

    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = MagicMock()
        mock_instance.aio.aclose = AsyncMock()
        mock_instance.close = MagicMock()
        mock_client_cls.return_value = mock_instance

        async with lifespan(app):
            # Generator should be stored in app.state
            assert hasattr(app.state, "generator")
            gen = app.state.generator
            assert isinstance(gen, GeminiNoteGenerator)
            # Client was eagerly initialized in lifespan
            assert gen._client is mock_instance

        # After lifespan exits, aclose() was awaited and client reset
        mock_instance.aio.aclose.assert_awaited_once()
        mock_instance.close.assert_called_once()
        assert gen._client is None


def test_get_generator_dependency_reuses_application_scoped_generator():
    """get_generator retrieves generator from request.app.state."""
    from app.main import get_generator

    mock_request = MagicMock()
    shared_generator = GeminiNoteGenerator()
    mock_request.app.state.generator = shared_generator

    retrieved = get_generator(mock_request)
    assert retrieved is shared_generator
