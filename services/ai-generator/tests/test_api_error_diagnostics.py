"""Focused tests for structured Google API error and quota diagnostic extraction."""

import io
import json
import logging
from unittest.mock import AsyncMock, MagicMock, PropertyMock

import pytest
from google.genai import errors as genai_errors

from app.errors import RateLimitedException, UpstreamErrorException
from app.generator import (
    GeminiNoteGenerator,
    extract_api_error_diagnostics,
    sanitize_diagnostic_string,
)
from app.main import (
    ALLOWLISTED_LOG_FIELDS,
    SafeJsonFormatter,
    _sanitize_log_value,
    setup_logging,
)
from app.schemas import ChunkSummary


# -----------------------------------------------------------------------------
# 1. QuotaFailure with Quota Metric
# -----------------------------------------------------------------------------

def test_extract_quota_failure_with_metric():
    """Extracts violations from google.rpc.QuotaFailure including subject and description."""
    error_payload = {
        "error": {
            "code": 429,
            "message": "Resource has been exhausted (e.g. check quota).",
            "status": "RESOURCE_EXHAUSTED",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                    "violations": [
                        {
                            "subject": "project:1234567890",
                            "description": "Quota exceeded for quota metric 'GenerateContentRequestsPerDayPerProject' and limit 'GenerateContentRequestsPerDayPerProject' of service 'generativelanguage.googleapis.com'",
                        }
                    ],
                }
            ],
        }
    }
    exc = genai_errors.APIError(code=429, response_json=error_payload)
    diagnostics = extract_api_error_diagnostics(exc)

    assert diagnostics["status_code"] == 429
    assert diagnostics["grpc_status"] == "RESOURCE_EXHAUSTED"
    assert "Resource has been exhausted" in diagnostics["error_message"]
    assert diagnostics["quota_failures"] is not None
    assert len(diagnostics["quota_failures"]) == 1
    assert diagnostics["quota_failures"][0]["subject"] == "project:1234567890"
    assert "GenerateContentRequestsPerDayPerProject" in diagnostics["quota_failures"][0]["description"]


# -----------------------------------------------------------------------------
# 2. ErrorInfo with Quota Metadata
# -----------------------------------------------------------------------------

def test_extract_error_info_with_quota_metadata():
    """Extracts reason and allowlisted metadata from google.rpc.ErrorInfo while ignoring arbitrary keys."""
    error_payload = {
        "error": {
            "code": 429,
            "message": "Rate limit exceeded",
            "status": "RESOURCE_EXHAUSTED",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    "reason": "RATE_LIMIT_EXCEEDED",
                    "domain": "googleapis.com",
                    "metadata": {
                        "consumer": "projects/987654321",
                        "quota_metric": "generativelanguage.googleapis.com/generate_content_requests_per_minute",
                        "quota_limit": "15",
                        "quota_location": "global",
                        "arbitrary_internal_field": "SHOULD_BE_DROPPED",
                    },
                }
            ],
        }
    }
    exc = genai_errors.APIError(code=429, response_json=error_payload)
    diagnostics = extract_api_error_diagnostics(exc)

    assert diagnostics["error_info"] is not None
    assert diagnostics["error_info"]["reason"] == "RATE_LIMIT_EXCEEDED"
    metadata = diagnostics["error_info"]["metadata"]
    assert metadata["consumer"] == "projects/987654321"
    assert metadata["quota_metric"] == "generativelanguage.googleapis.com/generate_content_requests_per_minute"
    assert metadata["quota_limit"] == "15"
    assert metadata["quota_location"] == "global"
    assert "arbitrary_internal_field" not in metadata


# -----------------------------------------------------------------------------
# 3. RetryInfo with Duration String and Object
# -----------------------------------------------------------------------------

def test_extract_retry_info_duration_string():
    """Extracts retryDelay string from google.rpc.RetryInfo."""
    error_payload = {
        "error": {
            "code": 429,
            "message": "Resource exhausted",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    "retryDelay": "43.5s",
                }
            ],
        }
    }
    exc = genai_errors.APIError(code=429, response_json=error_payload)
    diagnostics = extract_api_error_diagnostics(exc)

    assert diagnostics["retry_delay"] == "43.5s"


def test_extract_retry_info_duration_object():
    """Extracts structured seconds and nanos from google.rpc.RetryInfo."""
    error_payload = {
        "error": {
            "code": 429,
            "message": "Resource exhausted",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    "retryDelay": {"seconds": 55, "nanos": 120000000},
                }
            ],
        }
    }
    exc = genai_errors.APIError(code=429, response_json=error_payload)
    diagnostics = extract_api_error_diagnostics(exc)

    assert diagnostics["retry_delay"] == "55.120s"


