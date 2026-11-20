"""Tests for Pydantic request and response schemas."""

import pytest
from pydantic import ValidationError

from app.schemas import (
    MAX_TITLE_CHARS,
    MAX_TRANSCRIPT_CHARS,
    ChunkGeneratedNotes,
    ChunkGenerateRequest,
    GeneratedNotes,
    GenerateNotesRequest,
    SynthesizedNotes,
    SynthesizeRequest,
)


def test_request_schema_accepts_camel_case():
    """Request schema must accept camelCase videoTitle."""
    req = GenerateNotesRequest.model_validate(
        {"transcript": "Valid tutorial transcript with code.", "videoTitle": "TypeScript Tutorial"}
    )
    assert req.video_title == "TypeScript Tutorial"
    assert req.transcript == "Valid tutorial transcript with code."


def test_request_schema_accepts_snake_case():
    """Request schema must accept snake_case video_title."""
    req = GenerateNotesRequest.model_validate(
        {"transcript": "Valid tutorial transcript with code.", "video_title": "TypeScript Tutorial"}
    )
    assert req.video_title == "TypeScript Tutorial"
    assert req.transcript == "Valid tutorial transcript with code."


def test_request_schema_enforces_min_transcript_length():
    """Transcript shorter than MIN_TRANSCRIPT_CHARS must be rejected."""
    with pytest.raises(ValidationError) as exc_info:
        GenerateNotesRequest.model_validate({"transcript": "short", "videoTitle": "Title"})
    assert "transcript" in str(exc_info.value)


def test_request_schema_enforces_max_transcript_length():
    """Transcript exceeding MAX_TRANSCRIPT_CHARS must be rejected."""
    oversized = "a" * (MAX_TRANSCRIPT_CHARS + 1)
    with pytest.raises(ValidationError) as exc_info:
        GenerateNotesRequest.model_validate({"transcript": oversized, "videoTitle": "Title"})
    assert "transcript" in str(exc_info.value)


def test_request_schema_enforces_max_title_length():
    """Video title exceeding MAX_TITLE_CHARS must be rejected."""
    oversized_title = "t" * (MAX_TITLE_CHARS + 1)
    with pytest.raises(ValidationError) as exc_info:
        GenerateNotesRequest.model_validate(
            {"transcript": "Valid transcript content here.", "videoTitle": oversized_title}
        )
    assert "video_title" in str(exc_info.value) or "videoTitle" in str(exc_info.value)


def test_request_schema_enforces_min_title_length():
    """Empty video title must be rejected."""
    with pytest.raises(ValidationError) as exc_info:
        GenerateNotesRequest.model_validate({"transcript": "Valid transcript content here.", "videoTitle": "   "})
    assert "video_title" in str(exc_info.value) or "videoTitle" in str(exc_info.value)


def test_generated_notes_serializes_to_camel_case(sample_valid_notes_dict: dict):
    """GeneratedNotes model must dump to exact camelCase contract."""
    notes = GeneratedNotes.model_validate(sample_valid_notes_dict)
    dumped = notes.model_dump(by_alias=True)

    assert "overview" in dumped
    assert "keyConcepts" in dumped
    assert "detailedNotes" in dumped
    assert "shorthands" in dumped

    # Verify snake_case aliases are not in dumped by_alias output
    assert "key_concepts" not in dumped
    assert "detailed_notes" not in dumped


def test_generated_notes_preserves_four_field_contract(sample_valid_notes_dict: dict):
    """Model must validate all 4 fields and enforce array of strings."""
    notes = GeneratedNotes.model_validate(sample_valid_notes_dict)
    assert isinstance(notes.overview, str)
    assert isinstance(notes.key_concepts, list)
    assert all(isinstance(c, str) for c in notes.key_concepts)
    assert isinstance(notes.detailed_notes, str)
    assert isinstance(notes.shorthands, list)
    assert all(isinstance(s, str) for s in notes.shorthands)


def test_generated_notes_accepts_empty_key_concepts():
    """keyConcepts is permitted to be an empty array []."""
    data = {
        "overview": "Overview text.",
        "keyConcepts": [],
        "detailedNotes": "Detailed notes markdown.",
        "shorthands": ["Tip 1"],
    }
    notes = GeneratedNotes.model_validate(data)
    assert notes.key_concepts == []
    dumped = notes.model_dump(by_alias=True)
    assert dumped["keyConcepts"] == []


