"""Gemini AI note generation service using the official google-genai SDK."""

import json
import logging
import re
import time
from typing import Any

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel

from app.config import Settings, get_settings
from app.errors import (
    ConfigErrorException,
    MalformedOutputException,
    RateLimitedException,
    TimeoutException,
    UpstreamErrorException,
)
from app.schemas import (
    ChunkGeneratedNotes,
    ChunkSummary,
    GeneratedNotes,
    SynthesizedNotes,
    UsageMetadata,
)

logger = logging.getLogger("ai_generator.generator")

SAFE_METADATA_KEYS = frozenset({"quota_metric", "quota_limit", "consumer", "quota_location"})
SENSITIVE_KEY_PATTERN = re.compile(r"(AIza[0-9A-Za-z-_]{35}|Bearer\s+[A-Za-z0-9_\-\.]+)", re.IGNORECASE)


def sanitize_diagnostic_string(val: Any, max_len: int = 500) -> str | None:
    """Sanitize and truncate strings for safe diagnostic logging."""
    if not isinstance(val, str):
        return None
    sanitized = SENSITIVE_KEY_PATTERN.sub("[REDACTED]", val.strip())
    if len(sanitized) > max_len:
        return sanitized[:max_len] + "...[TRUNCATED]"
    return sanitized


def extract_api_error_diagnostics(exc: Any) -> dict[str, Any]:
    """Safely extract structured Google API error and quota diagnostic details.

    Never raises an exception, never leaks API keys, authorization tokens,
    transcripts, or unparsed request/response bodies.
    """
    diagnostics: dict[str, Any] = {
        "status_code": None,
        "grpc_status": None,
        "error_message": None,
        "quota_failures": None,
        "error_info": None,
        "retry_delay": None,
        "retry_after_header": None,
    }

    try:
        raw_code = getattr(exc, "code", None)
        diagnostics["status_code"] = raw_code if isinstance(raw_code, int) else None
        diagnostics["grpc_status"] = sanitize_diagnostic_string(getattr(exc, "status", None), max_len=100)

        raw_msg = getattr(exc, "message", None)
        if raw_msg is None and isinstance(exc, Exception) and not hasattr(exc, "details"):
            raw_msg = str(exc)
        diagnostics["error_message"] = sanitize_diagnostic_string(raw_msg, max_len=500)

        # Extract Retry-After from response headers if available
        response = getattr(exc, "response", None)
        if response is not None:
            headers = getattr(response, "headers", None)
            if headers is not None and hasattr(headers, "get"):
                raw_retry_after = headers.get("retry-after") or headers.get("Retry-After")
                if raw_retry_after is not None:
                    diagnostics["retry_after_header"] = sanitize_diagnostic_string(str(raw_retry_after), max_len=50)

        # Extract structured details from exc.details (parsed JSON response body)
        raw_details = getattr(exc, "details", None)
        details_list: list[Any] = []
        if isinstance(raw_details, dict):
            err_dict = raw_details.get("error")
            if isinstance(err_dict, dict) and isinstance(err_dict.get("details"), list):
                details_list = err_dict["details"]
            elif isinstance(raw_details.get("details"), list):
                details_list = raw_details["details"]
        elif isinstance(raw_details, list):
            details_list = raw_details

        quota_failures: list[dict[str, str]] = []
        error_info: dict[str, Any] | None = None
        retry_delay: str | None = None

        for item in details_list:
            if not isinstance(item, dict):
                continue

            type_name = str(item.get("@type", "") or item.get("type", ""))

            # Handle QuotaFailure
            if "QuotaFailure" in type_name:
                violations = item.get("violations")
                if isinstance(violations, list):
                    for v in violations[:5]:
                        if isinstance(v, dict):
                            entry: dict[str, str] = {}
                            subject = sanitize_diagnostic_string(v.get("subject"), max_len=150)
                            desc = sanitize_diagnostic_string(v.get("description"), max_len=300)
                            if subject:
                                entry["subject"] = subject
                            if desc:
                                entry["description"] = desc
                            if entry:
                                quota_failures.append(entry)

            # Handle ErrorInfo
            elif "ErrorInfo" in type_name:
                reason = sanitize_diagnostic_string(item.get("reason"), max_len=100)
                meta = item.get("metadata")
                safe_meta: dict[str, str] = {}
                if isinstance(meta, dict):
                    for k, v in meta.items():
                        if k in SAFE_METADATA_KEYS and v is not None:
                            safe_val = sanitize_diagnostic_string(str(v), max_len=150)
                            if safe_val is not None:
                                safe_meta[k] = safe_val
                if reason or safe_meta:
                    error_info = {}
                    if reason:
                        error_info["reason"] = reason
                    if safe_meta:
                        error_info["metadata"] = safe_meta

            # Handle RetryInfo
            elif "RetryInfo" in type_name:
                raw_delay = item.get("retryDelay")
                if isinstance(raw_delay, str):
                    retry_delay = sanitize_diagnostic_string(raw_delay, max_len=50)
                elif isinstance(raw_delay, dict):
                    sec = raw_delay.get("seconds")
                    nanos = raw_delay.get("nanos")
                    if sec is not None or nanos is not None:
                        s = sec if sec is not None else 0
                        retry_delay = f"{s}s" if not nanos else f"{s}.{str(nanos)[:3]}s"
                elif isinstance(raw_delay, (int, float)):
                    retry_delay = f"{raw_delay}s"

        if quota_failures:
            diagnostics["quota_failures"] = quota_failures
        if error_info:
            diagnostics["error_info"] = error_info
        if retry_delay:
            diagnostics["retry_delay"] = retry_delay

    except Exception:
        # Failsafe: never allow diagnostic extraction failure to crash exception handler
        pass

    return diagnostics


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


