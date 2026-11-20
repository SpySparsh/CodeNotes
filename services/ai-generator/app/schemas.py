"""Pydantic request and response schemas for CodeNotes AI generator service."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator
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


class UsageMetadata(BaseModel):
    """Token usage metrics extracted from Gemini response."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )

    prompt_tokens: int = Field(default=0, ge=0, alias="promptTokens", description="Prompt token count.")
    candidate_tokens: int = Field(default=0, ge=0, alias="candidateTokens", description="Candidate token count.")
    thoughts_tokens: int = Field(default=0, ge=0, alias="thoughtsTokens", description="Thoughts/reasoning token count.")
    total_tokens: int = Field(default=0, ge=0, alias="totalTokens", description="Total token count.")


class ChunkGenerateRequest(BaseModel):
    """Input payload for single chunk note generation."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    chunk_text: str = Field(
        ...,
        alias="chunkText",
        min_length=MIN_TRANSCRIPT_CHARS,
        max_length=MAX_TRANSCRIPT_CHARS,
        description="Text slice of the tutorial transcript for this chunk.",
    )
    video_title: str = Field(
        ...,
        alias="videoTitle",
        min_length=MIN_TITLE_CHARS,
        max_length=MAX_TITLE_CHARS,
        description="Title of the YouTube video.",
    )
    chunk_index: int = Field(
        default=0,
        alias="chunkIndex",
        ge=0,
        description="0-based index of this chunk.",
    )
    total_chunks: int = Field(
        default=1,
        alias="totalChunks",
        ge=1,
        description="Total number of chunks in the video.",
    )

    @model_validator(mode="before")
    @classmethod
    def populate_chunk_text_fallback(cls, data: Any) -> Any:
        if isinstance(data, dict):
            if "chunk_text" not in data and "chunkText" not in data:
                if "transcript" in data:
                    data["chunk_text"] = data["transcript"]
                elif "chunk" in data:
                    data["chunk_text"] = data["chunk"]
        return data


class ChunkGeneratedNotes(BaseModel):
    """Structured technical notes for a single transcript chunk, including token usage."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )

    overview: str = Field(
        ...,
        min_length=1,
        max_length=MAX_OVERVIEW_CHARS,
        description="Summary of this chunk's content (2-3 sentences).",
    )
    key_concepts: list[str] = Field(
        default_factory=list,
        alias="keyConcepts",
        max_length=MAX_LIST_ITEMS,
        description="List of key concepts extracted from this chunk.",
    )
    detailed_notes: str = Field(
        ...,
        alias="detailedNotes",
        min_length=1,
        max_length=MAX_DETAILED_NOTES_CHARS,
        description="Comprehensive markdown string containing detailed topics, contextual code blocks, and comparison tables.",
    )
    shorthands: list[str] = Field(
        default_factory=list,
        alias="shorthands",
        max_length=MAX_LIST_ITEMS,
        description="List of shorthands, quick tips, or gotchas for this chunk.",
    )
    usage: UsageMetadata = Field(..., description="Token usage metadata.")
    prompt_tokens: int = Field(default=0, ge=0, alias="promptTokens")
    candidate_tokens: int = Field(default=0, ge=0, alias="candidateTokens")
    thoughts_tokens: int = Field(default=0, ge=0, alias="thoughtsTokens")
    total_tokens: int = Field(default=0, ge=0, alias="totalTokens")


class ChunkSummary(BaseModel):
    """Summary of an individual chunk for hierarchical synthesis."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    chunk_index: int = Field(default=0, ge=0, alias="chunkIndex", description="0-based index of the chunk.")
    overview: str = Field(..., min_length=1, max_length=MAX_OVERVIEW_CHARS, description="Overview of this chunk.")
    key_concepts: list[str] = Field(
        default_factory=list,
        alias="keyConcepts",
        max_length=MAX_LIST_ITEMS,
        description="Key concepts covered in this chunk.",
    )
    shorthands: list[str] = Field(
        default_factory=list,
        alias="shorthands",
        max_length=MAX_LIST_ITEMS,
        description="Quick tips or gotchas from this chunk.",
    )


class SynthesizeRequest(BaseModel):
    """Input payload for multi-chunk hierarchical synthesis."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    video_title: str = Field(
        ...,
        alias="videoTitle",
        min_length=MIN_TITLE_CHARS,
        max_length=MAX_TITLE_CHARS,
        description="Title of the YouTube video.",
    )
    chunk_summaries: list[ChunkSummary] = Field(
        ...,
        alias="chunkSummaries",
        min_length=1,
        max_length=MAX_LIST_ITEMS,
        description="List of chunk summaries to synthesize into an executive summary.",
    )


class SynthesizedNotes(BaseModel):
    """Master executive synthesis and table of contents produced from chunk summaries."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )

    overview: str = Field(
        ...,
        min_length=1,
        max_length=MAX_OVERVIEW_CHARS,
        description="Global executive overview of the entire video (2-3 sentences).",
    )
    key_concepts: list[str] = Field(
        default_factory=list,
        alias="keyConcepts",
        max_length=MAX_LIST_ITEMS,
        description="Consolidated top key concepts across all sections.",
    )
    table_of_contents: list[str] = Field(
        default_factory=list,
        alias="tableOfContents",
        max_length=MAX_LIST_ITEMS,
        description="Master table of contents outlining sequential tutorial topics.",
    )
    shorthands: list[str] = Field(
        default_factory=list,
        alias="shorthands",
        max_length=MAX_LIST_ITEMS,
        description="Consolidated top tips, gotchas, and best practices.",
    )
    detailed_notes: str | None = Field(
        default=None,
        alias="detailedNotes",
        description="Optional synthesized or combined detailed notes string.",
    )
    usage: UsageMetadata = Field(..., description="Token usage metadata.")
    prompt_tokens: int = Field(default=0, ge=0, alias="promptTokens")
    candidate_tokens: int = Field(default=0, ge=0, alias="candidateTokens")
    thoughts_tokens: int = Field(default=0, ge=0, alias="thoughtsTokens")
    total_tokens: int = Field(default=0, ge=0, alias="totalTokens")


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
