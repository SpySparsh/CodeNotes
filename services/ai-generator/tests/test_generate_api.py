"""HTTP integration tests for POST /api/v1/generate."""

import json
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from google.genai import errors as genai_errors
from pydantic import SecretStr

from app.config import Settings
from app.errors import (
    ERR_CONFIG_ERROR,
    ERR_INVALID_REQUEST,
    ERR_MALFORMED_OUTPUT,
    ERR_RATE_LIMITED,
    ERR_TIMEOUT,
    ERR_UPSTREAM_ERROR,
)
from app.main import sanitize_request_id
from app.schemas import MAX_TITLE_CHARS, MAX_TRANSCRIPT_CHARS


def test_generate_notes_success_with_camel_case_contract(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_valid_notes_dict: dict,
):
    """POST /api/v1/generate returns 200 with exact camelCase field names matching contract."""
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_response = AsyncMock()
        mock_response.text = json.dumps(sample_valid_notes_dict)
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

        response = client.post(
            "/api/v1/generate",
            headers=auth_headers,
            json={
                "transcript": "In this tutorial we learn interfaces and generics in TypeScript.",
                "videoTitle": "TypeScript Tutorial",
            },
        )

        assert response.status_code == 200
        data = response.json()

        # Contract assertions
        assert "overview" in data
        assert "keyConcepts" in data
        assert "detailedNotes" in data
        assert "shorthands" in data
        assert "key_concepts" not in data
        assert "detailed_notes" not in data

        assert data["overview"] == sample_valid_notes_dict["overview"]
        assert data["keyConcepts"] == sample_valid_notes_dict["keyConcepts"]
        assert data["detailedNotes"] == sample_valid_notes_dict["detailedNotes"]
        assert data["shorthands"] == sample_valid_notes_dict["shorthands"]


