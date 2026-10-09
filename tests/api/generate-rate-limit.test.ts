import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
  fetchTranscript: vi.fn(),
}));

import { POST } from '@/app/api/generate/route';
import * as db from '@/lib/db';
import * as auth from '@/lib/auth';
import * as rateLimitModule from '@/lib/rate-limit';
import { inngest } from '@/inngest/client';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  withUserTransaction: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {
    constructor(msg = 'Unauthorized') {
      super(msg);
      this.name = 'UnauthorizedError';
    }
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('@/inngest/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/inngest/client')>();
  return {
    ...actual,
    inngest: {
      send: vi.fn().mockResolvedValue({ ids: ['inngest-test-evt-id'] }),
    },
  };
});

describe('POST /api/generate - Rate Limiting Integration', () => {
  const mockUserId = '123e4567-e89b-12d3-a456-426614174000';
  const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.requireUser).mockResolvedValue({ id: mockUserId } as any);
  });

  it('allows request when within rate limit and proceeds to queue generation', async () => {
    vi.mocked(rateLimitModule.checkRateLimit).mockResolvedValueOnce({
      allowed: true,
      limit: 5,
      remaining: 4,
      resetSeconds: 60,
      currentCount: 1,
    });

    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // idempotency check
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // insert pending

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: testUrl }),
    });

    const response = await POST(request);
    expect(response.status).toBe(202);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('pending');

    expect(rateLimitModule.checkRateLimit).toHaveBeenCalledWith({
      key: `generate:${mockUserId}`,
      limit: 5,
      windowSeconds: 60,
    });

    expect(inngest.send).toHaveBeenCalledTimes(1);
  });

  it('rejects with HTTP 429 when rate limit is exceeded', async () => {
    vi.mocked(rateLimitModule.checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      limit: 5,
      remaining: 0,
      resetSeconds: 42,
      currentCount: 6,
    });

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: testUrl }),
    });

    const response = await POST(request);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');

    const body = await response.json();
    expect(body).toEqual({
      error: 'Too many generation requests. Please try again later.',
    });

    // Verify no downstream DB idempotency check or Inngest event dispatch happened
    expect(db.query).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('does not check rate limit if request is unauthenticated (returns 401 first)', async () => {
    vi.mocked(auth.requireUser).mockRejectedValueOnce(new auth.UnauthorizedError());

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: testUrl }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(rateLimitModule.checkRateLimit).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('does not check rate limit if request body validation fails (returns 400 first)', async () => {
    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://not-youtube.com/video' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(rateLimitModule.checkRateLimit).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });
});