# -----------------------------------------------------------------------------
# 4. HTTP Retry-After Header
# -----------------------------------------------------------------------------

def test_extract_http_retry_after_header():
    """Extracts Retry-After header from underlying HTTP response object."""
    mock_response = MagicMock()
    mock_response.headers = {"retry-after": "60"}

    exc = genai_errors.APIError(
        code=429,
        response_json={"error": {"message": "Rate limited"}},
        response=mock_response,
    )
    diagnostics = extract_api_error_diagnostics(exc)

    assert diagnostics["retry_after_header"] == "60"


def test_extract_http_retry_after_header_case_insensitive():
    """Extracts Retry-After header regardless of casing."""
    mock_response = MagicMock()
    mock_response.headers = {"Retry-After": "120"}

    exc = genai_errors.APIError(
        code=429,
        response_json={"error": {"message": "Rate limited"}},
        response=mock_response,
    )
    diagnostics = extract_api_error_diagnostics(exc)

    assert diagnostics["retry_after_header"] == "120"


# -----------------------------------------------------------------------------
# 5. Missing Details
# -----------------------------------------------------------------------------

def test_extract_missing_details():
    """Handles empty response JSON without crashing."""
    exc = genai_errors.APIError(code=429, response_json={})
    diagnostics = extract_api_error_diagnostics(exc)

    assert diagnostics["status_code"] == 429
    assert diagnostics["grpc_status"] is None
    assert diagnostics["error_message"] is None
    assert diagnostics["quota_failures"] is None
    assert diagnostics["error_info"] is None
    assert diagnostics["retry_delay"] is None
    assert diagnostics["retry_after_header"] is None


# -----------------------------------------------------------------------------
# 6. Malformed Details
# -----------------------------------------------------------------------------

def test_extract_malformed_details_non_dict_and_non_list():
    """Handles non-dict and non-list details payloads gracefully."""
    # String payload
    exc1 = genai_errors.APIError(code=429, response_json="Plain string error")
    diagnostics1 = extract_api_error_diagnostics(exc1)
    assert diagnostics1["status_code"] == 429
    assert diagnostics1["quota_failures"] is None

    # Error details is not a list
    exc2 = genai_errors.APIError(code=429, response_json={"error": {"details": "invalid_string_details"}})
    diagnostics2 = extract_api_error_diagnostics(exc2)
    assert diagnostics2["status_code"] == 429
    assert diagnostics2["quota_failures"] is None

    # Details list contains non-dict items
    exc3 = genai_errors.APIError(code=429, response_json={"error": {"details": [None, 123, "string", []]}})
    diagnostics3 = extract_api_error_diagnostics(exc3)
    assert diagnostics3["status_code"] == 429
    assert diagnostics3["quota_failures"] is None


# -----------------------------------------------------------------------------
# 7. Unexpected Detail Types
# -----------------------------------------------------------------------------

def test_extract_unexpected_detail_types():
    """Ignores unfamiliar detail protobuf types without failing."""
    error_payload = {
        "error": {
            "code": 429,
            "message": "Resource exhausted",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.Help",
                    "links": [{"description": "API documentation", "url": "https://ai.google.dev"}],
                },
                {
                    "@type": "type.googleapis.com/google.rpc.BadRequest",
                    "fieldViolations": [{"field": "prompt", "description": "Too long"}],
                },
            ],
        }
    }
    exc = genai_errors.APIError(code=429, response_json=error_payload)
    diagnostics = extract_api_error_diagnostics(exc)

    assert diagnostics["status_code"] == 429
    assert diagnostics["quota_failures"] is None
    assert diagnostics["error_info"] is None
    assert diagnostics["retry_delay"] is None


# -----------------------------------------------------------------------------
# 8. Non-429 API Errors
# -----------------------------------------------------------------------------

def test_extract_non_429_api_errors():
    """Extracts status and message from 503 or 500 API errors."""
    error_payload = {
        "error": {
            "code": 503,
            "message": "The service is temporarily unavailable",
            "status": "UNAVAILABLE",
        }
    }
    exc = genai_errors.APIError(code=503, response_json=error_payload)
    diagnostics = extract_api_error_diagnostics(exc)

    assert diagnostics["status_code"] == 503
    assert diagnostics["grpc_status"] == "UNAVAILABLE"
    assert diagnostics["error_message"] == "The service is temporarily unavailable"
    assert diagnostics["quota_failures"] is None


# -----------------------------------------------------------------------------
# 9. Confirmation: No Secrets or Raw Response Logged
# -----------------------------------------------------------------------------

