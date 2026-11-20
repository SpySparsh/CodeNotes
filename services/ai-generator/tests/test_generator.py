"""Unit tests for prompt construction, Gemini invocation, and response parsing."""

import json
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from google.genai import errors as genai_errors
from google.genai import types
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
    build_chunk_prompt,
    build_prompt,
    build_synthesis_prompt,
    parse_and_validate_notes,
)
from app.schemas import ChunkSummary


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


# ---------------------------------------------------------------------------
# Diagnostics & Telemetry Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_diagnostics_records_stop_response_metadata(
    mock_gemini_client, sample_valid_notes_dict: dict, caplog: pytest.LogCaptureFixture
):
    """STOP finish reason and token counts are recorded in diagnostic logs."""
    mock_response = MagicMock()
    mock_response.text = json.dumps(sample_valid_notes_dict)
    mock_response.model_version = "gemini-2.5-flash-001"

    mock_candidate = MagicMock()
    mock_candidate.finish_reason = types.FinishReason.STOP
    mock_response.candidates = [mock_candidate]

    mock_usage = MagicMock()
    mock_usage.prompt_token_count = 1250
    mock_usage.candidates_token_count = 820
    mock_usage.thoughts_token_count = 210
    mock_usage.total_token_count = 2280
    mock_response.usage_metadata = mock_usage

    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with caplog.at_level(logging.INFO):
        notes = await generator.generate_notes(
            transcript="Tutorial on TypeScript architecture and patterns.",
            video_title="TypeScript Masterclass",
            request_id="test-req-diag-stop",
        )

    assert notes.overview == sample_valid_notes_dict["overview"]

    # Locate gemini_generation_response_received log record
    received_record = next(
        (r for r in caplog.records if r.message == "gemini_generation_response_received"),
        None,
    )
    assert received_record is not None
    assert received_record.request_id == "test-req-diag-stop"
    assert received_record.model == "gemini-2.5-flash"
    assert received_record.model_version == "gemini-2.5-flash-001"
    assert received_record.finish_reason == "STOP"
    assert received_record.prompt_tokens == 1250
    assert received_record.candidate_tokens == 820
    assert received_record.thoughts_tokens == 210
    assert received_record.total_tokens == 2280
    assert received_record.raw_response_chars == len(mock_response.text)
    assert received_record.duration_ms > 0


@pytest.mark.asyncio
async def test_diagnostics_records_max_tokens_response_metadata(
    mock_gemini_client, sample_valid_notes_dict: dict, caplog: pytest.LogCaptureFixture
):
    """MAX_TOKENS finish reason and token exhaustion metadata are recorded."""
    mock_response = MagicMock()
    mock_response.text = json.dumps(sample_valid_notes_dict)
    mock_response.model_version = "gemini-2.5-flash-001"

    mock_candidate = MagicMock()
    mock_candidate.finish_reason = types.FinishReason.MAX_TOKENS
    mock_response.candidates = [mock_candidate]

    mock_usage = MagicMock()
    mock_usage.prompt_token_count = 45000
    mock_usage.candidates_token_count = 8192
    mock_usage.thoughts_token_count = 2048
    mock_usage.total_token_count = 55240
    mock_response.usage_metadata = mock_usage

    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with caplog.at_level(logging.INFO):
        await generator.generate_notes(
            transcript="Long transcript simulating massive video content.",
            video_title="TypeScript Deep Dive",
            request_id="test-req-diag-max-tokens",
        )

    received_record = next(
        (r for r in caplog.records if r.message == "gemini_generation_response_received"),
        None,
    )
    assert received_record is not None
    assert received_record.finish_reason == "MAX_TOKENS"
    assert received_record.prompt_tokens == 45000
    assert received_record.candidate_tokens == 8192
    assert received_record.thoughts_tokens == 2048
    assert received_record.total_tokens == 55240


