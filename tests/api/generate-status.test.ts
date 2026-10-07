import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/generate/status/route';
import * as db from '@/lib/db';
import * as auth from '@/lib/auth';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
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

describe('GET /api/generate/status', () => {
  const mockUserId = '123e4567-e89b-12d3-a456-426614174000';
  const testKey = 'idem-status-test-key';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.requireUser).mockResolvedValue({ id: mockUserId } as any);
  });

  it('should return 401 when user is not authenticated', async () => {
    vi.mocked(auth.requireUser).mockRejectedValueOnce(new auth.UnauthorizedError());

    const request = new Request(`http://localhost:3000/api/generate/status?key=${testKey}`);
    const response = await GET(request);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('should return 400 when key parameter is missing', async () => {
    const request = new Request('http://localhost:3000/api/generate/status');
    const response = await GET(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('parameter (key) is required');
  });

  it('should return 404 when generation record does not exist for user', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    const request = new Request(`http://localhost:3000/api/generate/status?key=${testKey}`);
    const response = await GET(request);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Generation record not found');
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [mockUserId, testKey]);
  });

  it('should return pending status when job is queued', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ status: 'pending', note_id: null, attempts: 0 }],
      rowCount: 1,
    } as any);

    const request = new Request(`http://localhost:3000/api/generate/status?key=${testKey}`);
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: 'pending' });
  });

  it('should return processing status with attempt count', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ status: 'processing', note_id: null, attempts: 2 }],
      rowCount: 1,
    } as any);

    const request = new Request(`http://localhost:3000/api/generate/status?key=${testKey}`);
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: 'processing', attempts: 2 });
  });

  it('should return completed status with noteId when done', async () => {
    const noteId = 'completed-uuid-888';
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ status: 'completed', note_id: noteId }],
      rowCount: 1,
    } as any);

    const request = new Request(`http://localhost:3000/api/generate/status?key=${testKey}`);
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      status: 'completed',
      noteId,
    });
  });

  it('should return failed status with safe error message and error code', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          status: 'failed',
          note_id: null,
          error_message: 'Captions are disabled or unavailable for this video.',
          error_code: 'NO_TRANSCRIPT',
        },
      ],
      rowCount: 1,
    } as any);

    const request = new Request(`http://localhost:3000/api/generate/status?key=${testKey}`);
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      status: 'failed',
      error: 'Captions are disabled or unavailable for this video.',
      code: 'NO_TRANSCRIPT',
    });
  });
});