def test_sanitize_diagnostic_string_redacts_api_keys():
    """Sanitizer redacts Gemini API keys and Bearer tokens."""
    raw = "Failed with key AIzaSyD1234567890abcdef1234567890abcdef and Bearer eyJhbGciOiJIUzI1NiJ9.test"
    sanitized = sanitize_diagnostic_string(raw)
    assert "AIzaSyD1234567890" not in sanitized
    assert "eyJhbGci" not in sanitized
    assert "[REDACTED]" in sanitized


@pytest.mark.asyncio
async def test_logs_include_diagnostics_without_leaking_secrets_or_transcripts(caplog):
    """Execution error logs capture structured quota details without leaking transcripts or keys."""
    caplog.set_level(logging.WARNING, logger="ai_generator.generator")

    sensitive_transcript = "TOP_SECRET_PROPRIETARY_SOURCE_CODE_DO_NOT_LEAK"
    secret_api_key = "AIzaSyD00000000000000000000000000000000"

    mock_resp = MagicMock()
    mock_resp.headers = {"retry-after": "45"}

    api_error = genai_errors.APIError(
        code=429,
        response_json={
            "error": {
                "code": 429,
                "message": f"Resource exhausted using key {secret_api_key}",
                "status": "RESOURCE_EXHAUSTED",
                "details": [
                    {
                        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                        "violations": [
                            {
                                "subject": "project:test-proj",
                                "description": "Quota exceeded for quota metric 'GenerateContentRequestsPerDayPerProject'",
                            }
                        ],
                    }
                ],
            }
        },
        response=mock_resp,
    )

    mock_client = MagicMock()
    mock_client.aio.models.generate_content.side_effect = api_error

    generator = GeminiNoteGenerator(client=mock_client)

    # 1. Test generate_notes
    with pytest.raises(RateLimitedException):
        await generator.generate_notes(transcript=sensitive_transcript, video_title="Tutorial")

    # 2. Test generate_chunk
    with pytest.raises(RateLimitedException):
        await generator.generate_chunk(chunk_text=sensitive_transcript, video_title="Tutorial")

    # 3. Test synthesize
    with pytest.raises(RateLimitedException):
        await generator.synthesize(
            chunk_summaries=[ChunkSummary(chunk_index=0, overview="O", key_concepts=[], shorthands=[])],
            video_title="Tutorial",
        )

    # Verify log messages were emitted
    assert len(caplog.records) == 3
    for record in caplog.records:
        log_dict = getattr(record, "__dict__", {})
        # Verify structured diagnostic fields are present in log extra
        assert log_dict.get("status_code") == 429
        assert log_dict.get("grpc_status") == "RESOURCE_EXHAUSTED"
        assert log_dict.get("retry_after_header") == "45"
        assert log_dict.get("quota_failures") is not None
        assert "GenerateContentRequestsPerDayPerProject" in log_dict["quota_failures"][0]["description"]

        # Verify sensitive transcript text is NOT leaked in any log field
        assert sensitive_transcript not in record.message
        assert sensitive_transcript not in str(log_dict)

        # Verify API key was redacted
        assert secret_api_key not in str(log_dict)
        assert "[REDACTED]" in str(log_dict.get("error_message"))


# -----------------------------------------------------------------------------
# 10. Confirmation: Client-Facing Error Response Unchanged
# -----------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_client_facing_rate_limited_response_unchanged():
    """Client receives the exact same RateLimitedException semantics and message."""
    mock_client = MagicMock()
    mock_client.aio.models.generate_content.side_effect = genai_errors.APIError(
        code=429,
        response_json={
            "error": {
                "message": "Upstream internal quota exhausted detail",
                "status": "RESOURCE_EXHAUSTED",
            }
        },
    )

    generator = GeminiNoteGenerator(client=mock_client)

    # Monolithic
    with pytest.raises(RateLimitedException) as exc_notes:
        await generator.generate_notes(transcript="Text", video_title="Title")
    assert exc_notes.value.code == "RATE_LIMITED"
    assert exc_notes.value.status_code == 429
    assert exc_notes.value.message == "AI generation service is temporarily busy. Retrying later is recommended."
    assert exc_notes.value.headers == {}
    assert "Upstream internal quota" not in exc_notes.value.message

    # Chunk
    with pytest.raises(RateLimitedException) as exc_chunk:
        await generator.generate_chunk(chunk_text="Text", video_title="Title")
    assert exc_chunk.value.code == "RATE_LIMITED"
    assert exc_chunk.value.status_code == 429
    assert exc_chunk.value.message == "AI generation service is temporarily busy. Retrying later is recommended."
    assert exc_chunk.value.headers == {}

    # Synthesize
    with pytest.raises(RateLimitedException) as exc_synth:
        await generator.synthesize(
            chunk_summaries=[ChunkSummary(chunk_index=0, overview="O", key_concepts=[], shorthands=[])],
            video_title="Title",
        )
    assert exc_synth.value.code == "RATE_LIMITED"
    assert exc_synth.value.status_code == 429
    assert exc_synth.value.message == "AI generation service is temporarily busy. Retrying later is recommended."
    assert exc_synth.value.headers == {}


