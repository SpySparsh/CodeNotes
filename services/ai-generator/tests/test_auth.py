"""Tests for service-to-service authentication."""

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.errors import ERR_CONFIG_ERROR, ERR_UNAUTHORIZED


def test_missing_auth_header_rejected(client: TestClient):
    """Requests missing Authorization header must be rejected with HTTP 401."""
    response = client.post("/api/v1/generate", json={"transcript": "test transcript", "videoTitle": "test title"})
    assert response.status_code == 401
    assert response.headers.get("WWW-Authenticate") == "Bearer"
    body = response.json()
    assert body["error"]["code"] == ERR_UNAUTHORIZED
    assert "Missing Authorization header" in body["error"]["message"]


def test_malformed_auth_header_rejected(client: TestClient):
    """Malformed Authorization headers must be rejected with HTTP 401."""
    # Scheme is not Bearer
    res1 = client.post(
        "/api/v1/generate",
        headers={"Authorization": "Basic dXNlcjpwYXNz"},
        json={"transcript": "test transcript", "videoTitle": "test title"},
    )
    assert res1.status_code == 401
    assert res1.json()["error"]["code"] == ERR_UNAUTHORIZED

    # Only one word
    res2 = client.post(
        "/api/v1/generate",
        headers={"Authorization": "Bearer"},
        json={"transcript": "test transcript", "videoTitle": "test title"},
    )
    assert res2.status_code == 401
    assert res2.json()["error"]["code"] == ERR_UNAUTHORIZED

    # Three words
    res3 = client.post(
        "/api/v1/generate",
        headers={"Authorization": "Bearer token extra"},
        json={"transcript": "test transcript", "videoTitle": "test title"},
    )
    assert res3.status_code == 401
    assert res3.json()["error"]["code"] == ERR_UNAUTHORIZED


def test_invalid_token_rejected(client: TestClient):
    """Requests with incorrect token must be rejected with HTTP 401."""
    response = client.post(
        "/api/v1/generate",
        headers={"Authorization": "Bearer wrong-invalid-secret-token"},
        json={"transcript": "test transcript", "videoTitle": "test title"},
    )
    assert response.status_code == 401
    body = response.json()
    assert body["error"]["code"] == ERR_UNAUTHORIZED
    assert "Invalid service authentication credentials" in body["error"]["message"]


def test_unset_server_secret_fails_closed(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    """If server FASTAPI_SERVICE_SECRET is unset, requests must fail with HTTP 503 (fail closed)."""
    unconfigured_settings = Settings(
        gemini_api_key=SecretStr("mock-key"),
        fastapi_service_secret=None,  # Unset
    )
    monkeypatch.setattr("app.auth.get_settings", lambda: unconfigured_settings)

    response = client.post(
        "/api/v1/generate",
        headers={"Authorization": "Bearer any-token"},
        json={"transcript": "test transcript", "videoTitle": "test title"},
    )
    assert response.status_code == 503
    body = response.json()
    assert body["error"]["code"] == ERR_CONFIG_ERROR
    assert "not properly configured" in body["error"]["message"]


def test_placeholder_server_secret_fails_closed(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    """If server secret is default placeholder string, requests must fail closed with HTTP 503."""
    placeholder_settings = Settings(
        gemini_api_key=SecretStr("mock-key"),
        fastapi_service_secret=SecretStr("change_me_to_a_secure_random_string"),
    )
    monkeypatch.setattr("app.auth.get_settings", lambda: placeholder_settings)

    response = client.post(
        "/api/v1/generate",
        headers={"Authorization": "Bearer change_me_to_a_secure_random_string"},
        json={"transcript": "test transcript", "videoTitle": "test title"},
    )
    assert response.status_code == 503
    body = response.json()
    assert body["error"]["code"] == ERR_CONFIG_ERROR