@pytest.mark.asyncio
async def test_diagnostics_handles_missing_candidates_safely(
    mock_gemini_client, sample_valid_notes_dict: dict, caplog: pytest.LogCaptureFixture
):
    """Handles empty or missing candidates list gracefully without throwing."""
    mock_response = MagicMock()
    mock_response.text = json.dumps(sample_valid_notes_dict)
    mock_response.candidates = []  # No candidate present
    mock_response.usage_metadata = None
    mock_response.model_version = None

    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with caplog.at_level(logging.INFO):
        notes = await generator.generate_notes(
            transcript="Valid tutorial content.",
            video_title="Title",
            request_id="test-req-no-candidates",
        )

    assert notes.overview == sample_valid_notes_dict["overview"]

    received_record = next(
        (r for r in caplog.records if r.message == "gemini_generation_response_received"),
        None,
    )
    assert received_record is not None
    assert received_record.finish_reason is None


@pytest.mark.asyncio
async def test_diagnostics_handles_missing_usage_metadata_safely(
    mock_gemini_client, sample_valid_notes_dict: dict, caplog: pytest.LogCaptureFixture
):
    """Handles missing usage_metadata gracefully without throwing."""
    mock_response = MagicMock()
    mock_response.text = json.dumps(sample_valid_notes_dict)
    mock_response.candidates = [MagicMock(finish_reason="STOP")]
    mock_response.usage_metadata = None  # Usage not populated

    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with caplog.at_level(logging.INFO):
        notes = await generator.generate_notes(
            transcript="Valid tutorial content.",
            video_title="Title",
            request_id="test-req-no-usage",
        )

    assert notes.overview == sample_valid_notes_dict["overview"]

    received_record = next(
        (r for r in caplog.records if r.message == "gemini_generation_response_received"),
        None,
    )
    assert received_record is not None
    assert received_record.prompt_tokens is None
    assert received_record.candidate_tokens is None
    assert received_record.thoughts_tokens is None
    assert received_record.total_tokens is None


@pytest.mark.asyncio
async def test_diagnostics_emits_event_on_malformed_json_before_failing(
    mock_gemini_client, caplog: pytest.LogCaptureFixture
):
    """Malformed JSON outputs emit diagnostic metadata before parsing raises exception."""
    mock_response = MagicMock()
    mock_response.text = "NOT_A_VALID_JSON_STRING"
    mock_candidate = MagicMock()
    mock_candidate.finish_reason = types.FinishReason.STOP
    mock_response.candidates = [mock_candidate]

    mock_usage = MagicMock()
    mock_usage.prompt_token_count = 500
    mock_usage.candidates_token_count = 50
    mock_usage.thoughts_token_count = 10
    mock_usage.total_token_count = 560
    mock_response.usage_metadata = mock_usage

    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with caplog.at_level(logging.INFO):
        with pytest.raises(MalformedOutputException):
            await generator.generate_notes(
                transcript="Transcript that causes malformed model output.",
                video_title="Title",
                request_id="test-req-malformed-json",
            )

    # 1. Verify pre-parse response received event was recorded
    received_record = next(
        (r for r in caplog.records if r.message == "gemini_generation_response_received"),
        None,
    )
    assert received_record is not None
    assert received_record.finish_reason == "STOP"
    assert received_record.prompt_tokens == 500
    assert received_record.candidate_tokens == 50

    # 2. Verify structured failure event was recorded
    failed_record = next(
        (r for r in caplog.records if r.message == "gemini_generation_parsing_failed"),
        None,
    )
    assert failed_record is not None
    assert failed_record.request_id == "test-req-malformed-json"
    assert failed_record.exception_category == "MalformedOutputException"
    assert failed_record.finish_reason == "STOP"
    assert failed_record.prompt_tokens == 500
    assert failed_record.candidate_tokens == 50
    assert failed_record.thoughts_tokens == 10
    assert failed_record.raw_response_chars == len("NOT_A_VALID_JSON_STRING")


@pytest.mark.asyncio
async def test_diagnostics_never_logs_content_text(
    mock_gemini_client, sample_valid_notes_dict: dict, caplog: pytest.LogCaptureFixture
):
    """Never leaks prompt text, transcript text, raw response, or note content in logs."""
    canary_transcript = "CANARY_SECRET_TRANSCRIPT_ALPHA_98765"
    canary_title = "CANARY_SECRET_TITLE_BRAVO_43210"
    canary_overview = "CANARY_SECRET_OVERVIEW_CHARLIE_11111"
    canary_note = "CANARY_SECRET_DETAILED_NOTES_DELTA_22222"

    notes_dict = {
        **sample_valid_notes_dict,
        "overview": canary_overview,
        "detailedNotes": canary_note,
    }

    mock_response = MagicMock()
    mock_response.text = json.dumps(notes_dict)
    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with caplog.at_level(logging.DEBUG):
        await generator.generate_notes(
            transcript=canary_transcript,
            video_title=canary_title,
            request_id="test-req-canary",
        )

    # Scan all records for canary strings
    for record in caplog.records:
        formatted = f"{record.message} {record.__dict__}"
        assert canary_transcript not in formatted
        assert canary_title not in formatted
        assert canary_overview not in formatted
        assert canary_note not in formatted


