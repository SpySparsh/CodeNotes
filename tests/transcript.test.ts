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
// C. Provider Hierarchy & Fallback (acquireTranscript)
// ---------------------------------------------------------------------------
describe('C. Provider Hierarchy & Fallback', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv, SUPADATA_API_KEY: 'test-supadata-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses Supadata as primary provider and does NOT call youtube-transcript when Supadata succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'Supadata transcript text' }] }),
    } as any);

    const result = await acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(result.provider).toBe('supadata');
    expect(result.text).toBe('Supadata transcript text');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(YoutubeTranscript.fetchTranscript).not.toHaveBeenCalled();
  });

  it('raises non-retriable error and does NOT silently fall back when SUPADATA_API_KEY is missing', async () => {
    delete process.env.SUPADATA_API_KEY;

    await expect(
      acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_PROVIDER_AUTH_ERROR',
      isRetryable: false,
    });

    expect(YoutubeTranscript.fetchTranscript).not.toHaveBeenCalled();
  });

  it('raises non-retriable auth error when Supadata returns 401/403 without silent fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Invalid API Key',
    } as any);

    await expect(
      acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_PROVIDER_AUTH_ERROR',
      isRetryable: false,
    });

    expect(YoutubeTranscript.fetchTranscript).not.toHaveBeenCalled();
  });

  it('falls back to youtube-transcript when Supadata encounters a transient server error', async () => {
    // Supadata fails with 500
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as any);

    // Scraper succeeds
    vi.mocked(YoutubeTranscript.fetchTranscript).mockResolvedValueOnce([
      { text: 'Fallback scraper text', duration: 1, offset: 0 },
    ]);

    const result = await acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(result.provider).toBe('youtube-transcript');
    expect(result.text).toBe('Fallback scraper text');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(YoutubeTranscript.fetchTranscript).toHaveBeenCalledWith('dQw4w9WgXcQ');
  });

  it('falls back to youtube-transcript when Supadata encounters rate limiting (429)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limit exceeded',
    } as any);

    vi.mocked(YoutubeTranscript.fetchTranscript).mockResolvedValueOnce([
      { text: 'Fallback scraper text on rate limit', duration: 1, offset: 0 },
    ]);

    const result = await acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(result.provider).toBe('youtube-transcript');
    expect(result.text).toBe('Fallback scraper text on rate limit');
    expect(YoutubeTranscript.fetchTranscript).toHaveBeenCalledWith('dQw4w9WgXcQ');
  });

  it('throws TRANSCRIPT_UNAVAILABLE when both Supadata and youtube-transcript fail', async () => {
    // Supadata fails with 404
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    } as any);

    // Scraper fails
    vi.mocked(YoutubeTranscript.fetchTranscript).mockRejectedValueOnce(
      new Error('Could not find captions for video')
    );

    await expect(
      acquireTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      isRetryable: false,
    });
  });

  it('fetchTranscript backward compatibility function returns text and videoId', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: 'Compatibility test' }] }),
    } as any);

    const result = await fetchTranscript('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result.text).toBe('Compatibility test');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
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
