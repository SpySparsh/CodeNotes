import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
  fetchTranscript: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/db', () => {
  const queryFn = vi.fn();
  return {
    query: queryFn,
    getPool: vi.fn(),
    withTransaction: vi.fn(),
    withUserTransaction: vi.fn(),
  };
});

import {
  extractVideoTitle,
  fetchTranscript,
  acquireTranscript,
  validateYouTubeUrl,
  canonicalizeYouTubeUrl,
  extractVideoId,
  fetchSupadataTranscript,
  normalizeSupadataResponse,
  TranscriptError,
  TRANSCRIPT_TIMEOUT_MS,
} from '@/lib/transcript';
import { YoutubeTranscript } from 'youtube-transcript';
import * as db from '@/lib/db';
import { registry } from '@/lib/metrics';

// ---------------------------------------------------------------------------
// A. Canonicalization & URL Handling
// ---------------------------------------------------------------------------
describe('A. Canonicalization & URL Handling', () => {
  it('canonicalizes standard watch URL', () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    expect(canonicalizeYouTubeUrl(url)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(extractVideoId(url)).toBe('dQw4w9WgXcQ');
  });

  it('canonicalizes URL with timestamps and tracking parameters', () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120s&feature=share&si=test1234';
    expect(canonicalizeYouTubeUrl(url)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(extractVideoId(url)).toBe('dQw4w9WgXcQ');
  });

  it('canonicalizes youtu.be short URL', () => {
    const url = 'https://youtu.be/dQw4w9WgXcQ?t=45';
    expect(canonicalizeYouTubeUrl(url)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(extractVideoId(url)).toBe('dQw4w9WgXcQ');
  });

  it('canonicalizes YouTube Shorts URL', () => {
    const url = 'https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share';
    expect(canonicalizeYouTubeUrl(url)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(extractVideoId(url)).toBe('dQw4w9WgXcQ');
  });

  it('canonicalizes YouTube embed URL', () => {
    const url = 'https://www.youtube.com/embed/dQw4w9WgXcQ';
    expect(canonicalizeYouTubeUrl(url)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(extractVideoId(url)).toBe('dQw4w9WgXcQ');
  });

  it('rejects invalid or non-YouTube URLs', () => {
    expect(() => validateYouTubeUrl('https://evil.com/watch?v=dQw4w9WgXcQ')).toThrow();
    expect(() => canonicalizeYouTubeUrl('https://evil.com/watch?v=dQw4w9WgXcQ')).toThrow();
    expect(() => validateYouTubeUrl('not-a-url')).toThrow();
    expect(() => validateYouTubeUrl('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// B. Supadata Client & Normalization
// ---------------------------------------------------------------------------
describe('B. Supadata Client & Normalization', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv, SUPADATA_API_KEY: 'test-supadata-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('normalizes various Supadata response structures', () => {
    // Array of segment objects with text
    expect(
      normalizeSupadataResponse({
        content: [
          { text: 'Hello', start: 0, duration: 1 },
          { text: 'world', start: 1, duration: 1 },
        ],
      })
    ).toBe('Hello world');

    // Plain text content
    expect(normalizeSupadataResponse({ content: 'Direct content string' })).toBe('Direct content string');

    // Transcript key
    expect(
      normalizeSupadataResponse({
        transcript: [{ text: 'TypeScript' }, { text: 'Inngest' }],
      })
    ).toBe('TypeScript Inngest');

    // Array at root
    expect(normalizeSupadataResponse([{ text: 'Root' }, { text: 'Array' }])).toBe('Root Array');

    // Empty or malformed inputs
    expect(normalizeSupadataResponse({})).toBe('');
    expect(normalizeSupadataResponse(null)).toBe('');
    expect(normalizeSupadataResponse({ content: [] })).toBe('');
  });

  it('fetches and normalizes transcript successfully on 200 OK', async () => {
    const mockData = {
      content: [
        { text: 'Welcome to the CodeNotes tutorial.' },
        { text: 'We build durable workflows.' },
      ],
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    } as any);

    const result = await fetchSupadataTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result.text).toBe('Welcome to the CodeNotes tutorial. We build durable workflows.');
    expect(result.videoId).toBe('dQw4w9WgXcQ');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.supadata.ai/v1/transcript?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'test-supadata-key',
        }),
      })
    );
  });

  it('throws TRANSCRIPT_PROVIDER_AUTH_ERROR when SUPADATA_API_KEY is missing', async () => {
    delete process.env.SUPADATA_API_KEY;

    await expect(
      fetchSupadataTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_PROVIDER_AUTH_ERROR',
      isRetryable: false,
    });
  });

  it('throws TRANSCRIPT_PROVIDER_AUTH_ERROR on 401/403', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as any);

    await expect(
      fetchSupadataTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_PROVIDER_AUTH_ERROR',
      isRetryable: false,
    });
  });

  it('throws TRANSCRIPT_UNAVAILABLE on 404 (no captions)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Transcript not found for this video',
    } as any);

    await expect(
      fetchSupadataTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      isRetryable: false,
    });
  });

  it('throws TRANSCRIPT_PROVIDER_QUOTA_EXCEEDED on 429 with quota message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Monthly credit quota limit reached',
    } as any);

    await expect(
      fetchSupadataTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_PROVIDER_QUOTA_EXCEEDED',
      isRetryable: false,
    });
  });

  it('throws TRANSCRIPT_PROVIDER_RATE_LIMITED on 429 without quota message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limit exceeded, try again in 5 seconds',
    } as any);

    await expect(
      fetchSupadataTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_PROVIDER_RATE_LIMITED',
      isRetryable: true,
    });
  });

  it('throws TRANSCRIPT_PROVIDER_UNAVAILABLE on 500 server error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    } as any);

    await expect(
      fetchSupadataTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_PROVIDER_UNAVAILABLE',
      isRetryable: true,
    });
  });

  it('throws TRANSCRIPT_INVALID_RESPONSE on empty content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [] }),
    } as any);

    await expect(
      fetchSupadataTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_INVALID_RESPONSE',
      isRetryable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// C. Shared PostgreSQL Transcript Cache & Provider Hierarchy
// ---------------------------------------------------------------------------
describe('C. Shared PostgreSQL Transcript Cache & Provider Hierarchy', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    registry.resetMetrics();
    process.env = { ...originalEnv, SUPADATA_API_KEY: 'test-supadata-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('1. CACHE HIT: returns cached transcript without calling Supadata or youtube-transcript', async () => {
    // Mock DB select returns cached row
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          transcript_text: 'Cached transcript from PostgreSQL cache',
          language: 'en',
          provider: 'supadata',
        },
      ],
      rowCount: 1,
    } as any);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(result.text).toBe('Cached transcript from PostgreSQL cache');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(result.provider).toBe('supadata');
    expect(result.cached).toBe(true);

    // Verify neither external provider was called
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(YoutubeTranscript.fetchTranscript).not.toHaveBeenCalled();

    // Verify metrics: cache_hit recorded, no provider duration recorded
    const metricsText = await registry.metrics();
    expect(metricsText).toContain('codenotes_transcript_requests_total{source="cache_hit",status="success"} 1');
    expect(metricsText).not.toContain('codenotes_transcript_duration_seconds_count');
  });

  it('2. CACHE MISS: calls Supadata, normalizes, writes to cache with ON CONFLICT, and returns transcript', async () => {
    // 1. Cache select returns 0 rows (MISS)
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    // 2. Supadata API responds successfully
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'Fresh Supadata transcript text' }] }),
    } as any);

    // 3. Cache insert succeeds
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

    const result = await acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(result.text).toBe('Fresh Supadata transcript text');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(result.provider).toBe('supadata');
    expect(result.cached).toBe(false);

    // Verify DB insert query format
    const insertCall = vi.mocked(db.query).mock.calls.find((call) =>
      call[0].includes('INSERT INTO youtube_transcripts')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toContain('ON CONFLICT (video_id) DO NOTHING');
    expect(insertCall![1]).toEqual(['dQw4w9WgXcQ', 'Fresh Supadata transcript text', null, 'supadata']);

    // Verify metrics: supadata success and duration
    const metricsText = await registry.metrics();
    expect(metricsText).toContain('codenotes_transcript_requests_total{source="supadata",status="success"} 1');
    expect(metricsText).toContain('codenotes_transcript_duration_seconds_count{provider="supadata"} 1');
    expect(metricsText).not.toContain('provider="youtube_transcript"');
  });

  it('3. CACHE READ ERROR: fail-open bypasses cache error and continues with provider acquisition', async () => {
    // 1. Cache select throws database connection error
    vi.mocked(db.query).mockRejectedValueOnce(new Error('PostgreSQL connection timeout'));

    // 2. Supadata API responds successfully
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'Transcript after read error' }] }),
    } as any);

    // 3. Cache insert succeeds
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

    const result = await acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(result.text).toBe('Transcript after read error');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(result.provider).toBe('supadata');
  });

  it('4. CACHE WRITE ERROR: fail-open logs error and returns transcript without failing generation', async () => {
    // 1. Cache select returns 0 rows (MISS)
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    // 2. Supadata responds successfully
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'Transcript with write error' }] }),
    } as any);

    // 3. Cache insert fails
    vi.mocked(db.query).mockRejectedValueOnce(new Error('PostgreSQL disk full'));

    const result = await acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(result.text).toBe('Transcript with write error');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(result.provider).toBe('supadata');
  });

  it('5. CONCURRENT INSERT / RACE: handles simulated concurrent insert safely with ON CONFLICT', async () => {
    // Cache miss
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    // Supadata succeeds
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'Concurrent race transcript' }] }),
    } as any);

    // Insert returns rowCount 0 because another concurrent execution already inserted
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    const result = await acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(result.text).toBe('Concurrent race transcript');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
  });

  it('6. URL VARIANTS: timestamped and short URLs resolve to same video_id and query cache with that key', async () => {
    // Cache HIT for youtu.be/dQw4w9WgXcQ?t=100
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          transcript_text: 'Cached content for canonicalized short URL',
          language: 'en',
          provider: 'supadata',
        },
      ],
      rowCount: 1,
    } as any);

    const result = await acquireTranscript('https://youtu.be/dQw4w9WgXcQ?t=100');

    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(result.text).toBe('Cached content for canonicalized short URL');

    const selectCall = vi.mocked(db.query).mock.calls[0];
    expect(selectCall[1]).toEqual(['dQw4w9WgXcQ']);
  });

  it('7. PROVIDER FALLBACK: cache miss -> Supadata fails -> youtube-transcript succeeds -> cached with provider=youtube-transcript', async () => {
    // 1. Cache miss
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    // 2. Supadata fails with 500
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as any);

    // 3. Fallback scraper succeeds
    vi.mocked(YoutubeTranscript.fetchTranscript).mockResolvedValueOnce([
      { text: 'Fallback scraper text', duration: 1, offset: 0 },
    ]);

    // 4. Cache insert
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

    const result = await acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(result.provider).toBe('youtube-transcript');
    expect(result.text).toBe('Fallback scraper text');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(YoutubeTranscript.fetchTranscript).toHaveBeenCalledWith('dQw4w9WgXcQ');

    const insertCall = vi.mocked(db.query).mock.calls.find((call) =>
      call[0].includes('INSERT INTO youtube_transcripts')
    );
    expect(insertCall![1]).toEqual(['dQw4w9WgXcQ', 'Fallback scraper text', null, 'youtube-transcript']);

    // Verify metrics: both supadata/error and youtube_transcript_fallback/success are recorded
    const metricsText = await registry.metrics();
    expect(metricsText).toContain('codenotes_transcript_requests_total{source="supadata",status="error"} 1');
    expect(metricsText).toContain('codenotes_transcript_requests_total{source="youtube_transcript_fallback",status="success"} 1');
    expect(metricsText).toContain('codenotes_transcript_duration_seconds_count{provider="supadata"} 1');
    expect(metricsText).toContain('codenotes_transcript_duration_seconds_count{provider="youtube_transcript"} 1');
  });

  it('8. TERMINAL FAILURE: cache miss -> both providers fail -> throws clean TRANSCRIPT_UNAVAILABLE', async () => {
    // 1. Cache miss
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    // 2. Supadata fails with 404
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    } as any);

    // 3. Scraper fails
    vi.mocked(YoutubeTranscript.fetchTranscript).mockRejectedValueOnce(
      new Error('Could not find captions for video')
    );

    await expect(
      acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      isRetryable: false,
    });

    // Verify metrics: both primary failure and fallback failure recorded
    const metricsText = await registry.metrics();
    expect(metricsText).toContain('codenotes_transcript_requests_total{source="supadata",status="error"} 1');
    expect(metricsText).toContain('codenotes_transcript_requests_total{source="youtube_transcript_fallback",status="error"} 1');
    expect(metricsText).toContain('codenotes_transcript_duration_seconds_count{provider="supadata"} 1');
    expect(metricsText).toContain('codenotes_transcript_duration_seconds_count{provider="youtube_transcript"} 1');
  });

  it('raises non-retriable error and does NOT silently fall back when SUPADATA_API_KEY is missing on cache miss', async () => {
    delete process.env.SUPADATA_API_KEY;

    // Cache miss
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    await expect(
      acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_PROVIDER_AUTH_ERROR',
      isRetryable: false,
    });

    expect(YoutubeTranscript.fetchTranscript).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// extractVideoTitle
// ---------------------------------------------------------------------------
describe('extractVideoTitle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns video title when noembed succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title: 'Learn TypeScript in 50 Minutes' }),
    } as any);

    const title = await extractVideoTitle('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(title).toBe('Learn TypeScript in 50 Minutes');
  });

  it('falls back to "Unknown Video" when fetch fails or URL is invalid', async () => {
    const resultInvalid = await extractVideoTitle('https://evil.com/video');
    expect(resultInvalid).toBe('Unknown Video');

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));
    const resultNetwork = await extractVideoTitle('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(resultNetwork).toBe('Unknown Video');
  });
});