# -----------------------------------------------------------------------------
# 11. Edge-Case Extraction Tests
# -----------------------------------------------------------------------------

def test_extract_retry_info_zero_seconds_nonzero_nanos():
    """Extracts duration string when seconds is 0 and nanos is nonzero."""
    error_payload = {
        "error": {
            "code": 429,
            "message": "Resource exhausted",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    "retryDelay": {"seconds": 0, "nanos": 500000000},
                }
            ],
        }
    }
    exc = genai_errors.APIError(code=429, response_json=error_payload)
    diagnostics = extract_api_error_diagnostics(exc)
    assert diagnostics["retry_delay"] == "0.500s"


def test_extract_retry_info_omitted_seconds_with_nanos():
    """Extracts duration string when seconds is omitted but nanos is present."""
    error_payload = {
        "error": {
            "code": 429,
            "message": "Resource exhausted",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    "retryDelay": {"nanos": 750000000},
                }
            ],
        }
    }
    exc = genai_errors.APIError(code=429, response_json=error_payload)
    diagnostics = extract_api_error_diagnostics(exc)
    assert diagnostics["retry_delay"] == "0.750s"


def test_extract_unexpected_inputs_to_extractor():
    """Handles unexpected and non-APIError inputs safely without raising exceptions."""
    # None
    d_none = extract_api_error_diagnostics(None)
    assert isinstance(d_none, dict)
    assert d_none["status_code"] is None

    # Primitive types
    d_int = extract_api_error_diagnostics(12345)
    assert d_int["status_code"] is None

    d_str = extract_api_error_diagnostics("some error string")
    assert d_str["status_code"] is None

    # Standard exceptions without SDK attributes
    d_exc = extract_api_error_diagnostics(ValueError("unhandled value"))
    assert d_exc["status_code"] is None
    assert d_exc["error_message"] == "unhandled value"

    # Mock object whose property accessor throws an exception
    class BrokenException:
        @property
        def code(self):
            raise RuntimeError("Property access failed!")

    d_broken = extract_api_error_diagnostics(BrokenException())
    assert isinstance(d_broken, dict)
    assert d_broken["status_code"] is None


# -----------------------------------------------------------------------------
# 12. SafeJsonFormatter Stdout Formatting Tests
# -----------------------------------------------------------------------------

def test_safe_json_formatter_ordinary_log_format():
    """Ordinary application log preserves timestamp, level, logger, message without extra fields."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    formatter = SafeJsonFormatter()
    handler.setFormatter(formatter)

    test_logger = logging.getLogger("test.ordinary")
    test_logger.setLevel(logging.INFO)
    test_logger.handlers = [handler]
    test_logger.propagate = False

    test_logger.info("Service initialized successfully.")
    raw_output = stream.getvalue().strip()
    parsed = json.loads(raw_output)

    assert parsed["level"] == "INFO"
    assert parsed["logger"] == "test.ordinary"
    assert parsed["message"] == "Service initialized successfully."
    assert "timestamp" in parsed
    # Verify no diagnostic fields are present in ordinary log
    for field in ALLOWLISTED_LOG_FIELDS:
        assert field not in parsed


def test_safe_json_formatter_gemini_429_diagnostic_fields_emitted():
    """Gemini 429 log serializes all allowlisted diagnostic and operational fields to JSON stdout."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    formatter = SafeJsonFormatter()
    handler.setFormatter(formatter)

    test_logger = logging.getLogger("test.gemini.429")
    test_logger.setLevel(logging.WARNING)
    test_logger.handlers = [handler]
    test_logger.propagate = False

    diagnostic_payload = {
        "status_code": 429,
        "grpc_status": "RESOURCE_EXHAUSTED",
        "error_message": "Quota exceeded for quota metric 'GenerateContentRequestsPerDayPerProject'",
        "quota_failures": [
            {
                "subject": "project:123456",
                "description": "Quota exceeded for quota metric 'GenerateContentRequestsPerDayPerProject'",
            }
        ],
        "error_info": {
            "reason": "RATE_LIMIT_EXCEEDED",
            "metadata": {
                "quota_metric": "GenerateContentRequestsPerDayPerProject",
                "quota_limit": "20",
                "consumer": "projects/123456",
            },
        },
        "retry_delay": "45s",
        "retry_after_header": "60",
        "request_id": "req-diag-001",
        "model": "gemini-2.5-flash",
        "chunk_index": 1,
        "total_chunks": 7,
        "timeout_ms": 75000,
        "duration_ms": 1245.8,
    }

    test_logger.warning("gemini_chunk_api_error", extra=diagnostic_payload)
    raw_output = stream.getvalue().strip()
    parsed = json.loads(raw_output)

    # Core log fields
    assert parsed["level"] == "WARNING"
    assert parsed["logger"] == "test.gemini.429"
    assert parsed["message"] == "gemini_chunk_api_error"

    # All allowlisted diagnostic fields
    assert parsed["status_code"] == 429
    assert parsed["grpc_status"] == "RESOURCE_EXHAUSTED"
    assert "GenerateContentRequestsPerDayPerProject" in parsed["error_message"]
    assert parsed["quota_failures"] == diagnostic_payload["quota_failures"]
    assert parsed["error_info"] == diagnostic_payload["error_info"]
    assert parsed["retry_delay"] == "45s"
    assert parsed["retry_after_header"] == "60"
    assert parsed["request_id"] == "req-diag-001"
    assert parsed["model"] == "gemini-2.5-flash"
    assert parsed["chunk_index"] == 1
    assert parsed["total_chunks"] == 7
    assert parsed["timeout_ms"] == 75000
    assert parsed["duration_ms"] == 1245.8


