import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from '@/app/api/health/route';
import * as db from '@/lib/db';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
}));

describe('GET /api/health', () => {
  const originalCommitSha = process.env.VERCEL_GIT_COMMIT_SHA;
  const originalVercelEnv = process.env.VERCEL_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    if (originalCommitSha !== undefined) {
      process.env.VERCEL_GIT_COMMIT_SHA = originalCommitSha;
    } else {
      delete process.env.VERCEL_GIT_COMMIT_SHA;
    }

    if (originalVercelEnv !== undefined) {
      process.env.VERCEL_ENV = originalVercelEnv;
    } else {
      delete process.env.VERCEL_ENV;
    }
  });

  it('should return 200 with healthy status and null metadata when Vercel env vars are not set', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ '?column?': 1 }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request('http://localhost:3000/api/health', {
      headers: { 'x-request-id': 'custom-req-123' },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('custom-req-123');

    const body = await response.json();
    expect(body.status).toBe('healthy');
    expect(body.database).toBe('connected');
    expect(body.commit).toBeNull();
    expect(body.environment).toBeNull();
    expect(body.timestamp).toBeDefined();
    expect(db.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('should return 200 with commit and environment metadata when Vercel env vars are configured', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'ec313384d2cdfa2b21a93f621829e16790c125b6';
    process.env.VERCEL_ENV = 'production';

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ '?column?': 1 }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('healthy');
    expect(body.database).toBe('connected');
    expect(body.commit).toBe('ec313384d2cdfa2b21a93f621829e16790c125b6');
    expect(body.environment).toBe('production');
    expect(body.timestamp).toBeDefined();
  });

  it('should treat blank or whitespace-only metadata env vars as null', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = '   ';
    process.env.VERCEL_ENV = '';

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ '?column?': 1 }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.commit).toBeNull();
    expect(body.environment).toBeNull();
  });

  it('should return 503 with unhealthy status and metadata when DB fails', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'test-commit-sha';
    process.env.VERCEL_ENV = 'preview';

    vi.mocked(db.query).mockRejectedValueOnce(new Error('Connection refused'));

    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBeDefined();

    const body = await response.json();
    expect(body.status).toBe('unhealthy');
    expect(body.database).toBe('disconnected');
    expect(body.commit).toBe('test-commit-sha');
    expect(body.environment).toBe('preview');
    expect(body.timestamp).toBeDefined();
    // Verify no raw internal error details, credentials or connection strings are leaked
    expect((body as any).error).toBeUndefined();
    expect((body as any).errorMessage).toBeUndefined();
  });
});