def test_generated_notes_accepts_empty_shorthands():
    """shorthands is permitted to be an empty array []."""
    data = {
        "overview": "Overview text.",
        "keyConcepts": ["Concept 1"],
        "detailedNotes": "Detailed notes markdown.",
        "shorthands": [],
    }
    notes = GeneratedNotes.model_validate(data)
    assert notes.shorthands == []
    dumped = notes.model_dump(by_alias=True)
    assert dumped["shorthands"] == []


def test_generated_notes_rejects_omitted_shorthands():
    """shorthands is required; omitting it must raise ValidationError."""
    data = {
        "overview": "Overview text.",
        "keyConcepts": ["Concept 1"],
        "detailedNotes": "Detailed notes markdown.",
    }
    with pytest.raises(ValidationError) as exc_info:
        GeneratedNotes.model_validate(data)
    assert "shorthands" in str(exc_info.value)


def test_generated_notes_rejects_missing_overview():
    """Missing overview must fail validation."""
    data = {
        "keyConcepts": ["Concept 1"],
        "detailedNotes": "Notes text.",
        "shorthands": [],
    }
    with pytest.raises(ValidationError):
        GeneratedNotes.model_validate(data)


def test_generated_notes_rejects_missing_detailed_notes():
    """Missing detailedNotes must fail validation."""
    data = {
        "overview": "Overview text.",
        "keyConcepts": ["Concept 1"],
        "shorthands": [],
    }
    with pytest.raises(ValidationError):
        GeneratedNotes.model_validate(data)


def test_generated_notes_rejects_non_list_key_concepts():
    """keyConcepts must be a list of strings, not a single string."""
    data = {
        "overview": "Overview text.",
        "keyConcepts": "Not a list",
        "detailedNotes": "Notes text.",
        "shorthands": [],
    }
    with pytest.raises(ValidationError):
        GeneratedNotes.model_validate(data)


def test_generated_notes_rejects_wrong_field_types():
    """Wrong field types must fail validation."""
    # overview as number
    with pytest.raises(ValidationError):
        GeneratedNotes.model_validate(
            {
                "overview": 12345,
                "keyConcepts": ["Concept"],
                "detailedNotes": "Notes",
                "shorthands": [],
            }
        )

    # shorthands as dict
    with pytest.raises(ValidationError):
        GeneratedNotes.model_validate(
            {
                "overview": "Overview",
                "keyConcepts": ["Concept"],
                "detailedNotes": "Notes",
                "shorthands": {"tip": 1},
            }
        )


def test_generated_notes_json_schema_matches_typescript_contract():
    """GeneratedNotes JSON schema must require all 4 fields and allow empty keyConcepts."""
    schema = GeneratedNotes.model_json_schema()
    required = set(schema.get("required", []))
    expected_required = {"overview", "keyConcepts", "detailedNotes", "shorthands"}
    assert expected_required.issubset(required)

    # Verify keyConcepts schema does not enforce minItems
    key_concepts_prop = schema["properties"]["keyConcepts"]
    assert key_concepts_prop.get("type") == "array"
    assert "minItems" not in key_concepts_prop


def test_chunk_generate_request_accepts_camel_and_snake_case():
    """ChunkGenerateRequest must accept both camelCase and snake_case fields."""
    req_camel = ChunkGenerateRequest.model_validate(
        {
            "chunkText": "This is a valid chunk slice.",
            "videoTitle": "TypeScript Full Course",
            "chunkIndex": 2,
            "totalChunks": 5,
        }
    )
    assert req_camel.chunk_text == "This is a valid chunk slice."
    assert req_camel.video_title == "TypeScript Full Course"
    assert req_camel.chunk_index == 2
    assert req_camel.total_chunks == 5

    req_snake = ChunkGenerateRequest.model_validate(
        {
            "chunk_text": "This is a valid chunk slice.",
            "video_title": "TypeScript Full Course",
            "chunk_index": 0,
            "total_chunks": 1,
        }
    )
    assert req_snake.chunk_text == "This is a valid chunk slice."
    assert req_snake.video_title == "TypeScript Full Course"
    assert req_snake.chunk_index == 0
    assert req_snake.total_chunks == 1