def test_safe_json_formatter_redacts_secrets_in_emitted_json():
    """Redacts API keys and Bearer tokens even if present inside allowlisted fields."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    formatter = SafeJsonFormatter()
    handler.setFormatter(formatter)

    test_logger = logging.getLogger("test.redaction")
    test_logger.setLevel(logging.WARNING)
    test_logger.handlers = [handler]
    test_logger.propagate = False

    secret_key = "AIzaSyD9876543210abcdef9876543210abcdef"
    secret_token = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive"

    test_logger.warning(
        "gemini_api_error",
        extra={
            "status_code": 429,
            "error_message": f"Authentication failed with key {secret_key}",
            "error_info": {
                "reason": "AUTH_FAILED",
                "metadata": {"consumer": f"token {secret_token}"},
            },
        },
    )

    raw_output = stream.getvalue().strip()
    assert secret_key not in raw_output
    assert "eyJhbGci" not in raw_output
    assert "[REDACTED]" in raw_output

    parsed = json.loads(raw_output)
    assert "[REDACTED]" in parsed["error_message"]
    assert "[REDACTED]" in parsed["error_info"]["metadata"]["consumer"]


def test_safe_json_formatter_excludes_transcript_prompt_and_arbitrary_metadata():
    """Ensures transcripts, prompts, and arbitrary unallowlisted fields NEVER appear in emitted JSON."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    formatter = SafeJsonFormatter()
    handler.setFormatter(formatter)

    test_logger = logging.getLogger("test.privacy")
    test_logger.setLevel(logging.WARNING)
    test_logger.handlers = [handler]
    test_logger.propagate = False

    forbidden_transcript = "PROPRIETARY_TRANSCRIPT_CONTENT_TOP_SECRET"
    forbidden_prompt = "CONFIDENTIAL_SYSTEM_PROMPT_INSTRUCTION"

    test_logger.warning(
        "gemini_chunk_api_error",
        extra={
            "status_code": 429,
            "transcript": forbidden_transcript,
            "prompt": forbidden_prompt,
            "chunk_text": "CHUNK_DATA_SECRET",
            "arbitrary_field": "SHOULD_BE_DROPPED",
            "internal_stack": ["line 1", "line 2"],
            "raw_response": {"body": "full_unparsed_json"},
        },
    )

    raw_output = stream.getvalue().strip()
    assert forbidden_transcript not in raw_output
    assert forbidden_prompt not in raw_output
    assert "CHUNK_DATA_SECRET" not in raw_output
    assert "arbitrary_field" not in raw_output
    assert "internal_stack" not in raw_output
    assert "raw_response" not in raw_output

    parsed = json.loads(raw_output)
    assert "transcript" not in parsed
    assert "prompt" not in parsed
    assert "chunk_text" not in parsed
    assert "arbitrary_field" not in parsed
    assert "raw_response" not in parsed
    assert parsed["status_code"] == 429


