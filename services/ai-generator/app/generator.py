"""Gemini AI note generation service using the official google-genai SDK."""

import json
import logging
import re
import time

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.errors import (
    ConfigErrorException,
    MalformedOutputException,
    RateLimitedException,
    TimeoutException,
    UpstreamErrorException,
)
from app.schemas import GeneratedNotes

logger = logging.getLogger("ai_generator.generator")


def build_prompt(transcript: str, video_title: str) -> str:
    """Construct prompt preserving the exact prompt requirements from src/lib/gemini.ts."""
    return f"""
You are a Senior Full-Stack Engineer and Technical Content Architect.
I have a transcript from a YouTube programming tutorial titled "{video_title}".
Your objective is to generate premium, highly structured technical study notes based on this content.

# Functional Requirements
1. **Structure First:** Your output must adhere to the following logical structure:
   - Overview
   - Key Concepts List
   - Detailed Topics (the main content)
   - Comparison Tables (where applicable)
   - Shorthands/Quick Tips

2. **Contextual Code Mapping:** Do NOT clump code blocks at the end. When you process a theory block or topic within the 'detailedNotes' markdown, you MUST immediately locate and insert the syntactically correct code block exactly where it belongs conceptually. All code must reside inline within the appropriate detailed topic sections using standard markdown fences (e.g., ```typescript).

3. **Comparison Tables:** Whenever the transcript compares two or more topics, concepts, or tools (e.g., if-else vs switch, React vs Vue), you MUST generate a Markdown comparison table to highlight differences (Performance, Use Case, Readability, etc.) inline within the 'detailedNotes' markdown string.

Return the result strictly as a JSON object matching this schema:
{{
  "overview": "A compelling overview of the video's purpose (2-3 sentences).",
  "keyConcepts": ["Concept 1", "Concept 2", "Concept 3"],
  "detailedNotes": "The exhaustive, comprehensive markdown string containing all the Detailed Topics with contextual inline ``` code blocks and Markdown Comparison Tables.",
  "shorthands": ["Quick tip 1", "Gotcha 2", "Best practice 3"]
}}

Here is the transcript:
==================
{transcript}
==================
"""