def build_chunk_prompt(chunk_text: str, video_title: str, chunk_index: int = 0, total_chunks: int = 1) -> str:
    """Construct prompt for generating structured technical study notes for a single transcript chunk."""
    return f"""
You are a Senior Full-Stack Engineer and Technical Content Architect.
I have a transcript section from a YouTube programming tutorial titled "{video_title}".
This is Section {chunk_index + 1} of {total_chunks}.
Your objective is to generate detailed, structured technical study notes based on THIS SPECIFIC SECTION of the tutorial.

# Functional Requirements
1. **Structure First:** Your output must adhere to the following logical structure:
   - Overview
   - Key Concepts List
   - Detailed Topics (the main content)
   - Comparison Tables (where applicable)
   - Shorthands/Quick Tips

2. **Contextual Code Mapping:** Do NOT clump code blocks at the end. When you process a theory block or topic within the 'detailedNotes' markdown, you MUST immediately locate and insert the syntactically correct code block exactly where it belongs conceptually. All code must reside inline within the appropriate detailed topic sections using standard markdown fences (e.g., ```typescript).

3. **Comparison Tables:** Whenever the transcript section compares two or more topics, concepts, or tools (e.g., if-else vs switch, React vs Vue), you MUST generate a Markdown comparison table to highlight differences (Performance, Use Case, Readability, etc.) inline within the 'detailedNotes' markdown string.

Return the result strictly as a JSON object matching this schema:
{{
  "overview": "A compelling overview of this section's purpose and topics (2-3 sentences).",
  "keyConcepts": ["Concept 1", "Concept 2", "Concept 3"],
  "detailedNotes": "The exhaustive, comprehensive markdown string containing all the Detailed Topics with contextual inline ``` code blocks and Markdown Comparison Tables.",
  "shorthands": ["Quick tip 1", "Gotcha 2", "Best practice 3"]
}}

Here is the transcript section:
==================
{chunk_text}
==================
"""


def build_synthesis_prompt(summaries_text: str, video_title: str) -> str:
    """Construct prompt for synthesizing section summaries into an executive overview and master outline."""
    return f"""
You are a Principal Software Architect and Technical Editor.
Below are section summaries from a comprehensive YouTube programming tutorial titled "{video_title}".
Your objective is to synthesize these section summaries into a master executive overview and unified technical guide.

# Requirements
1. **Executive Overview:** 2-3 compelling sentences summarizing the overall purpose, key skills taught, and architectural takeaways of the complete tutorial.
2. **Consolidated Key Concepts:** Extract and unify the top 10 most critical architectural or technical concepts across all sections.
3. **Master Table of Contents:** A clean sequential list of the major topic headers covered in the video, reflecting the logical progression of the tutorial.
4. **Unified Shorthands / Gotchas:** The top 8 most important best practices, warnings, gotchas, or syntax rules across the entire tutorial.

Return the result strictly as a JSON object matching this schema:
{{
  "overview": "Global executive overview of the complete tutorial (2-3 sentences).",
  "keyConcepts": ["Concept 1", "Concept 2"],
  "tableOfContents": ["Section 1: Topic", "Section 2: Topic"],
  "shorthands": ["Best practice 1", "Gotcha 2"]
}}

Here are the section summaries:
==================
{summaries_text}
==================
"""


