import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateChunkAiNotes,
  synthesizeSectionNotes,
  chunkGeneratedNotesSchema,
  synthesizedNotesSchema,
  AiClientError,
  type ChunkSummary,
} from '@/lib/ai-client';
import { registry } from '@/lib/metrics';

describe('AI Client Adapter — Chunk & Synthesis Endpoints', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const mockChunkText = 'In this section we explore PostgreSQL advisory locks and row-level locking.';
  const mockTitle = 'PostgreSQL High Concurrency Masterclass';
  const validServiceUrl = 'http://127.0.0.1:8000';
  const validSecret = 'valid-test-service-secret';

  const sampleChunkResponse = {
    overview: 'An in-depth look at concurrency controls in PostgreSQL.',
    keyConcepts: ['Advisory Locks', 'FOR UPDATE', 'Transaction Isolation'],
    detailedNotes: '# Concurrency Controls\n\nPostgreSQL supports explicit row locks.',
    shorthands: ['Use FOR UPDATE for serializing updates', 'Avoid unbounded timeouts'],
    usage: {
      promptTokens: 120,
      candidateTokens: 350,
      thoughtsTokens: 85,
      totalTokens: 555,
    },
    promptTokens: 120,
    candidateTokens: 350,
    thoughtsTokens: 85,
    totalTokens: 555,
  };

  const sampleSynthesizedResponse = {
    overview: 'A complete master guide to advanced PostgreSQL concurrency and transaction isolation.',
    keyConcepts: ['ACID Guarantees', 'MVCC Internals', 'Deadlock Avoidance'],
    tableOfContents: [
      '1. Introduction to MVCC',
      '2. Explicit Row Locks',
      '3. Advisory Locking Patterns',
      '4. Production Troubleshooting',
    ],
    shorthands: ['Always order table access symmetrically', 'Index foreign keys'],
    detailedNotes: '# Master PostgreSQL Guide\n\nComplete synthesized technical guide.',
    usage: {
      promptTokens: 450,
      candidateTokens: 800,
      thoughtsTokens: 210,
      totalTokens: 1460,
    },
    promptTokens: 450,
    candidateTokens: 800,
    thoughtsTokens: 210,
    totalTokens: 1460,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registry.resetMetrics();
    process.env = { ...originalEnv };
    process.env.FASTAPI_SERVICE_URL = validServiceUrl;
    process.env.FASTAPI_SERVICE_SECRET = validSecret;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  describe('generateChunkAiNotes()', () => {
    it('validates input parameters before making network request', async () => {
      // Empty chunkText
      await expect(generateChunkAiNotes('', mockTitle)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        isRetryable: false,
      });

      // Empty videoTitle
      await expect(generateChunkAiNotes(mockChunkText, '')).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        isRetryable: false,
      });

      // Negative chunkIndex
      await expect(generateChunkAiNotes(mockChunkText, mockTitle, -1, 5)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        isRetryable: false,
      });

      // totalChunks < 1
      await expect(generateChunkAiNotes(mockChunkText, mockTitle, 0, 0)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        isRetryable: false,
      });
    });

    it('sends POST to /api/v1/generate-chunk with correct headers and returns parsed notes with thoughtsTokens', async () => {
      let capturedUrl = '';
      let capturedMethod = '';
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: any = null;

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedMethod = init.method || 'GET';
        capturedHeaders = init.headers as Record<string, string>;
        capturedBody = JSON.parse(init.body as string);

        return new Response(JSON.stringify(sampleChunkResponse), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'x-request-id': 'server-trace-123',
          },
        });
      });

      const result = await generateChunkAiNotes(mockChunkText, mockTitle, 2, 5, {
        requestId: 'custom-chunk-req-001',
      });

      expect(capturedUrl).toBe('http://127.0.0.1:8000/api/v1/generate-chunk');
      expect(capturedMethod).toBe('POST');
      expect(capturedHeaders['Authorization']).toBe(`Bearer ${validSecret}`);
      expect(capturedHeaders['X-Request-ID']).toBe('custom-chunk-req-001');
      expect(capturedBody).toEqual({
        chunkText: mockChunkText,
        videoTitle: mockTitle,
        chunkIndex: 2,
        totalChunks: 5,
      });

      expect(result.overview).toBe(sampleChunkResponse.overview);
      expect(result.usage.thoughtsTokens).toBe(85);
      expect(result.usage.totalTokens).toBe(555);
      expect(result.thoughtsTokens).toBe(85);
    });

    it('handles HTTP 429 Rate Limiting with retryable error', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'RATE_LIMITED',
              message: 'Gemini quota exceeded. Please slow down.',
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      });

      await expect(generateChunkAiNotes(mockChunkText, mockTitle)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        isRetryable: true,
        statusCode: 429,
      });
    });

    it('handles malformed schema response from upstream', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        return new Response(JSON.stringify({ invalid: 'schema' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      await expect(generateChunkAiNotes(mockChunkText, mockTitle)).rejects.toMatchObject({
        code: 'MALFORMED_AI_OUTPUT',
        isRetryable: false,
      });
    });
  });

  describe('synthesizeSectionNotes()', () => {
    const sampleSummaries: ChunkSummary[] = [
      {
        chunkIndex: 0,
        overview: 'Overview of part 1',
        keyConcepts: ['Concept 1'],
        shorthands: ['Tip 1'],
      },
      {
        chunkIndex: 1,
        overview: 'Overview of part 2',
        keyConcepts: ['Concept 2'],
        shorthands: ['Tip 2'],
      },
    ];

    it('validates that chunkSummaries is non-empty', async () => {
      await expect(synthesizeSectionNotes([], mockTitle)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        isRetryable: false,
      });

      await expect(synthesizeSectionNotes(null as any, mockTitle)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        isRetryable: false,
      });
    });

    it('sends POST to /api/v1/synthesize and returns master synthesized guide', async () => {
      let capturedUrl = '';
      let capturedBody: any = null;

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body as string);

        return new Response(JSON.stringify(sampleSynthesizedResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const result = await synthesizeSectionNotes(sampleSummaries, mockTitle);

      expect(capturedUrl).toBe('http://127.0.0.1:8000/api/v1/synthesize');
      expect(capturedBody.videoTitle).toBe(mockTitle);
      expect(capturedBody.chunkSummaries).toHaveLength(2);

      expect(result.overview).toBe(sampleSynthesizedResponse.overview);
      expect(result.tableOfContents).toHaveLength(4);
      expect(result.usage.thoughtsTokens).toBe(210);
      expect(result.usage.totalTokens).toBe(1460);
    });
  });
});
