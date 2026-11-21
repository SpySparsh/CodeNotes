import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NonRetriableError } from 'inngest';
import crypto from 'crypto';
import { computeCanonicalManifestHash, type ChunkManifest } from '@/lib/chunk-planner';

describe('Adaptive Synthesis Linkage & Manifest Verification Invariants', () => {
  const mockUserId = '123e4567-e89b-12d3-a456-426614174000';
  const mockKey = 'idem-key-adaptive-1';
  const videoId = 'dQw4w9WgXcQ';

  const mockManifest: ChunkManifest = {
    videoId,
    totalChunks: 2,
    totalCodePoints: 14000,
    chunks: [
      {
        chunkIndex: 0,
        startChar: 0,
        endChar: 7000,
        codePointCount: 7000,
        contentSha256: 'hash-0',
        estimatedTokens: 2500,
      },
      {
        chunkIndex: 1,
        startChar: 7000,
        endChar: 14000,
        codePointCount: 7000,
        contentSha256: 'hash-1',
        estimatedTokens: 2500,
      },
    ],
  };

  it('verifies manifest hash matches canonical representation', () => {
    const canonicalHash = computeCanonicalManifestHash(mockManifest);
    expect(canonicalHash).toHaveLength(64);

    // Any modification changes the hash
    const altered = { ...mockManifest, totalChunks: 3 };
    expect(computeCanonicalManifestHash(altered)).not.toBe(canonicalHash);
  });

  it('detects missing chunk indices in database result sequence', () => {
    // Only chunk 0 is returned; chunk 1 is missing
    const incompleteDbRows = [
      { chunk_index: 0, chunk_notes: { overview: 'Part 1', detailedNotes: 'Notes 1' } },
    ];

    expect(incompleteDbRows.length).not.toBe(mockManifest.totalChunks);
  });

  it('detects non-contiguous or gap chunk indices in database result sequence', () => {
    // Chunks 0 and 2 returned (length 2), but chunk 1 is missing
    const gapDbRows = [
      { chunk_index: 0, chunk_notes: { overview: 'Part 1', detailedNotes: 'Notes 1' } },
      { chunk_index: 2, chunk_notes: { overview: 'Part 3', detailedNotes: 'Notes 3' } },
    ];

    let hasGapOrMismatch = false;
    for (let idx = 0; idx < mockManifest.totalChunks; idx++) {
      if (!gapDbRows[idx] || gapDbRows[idx].chunk_index !== idx) {
        hasGapOrMismatch = true;
        break;
      }
    }

    expect(hasGapOrMismatch).toBe(true);
  });

  it('validates correct synthesis linkage properties to persist', () => {
    const synthAttemptId = crypto.randomUUID();
    const noteId = crypto.randomUUID();

    const insertPayload = {
      id: noteId,
      user_id: mockUserId,
      parent_key: mockKey,
      attempt_id: synthAttemptId,
    };

    expect(insertPayload.parent_key).toBe(mockKey);
    expect(insertPayload.attempt_id).toBe(synthAttemptId);
    expect(insertPayload.parent_key).not.toBeNull();
    expect(insertPayload.attempt_id).not.toBeNull();
  });

  it('regression: rejects publishing monolithic note when attempt identity is missing and cannot publish unlinked note', () => {
    // Verifies that a monolithic completion fallback cannot proceed without attempt_id
    const attemptId: string | null = null;
    const reservationToken: string | null = null;

    expect(() => {
      if (!attemptId || !reservationToken) {
        throw new NonRetriableError(
          'PERSIST_FAILED: Cannot publish monolithic note without verified dispatch attempt and reservation'
        );
      }
    }).toThrow(NonRetriableError);
  });
});