def test_safe_json_formatter_malformed_values_cannot_crash_logging():
    """Formatter falls back safely when encountering un-serializable objects without raising."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    formatter = SafeJsonFormatter()
    handler.setFormatter(formatter)

    test_logger = logging.getLogger("test.malformed")
    test_logger.setLevel(logging.ERROR)
    test_logger.handlers = [handler]
    test_logger.propagate = False

    class Unstringifiable:
        def __str__(self):
            raise RuntimeError("Cannot stringify!")

    # Pass unstringifiable object
    test_logger.error(
        "gemini_unexpected_error",
        extra={
            "status_code": 500,
            "error_info": Unstringifiable(),
        },
    )

    raw_output = stream.getvalue().strip()
    assert raw_output.startswith("{") and raw_output.endswith("}")
    parsed = json.loads(raw_output)
    assert parsed["level"] == "ERROR"
    assert parsed["message"] == "gemini_unexpected_error"


@pytest.mark.asyncio
async def test_actual_stdout_capture_during_gemini_429():
    """Validates real end-to-end stdout stream emission during a simulated Gemini 429 error."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(SafeJsonFormatter())

    app_logger = logging.getLogger("ai_generator.generator")
    original_handlers = list(app_logger.handlers)
    original_propagate = app_logger.propagate

    app_logger.handlers = [handler]
    app_logger.propagate = False

    try:
        mock_resp = MagicMock()
        mock_resp.headers = {"retry-after": "50"}

        api_error = genai_errors.APIError(
            code=429,
            response_json={
                "error": {
                    "code": 429,
                    "message": "Quota exceeded",
                    "status": "RESOURCE_EXHAUSTED",
                    "details": [
                        {
                            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                            "violations": [
                                {
                                    "subject": "project:test-e2e",
                                    "description": "Quota exceeded for quota metric 'GenerateContentRequestsPerDayPerProject'",
                                }
                            ],
                        }
                    ],
                }
            },
            response=mock_resp,
        )

        mock_client = MagicMock()
        mock_client.aio.models.generate_content.side_effect = api_error

        generator = GeminiNoteGenerator(client=mock_client)
        with pytest.raises(RateLimitedException):
            await generator.generate_chunk(chunk_text="Chunk text", video_title="Video")

        lines = [json.loads(l) for l in stream.getvalue().strip().splitlines() if l.strip()]
        assert len(lines) == 2

        # 1. Started event
        started_log = lines[0]
        assert started_log["level"] == "INFO"
        assert started_log["message"] == "gemini_chunk_generation_started"
        assert started_log["chunk_index"] == 0

        # 2. Error diagnostic event
        parsed = lines[1]
        assert parsed["level"] == "WARNING"
        assert parsed["message"] == "gemini_chunk_api_error"
        assert parsed["status_code"] == 429
        assert parsed["grpc_status"] == "RESOURCE_EXHAUSTED"
        assert parsed["retry_after_header"] == "50"
        assert len(parsed["quota_failures"]) == 1
        assert "GenerateContentRequestsPerDayPerProject" in parsed["quota_failures"][0]["description"]

    finally:
        app_logger.handlers = original_handlers
        app_logger.propagate = original_propagate


# -----------------------------------------------------------------------------
# 15. Message Sanitization Tests (Fix 1)
# -----------------------------------------------------------------------------

def test_safe_json_formatter_redacts_secret_in_message():
    """Secrets embedded directly inside record.msg or record.getMessage() are redacted."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(SafeJsonFormatter())

    test_logger = logging.getLogger("test.secret_message")
    test_logger.setLevel(logging.INFO)
    test_logger.handlers = [handler]
    test_logger.propagate = False

    secret_key = "AIzaSyB1234567890abcdef1234567890abcdef"
    secret_token = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.topsecret"

    test_logger.info(f"Failed to connect using API key: {secret_key}")
    test_logger.info(f"Authorization header contains: {secret_token}")

    raw_output = stream.getvalue()
    assert secret_key not in raw_output
    assert "eyJhbGci" not in raw_output

    lines = [json.loads(l) for l in raw_output.strip().splitlines() if l.strip()]
    assert len(lines) == 2
    assert lines[0]["message"] == "Failed to connect using API key: [REDACTED]"
    assert lines[1]["message"] == "Authorization header contains: [REDACTED]"


def test_safe_json_formatter_truncates_oversized_message():
    """Messages exceeding 1000 characters are safely truncated."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(SafeJsonFormatter())

    test_logger = logging.getLogger("test.oversized_message")
    test_logger.setLevel(logging.INFO)
    test_logger.handlers = [handler]
    test_logger.propagate = False

    oversized_text = "X" * 2500
    test_logger.info(oversized_text)

    raw_output = stream.getvalue().strip()
    parsed = json.loads(raw_output)

    assert len(parsed["message"]) == 1000 + len("...[TRUNCATED]")
    assert parsed["message"].startswith("XXXXX")
    assert parsed["message"].endswith("...[TRUNCATED]")