class SynthesizedNotesContent(BaseModel):
    """Internal model for validating Gemini raw synthesis output."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )

    overview: str = Field(..., min_length=1)
    key_concepts: list[str] = Field(default_factory=list, alias="keyConcepts")
    table_of_contents: list[str] = Field(default_factory=list, alias="tableOfContents")
    shorthands: list[str] = Field(default_factory=list, alias="shorthands")


def parse_and_validate_synthesized_notes(raw_text: str) -> SynthesizedNotesContent:
    """Parse raw text from model output, strip markdown code fences, and validate synthesized notes schema."""
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
            "gemini_synthesis_json_parse_failed",
            extra={"output_length": len(cleaned), "error": str(exc)},
        )
        raise MalformedOutputException("AI returned malformed JSON data.") from exc

    if not isinstance(data, dict):
        raise MalformedOutputException("AI returned non-object JSON output.")

    try:
        return SynthesizedNotesContent.model_validate(data)
    except ValidationError as exc:
        logger.error(
            "gemini_synthesis_schema_validation_failed",
            extra={"output_length": len(cleaned), "error_count": exc.error_count()},
        )
        raise MalformedOutputException(
            "The AI model output could not be parsed into synthesized notes format."
        ) from exc


def extract_usage_metadata(response: Any) -> UsageMetadata:
    """Extract prompt, candidate, thoughts, and total token metrics from Google GenAI SDK response."""
    usage = getattr(response, "usage_metadata", None)
    prompt_tokens = 0
    candidate_tokens = 0
    thoughts_tokens = 0
    total_tokens = 0

    if usage is not None:
        p_tok = getattr(usage, "prompt_token_count", None)
        c_tok = getattr(usage, "candidates_token_count", None)
        th_tok = getattr(usage, "thoughts_token_count", None)
        tot_tok = getattr(usage, "total_token_count", None)

        if isinstance(p_tok, int) and not isinstance(p_tok, bool):
            prompt_tokens = p_tok
        if isinstance(c_tok, int) and not isinstance(c_tok, bool):
            candidate_tokens = c_tok
        if isinstance(th_tok, int) and not isinstance(th_tok, bool):
            thoughts_tokens = th_tok
        if isinstance(tot_tok, int) and not isinstance(tot_tok, bool):
            total_tokens = tot_tok

    return UsageMetadata(
        prompt_tokens=prompt_tokens,
        candidate_tokens=candidate_tokens,
        thoughts_tokens=thoughts_tokens,
        total_tokens=total_tokens,
    )


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
            duration_ms = (time.perf_counter() - start_time) * 1000

            # Safe diagnostic extraction immediately after receiving response, BEFORE accessing response.text
            raw_model_version = getattr(response, "model_version", None)
            model_version = raw_model_version if isinstance(raw_model_version, str) else None

            finish_reason: str | None = None
            candidates = getattr(response, "candidates", None)
            if candidates and isinstance(candidates, (list, tuple)) and len(candidates) > 0:
                candidate = candidates[0]
                raw_finish_reason = getattr(candidate, "finish_reason", None)
                if raw_finish_reason is not None:
                    if hasattr(raw_finish_reason, "name") and isinstance(raw_finish_reason.name, str):
                        finish_reason = raw_finish_reason.name
                    elif isinstance(raw_finish_reason, str):
                        finish_reason = raw_finish_reason
                    else:
                        type_name = type(raw_finish_reason).__name__
                        if "Mock" not in type_name:
                            finish_reason = str(raw_finish_reason)

            usage = getattr(response, "usage_metadata", None)
            prompt_tokens: int | None = None
            candidate_tokens: int | None = None
            thoughts_tokens: int | None = None
            total_tokens: int | None = None

            if usage is not None:
                p_tok = getattr(usage, "prompt_token_count", None)
                c_tok = getattr(usage, "candidates_token_count", None)
                th_tok = getattr(usage, "thoughts_token_count", None)
                tot_tok = getattr(usage, "total_token_count", None)

                prompt_tokens = p_tok if isinstance(p_tok, int) and not isinstance(p_tok, bool) else None
                candidate_tokens = c_tok if isinstance(c_tok, int) and not isinstance(c_tok, bool) else None
                thoughts_tokens = th_tok if isinstance(th_tok, int) and not isinstance(th_tok, bool) else None
                total_tokens = tot_tok if isinstance(tot_tok, int) and not isinstance(tot_tok, bool) else None

            # Safe text extraction handling absent candidates/content, missing parts, or accessor exceptions
            raw_text: str | None = None
            text_extraction_exc: Exception | None = None
            try:
                raw_text = response.text
            except Exception as exc:
                text_extraction_exc = exc

            raw_chars = len(raw_text) if isinstance(raw_text, str) else 0

            diagnostic_context = {
                "request_id": request_id,
                "model": model_name,
                "model_version": model_version,
                "transcript_chars": len(transcript),
                "prompt_chars": len(prompt),
                "duration_ms": round(duration_ms, 2),
                "finish_reason": finish_reason,
                "prompt_tokens": prompt_tokens,
                "candidate_tokens": candidate_tokens,
                "thoughts_tokens": thoughts_tokens,
                "total_tokens": total_tokens,
                "raw_response_chars": raw_chars,
            }

            # Log diagnostic metadata immediately before JSON parsing / validation
            logger.info("gemini_generation_response_received", extra=diagnostic_context)

            # Handle text extraction failure or absent textual content
            if text_extraction_exc is not None:
                logger.error(
                    "gemini_generation_parsing_failed",
                    extra={
                        "request_id": request_id,
                        "exception_category": type(text_extraction_exc).__name__,
                        "finish_reason": finish_reason,
                        "prompt_tokens": prompt_tokens,
                        "candidate_tokens": candidate_tokens,
                        "thoughts_tokens": thoughts_tokens,
                        "total_tokens": total_tokens,
                        "raw_response_chars": 0,
                        "duration_ms": round(duration_ms, 2),
                    },
                )
                raise MalformedOutputException(
                    "Failed to extract textual content from AI response."
                ) from text_extraction_exc

            if not raw_text or not raw_text.strip():
                logger.error(
                    "gemini_generation_parsing_failed",
                    extra={
                        "request_id": request_id,
                        "exception_category": "MalformedOutputException",
                        "finish_reason": finish_reason,
                        "prompt_tokens": prompt_tokens,
                        "candidate_tokens": candidate_tokens,
                        "thoughts_tokens": thoughts_tokens,
                        "total_tokens": total_tokens,
                        "raw_response_chars": raw_chars,
                        "duration_ms": round(duration_ms, 2),
                    },
                )
                raise MalformedOutputException("AI model returned no usable text content in response candidates.")

            # Attempt parsing and schema validation
            try:
                notes = parse_and_validate_notes(raw_text)
            except Exception as parse_exc:
                logger.error(
                    "gemini_generation_parsing_failed",
                    extra={
                        "request_id": request_id,
                        "exception_category": type(parse_exc).__name__,
                        "finish_reason": finish_reason,
                        "prompt_tokens": prompt_tokens,
                        "candidate_tokens": candidate_tokens,
                        "thoughts_tokens": thoughts_tokens,
                        "total_tokens": total_tokens,
                        "raw_response_chars": raw_chars,
                        "duration_ms": round(duration_ms, 2),
                    },
                )
                raise

            logger.info(
                "gemini_generation_completed",
                extra={
                    **diagnostic_context,
                    "output_chars": raw_chars,
                    "overview_chars": len(notes.overview),
                    "key_concepts_count": len(notes.key_concepts),
                    "detailed_notes_chars": len(notes.detailed_notes),
                    "shorthands_count": len(notes.shorthands),
                },
            )
            return notes

        except genai_errors.APIError as exc:
            duration_ms = (time.perf_counter() - start_time) * 1000
            error_code = exc.code
            error_message = exc.message or ""
            diagnostics = extract_api_error_diagnostics(exc)

            logger.warning(
                "gemini_api_error",
                extra={
                    **log_context,
                    "duration_ms": round(duration_ms, 2),
                    **diagnostics,
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

    async def generate_chunk(
        self,
        chunk_text: str,
        video_title: str,
        chunk_index: int = 0,
        total_chunks: int = 1,
        request_id: str | None = None,
    ) -> ChunkGeneratedNotes:
        """Invoke Gemini model for a single transcript chunk and return ChunkGeneratedNotes with token usage."""
        client = self.get_client()
        prompt = build_chunk_prompt(
            chunk_text=chunk_text,
            video_title=video_title,
            chunk_index=chunk_index,
            total_chunks=total_chunks,
        )
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
            "chunk_index": chunk_index,
            "total_chunks": total_chunks,
            "chunk_chars": len(chunk_text),
            "video_title_chars": len(video_title),
            "timeout_ms": timeout_ms,
        }
        logger.info("gemini_chunk_generation_started", extra=log_context)

        start_time = time.perf_counter()
        try:
            response = await client.aio.models.generate_content(
                model=model_name,
                contents=prompt,
                config=config,
            )
            duration_ms = (time.perf_counter() - start_time) * 1000

            raw_model_version = getattr(response, "model_version", None)
            model_version = raw_model_version if isinstance(raw_model_version, str) else None

            finish_reason: str | None = None
            candidates = getattr(response, "candidates", None)
            if candidates and isinstance(candidates, (list, tuple)) and len(candidates) > 0:
                candidate = candidates[0]
                raw_finish_reason = getattr(candidate, "finish_reason", None)
                if raw_finish_reason is not None:
                    if hasattr(raw_finish_reason, "name") and isinstance(raw_finish_reason.name, str):
                        finish_reason = raw_finish_reason.name
                    elif isinstance(raw_finish_reason, str):
                        finish_reason = raw_finish_reason
                    else:
                        type_name = type(raw_finish_reason).__name__
                        if "Mock" not in type_name:
                            finish_reason = str(raw_finish_reason)

            usage_meta = extract_usage_metadata(response)

            raw_text: str | None = None
            text_extraction_exc: Exception | None = None
            try:
                raw_text = response.text
            except Exception as exc:
                text_extraction_exc = exc

            raw_chars = len(raw_text) if isinstance(raw_text, str) else 0

            diagnostic_context = {
                "request_id": request_id,
                "model": model_name,
                "model_version": model_version,
                "chunk_index": chunk_index,
                "total_chunks": total_chunks,
                "chunk_chars": len(chunk_text),
                "prompt_chars": len(prompt),
                "duration_ms": round(duration_ms, 2),
                "finish_reason": finish_reason,
                "prompt_tokens": usage_meta.prompt_tokens,
                "candidate_tokens": usage_meta.candidate_tokens,
                "thoughts_tokens": usage_meta.thoughts_tokens,
                "total_tokens": usage_meta.total_tokens,
                "raw_response_chars": raw_chars,
            }
            logger.info("gemini_chunk_response_received", extra=diagnostic_context)

            if text_extraction_exc is not None:
                logger.error(
                    "gemini_chunk_parsing_failed",
                    extra={**diagnostic_context, "exception_category": type(text_extraction_exc).__name__},
                )
                raise MalformedOutputException(
                    "Failed to extract textual content from AI response."
                ) from text_extraction_exc

            if not raw_text or not raw_text.strip():
                logger.error(
                    "gemini_chunk_parsing_failed",
                    extra={**diagnostic_context, "exception_category": "MalformedOutputException"},
                )
                raise MalformedOutputException("AI model returned no usable text content in response candidates.")

            try:
                notes = parse_and_validate_notes(raw_text)
            except Exception as parse_exc:
                logger.error(
                    "gemini_chunk_parsing_failed",
                    extra={**diagnostic_context, "exception_category": type(parse_exc).__name__},
                )
                raise

            chunk_notes = ChunkGeneratedNotes(
                overview=notes.overview,
                key_concepts=notes.key_concepts,
                detailed_notes=notes.detailed_notes,
                shorthands=notes.shorthands,
                usage=usage_meta,
                prompt_tokens=usage_meta.prompt_tokens,
                candidate_tokens=usage_meta.candidate_tokens,
                thoughts_tokens=usage_meta.thoughts_tokens,
                total_tokens=usage_meta.total_tokens,
            )

            logger.info(
                "gemini_chunk_generation_completed",
                extra={
                    **diagnostic_context,
                    "output_chars": raw_chars,
                    "overview_chars": len(chunk_notes.overview),
                    "key_concepts_count": len(chunk_notes.key_concepts),
                    "detailed_notes_chars": len(chunk_notes.detailed_notes),
                    "shorthands_count": len(chunk_notes.shorthands),
                },
            )
            return chunk_notes

        except genai_errors.APIError as exc:
            duration_ms = (time.perf_counter() - start_time) * 1000
            error_code = exc.code
            error_message = exc.message or ""
            diagnostics = extract_api_error_diagnostics(exc)

            logger.warning(
                "gemini_chunk_api_error",
                extra={
                    **log_context,
                    "duration_ms": round(duration_ms, 2),
                    **diagnostics,
                },
            )

            if error_code == 429 or "RESOURCE_EXHAUSTED" in error_message or "rate limit" in error_message.lower():
                raise RateLimitedException(
                    "AI generation service is temporarily busy. Retrying later is recommended."
                ) from exc

            if error_code == 504 or "timeout" in error_message.lower() or "deadline exceeded" in error_message.lower():
                raise TimeoutException(timeout_seconds=int(timeout_ms / 1000)) from exc

            raise UpstreamErrorException("Upstream AI provider error occurred.") from exc

        except TimeoutError as exc:
            duration_ms = (time.perf_counter() - start_time) * 1000
            logger.warning("gemini_chunk_timeout_error", extra={**log_context, "duration_ms": round(duration_ms, 2)})
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

            if "timeout" in exc_name.lower() or "timeout" in exc_msg or "timed out" in exc_msg:
                logger.warning(
                    "gemini_chunk_client_timeout", extra={**log_context, "duration_ms": round(duration_ms, 2)}
                )
                raise TimeoutException(timeout_seconds=int(timeout_ms / 1000)) from exc

            logger.error(
                "gemini_chunk_unexpected_error",
                extra={**log_context, "duration_ms": round(duration_ms, 2), "error_type": exc_name},
            )
            raise UpstreamErrorException("Unexpected error occurred while invoking AI provider.") from exc

    async def synthesize(
        self,
        chunk_summaries: list[ChunkSummary],
        video_title: str,
        request_id: str | None = None,
    ) -> SynthesizedNotes:
        """Invoke Gemini model to synthesize multiple chunk summaries into an executive synthesis."""
        client = self.get_client()
        summaries_text = "\n\n".join(
            f"--- Section {cs.chunk_index + 1} ---\nOverview: {cs.overview}\nKey Concepts: {', '.join(cs.key_concepts)}\nShorthands/Tips: {', '.join(cs.shorthands)}"
            for cs in chunk_summaries
        )
        prompt = build_synthesis_prompt(summaries_text=summaries_text, video_title=video_title)
        model_name = self.settings.gemini_model
        timeout_ms = self.settings.gemini_timeout_ms

        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=SynthesizedNotesContent,
            http_options=types.HttpOptions(timeout=timeout_ms),
        )

        log_context = {
            "request_id": request_id,
            "model": model_name,
            "chunk_count": len(chunk_summaries),
            "video_title_chars": len(video_title),
            "timeout_ms": timeout_ms,
        }
        logger.info("gemini_synthesis_started", extra=log_context)

        start_time = time.perf_counter()
        try:
            response = await client.aio.models.generate_content(
                model=model_name,
                contents=prompt,
                config=config,
            )
            duration_ms = (time.perf_counter() - start_time) * 1000

            raw_model_version = getattr(response, "model_version", None)
            model_version = raw_model_version if isinstance(raw_model_version, str) else None

            finish_reason: str | None = None
            candidates = getattr(response, "candidates", None)
            if candidates and isinstance(candidates, (list, tuple)) and len(candidates) > 0:
                candidate = candidates[0]
                raw_finish_reason = getattr(candidate, "finish_reason", None)
                if raw_finish_reason is not None:
                    if hasattr(raw_finish_reason, "name") and isinstance(raw_finish_reason.name, str):
                        finish_reason = raw_finish_reason.name
                    elif isinstance(raw_finish_reason, str):
                        finish_reason = raw_finish_reason
                    else:
                        type_name = type(raw_finish_reason).__name__
                        if "Mock" not in type_name:
                            finish_reason = str(raw_finish_reason)

            usage_meta = extract_usage_metadata(response)

            raw_text: str | None = None
            text_extraction_exc: Exception | None = None
            try:
                raw_text = response.text
            except Exception as exc:
                text_extraction_exc = exc

            raw_chars = len(raw_text) if isinstance(raw_text, str) else 0

            diagnostic_context = {
                "request_id": request_id,
                "model": model_name,
                "model_version": model_version,
                "chunk_count": len(chunk_summaries),
                "prompt_chars": len(prompt),
                "duration_ms": round(duration_ms, 2),
                "finish_reason": finish_reason,
                "prompt_tokens": usage_meta.prompt_tokens,
                "candidate_tokens": usage_meta.candidate_tokens,
                "thoughts_tokens": usage_meta.thoughts_tokens,
                "total_tokens": usage_meta.total_tokens,
                "raw_response_chars": raw_chars,
            }
            logger.info("gemini_synthesis_response_received", extra=diagnostic_context)

            if text_extraction_exc is not None:
                logger.error(
                    "gemini_synthesis_parsing_failed",
                    extra={**diagnostic_context, "exception_category": type(text_extraction_exc).__name__},
                )
                raise MalformedOutputException(
                    "Failed to extract textual content from AI response."
                ) from text_extraction_exc

            if not raw_text or not raw_text.strip():
                logger.error(
                    "gemini_synthesis_parsing_failed",
                    extra={**diagnostic_context, "exception_category": "MalformedOutputException"},
                )
                raise MalformedOutputException("AI model returned no usable text content in response candidates.")

            try:
                synth_data = parse_and_validate_synthesized_notes(raw_text)
            except Exception as parse_exc:
                logger.error(
                    "gemini_synthesis_parsing_failed",
                    extra={**diagnostic_context, "exception_category": type(parse_exc).__name__},
                )
                raise

            synthesized = SynthesizedNotes(
                overview=synth_data.overview,
                key_concepts=synth_data.key_concepts,
                table_of_contents=synth_data.table_of_contents,
                shorthands=synth_data.shorthands,
                detailed_notes=None,
                usage=usage_meta,
                prompt_tokens=usage_meta.prompt_tokens,
                candidate_tokens=usage_meta.candidate_tokens,
                thoughts_tokens=usage_meta.thoughts_tokens,
                total_tokens=usage_meta.total_tokens,
            )

            logger.info(
                "gemini_synthesis_completed",
                extra={
                    **diagnostic_context,
                    "output_chars": raw_chars,
                    "overview_chars": len(synthesized.overview),
                    "key_concepts_count": len(synthesized.key_concepts),
                    "table_of_contents_count": len(synthesized.table_of_contents),
                    "shorthands_count": len(synthesized.shorthands),
                },
            )
            return synthesized

        except genai_errors.APIError as exc:
            duration_ms = (time.perf_counter() - start_time) * 1000
            error_code = exc.code
            error_message = exc.message or ""
            diagnostics = extract_api_error_diagnostics(exc)

            logger.warning(
                "gemini_synthesis_api_error",
                extra={
                    **log_context,
                    "duration_ms": round(duration_ms, 2),
                    **diagnostics,
                },
            )

            if error_code == 429 or "RESOURCE_EXHAUSTED" in error_message or "rate limit" in error_message.lower():
                raise RateLimitedException(
                    "AI generation service is temporarily busy. Retrying later is recommended."
                ) from exc

            if error_code == 504 or "timeout" in error_message.lower() or "deadline exceeded" in error_message.lower():
                raise TimeoutException(timeout_seconds=int(timeout_ms / 1000)) from exc

            raise UpstreamErrorException("Upstream AI provider error occurred.") from exc

        except TimeoutError as exc:
            duration_ms = (time.perf_counter() - start_time) * 1000
            logger.warning(
                "gemini_synthesis_timeout_error", extra={**log_context, "duration_ms": round(duration_ms, 2)}
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

            if "timeout" in exc_name.lower() or "timeout" in exc_msg or "timed out" in exc_msg:
                logger.warning(
                    "gemini_synthesis_client_timeout", extra={**log_context, "duration_ms": round(duration_ms, 2)}
                )
                raise TimeoutException(timeout_seconds=int(timeout_ms / 1000)) from exc

            logger.error(
                "gemini_synthesis_unexpected_error",
                extra={**log_context, "duration_ms": round(duration_ms, 2), "error_type": exc_name},
            )
            raise UpstreamErrorException("Unexpected error occurred while invoking AI provider.") from exc