@pytest.mark.asyncio
async def test_diagnostics_records_generated_field_lengths_on_success(
    mock_gemini_client, sample_valid_notes_dict: dict, caplog: pytest.LogCaptureFixture
):
    """Successful generation records exact field lengths and item counts in completion event."""
    mock_response = MagicMock()
    mock_response.text = json.dumps(sample_valid_notes_dict)
    mock_candidate = MagicMock()
    mock_candidate.finish_reason = types.FinishReason.STOP
    mock_response.candidates = [mock_candidate]
    mock_response.usage_metadata = MagicMock(
        prompt_token_count=100, candidates_token_count=200, thoughts_token_count=50, total_token_count=350
    )

    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with caplog.at_level(logging.INFO):
        await generator.generate_notes(
            transcript="Sample transcript.",
            video_title="Sample Title",
            request_id="test-req-field-lengths",
        )

    completed_record = next(
        (r for r in caplog.records if r.message == "gemini_generation_completed"),
        None,
    )
    assert completed_record is not None
    assert completed_record.overview_chars == len(sample_valid_notes_dict["overview"])
    assert completed_record.key_concepts_count == len(sample_valid_notes_dict["keyConcepts"])
    assert completed_record.detailed_notes_chars == len(sample_valid_notes_dict["detailedNotes"])
    assert completed_record.shorthands_count == len(sample_valid_notes_dict["shorthands"])


@pytest.mark.asyncio
async def test_diagnostics_records_metadata_when_no_usable_text_candidate(
    mock_gemini_client, caplog: pytest.LogCaptureFixture
):
    """Verifies metadata is logged when actual GenerateContentResponse has no usable text."""
    # Construct an actual google.genai.types.GenerateContentResponse without text content
    sdk_response = types.GenerateContentResponse(
        candidates=[
            types.Candidate(
                finish_reason=types.FinishReason.SAFETY,
                # Candidate content absent / no text parts
            )
        ],
        usage_metadata=types.GenerateContentResponseUsageMetadata(
            prompt_token_count=1800,
            candidates_token_count=0,
            thoughts_token_count=120,
            total_token_count=1920,
        ),
        model_version="gemini-2.5-flash-001",
    )

    mock_gemini_client.aio.models.generate_content.return_value = sdk_response

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with caplog.at_level(logging.INFO):
        with pytest.raises(MalformedOutputException) as exc_info:
            await generator.generate_notes(
                transcript="Transcript that triggered a non-textual response.",
                video_title="Safety Blocked Topic",
                request_id="test-req-no-text-sdk-response",
            )

    assert "no usable text" in exc_info.value.message.lower()

    # 1. Verify pre-parse response received event captured finish_reason and usage
    received_record = next(
        (r for r in caplog.records if r.message == "gemini_generation_response_received"),
        None,
    )
    assert received_record is not None
    assert received_record.request_id == "test-req-no-text-sdk-response"
    assert received_record.model == "gemini-2.5-flash"
    assert received_record.model_version == "gemini-2.5-flash-001"
    assert received_record.finish_reason == "SAFETY"
    assert received_record.prompt_tokens == 1800
    assert received_record.candidate_tokens == 0
    assert received_record.thoughts_tokens == 120
    assert received_record.total_tokens == 1920
    assert received_record.raw_response_chars == 0

    # 2. Verify parsing failure structured event captured finish reason and usage
    failed_record = next(
        (r for r in caplog.records if r.message == "gemini_generation_parsing_failed"),
        None,
    )
    assert failed_record is not None
    assert failed_record.request_id == "test-req-no-text-sdk-response"
    assert failed_record.exception_category == "MalformedOutputException"
    assert failed_record.finish_reason == "SAFETY"
    assert failed_record.prompt_tokens == 1800
    assert failed_record.candidate_tokens == 0
    assert failed_record.thoughts_tokens == 120
    assert failed_record.raw_response_chars == 0


