import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
  fetchTranscript: vi.fn(),
}));

import { extractVideoTitle, fetchTranscript, TRANSCRIPT_TIMEOUT_MS } from '@/lib/transcript';
import { YoutubeTranscript } from 'youtube-transcript';

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

  it('throws for invalid YouTube URL', async () => {
    await expect(fetchTranscript('https://example.com/not-youtube')).rejects.toThrow(
      'Failed to fetch video transcript. The video might not have captions enabled.'
    );
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
