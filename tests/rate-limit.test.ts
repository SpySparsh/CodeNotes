import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkRateLimit } from '@/lib/rate-limit';
import * as db from '@/lib/db';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('PostgreSQL-backed Rate Limiter (checkRateLimit)', () => {
  const testKey = 'generate:user_123e4567';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // disable opportunistic cleanup by default in unit tests
  });

  it('allows the first request within the window (count = 1)', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ count: 1 }],
      rowCount: 1,
    } as any);

    const result = await checkRateLimit({
      key: testKey,
      limit: 5,
      windowSeconds: 60,
    });

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(5);
    expect(result.remaining).toBe(4);
    expect(result.currentCount).toBe(1);
    expect(result.resetSeconds).toBeGreaterThan(0);
    expect(result.resetSeconds).toBeLessThanOrEqual(60);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.query).mock.calls[0][0]).toContain('INSERT INTO rate_limit_buckets');
    expect(vi.mocked(db.query).mock.calls[0][0]).toContain('ON CONFLICT (key, window_start) DO UPDATE');
  });

  it('allows requests within the limit (counts 2 to 5)', async () => {
    for (let currentCount = 2; currentCount <= 5; currentCount++) {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ count: currentCount }],
        rowCount: 1,
      } as any);

      const result = await checkRateLimit({
        key: testKey,
        limit: 5,
        windowSeconds: 60,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5 - currentCount);
      expect(result.currentCount).toBe(currentCount);
    }
  });

  it('rejects requests beyond the limit (count >= 6)', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ count: 6 }],
      rowCount: 1,
    } as any);

    const result = await checkRateLimit({
      key: testKey,
      limit: 5,
      windowSeconds: 60,
    });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.currentCount).toBe(6);
    expect(result.resetSeconds).toBeGreaterThan(0);
  });

  it('maintains independent rate limits for different user keys', async () => {
    const userAKey = 'generate:user_A';
    const userBKey = 'generate:user_B';

    // User A at count 5 (allowed)
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ count: 5 }],
      rowCount: 1,
    } as any);

    // User B at count 1 (allowed)
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ count: 1 }],
      rowCount: 1,
    } as any);

    const resA = await checkRateLimit({ key: userAKey, limit: 5, windowSeconds: 60 });
    const resB = await checkRateLimit({ key: userBKey, limit: 5, windowSeconds: 60 });

    expect(resA.allowed).toBe(true);
    expect(resA.remaining).toBe(0);

    expect(resB.allowed).toBe(true);
    expect(resB.remaining).toBe(4);

    expect(vi.mocked(db.query).mock.calls[0][1]?.[0]).toBe(userAKey);
    expect(vi.mocked(db.query).mock.calls[1][1]?.[0]).toBe(userBKey);
  });

  it('resets count when a new window start is used', async () => {
    // Window 1: count 6 (rejected)
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ count: 6 }],
      rowCount: 1,
    } as any);

    const res1 = await checkRateLimit({ key: testKey, limit: 5, windowSeconds: 60 });
    expect(res1.allowed).toBe(false);

    // Window 2: new window start timestamp returns count 1 (allowed)
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ count: 1 }],
      rowCount: 1,
    } as any);

    const res2 = await checkRateLimit({ key: testKey, limit: 5, windowSeconds: 60 });
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(4);
  });

  it('fails open if database encounters a transient error', async () => {
    vi.mocked(db.query).mockRejectedValueOnce(new Error('PostgreSQL connection timeout'));

    const result = await checkRateLimit({
      key: testKey,
      limit: 5,
      windowSeconds: 60,
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.currentCount).toBe(1);
  });

  it('triggers opportunistic stale bucket cleanup when sampled', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01); // trigger sampling (< 0.05)

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ count: 1 }],
      rowCount: 1,
    } as any);
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any); // cleanup query

    await checkRateLimit({
      key: testKey,
      limit: 5,
      windowSeconds: 60,
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(vi.mocked(db.query).mock.calls[1][0]).toContain('DELETE FROM rate_limit_buckets WHERE expires_at < NOW()');
  });
});