def test_chunk_generate_request_fallback_from_transcript():
    """If transcript is provided instead of chunkText, fallback populates chunk_text."""
    req = ChunkGenerateRequest.model_validate({"transcript": "Transcript content fallback.", "videoTitle": "Course"})
    assert req.chunk_text == "Transcript content fallback."
    assert req.chunk_index == 0
    assert req.total_chunks == 1


def test_chunk_generate_request_validates_min_max_length():
    """ChunkGenerateRequest rejects empty or oversized fields."""
    with pytest.raises(ValidationError):
        ChunkGenerateRequest.model_validate({"chunkText": "short", "videoTitle": "Title"})

    with pytest.raises(ValidationError):
        ChunkGenerateRequest.model_validate({"chunkText": "Valid text", "videoTitle": ""})


def test_chunk_generated_notes_serializes_with_usage():
    """ChunkGeneratedNotes must serialize to camelCase and include usage + flat token metrics."""
    data = {
        "overview": "Section overview.",
        "keyConcepts": ["Concept A", "Concept B"],
        "detailedNotes": "Detailed section notes with code.",
        "shorthands": ["Tip 1"],
        "usage": {
            "promptTokens": 1500,
            "candidateTokens": 400,
            "thoughtsTokens": 80,
            "totalTokens": 1980,
        },
        "promptTokens": 1500,
        "candidateTokens": 400,
        "thoughtsTokens": 80,
        "totalTokens": 1980,
    }
    notes = ChunkGeneratedNotes.model_validate(data)
    dumped = notes.model_dump(by_alias=True)

    assert dumped["overview"] == "Section overview."
    assert dumped["keyConcepts"] == ["Concept A", "Concept B"]
    assert dumped["detailedNotes"] == "Detailed section notes with code."
    assert dumped["shorthands"] == ["Tip 1"]
    assert dumped["usage"]["thoughtsTokens"] == 80
    assert dumped["thoughtsTokens"] == 80
    assert dumped["promptTokens"] == 1500
    assert dumped["totalTokens"] == 1980


def test_synthesize_request_accepts_chunk_summaries():
    """SynthesizeRequest must validate videoTitle and non-empty list of ChunkSummary."""
    req = SynthesizeRequest.model_validate(
        {
            "videoTitle": "Full Course Title",
            "chunkSummaries": [
                {
                    "chunkIndex": 0,
                    "overview": "Intro overview",
                    "keyConcepts": ["Basics"],
                    "shorthands": ["Rule 1"],
                },
                {
                    "chunkIndex": 1,
                    "overview": "Advanced overview",
                    "keyConcepts": ["Generics"],
                    "shorthands": ["Gotcha 2"],
                },
            ],
        }
    )
    assert req.video_title == "Full Course Title"
    assert len(req.chunk_summaries) == 2
    assert req.chunk_summaries[0].chunk_index == 0
    assert req.chunk_summaries[1].key_concepts == ["Generics"]


def test_synthesized_notes_serializes_with_table_of_contents():
    """SynthesizedNotes serializes to camelCase with tableOfContents and usage metadata."""
    data = {
        "overview": "Global executive overview.",
        "keyConcepts": ["Concept 1", "Concept 2"],
        "tableOfContents": ["1. Introduction", "2. Core Principles", "3. Summary"],
        "shorthands": ["Global Tip 1"],
        "usage": {
            "promptTokens": 2000,
            "candidateTokens": 500,
            "thoughtsTokens": 120,
            "totalTokens": 2620,
        },
        "promptTokens": 2000,
        "candidateTokens": 500,
        "thoughtsTokens": 120,
        "totalTokens": 2620,
    }
    synth = SynthesizedNotes.model_validate(data)
    dumped = synth.model_dump(by_alias=True)

    assert dumped["overview"] == "Global executive overview."
    assert dumped["tableOfContents"] == ["1. Introduction", "2. Core Principles", "3. Summary"]
    assert dumped["usage"]["thoughtsTokens"] == 120
    assert dumped["thoughtsTokens"] == 120
    assert dumped["totalTokens"] == 2620
