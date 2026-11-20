import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  getCodePointLength,
  sliceByCodePoints,
  planChunkManifest,
  verifyChunkManifest,
  TARGET_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  MAX_CHUNK_CHARS,
  MAX_CHUNKS,
  MAX_TOTAL_TRANSCRIPT_CODE_POINTS,
  type ChunkManifest,
} from '@/lib/chunk-planner';

describe('Unicode Chunk Planner (src/lib/chunk-planner.ts)', () => {
  const sampleVideoId = 'yt-video-12345';

  describe('Unicode Code-Point Utilities', () => {
    it('accurately counts code points for ASCII text', () => {
      const text = 'Hello, World!';
      expect(getCodePointLength(text)).toBe(text.length);
      expect(getCodePointLength(text)).toBe(13);
    });

    it('correctly counts code points for surrogate pairs / emojis where JS .length is 2', () => {
      // 🚀 is 1 code point (U+1F680), but .length in UTF-16 is 2
      const rocket = '🚀';
      expect(rocket.length).toBe(2);
      expect(getCodePointLength(rocket)).toBe(1);

      // Multiple emojis and symbols
      const mixed = 'CodeNotes 🚀 AI 💻 is great! 🎉';
      expect(mixed.length).toBe(31); // 3 emojis each count as 2 UTF-16 units
      expect(getCodePointLength(mixed)).toBe(28); // exactly 28 Unicode code points
    });

    it('slices text strictly by code points without splitting surrogate pairs', () => {
      const text = 'A🚀B💻C';
      // Code points:
      // Index 0: 'A'
      // Index 1: '🚀'
      // Index 2: 'B'
      // Index 3: '💻'
      // Index 4: 'C'
      expect(getCodePointLength(text)).toBe(5);

      const slice1 = sliceByCodePoints(text, 0, 2); // 'A🚀'
      expect(slice1).toBe('A🚀');
      expect(getCodePointLength(slice1)).toBe(2);

      const slice2 = sliceByCodePoints(text, 1, 4); // '🚀B💻'
      expect(slice2).toBe('🚀B💻');
      expect(getCodePointLength(slice2)).toBe(3);

      const slice3 = sliceByCodePoints(text, 3); // '💻C'
      expect(slice3).toBe('💻C');
      expect(getCodePointLength(slice3)).toBe(2);
    });

    it('handles empty and null strings gracefully', () => {
      expect(getCodePointLength('')).toBe(0);
      expect(sliceByCodePoints('', 0, 5)).toBe('');
    });
  });

  describe('Short Video Optimization (Single Chunk)', () => {
    it('creates a single chunk when transcript length is <= MAX_CHUNK_CHARS', () => {
      const shortText = 'This is a short video transcript under the max threshold.';
      const manifest = planChunkManifest(sampleVideoId, shortText);

      expect(manifest.videoId).toBe(sampleVideoId);
      expect(manifest.totalChunks).toBe(1);
      expect(manifest.totalCodePoints).toBe(getCodePointLength(shortText));
      expect(manifest.chunks.length).toBe(1);

      const chunk = manifest.chunks[0];
      expect(chunk.chunkIndex).toBe(0);
      expect(chunk.startChar).toBe(0);
      expect(chunk.endChar).toBe(manifest.totalCodePoints);
      expect(chunk.codePointCount).toBe(manifest.totalCodePoints);
      expect(chunk.estimatedTokens).toBe(Math.ceil(manifest.totalCodePoints / 4));

      const expectedSha256 = crypto.createHash('sha256').update(shortText, 'utf8').digest('hex');
      expect(chunk.contentSha256).toBe(expectedSha256);

      expect(verifyChunkManifest(manifest, shortText)).toBe(true);
    });

    it('creates a single chunk with emojis preserving exact hash and length', () => {
      const emojiText = '🚀 Welcome to CodeNotes AI! 💻 Learn TypeScript and PostgreSQL fast! 🎉';
      const manifest = planChunkManifest(sampleVideoId, emojiText);

      expect(manifest.totalChunks).toBe(1);
      expect(manifest.totalCodePoints).toBe(getCodePointLength(emojiText));
      expect(verifyChunkManifest(manifest, emojiText)).toBe(true);
    });
  });

  describe('Multi-Chunk Planning and Natural Boundary Snapping', () => {
    it('partitions large transcripts into balanced chunks snapping to paragraph boundaries', () => {
      // Build a synthetic transcript with clear paragraph breaks every ~6,000 code points
      const paragraphA = 'Paragraph A contains detailed introductory explanations. '.repeat(105) + '\n\n'; // ~6,000 chars
      const paragraphB = 'Paragraph B delves deeply into architectural patterns. '.repeat(110) + '\n\n';   // ~6,000 chars
      const paragraphC = 'Paragraph C covers concurrency controls and testing. '.repeat(115) + '\n\n';      // ~6,500 chars
      const paragraphD = 'Paragraph D provides final conclusions and best practices. '.repeat(100);          // ~5,500 chars

      const fullTranscript = paragraphA + paragraphB + paragraphC + paragraphD;
      const totalCodePoints = getCodePointLength(fullTranscript);

      const manifest = planChunkManifest(sampleVideoId, fullTranscript, {
        targetChunkChars: 7_000,
        minChunkChars: 5_000,
        maxChunkChars: 8_500,
      });

      expect(manifest.totalChunks).toBeGreaterThan(1);
      expect(manifest.totalCodePoints).toBe(totalCodePoints);

      // Verify that every intermediate boundary ends with '\n\n' (snapped to paragraph break)
      const codePoints = Array.from(fullTranscript);
      for (let i = 0; i < manifest.chunks.length - 1; i++) {
        const chunk = manifest.chunks[i];
        const slice = codePoints.slice(chunk.startChar, chunk.endChar).join('');
        expect(slice.endsWith('\n\n')).toBe(true);
      }

      expect(verifyChunkManifest(manifest, fullTranscript)).toBe(true);
    });

    it('snaps to sentence boundaries (. ) when paragraph breaks are not available', () => {
      const sentence = 'This is an important concept in distributed databases. '; // 55 chars
      // Repeat to create ~20,000 chars without any \n\n
      const fullTranscript = sentence.repeat(380);
      const totalCodePoints = getCodePointLength(fullTranscript);

      const manifest = planChunkManifest(sampleVideoId, fullTranscript, {
        targetChunkChars: 7_000,
        minChunkChars: 5_000,
        maxChunkChars: 8_500,
      });

      expect(manifest.totalChunks).toBeGreaterThan(1);
      expect(manifest.totalCodePoints).toBe(totalCodePoints);

      // Verify that intermediate chunks end with '. ' or '.'
      const codePoints = Array.from(fullTranscript);
      for (let i = 0; i < manifest.chunks.length - 1; i++) {
        const chunk = manifest.chunks[i];
        const slice = codePoints.slice(chunk.startChar, chunk.endChar).join('');
        expect(slice.endsWith(' ') && slice.slice(-2, -1) === '.').toBe(true);
      }

      expect(verifyChunkManifest(manifest, fullTranscript)).toBe(true);
    });

    it('safely plans across 25,000+ characters containing emojis and surrogate pairs', () => {
      // Build a large transcript heavily saturated with emojis and Unicode characters
      const emojiParagraph = '🚀 Step through CodeNotes AI 💻 architecture with 🛡️ security and ⚡ speed! '.repeat(85) + '\n\n';
      const fullTranscript = emojiParagraph.repeat(5); // ~30,000+ code points

      const totalCodePoints = getCodePointLength(fullTranscript);
      const manifest = planChunkManifest(sampleVideoId, fullTranscript);

      expect(manifest.totalChunks).toBeGreaterThan(1);
      expect(manifest.totalCodePoints).toBe(totalCodePoints);

      // Invariant: sum of codePointCount across chunks must exactly equal totalCodePoints
      const sumCodePoints = manifest.chunks.reduce((acc, c) => acc + c.codePointCount, 0);
      expect(sumCodePoints).toBe(totalCodePoints);

      // Invariant: sum of (endChar - startChar) must equal totalCodePoints
      const sumOffsets = manifest.chunks.reduce((acc, c) => acc + (c.endChar - c.startChar), 0);
      expect(sumOffsets).toBe(totalCodePoints);

      // Invariant: chunks are strictly contiguous
      let expectedStart = 0;
      for (const chunk of manifest.chunks) {
        expect(chunk.startChar).toBe(expectedStart);
        expect(chunk.endChar).toBeGreaterThan(chunk.startChar);
        expect(chunk.codePointCount).toBe(chunk.endChar - chunk.startChar);
        expectedStart = chunk.endChar;
      }
      expect(expectedStart).toBe(totalCodePoints);

      expect(verifyChunkManifest(manifest, fullTranscript)).toBe(true);
    });
  });

  describe('Manifest Invariant Verification (verifyChunkManifest)', () => {
    it('returns true for a valid generated manifest', () => {
      const text = 'Valid transcript text that spans enough characters to test verification logic accurately.'.repeat(100);
      const manifest = planChunkManifest(sampleVideoId, text);
      expect(verifyChunkManifest(manifest, text)).toBe(true);
    });

    it('returns false if manifest totalCodePoints does not match actual text code points', () => {
      const text = 'Valid transcript text.'.repeat(100);
      const manifest = planChunkManifest(sampleVideoId, text);
      manifest.totalCodePoints += 1;
      expect(verifyChunkManifest(manifest, text)).toBe(false);
    });

    it('returns false if a chunk contentSha256 is tampered with', () => {
      const text = 'Valid transcript text.'.repeat(500);
      const manifest = planChunkManifest(sampleVideoId, text);
      manifest.chunks[0].contentSha256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(verifyChunkManifest(manifest, text)).toBe(false);
    });

    it('returns false if there is an offset gap between chunks', () => {
      const text = 'Valid transcript text.'.repeat(500);
      const manifest = planChunkManifest(sampleVideoId, text);
      manifest.chunks[1].startChar += 5; // Introduce a 5-char gap
      expect(verifyChunkManifest(manifest, text)).toBe(false);
    });

    it('returns false if chunkIndex sequence is non-monotonic', () => {
      const text = 'Valid transcript text.'.repeat(500);
      const manifest = planChunkManifest(sampleVideoId, text);
      manifest.chunks[1].chunkIndex = 99;
      expect(verifyChunkManifest(manifest, text)).toBe(false);
    });

    it('returns false if chunks array is empty', () => {
      const manifest: ChunkManifest = {
        videoId: sampleVideoId,
        totalChunks: 0,
        totalCodePoints: 0,
        chunks: [],
      };
      expect(verifyChunkManifest(manifest, '')).toBe(false);
    });
  });

  describe('Validation & Error Boundaries', () => {
    it('throws error when videoId is empty or blank', () => {
      expect(() => planChunkManifest('', 'Some transcript text')).toThrow('videoId is required');
      expect(() => planChunkManifest('   ', 'Some transcript text')).toThrow('videoId is required');
    });

    it('throws error when transcript is empty', () => {
      expect(() => planChunkManifest(sampleVideoId, '')).toThrow('Transcript is empty');
      expect(() => planChunkManifest(sampleVideoId, null as any)).toThrow('Transcript is empty');
    });

    it('throws error when transcript exceeds 500,000 code points', () => {
      // Create a mock large string length
      const largeText = 'A'.repeat(MAX_TOTAL_TRANSCRIPT_CODE_POINTS + 1);
      expect(() => planChunkManifest(sampleVideoId, largeText)).toThrow('exceeds maximum supported limit');
    });

    it('throws error if chunk count exceeds maxChunks', () => {
      const text = 'A'.repeat(10_000);
      // Force very small chunk size with maxChunks=2
      expect(() =>
        planChunkManifest(sampleVideoId, text, {
          targetChunkChars: 100,
          minChunkChars: 50,
          maxChunkChars: 150,
          maxChunks: 2,
        })
      ).toThrow('Chunk planning exceeded maximum allowed chunks');
    });
  });
});
