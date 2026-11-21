/**
 * CodeNotes AI — Unicode Code-Point Chunk Planner
 * Partitions long video transcripts into balanced, boundary-aligned chunks.
 *
 * CRITICAL UNICODE INVARIANT:
 * JavaScript strings natively measure UTF-16 code units (where surrogate pairs like emojis count as 2).
 * PostgreSQL `char_length()` / `substring(... from start for length)` and Python string slicing operate
 * strictly on Unicode code points (1 code point per character).
 *
 * This module enforces strict Unicode code-point indexing across all boundary calculations,
 * guaranteeing 100% boundary alignment with PostgreSQL `public.youtube_transcripts` retrieval.
 */

import crypto from 'crypto';

// -----------------------------------------------------------------------------
// CONSTANTS & SIZING CONSTRAINTS
// -----------------------------------------------------------------------------

export const TARGET_CHUNK_CHARS = 7_000;
export const MIN_CHUNK_CHARS = 5_000;
export const MAX_CHUNK_CHARS = 8_500;
export const MAX_CHUNKS = 75;
export const MAX_TOTAL_TRANSCRIPT_CODE_POINTS = 500_000;

// -----------------------------------------------------------------------------
// MANIFEST INTERFACES
// -----------------------------------------------------------------------------

export interface ChunkManifestItem {
  chunkIndex: number;
  startChar: number; // 0-based code-point offset (inclusive)
  endChar: number;   // 0-based code-point offset (exclusive)
  codePointCount: number;
  contentSha256: string;
  estimatedTokens: number;
}

export interface ChunkManifest {
  videoId: string;
  totalChunks: number;
  totalCodePoints: number;
  chunks: ChunkManifestItem[];
}

// -----------------------------------------------------------------------------
// CODE-POINT UTILITIES
// -----------------------------------------------------------------------------

/**
 * Returns the exact count of Unicode code points in a string.
 * Accurately treats emojis and surrogate pairs (e.g. '🚀' or '💻') as 1 code point.
 */
export function getCodePointLength(text: string): number {
  if (!text) return 0;
  return Array.from(text).length;
}

/**
 * Slices a string by Unicode code-point offsets [start, end),
 * ensuring surrogate pairs are never split across slices.
 */
export function sliceByCodePoints(text: string, start: number, end?: number): string {
  if (!text) return '';
  const codePoints = Array.from(text);
  return codePoints.slice(start, end).join('');
}

// -----------------------------------------------------------------------------
// NATURAL BOUNDARY FINDER
// -----------------------------------------------------------------------------

/**
 * Locates the optimal semantic split point within codePoints[minEnd..maxEnd].
 * Prioritizes:
 * 1. Paragraph breaks (\n\n)
 * 2. Sentence terminators (. , ? , ! followed by space or newline)
 * 3. Line breaks (\n)
 * 4. Clause delimiters (, ; :)
 * 5. Word boundaries (spaces)
 */
function findNaturalBoundary(
  codePoints: string[],
  minEnd: number,
  maxEnd: number,
  idealTarget: number
): number {
  const windowEnd = Math.min(maxEnd, codePoints.length);
  const windowStart = Math.max(minEnd, 0);

  // Search backwards from windowEnd towards windowStart for paragraph breaks
  for (let i = windowEnd - 1; i >= windowStart; i--) {
    if (codePoints[i] === '\n' && i > windowStart && codePoints[i - 1] === '\n') {
      return i + 1; // Include trailing newline
    }
  }

  // Search backwards for sentence endings (. ? ! followed by space or newline)
  for (let i = windowEnd - 1; i >= windowStart; i--) {
    const char = codePoints[i];
    if (char === '.' || char === '?' || char === '!') {
      if (i + 1 < codePoints.length) {
        const nextChar = codePoints[i + 1];
        if (nextChar === ' ' || nextChar === '\n' || nextChar === '\t') {
          return i + 2; // Split immediately after the space/newline
        }
      } else {
        return i + 1;
      }
    }
  }

  // Search backwards for newline
  for (let i = windowEnd - 1; i >= windowStart; i--) {
    if (codePoints[i] === '\n') {
      return i + 1;
    }
  }

  // Search backwards for clause punctuation followed by space
  for (let i = windowEnd - 1; i >= windowStart; i--) {
    const char = codePoints[i];
    if (char === ',' || char === ';' || char === ':') {
      if (i + 1 < codePoints.length && (codePoints[i + 1] === ' ' || codePoints[i + 1] === '\n')) {
        return i + 2;
      }
    }
  }

  // Search backwards for word break
  for (let i = windowEnd - 1; i >= windowStart; i--) {
    if (codePoints[i] === ' ') {
      return i + 1;
    }
  }

  // Fallback: If no punctuation or whitespace is found in window, cut at idealTarget
  return Math.min(idealTarget, windowEnd);
}