def test_generate_notes_with_markdown_fences(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_valid_notes_dict: dict,
):
    """POST /api/v1/generate strips markdown code fences returned by model."""
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_response = AsyncMock()
        mock_response.text = f"```json\n{json.dumps(sample_valid_notes_dict)}\n```"
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

        response = client.post(
            "/api/v1/generate",
            headers=auth_headers,
            json={
                "transcript": "Tutorial content about state management.",
                "videoTitle": "Zustand Masterclass",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["overview"] == sample_valid_notes_dict["overview"]


def test_generate_notes_rejects_missing_fields(client: TestClient, auth_headers: dict[str, str]):
    """Missing transcript or videoTitle must return HTTP 422 INVALID_REQUEST."""
    res1 = client.post("/api/v1/generate", headers=auth_headers, json={})
    assert res1.status_code == 422
    assert res1.json()["error"]["code"] == ERR_INVALID_REQUEST

    res2 = client.post("/api/v1/generate", headers=auth_headers, json={"transcript": "valid text"})
    assert res2.status_code == 422
    assert res2.json()["error"]["code"] == ERR_INVALID_REQUEST

    res3 = client.post("/api/v1/generate", headers=auth_headers, json={"videoTitle": "Valid Title"})
    assert res3.status_code == 422
    assert res3.json()["error"]["code"] == ERR_INVALID_REQUEST


def test_generate_notes_rejects_oversized_transcript(client: TestClient, auth_headers: dict[str, str]):
    """Transcript exceeding MAX_TRANSCRIPT_CHARS must return HTTP 422."""
    oversized = "a" * (MAX_TRANSCRIPT_CHARS + 10)
    response = client.post(
        "/api/v1/generate",
        headers=auth_headers,
        json={"transcript": oversized, "videoTitle": "Valid Title"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == ERR_INVALID_REQUEST


def test_generate_notes_rejects_oversized_title(client: TestClient, auth_headers: dict[str, str]):
    """Video title exceeding MAX_TITLE_CHARS must return HTTP 422."""
    oversized_title = "t" * (MAX_TITLE_CHARS + 5)
    response = client.post(
        "/api/v1/generate",
        headers=auth_headers,
        json={"transcript": "Valid transcript here.", "videoTitle": oversized_title},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == ERR_INVALID_REQUEST


def test_generate_notes_handles_malformed_model_json(client: TestClient, auth_headers: dict[str, str]):
    """Model output that cannot be parsed as JSON must return HTTP 502 MALFORMED_OUTPUT."""
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_response = AsyncMock()
        mock_response.text = "NOT_VALID_JSON_RESPONSE"
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

        response = client.post(
            "/api/v1/generate",
            headers=auth_headers,
            json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
        )

        assert response.status_code == 502
        body = response.json()
        assert body["error"]["code"] == ERR_MALFORMED_OUTPUT
        assert "malformed" in body["error"]["message"].lower()


def test_generate_notes_handles_structurally_invalid_model_output(
    client: TestClient,
    auth_headers: dict[str, str],
):
    """Model output missing required fields (e.g. missing overview) must return HTTP 502."""
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_response = AsyncMock()
        # Missing overview
        mock_response.text = json.dumps({"keyConcepts": ["Concept 1"], "detailedNotes": "Notes"})
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

        response = client.post(
            "/api/v1/generate",
            headers=auth_headers,
            json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
        )

        assert response.status_code == 502
        body = response.json()
        assert body["error"]["code"] == ERR_MALFORMED_OUTPUT


def test_generate_notes_handles_upstream_timeout(client: TestClient, auth_headers: dict[str, str]):
    """Upstream timeout must return HTTP 504 TIMEOUT."""
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_instance.aio.models.generate_content = AsyncMock(side_effect=TimeoutError("Request deadline exceeded"))

        response = client.post(
            "/api/v1/generate",
            headers=auth_headers,
            json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
        )

        assert response.status_code == 504
        body = response.json()
        assert body["error"]["code"] == ERR_TIMEOUT
        assert "timed out after 75 seconds" in body["error"]["message"]


def test_generate_notes_handles_upstream_rate_limiting(client: TestClient, auth_headers: dict[str, str]):
    """Upstream 429 RESOURCE_EXHAUSTED must return HTTP 429 RATE_LIMITED."""
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        api_error = genai_errors.APIError(
            code=429,
            response_json={"error": {"message": "[429 Too Many Requests] RESOURCE_EXHAUSTED"}},
        )
        mock_instance.aio.models.generate_content = AsyncMock(side_effect=api_error)

        response = client.post(
            "/api/v1/generate",
            headers=auth_headers,
            json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
        )

        assert response.status_code == 429
        body = response.json()
        assert body["error"]["code"] == ERR_RATE_LIMITED


def test_generate_notes_handles_upstream_server_error(client: TestClient, auth_headers: dict[str, str]):
    """Upstream 503 error must return HTTP 502 UPSTREAM_ERROR."""
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        api_error = genai_errors.APIError(
            code=503,
            response_json={"error": {"message": "[503 Service Unavailable] Overloaded"}},
        )
        mock_instance.aio.models.generate_content = AsyncMock(side_effect=api_error)

        response = client.post(
            "/api/v1/generate",
            headers=auth_headers,
            json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
        )

        assert response.status_code == 502
        body = response.json()
        assert body["error"]["code"] == ERR_UPSTREAM_ERROR


def test_secret_and_transcript_privacy_in_error_responses(
    client: TestClient,
    auth_headers: dict[str, str],
):
    """Errors must never leak secrets, API keys, or raw transcript contents."""
    sensitive_transcript = "SUPER_SECRET_INTERNAL_TRANSCRIPT_CONTENT_12345"
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_response = AsyncMock()
        mock_response.text = "NOT_JSON"
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

        response = client.post(
            "/api/v1/generate",
            headers=auth_headers,
            json={"transcript": sensitive_transcript, "videoTitle": "Title"},
        )

        raw_response = response.text
        assert sensitive_transcript not in raw_response
        assert "mock-test-gemini-api-key" not in raw_response
        assert "mock-test-service-secret" not in raw_response


def test_generate_notes_fails_safely_when_gemini_api_key_missing(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    """If GEMINI_API_KEY is not configured, must return HTTP 503 CONFIG_ERROR."""
    missing_key_settings = Settings(
        gemini_api_key=None,
        fastapi_service_secret=SecretStr("mock-test-service-secret"),
    )
    monkeypatch.setattr("app.generator.get_settings", lambda: missing_key_settings)

    response = client.post(
        "/api/v1/generate",
        headers=auth_headers,
        json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
    )

    assert response.status_code == 503
    body = response.json()
    assert body["error"]["code"] == ERR_CONFIG_ERROR


def test_request_correlation_id_preserved(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_valid_notes_dict: dict,
):
    """Correlation ID from x-request-id header must be echoed back in response."""
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_response = AsyncMock()
        mock_response.text = json.dumps(sample_valid_notes_dict)
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

        response = client.post(
            "/api/v1/generate",
            headers={**auth_headers, "X-Request-ID": "custom-trace-uuid-999"},
            json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
        )

        assert response.headers.get("x-request-id") == "custom-trace-uuid-999"


def test_request_correlation_id_generated_when_omitted(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_valid_notes_dict: dict,
):
    """Correlation ID must be automatically generated when x-request-id is omitted."""
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_response = AsyncMock()
        mock_response.text = json.dumps(sample_valid_notes_dict)
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

        response = client.post(
            "/api/v1/generate",
            headers=auth_headers,
            json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
        )

        assert "x-request-id" in response.headers
        assert len(response.headers["x-request-id"]) > 10


def test_generate_notes_success_with_empty_key_concepts(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_valid_notes_dict: dict,
):
    """POST /api/v1/generate accepts empty keyConcepts array matching Gemini schema."""
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_response = AsyncMock()
        payload_from_model = {**sample_valid_notes_dict, "keyConcepts": []}
        mock_response.text = json.dumps(payload_from_model)
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

        response = client.post(
            "/api/v1/generate",
            headers=auth_headers,
            json={
                "transcript": "Tutorial video transcript without distinct key concepts listed.",
                "videoTitle": "Short Intro",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["keyConcepts"] == []


def test_request_id_sanitization_valid_characters(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_valid_notes_dict: dict,
):
    """Request ID with valid alphanumeric, underscores, hyphens, and dots is preserved."""
    valid_custom_id = "req_123.ABC-test"
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_response = AsyncMock()
        mock_response.text = json.dumps(sample_valid_notes_dict)
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

        response = client.post(
            "/api/v1/generate",
            headers={**auth_headers, "X-Request-ID": valid_custom_id},
            json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
        )

        assert response.headers.get("x-request-id") == valid_custom_id


def test_request_id_sanitization_oversized_replaces_with_uuid(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_valid_notes_dict: dict,
):
    """Request ID exceeding 64 characters must be replaced with a newly generated UUID4."""
    oversized_id = "a" * 65
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_response = AsyncMock()
        mock_response.text = json.dumps(sample_valid_notes_dict)
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

        response = client.post(
            "/api/v1/generate",
            headers={**auth_headers, "X-Request-ID": oversized_id},
            json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
        )

        returned_id = response.headers.get("x-request-id")
        assert returned_id != oversized_id
        # Verify returned_id is a valid UUID4
        parsed = uuid.UUID(returned_id)
        assert parsed.version == 4


def test_request_id_sanitization_newline_injection_replaces_with_uuid(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_valid_notes_dict: dict,
):
    """Request ID attempting newline/CRLF injection must be replaced with a newly generated UUID4."""
    malicious_id = "legit-id\r\nX-Injected: evil"
    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_response = AsyncMock()
        mock_response.text = json.dumps(sample_valid_notes_dict)
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

        response = client.post(
            "/api/v1/generate",
            headers={**auth_headers, "X-Request-ID": malicious_id},
            json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
        )

        returned_id = response.headers.get("x-request-id")
        assert "evil" not in returned_id
        assert "\n" not in returned_id
        assert "\r" not in returned_id
        parsed = uuid.UUID(returned_id)
        assert parsed.version == 4


def test_request_id_sanitization_special_characters_replaces_with_uuid(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_valid_notes_dict: dict,
):
    """Request ID containing forbidden special/control characters must be replaced with UUID4."""
    for invalid_id in ["id with spaces", "<script>alert(1)</script>", "id;DROP TABLE", "id/slash", "id\\backslash"]:
        with patch("app.generator.genai.Client") as mock_client_cls:
            mock_instance = mock_client_cls.return_value
            mock_response = AsyncMock()
            mock_response.text = json.dumps(sample_valid_notes_dict)
            mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)

            response = client.post(
                "/api/v1/generate",
                headers={**auth_headers, "X-Request-ID": invalid_id},
                json={"transcript": "Valid transcript text.", "videoTitle": "Title"},
            )

            returned_id = response.headers.get("x-request-id")
            assert returned_id != invalid_id
            parsed = uuid.UUID(returned_id)
            assert parsed.version == 4


def test_sanitize_request_id_unit_behavior():
    """Unit test sanitize_request_id for empty, valid, boundary, and injection values."""
    # None or empty string -> UUID4
    res_none = sanitize_request_id(None)
    assert uuid.UUID(res_none).version == 4
    res_empty = sanitize_request_id("")
    assert uuid.UUID(res_empty).version == 4

    # Valid boundary: exactly 64 safe chars
    safe_64 = "A" * 64
    assert sanitize_request_id(safe_64) == safe_64

    # Invalid boundary: 65 chars
    oversized = "A" * 65
    res_oversized = sanitize_request_id(oversized)
    assert res_oversized != oversized
    assert uuid.UUID(res_oversized).version == 4

    # Valid characters: alphanumeric, hyphen, underscore, dot
    valid_chars = "Trace_123-abc.DEF"
    assert sanitize_request_id(valid_chars) == valid_chars

    # Forbidden characters
    for forbidden in ["has space", "foo\nbar", "foo\r\nbar", "foo\x00bar", "foo#bar", "foo?bar"]:
        sanitized = sanitize_request_id(forbidden)
        assert sanitized != forbidden
        assert uuid.UUID(sanitized).version == 4