@pytest.mark.asyncio
async def test_diagnostics_handles_text_accessor_exception_safely(mock_gemini_client, caplog: pytest.LogCaptureFixture):
    """Verifies metadata is logged even when response.text raises an exception."""
    mock_response = MagicMock()
    # Configure response.text to raise an unexpected exception
    type(mock_response).text = property(lambda self: (_ for _ in ()).throw(ValueError("Invalid candidate state")))
    mock_candidate = MagicMock()
    mock_candidate.finish_reason = types.FinishReason.BLOCKLIST
    mock_response.candidates = [mock_candidate]
    mock_response.model_version = "gemini-2.5-flash-001"
    mock_response.usage_metadata = MagicMock(
        prompt_token_count=900,
        candidates_token_count=0,
        thoughts_token_count=50,
        total_token_count=950,
    )

    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with caplog.at_level(logging.INFO):
        with pytest.raises(MalformedOutputException) as exc_info:
            await generator.generate_notes(
                transcript="Transcript triggering text accessor exception.",
                video_title="Title",
                request_id="test-req-text-accessor-error",
            )

    assert "failed to extract" in exc_info.value.message.lower()

    received_record = next(
        (r for r in caplog.records if r.message == "gemini_generation_response_received"),
        None,
    )
    assert received_record is not None
    assert received_record.finish_reason == "BLOCKLIST"
    assert received_record.prompt_tokens == 900
    assert received_record.candidate_tokens == 0
    assert received_record.thoughts_tokens == 50
    assert received_record.raw_response_chars == 0

    failed_record = next(
        (r for r in caplog.records if r.message == "gemini_generation_parsing_failed"),
        None,
    )
    assert failed_record is not None
    assert failed_record.exception_category == "ValueError"
    assert failed_record.finish_reason == "BLOCKLIST"
    assert failed_record.prompt_tokens == 900
    assert failed_record.thoughts_tokens == 50
    assert failed_record.raw_response_chars == 0


def test_build_chunk_prompt_includes_section_indices():
    """build_chunk_prompt must include section indices and tutorial title."""
    prompt = build_chunk_prompt(
        chunk_text="Chunk transcript content.",
        video_title="FastAPI Mastery",
        chunk_index=2,
        total_chunks=10,
    )
    assert 'titled "FastAPI Mastery"' in prompt
    assert "Section 3 of 10" in prompt
    assert "Chunk transcript content." in prompt


def test_build_synthesis_prompt_formats_sections():
    """build_synthesis_prompt must format summaries and video title."""
    prompt = build_synthesis_prompt(
        summaries_text="Section 1: Basics\nSection 2: Advanced",
        video_title="FastAPI Mastery",
    )
    assert 'titled "FastAPI Mastery"' in prompt
    assert "Section 1: Basics" in prompt
    assert "Executive Overview:" in prompt
    assert "Master Table of Contents:" in prompt


@pytest.mark.asyncio
async def test_generate_chunk_success_with_thoughts_tokens(mock_gemini_client, sample_valid_notes_dict: dict):
    """generate_chunk returns ChunkGeneratedNotes and extracts thoughts_tokens from usage_metadata."""
    mock_response = MagicMock()
    mock_response.text = json.dumps(sample_valid_notes_dict)
    mock_response.model_version = "gemini-2.5-flash-001"
    mock_candidate = MagicMock()
    mock_candidate.finish_reason = types.FinishReason.STOP
    mock_response.candidates = [mock_candidate]
    mock_response.usage_metadata = MagicMock(
        prompt_token_count=1600,
        candidates_token_count=420,
        thoughts_token_count=135,
        total_token_count=2155,
    )

    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    result = await generator.generate_chunk(
        chunk_text="Tutorial slice on database transactions and isolation levels.",
        video_title="PostgreSQL Mastery",
        chunk_index=1,
        total_chunks=4,
        request_id="chunk-req-001",
    )

    assert result.overview == sample_valid_notes_dict["overview"]
    assert result.key_concepts == sample_valid_notes_dict["keyConcepts"]
    assert result.detailed_notes == sample_valid_notes_dict["detailedNotes"]
    assert result.shorthands == sample_valid_notes_dict["shorthands"]

    # Verify usage extraction
    assert result.usage.prompt_tokens == 1600
    assert result.usage.candidate_tokens == 420
    assert result.usage.thoughts_tokens == 135
    assert result.usage.total_tokens == 2155

    # Verify flat field parity
    assert result.prompt_tokens == 1600
    assert result.candidate_tokens == 420
    assert result.thoughts_tokens == 135
    assert result.total_tokens == 2155