// -----------------------------------------------------------------------------
// CHUNK PLANNER ENTRYPOINT
// -----------------------------------------------------------------------------

export interface PlanChunkManifestOptions {
  targetChunkChars?: number;
  minChunkChars?: number;
  maxChunkChars?: number;
  maxChunks?: number;
}

/**
 * Plans and generates a verified ChunkManifest for a video transcript.
 * Guarantees:
 * - Chunk boundaries are pure Unicode code points.
 * - Chunks are strictly contiguous with zero gaps and zero overlaps.
 * - sum(chunk.endChar - chunk.startChar) === totalCodePoints.
 * - Total chunks <= maxChunks (default 75).
 */
export function planChunkManifest(
  videoId: string,
  transcript: string,
  options?: PlanChunkManifestOptions
): ChunkManifest {
  if (!videoId || videoId.trim().length === 0) {
    throw new Error('videoId is required for chunk planning');
  }

  const codePoints = Array.from(transcript || '');
  const totalCodePoints = codePoints.length;

  if (totalCodePoints === 0) {
    throw new Error('Transcript is empty; cannot generate chunk manifest');
  }

  if (totalCodePoints > MAX_TOTAL_TRANSCRIPT_CODE_POINTS) {
    throw new Error(
      `Transcript length (${totalCodePoints} code points) exceeds maximum supported limit (${MAX_TOTAL_TRANSCRIPT_CODE_POINTS})`
    );
  }

  const targetChars = options?.targetChunkChars ?? TARGET_CHUNK_CHARS;
  const minChars = options?.minChunkChars ?? MIN_CHUNK_CHARS;
  const maxChars = options?.maxChunkChars ?? MAX_CHUNK_CHARS;
  const maxChunksAllowed = options?.maxChunks ?? MAX_CHUNKS;

  const chunks: ChunkManifestItem[] = [];

  // Short video optimization: single chunk if within maxChunkChars
  if (totalCodePoints <= maxChars) {
    const chunkText = transcript;
    const contentSha256 = crypto.createHash('sha256').update(chunkText, 'utf8').digest('hex');
    const estimatedTokens = Math.max(1, Math.ceil(totalCodePoints / 4));

    chunks.push({
      chunkIndex: 0,
      startChar: 0,
      endChar: totalCodePoints,
      codePointCount: totalCodePoints,
      contentSha256,
      estimatedTokens,
    });

    return {
      videoId,
      totalChunks: 1,
      totalCodePoints,
      chunks,
    };
  }

  let startChar = 0;
  let chunkIndex = 0;

  while (startChar < totalCodePoints) {
    const remainingCodePoints = totalCodePoints - startChar;

    let endChar: number;
    if (remainingCodePoints <= maxChars) {
      // Remaining text fits comfortably in final chunk
      endChar = totalCodePoints;
    } else {
      const idealTarget = startChar + targetChars;
      const minEnd = Math.min(startChar + minChars, totalCodePoints);
      const maxEnd = Math.min(startChar + maxChars, totalCodePoints);

      endChar = findNaturalBoundary(codePoints, minEnd, maxEnd, idealTarget);

      // Ensure progress is strictly monotonically increasing
      if (endChar <= startChar) {
        endChar = Math.min(startChar + targetChars, totalCodePoints);
      }
    }

    const chunkCodePoints = codePoints.slice(startChar, endChar);
    const chunkText = chunkCodePoints.join('');
    const codePointCount = endChar - startChar;
    const contentSha256 = crypto.createHash('sha256').update(chunkText, 'utf8').digest('hex');
    const estimatedTokens = Math.max(1, Math.ceil(codePointCount / 4));

    chunks.push({
      chunkIndex,
      startChar,
      endChar,
      codePointCount,
      contentSha256,
      estimatedTokens,
    });

    startChar = endChar;
    chunkIndex++;

    if (chunkIndex > maxChunksAllowed) {
      throw new Error(
        `Chunk planning exceeded maximum allowed chunks (${maxChunksAllowed}). Total code points: ${totalCodePoints}`
      );
    }
  }

  const manifest: ChunkManifest = {
    videoId,
    totalChunks: chunks.length,
    totalCodePoints,
    chunks,
  };

  // Enforce coverage invariant check before returning
  if (!verifyChunkManifest(manifest, transcript)) {
    throw new Error('Chunk manifest failed invariant validation');
  }

  return manifest;
}

