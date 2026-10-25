"""Tests for the /health endpoint."""

from fastapi.testclient import TestClient


def test_health_check_success(client: TestClient):
    """GET /health must return HTTP 200 with minimal health status."""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


def test_health_check_requires_no_auth(client: TestClient):
    """GET /health must be accessible without any Authorization header."""
    response = client.get("/health", headers={})
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


def test_health_check_exposes_no_secrets(client: TestClient):
    """Health check must never return environment variables or secrets."""
    response = client.get("/health")
    data = response.json()
    assert "gemini_api_key" not in data
    assert "fastapi_service_secret" not in data
    assert "secret" not in str(response.content).lower()