def test_safe_json_formatter_fallback_sanitizes_message():
    """Fallback formatting path also rigorously sanitizes secrets and truncates oversized messages."""
    formatter = SafeJsonFormatter()
    secret_key = "AIzaSyD99999999999999999999999999999999"
    oversized_message = f"Error occurred with key {secret_key} " + ("Y" * 2000)

    # Create a record that causes format() try block to fail
    record = logging.LogRecord(
        name="test.fallback",
        level=logging.ERROR,
        pathname="test.py",
        lineno=1,
        msg=oversized_message,
        args=(),
        exc_info=None,
    )

    # Inject a property that raises an error when accessed by format()
    class CrashingField:
        def __str__(self):
            raise RuntimeError("Forced crash in normal formatter path")

    setattr(record, "status_code", CrashingField())

    output = formatter.format(record)
    assert secret_key not in output
    assert "[REDACTED]" in output
    assert "...[TRUNCATED]" in output

    parsed = json.loads(output)
    assert parsed["level"] == "ERROR"
    assert parsed["logger"] == "test.fallback"
    assert "[REDACTED]" in parsed["message"]
    assert parsed["message"].endswith("...[TRUNCATED]")


def test_safe_json_formatter_formatting_error_cannot_expose_unsanitized_message():
    """Formatting errors in getMessage() or fatal serialization errors cannot expose raw secrets."""
    formatter = SafeJsonFormatter()

    # Case 1: getMessage() raises TypeError due to invalid % formatting
    record_bad_args = logging.LogRecord(
        name="test.bad_args",
        level=logging.ERROR,
        pathname="test.py",
        lineno=1,
        msg="Invalid format %d with key AIzaSyD00000000000000000000000000000000",
        args=("non_int_arg",),  # raises TypeError
        exc_info=None,
    )

    output = formatter.format(record_bad_args)
    parsed = json.loads(output)
    assert "AIzaSy" not in output
    assert parsed["message"] == "[UNSERIALIZABLE]"

    # Case 2: Fatal error during fallback json.dumps
    with pytest.MonkeyPatch.context() as mp:
        def crashing_dumps(*args, **kwargs):
            raise RuntimeError("Fatal serialization crash")
        mp.setattr(json, "dumps", crashing_dumps)

        fatal_output = formatter.format(record_bad_args)
        assert fatal_output == '{"level":"ERROR","message":"[LOG_FORMATTING_FATAL_ERROR]"}'


# -----------------------------------------------------------------------------
# 16. Operational Telemetry Tests (Fix 2)
# -----------------------------------------------------------------------------

def test_safe_json_formatter_operational_telemetry_included():
    """Operational token telemetry, finish_reason, and character counts appear in emitted JSON while unapproved fields remain excluded."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(SafeJsonFormatter())

    test_logger = logging.getLogger("test.telemetry")
    test_logger.setLevel(logging.INFO)
    test_logger.handlers = [handler]
    test_logger.propagate = False

    test_logger.info(
        "gemini_generation_completed",
        extra={
            "request_id": "req-telemetry-456",
            "model": "gemini-2.5-flash",
            "duration_ms": 3412.5,
            # Operational metrics (approved)
            "prompt_tokens": 4200,
            "candidate_tokens": 1150,
            "thoughts_tokens": 300,
            "total_tokens": 5650,
            "finish_reason": "STOP",
            "transcript_chars": 15800,
            "output_chars": 4200,
            # Unapproved / sensitive fields (must be excluded)
            "transcript": "CONFIDENTIAL_FULL_TRANSCRIPT_BODY",
            "prompt": "CONFIDENTIAL_SYSTEM_PROMPT_INSTRUCTIONS",
            "raw_response": {"text": "raw model output"},
            "user_data": {"user_id": "usr_private_123"},
            "arbitrary_metadata": {"foo": "bar"},
        },
    )

    raw_output = stream.getvalue().strip()
    assert "CONFIDENTIAL_FULL_TRANSCRIPT_BODY" not in raw_output
    assert "CONFIDENTIAL_SYSTEM_PROMPT_INSTRUCTIONS" not in raw_output
    assert "raw model output" not in raw_output
    assert "usr_private_123" not in raw_output
    assert "arbitrary_metadata" not in raw_output

    parsed = json.loads(raw_output)
    assert parsed["message"] == "gemini_generation_completed"
    assert parsed["request_id"] == "req-telemetry-456"
    assert parsed["model"] == "gemini-2.5-flash"
    assert parsed["duration_ms"] == 3412.5
    assert parsed["prompt_tokens"] == 4200
    assert parsed["candidate_tokens"] == 1150
    assert parsed["thoughts_tokens"] == 300
    assert parsed["total_tokens"] == 5650
    assert parsed["finish_reason"] == "STOP"
    assert parsed["transcript_chars"] == 15800
    assert parsed["output_chars"] == 4200

    # Ensure unapproved fields are NOT in the parsed dictionary
    assert "transcript" not in parsed
    assert "prompt" not in parsed
    assert "raw_response" not in parsed
    assert "user_data" not in parsed
    assert "arbitrary_metadata" not in parsed


@pytest.mark.asyncio
async def test_actual_stdout_capture_during_successful_generation():
    """Verifies end-to-end stdout stream emission of token telemetry during successful chunk generation."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(SafeJsonFormatter())

    app_logger = logging.getLogger("ai_generator.generator")
    original_handlers = list(app_logger.handlers)
    original_propagate = app_logger.propagate

    app_logger.handlers = [handler]
    app_logger.propagate = False

    try:
        mock_response = MagicMock()
        mock_response.text = json.dumps({
            "overview": "Overview of chunk",
            "keyConcepts": ["Concept A", "Concept B"],
            "detailedNotes": "Detailed notes markdown",
            "shorthands": ["Tip 1"],
        })
        mock_response.model_version = "gemini-2.5-flash-preview"

        mock_candidate = MagicMock()
        mock_candidate.finish_reason = "STOP"
        mock_response.candidates = [mock_candidate]

        mock_usage = MagicMock()
        mock_usage.prompt_token_count = 1200
        mock_usage.candidates_token_count = 450
        mock_usage.thoughts_token_count = 100
        mock_usage.total_token_count = 1750
        mock_response.usage_metadata = mock_usage

        mock_client = MagicMock()
        mock_client.aio.models.generate_content = AsyncMock(return_value=mock_response)

        generator = GeminiNoteGenerator(client=mock_client)
        result = await generator.generate_chunk(
            chunk_text="Short chunk transcript content",
            video_title="Tutorial Title",
            chunk_index=0,
            total_chunks=1,
            request_id="req-e2e-success",
        )
        assert result.overview == "Overview of chunk"

        lines = [json.loads(l) for l in stream.getvalue().strip().splitlines() if l.strip()]
        completed_logs = [l for l in lines if l.get("message") == "gemini_chunk_generation_completed"]
        assert len(completed_logs) == 1
        comp = completed_logs[0]

        assert comp["request_id"] == "req-e2e-success"
        assert comp["chunk_index"] == 0
        assert comp["total_chunks"] == 1
        assert comp["prompt_tokens"] == 1200
        assert comp["candidate_tokens"] == 450
        assert comp["thoughts_tokens"] == 100
        assert comp["total_tokens"] == 1750
        assert comp["finish_reason"] == "STOP"
        assert comp["output_chars"] > 0
        assert "chunk_text" not in comp
        assert "Short chunk transcript content" not in stream.getvalue()

    finally:
        app_logger.handlers = original_handlers
        app_logger.propagate = original_propagate