// -----------------------------------------------------------------------------
// MANIFEST INVARIANT VERIFICATION
// -----------------------------------------------------------------------------

/**
 * Verifies that a chunk manifest strictly satisfies all coverage and cryptographic invariants:
 * 1. chunks[0].startChar === 0
 * 2. chunks[i].startChar === chunks[i-1].endChar (no gaps, no overlaps)
 * 3. chunks[last].endChar === totalCodePoints
 * 4. sum(chunk.codePointCount) === totalCodePoints
 * 5. contentSha256 matches slice SHA-256 for every chunk
 */
export function verifyChunkManifest(manifest: ChunkManifest, fullTranscript: string): boolean {
  if (!manifest || manifest.chunks.length === 0) return false;

  const codePoints = Array.from(fullTranscript);
  if (codePoints.length !== manifest.totalCodePoints) return false;

  let expectedStart = 0;
  let accumulatedCount = 0;

  for (let i = 0; i < manifest.chunks.length; i++) {
    const chunk = manifest.chunks[i];

    if (chunk.chunkIndex !== i) return false;
    if (chunk.startChar !== expectedStart) return false;
    if (chunk.endChar <= chunk.startChar) return false;
    if (chunk.codePointCount !== chunk.endChar - chunk.startChar) return false;

    // Verify hash against actual code-point slice
    const slice = codePoints.slice(chunk.startChar, chunk.endChar).join('');
    const actualHash = crypto.createHash('sha256').update(slice, 'utf8').digest('hex');
    if (actualHash !== chunk.contentSha256) return false;

    expectedStart = chunk.endChar;
    accumulatedCount += chunk.codePointCount;
  }

  if (expectedStart !== manifest.totalCodePoints) return false;
  if (accumulatedCount !== manifest.totalCodePoints) return false;

  return true;
}

/**
 * Computes a deterministic canonical SHA-256 hash of a ChunkManifest.
 * Standardizes key ordering and property types across manifest generation and verification.
 */
export function computeCanonicalManifestHash(manifest: ChunkManifest): string {
  if (!manifest || !Array.isArray(manifest.chunks)) {
    throw new Error('Invalid manifest for canonical hash computation');
  }

  // Canonical representation: sorted chunk list with deterministic fields
  const canonicalChunks = manifest.chunks
    .slice()
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((c) => ({
      chunkIndex: c.chunkIndex,
      codePointCount: c.codePointCount,
      contentSha256: c.contentSha256,
      endChar: c.endChar,
      estimatedTokens: c.estimatedTokens,
      startChar: c.startChar,
    }));

  const canonicalPayload = JSON.stringify({
    chunks: canonicalChunks,
    totalChunks: manifest.totalChunks,
    totalCodePoints: manifest.totalCodePoints,
    videoId: manifest.videoId,
  });

  return crypto.createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}
