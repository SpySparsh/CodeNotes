"""Pydantic request and response schemas for CodeNotes AI generator service."""

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# Maximum allowed transcript length (approx. 500k characters ~ 100k words, sufficient for 4-5h tutorials)
MAX_TRANSCRIPT_CHARS = 500_000
MIN_TRANSCRIPT_CHARS = 10

# Maximum allowed video title length
MAX_TITLE_CHARS = 500
MIN_TITLE_CHARS = 1

# Maximum reasonable generated text lengths to safeguard memory
MAX_OVERVIEW_CHARS = 10_000
MAX_DETAILED_NOTES_CHARS = 200_000
MAX_LIST_ITEMS = 100


class GenerateNotesRequest(BaseModel):
    """Input payload for note generation.

    Accepts both camelCase and snake_case field names for maximum caller flexibility.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    transcript: str = Field(
        ...,
        min_length=MIN_TRANSCRIPT_CHARS,
        max_length=MAX_TRANSCRIPT_CHARS,
        description="Full text transcript of the tutorial video.",
    )
    video_title: str = Field(
        ...,
        alias="videoTitle",
        min_length=MIN_TITLE_CHARS,
        max_length=MAX_TITLE_CHARS,
        description="Title of the YouTube video.",
    )


class GeneratedNotes(BaseModel):
    """Structured technical notes produced by Gemini model.

    Serializes using camelCase to preserve 1:1 compatibility with existing TypeScript types.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )

    overview: str = Field(
        ...,
        min_length=1,
        max_length=MAX_OVERVIEW_CHARS,
        description="A compelling overview of the video's purpose (2-3 sentences).",
    )
    key_concepts: list[str] = Field(
        ...,
        alias="keyConcepts",
        max_length=MAX_LIST_ITEMS,
        description="List of key concepts extracted from the video.",
    )
    detailed_notes: str = Field(
        ...,
        alias="detailedNotes",
        min_length=1,
        max_length=MAX_DETAILED_NOTES_CHARS,
        description="Comprehensive markdown string containing detailed topics, contextual code blocks, and comparison tables.",
    )
    shorthands: list[str] = Field(
        ...,
        alias="shorthands",
        max_length=MAX_LIST_ITEMS,
        description="List of shorthands, quick tips, or gotchas.",
    )


class ErrorDetail(BaseModel):
    """Machine-readable error information."""

    code: str = Field(..., description="Machine-readable error code")
    message: str = Field(..., description="Human-readable sanitized error description")


class ErrorResponse(BaseModel):
    """Standardized error envelope."""

    error: ErrorDetail


class HealthResponse(BaseModel):
    """Service health response."""

    status: str = Field(default="healthy", description="Service health state")
