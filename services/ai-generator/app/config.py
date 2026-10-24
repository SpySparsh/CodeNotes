"""Configuration and environment settings for the AI Generator service."""

from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables and .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Google Gemini API Configuration
    gemini_api_key: SecretStr | None = Field(
        default=None,
        description="Google Gemini API key from Google AI Studio",
    )
    gemini_model: str = Field(
        default="gemini-2.5-flash",
        description="Gemini model name to use for note generation",
    )
    gemini_timeout_ms: int = Field(
        default=75000,
        description="Outbound timeout for Gemini API calls in milliseconds (default 75s)",
    )

    # Service-to-Service Authentication
    fastapi_service_secret: SecretStr | None = Field(
        default=None,
        description="Shared secret Bearer token required for /api/v1/generate",
    )

    # Server Bindings
    host: str = Field(default="0.0.0.0", description="Server bind host")
    port: int = Field(default=8000, description="Server bind port")
    environment: str = Field(default="development", description="Runtime environment")

    @property
    def is_gemini_configured(self) -> bool:
        """Check if Gemini API key is validly configured."""
        if not self.gemini_api_key:
            return False
        val = self.gemini_api_key.get_secret_value().strip()
        return bool(val and val != "your_gemini_api_key_here")

    @property
    def is_auth_configured(self) -> bool:
        """Check if service authentication secret is configured."""
        if not self.fastapi_service_secret:
            return False
        val = self.fastapi_service_secret.get_secret_value().strip()
        return bool(val and val != "change_me_to_a_secure_random_string")


@lru_cache
def get_settings() -> Settings:
    """Return cached settings instance."""
    return Settings()