# -----------------------------------------------------------------------------
# 17. Bounded Collection Consumption & Non-Throwing Fallback Tests
# -----------------------------------------------------------------------------

def test_sanitize_log_value_bounds_collection_consumption():
    """Confirms no more than 25 items are consumed from large or instrumented collections."""
    consumed_count = 0

    class InstrumentedSequence(list):
        def __iter__(self):
            nonlocal consumed_count
            for item in super().__iter__():
                consumed_count += 1
                yield item

    large_list = InstrumentedSequence(range(100))
    sanitized = _sanitize_log_value(large_list)

    assert len(sanitized) == 25
    assert consumed_count == 25  # Bounded iteration stops at exactly 25 items

    # Also verify instrumented dict items()
    dict_consumed = 0

    class InstrumentedDict(dict):
        def items(self):
            nonlocal dict_consumed
            for k, v in super().items():
                dict_consumed += 1
                yield k, v

    large_dict = InstrumentedDict({f"k_{i}": f"v_{i}" for i in range(100)})
    sanitized_dict = _sanitize_log_value(large_dict)

    assert len(sanitized_dict) == 25
    assert dict_consumed == 25  # Bounded iteration stops at exactly 25 items


def test_safe_json_formatter_fallback_handles_timestamp_failure():
    """Formatter still emits valid fallback JSON when timestamp formatting fails."""
    formatter = SafeJsonFormatter()
    record = logging.LogRecord(
        name="test.broken_timestamp",
        level=logging.WARNING,
        pathname="test.py",
        lineno=1,
        msg="Operational warning with bad timestamp",
        args=(),
        exc_info=None,
    )

    # Force formatTime to raise an exception
    with pytest.MonkeyPatch.context() as mp:
        def crashing_format_time(*args, **kwargs):
            raise ValueError("Corrupted time attribute")

        mp.setattr(formatter, "formatTime", crashing_format_time)

        output = formatter.format(record)
        assert output.startswith("{") and output.endswith("}")
        parsed = json.loads(output)
        assert parsed["level"] == "WARNING"
        assert parsed["logger"] == "test.broken_timestamp"
        assert parsed["message"] == "Operational warning with bad timestamp"
        assert "timestamp" not in parsed



