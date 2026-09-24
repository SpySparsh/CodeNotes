import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/health/route';
import * as db from '@/lib/db';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
}));

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 with healthy status when DB is connected', async () => {
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
    expect(body.timestamp).toBeDefined();
    expect(db.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('should return 503 with unhealthy status when DB fails', async () => {
    vi.mocked(db.query).mockRejectedValueOnce(new Error('Connection refused'));

    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBeDefined();

    const body = await response.json();
    expect(body.status).toBe('unhealthy');
    expect(body.database).toBe('disconnected');
    expect(body.timestamp).toBeDefined();
    // Verify no raw internal error details are leaked
    expect((body as any).error).toBeUndefined();
    expect((body as any).errorMessage).toBeUndefined();
  });
});
