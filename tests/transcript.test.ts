import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
  fetchTranscript: vi.fn(),
}));

import { extractVideoTitle } from '@/lib/transcript';

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