def parse_and_validate_notes(raw_text: str) -> GeneratedNotes:
    """Parse raw text from model output, strip markdown code fences, and validate schema."""
    cleaned = raw_text.strip()
    if cleaned.startswith("```json"):
        cleaned = re.sub(r"^```json\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        cleaned = cleaned.strip()
    elif cleaned.startswith("```"):
        cleaned = re.sub(r"^```\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        cleaned = cleaned.strip()

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        logger.error(
            "gemini_json_parse_failed",
            extra={"output_length": len(cleaned), "error": str(exc)},
        )
        raise MalformedOutputException("AI returned malformed JSON data.") from exc

    if not isinstance(data, dict):
        raise MalformedOutputException("AI returned non-object JSON output.")

    try:
        return GeneratedNotes.model_validate(data)
    except ValidationError as exc:
        logger.error(
            "gemini_schema_validation_failed",
            extra={"output_length": len(cleaned), "error_count": exc.error_count()},
        )
        raise MalformedOutputException("The AI model output could not be parsed into notes format.") from exc


class GeminiNoteGenerator:
    """Orchestrates asynchronous note generation via Google Gemini."""

    def __init__(
        self,
        settings: Settings | None = None,
        client: genai.Client | None = None,
    ):
        self.settings = settings or get_settings()
        self._client = client

    def get_client(self) -> genai.Client:
        """Initialize or return the cached genai.Client."""
        if not self.settings.is_gemini_configured:
            raise ConfigErrorException("Gemini API key is missing or invalid. Please configure GEMINI_API_KEY.")

        if self._client is None:
            api_key = self.settings.gemini_api_key.get_secret_value()  # type: ignore[union-attr]
            self._client = genai.Client(api_key=api_key)

        return self._client

    async def aclose(self) -> None:
        """Close underlying asynchronous and synchronous client connections cleanly."""
        if self._client is not None:
            try:
                await self._client.aio.aclose()
                self._client.close()
            except Exception as exc:
                logger.error("gemini_client_cleanup_failed", extra={"error": str(exc)})
                raise
            finally:
                self._client = None

    async def generate_notes(
        self,
        transcript: str,
        video_title: str,
        request_id: str | None = None,
    ) -> GeneratedNotes:
        """Invoke Gemini model and produce validated structured technical study notes.

        Never logs transcripts, prompts, or full response text.
        """
        client = self.get_client()
        prompt = build_prompt(transcript=transcript, video_title=video_title)
        model_name = self.settings.gemini_model
        timeout_ms = self.settings.gemini_timeout_ms

        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=GeneratedNotes,
            http_options=types.HttpOptions(timeout=timeout_ms),
        )

        log_context = {
            "request_id": request_id,
            "model": model_name,
            "transcript_chars": len(transcript),
            "video_title_chars": len(video_title),
            "timeout_ms": timeout_ms,
        }
        logger.info("gemini_generation_started", extra=log_context)

        start_time = time.perf_counter()
        try:
            response = await client.aio.models.generate_content(
                model=model_name,
                contents=prompt,
                config=config,
            )
            raw_text = response.text or ""
            duration_ms = (time.perf_counter() - start_time) * 1000

            notes = parse_and_validate_notes(raw_text)

            logger.info(
                "gemini_generation_completed",
                extra={
                    **log_context,
                    "duration_ms": round(duration_ms, 2),
                    "output_chars": len(raw_text),
                    "key_concepts_count": len(notes.key_concepts),
                    "shorthands_count": len(notes.shorthands),
                },
            )
            return notes

        except genai_errors.APIError as exc:
            duration_ms = (time.perf_counter() - start_time) * 1000
            error_code = exc.code
            error_message = exc.message or ""

            logger.warning(
                "gemini_api_error",
                extra={
                    **log_context,
                    "duration_ms": round(duration_ms, 2),
                    "status_code": error_code,
                },
            )

            # Check rate limiting / quota exhaustion
            if error_code == 429 or "RESOURCE_EXHAUSTED" in error_message or "rate limit" in error_message.lower():
                raise RateLimitedException(
                    "AI generation service is temporarily busy. Retrying later is recommended."
                ) from exc

            # Check timeouts reported by API client
            if error_code == 504 or "timeout" in error_message.lower() or "deadline exceeded" in error_message.lower():
                raise TimeoutException(timeout_seconds=int(timeout_ms / 1000)) from exc

            # Other 4xx or 5xx upstream failures
            raise UpstreamErrorException("Upstream AI provider error occurred.") from exc

        except TimeoutError as exc:
            duration_ms = (time.perf_counter() - start_time) * 1000
            logger.warning(
                "gemini_timeout_error",
                extra={**log_context, "duration_ms": round(duration_ms, 2)},
            )
            raise TimeoutException(timeout_seconds=int(timeout_ms / 1000)) from exc

        except Exception as exc:
            if isinstance(
                exc,
                (
                    ConfigErrorException,
                    MalformedOutputException,
                    RateLimitedException,
                    TimeoutException,
                    UpstreamErrorException,
                ),
            ):
                raise

            duration_ms = (time.perf_counter() - start_time) * 1000
            exc_name = type(exc).__name__
            exc_msg = str(exc).lower()

            # Catch httpx timeouts that bubble through SDK
            if "timeout" in exc_name.lower() or "timeout" in exc_msg or "timed out" in exc_msg:
                logger.warning(
                    "gemini_client_timeout",
                    extra={**log_context, "duration_ms": round(duration_ms, 2)},
                )
                raise TimeoutException(timeout_seconds=int(timeout_ms / 1000)) from exc

            logger.error(
                "gemini_unexpected_error",
                extra={
                    **log_context,
                    "duration_ms": round(duration_ms, 2),
                    "error_type": exc_name,
                },
            )
            raise UpstreamErrorException("Unexpected error occurred while invoking AI provider.") from exc