@pytest.mark.asyncio
async def test_generate_chunk_handles_rate_limit(mock_gemini_client):
    """generate_chunk raises RateLimitedException on upstream 429."""
    api_error = genai_errors.APIError(
        code=429,
        response_json={"error": {"message": "[429 Too Many Requests] RESOURCE_EXHAUSTED: rate limit exceeded"}},
    )
    mock_gemini_client.aio.models.generate_content.side_effect = api_error

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with pytest.raises(RateLimitedException):
        await generator.generate_chunk(
            chunk_text="Valid chunk text for testing.",
            video_title="Title",
        )


@pytest.mark.asyncio
async def test_generate_chunk_handles_timeout(mock_gemini_client):
    """generate_chunk raises TimeoutException on timeout."""
    mock_gemini_client.aio.models.generate_content.side_effect = TimeoutError("Deadline exceeded")

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with pytest.raises(TimeoutException):
        await generator.generate_chunk(
            chunk_text="Valid chunk text for testing.",
            video_title="Title",
        )


@pytest.mark.asyncio
async def test_synthesize_success_with_thoughts_tokens(mock_gemini_client):
    """synthesize returns SynthesizedNotes and extracts thoughts_tokens."""
    synth_output = {
        "overview": "Master executive overview synthesizing 3 sections.",
        "keyConcepts": ["Architecture", "Resilience", "Transactions"],
        "tableOfContents": [
            "1. Architectural Fundamentals",
            "2. Failure Modes",
            "3. Concurrency Patterns",
        ],
        "shorthands": ["Always lock parents first", "Fail closed on rate limits"],
    }
    mock_response = MagicMock()
    mock_response.text = json.dumps(synth_output)
    mock_response.model_version = "gemini-2.5-flash-001"
    mock_candidate = MagicMock()
    mock_candidate.finish_reason = types.FinishReason.STOP
    mock_response.candidates = [mock_candidate]
    mock_response.usage_metadata = MagicMock(
        prompt_token_count=2100,
        candidates_token_count=520,
        thoughts_token_count=180,
        total_token_count=2800,
    )

    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    summaries = [
        ChunkSummary(chunk_index=0, overview="Overview 1", key_concepts=["C1"], shorthands=["S1"]),
        ChunkSummary(chunk_index=1, overview="Overview 2", key_concepts=["C2"], shorthands=["S2"]),
    ]

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    result = await generator.synthesize(
        chunk_summaries=summaries,
        video_title="System Design Masterclass",
        request_id="synth-req-001",
    )

    assert result.overview == synth_output["overview"]
    assert result.key_concepts == synth_output["keyConcepts"]
    assert result.table_of_contents == synth_output["tableOfContents"]
    assert result.shorthands == synth_output["shorthands"]

    assert result.usage.prompt_tokens == 2100
    assert result.usage.candidate_tokens == 520
    assert result.usage.thoughts_tokens == 180
    assert result.usage.total_tokens == 2800

    assert result.thoughts_tokens == 180
    assert result.total_tokens == 2800


@pytest.mark.asyncio
async def test_synthesize_handles_malformed_output(mock_gemini_client):
    """synthesize raises MalformedOutputException on invalid JSON."""
    mock_response = MagicMock()
    mock_response.text = "Not a valid JSON response"
    mock_response.candidates = [MagicMock()]
    mock_response.usage_metadata = None

    mock_gemini_client.aio.models.generate_content.return_value = mock_response

    summaries = [
        ChunkSummary(chunk_index=0, overview="Overview 1", key_concepts=["C1"], shorthands=["S1"]),
    ]

    generator = GeminiNoteGenerator(client=mock_gemini_client)
    with pytest.raises(MalformedOutputException):
        await generator.synthesize(
            chunk_summaries=summaries,
            video_title="Video",
        )
