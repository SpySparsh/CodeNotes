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

import { extractVideoTitle, fetchTranscript, validateYouTubeUrl, TRANSCRIPT_TIMEOUT_MS } from '@/lib/transcript';
import { YoutubeTranscript } from 'youtube-transcript';

// ---------------------------------------------------------------------------
// validateYouTubeUrl
// ---------------------------------------------------------------------------
describe('validateYouTubeUrl', () => {
  it('accepts https://www.youtube.com/watch?v=12345678901', () => {
    expect(() => validateYouTubeUrl('https://www.youtube.com/watch?v=12345678901')).not.toThrow();
  });

  it('accepts https://youtube.com/watch?v=12345678901', () => {
    expect(() => validateYouTubeUrl('https://youtube.com/watch?v=12345678901')).not.toThrow();
  });

  it('accepts https://youtu.be/12345678901', () => {
    expect(() => validateYouTubeUrl('https://youtu.be/12345678901')).not.toThrow();
  });

  it('accepts YouTube Shorts URL', () => {
    expect(() => validateYouTubeUrl('https://www.youtube.com/shorts/12345678901')).not.toThrow();
  });

  it('accepts YouTube embed URL', () => {
    expect(() => validateYouTubeUrl('https://www.youtube.com/embed/12345678901')).not.toThrow();
  });

  it('rejects a non-YouTube hostname', () => {
    expect(() => validateYouTubeUrl('https://evil.com/watch?v=12345678901')).toThrow('Invalid YouTube URL');
  });

  it('rejects a URL that embeds youtube.com in a different hostname', () => {
    expect(() => validateYouTubeUrl('https://youtube.com.evil.com/watch?v=12345678901')).toThrow('Invalid YouTube URL');
  });

  it('rejects a vimeo URL', () => {
    expect(() => validateYouTubeUrl('https://vimeo.com/123456789')).toThrow('Invalid YouTube URL');
  });

  it('rejects a plain string that is not a URL', () => {
    expect(() => validateYouTubeUrl('not-a-url')).toThrow('Invalid YouTube URL');
  });

  it('rejects an empty string', () => {
    expect(() => validateYouTubeUrl('')).toThrow('Invalid YouTube URL');
  });
});

// ---------------------------------------------------------------------------
// fetchTranscript
// ---------------------------------------------------------------------------
describe('fetchTranscript behavior and bounded timeout', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('transcript succeeds before timeout', async () => {
    vi.mocked(YoutubeTranscript.fetchTranscript).mockResolvedValueOnce([
      { text: 'Hello', duration: 1, offset: 0 },
      { text: 'world', duration: 1, offset: 1 },
    ]);

    const result = await fetchTranscript('https://www.youtube.com/watch?v=12345678901');
    expect(result.text).toBe('Hello world');
    expect(result.videoId).toBe('12345678901');
    expect(YoutubeTranscript.fetchTranscript).toHaveBeenCalledWith('12345678901');
  });

  it('transcript parsing behavior remains unchanged with shorthand URL', async () => {
    vi.mocked(YoutubeTranscript.fetchTranscript).mockResolvedValueOnce([
      { text: 'TypeScript', duration: 2, offset: 0 },
      { text: 'Tutorial', duration: 2, offset: 2 },
    ]);

    const result = await fetchTranscript('https://youtu.be/12345678901');
    expect(result.text).toBe('TypeScript Tutorial');
    expect(result.videoId).toBe('12345678901');
  });

  it('rejects a non-YouTube URL with Invalid YouTube URL (before any network call)', async () => {
    await expect(fetchTranscript('https://example.com/not-youtube')).rejects.toThrow(
      'Invalid YouTube URL'
    );
    expect(YoutubeTranscript.fetchTranscript).not.toHaveBeenCalled();
  });

  it('transcript operation exceeds timeout and timeout error propagates correctly', async () => {
    vi.useFakeTimers();
    try {
      // Simulate hanging promise
      vi.mocked(YoutubeTranscript.fetchTranscript).mockImplementationOnce(() => new Promise(() => {}));

      const fetchPromise = fetchTranscript('https://www.youtube.com/watch?v=12345678901');

      // Fast-forward beyond the configured transcript timeout
      vi.advanceTimersByTime(TRANSCRIPT_TIMEOUT_MS + 100);

      await expect(fetchPromise).rejects.toThrow(
        'Failed to fetch video transcript: Operation timed out. Please try again.'
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// extractVideoTitle
// ---------------------------------------------------------------------------
describe('extractVideoTitle timeout and fallback behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns video title when noembed succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title: 'Learn TypeScript in 50 Minutes' }),
    } as any);

    const title = await extractVideoTitle('https://www.youtube.com/watch?v=12345678901');
    expect(title).toBe('Learn TypeScript in 50 Minutes');
  });

  it('uses encodeURIComponent when calling NoEmbed', async () => {
    const url = 'https://www.youtube.com/watch?v=12345678901';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title: 'Test Video' }),
    } as any);

    await extractVideoTitle(url);

    expect(fetchSpy).toHaveBeenCalledWith(
      `https://noembed.com/embed?url=${encodeURIComponent(url)}`,
      expect.anything()
    );
  });

  it('returns Unknown Video for a non-YouTube URL without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await extractVideoTitle('https://evil.com/watch?v=12345678901');
    expect(result).toBe('Unknown Video');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to "Unknown Video" when fetch times out or aborts', async () => {
    const abortError = new Error('The operation was aborted due to timeout');
    abortError.name = 'TimeoutError';
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortError);

    const title = await extractVideoTitle('https://www.youtube.com/watch?v=12345678901');
    expect(title).toBe('Unknown Video');
  });

  it('falls back to "Unknown Video" when response is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 504,
    } as any);

    const title = await extractVideoTitle('https://www.youtube.com/watch?v=12345678901');
    expect(title).toBe('Unknown Video');
  });
});
