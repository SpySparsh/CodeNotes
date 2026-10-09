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
import { inngest } from '@/inngest/client';

vi.mock('@/lib/db', () => {
  const queryFn = vi.fn();
  return {
    query: queryFn,
    withUserTransaction: vi.fn(),
  };
});

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    limit: 5,
    remaining: 4,
    resetSeconds: 60,
    currentCount: 1,
  }),
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

vi.mock('@/inngest/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/inngest/client')>();
  return {
    ...actual,
    inngest: {
      send: vi.fn().mockResolvedValue({ ids: ['inngest-test-evt-id'] }),
    },
  };
});

describe('POST /api/generate (Asynchronous Inngest Flow)', () => {
  const mockUserId = '123e4567-e89b-12d3-a456-426614174000';
  const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.requireUser).mockResolvedValue({ id: mockUserId } as any);
  });

  it('should return 401 when user is unauthenticated', async () => {
    vi.mocked(auth.requireUser).mockRejectedValueOnce(new auth.UnauthorizedError());

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: testUrl }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body).toEqual({ error: 'Unauthorized' });
    expect(db.query).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('should return 400 when url is missing from request body', async () => {
    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBeDefined();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('should return 400 when url is not a valid YouTube domain', async () => {
    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://vimeo.com/12345678' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toContain('valid YouTube video URL');
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('should return 202 Accepted and dispatch Inngest event for a new generation request', async () => {
    // 1. Check existing: no rows
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    // 2. Insert pending row
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

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
    expect(body.jobId).toBeDefined();
    expect(body.idempotencyKey).toBeDefined();

    expect(inngest.send).toHaveBeenCalledTimes(1);
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'notes/generate.requested',
      id: body.jobId,
      data: {
        userId: mockUserId,
        idempotencyKey: body.idempotencyKey,
        videoId: 'dQw4w9WgXcQ',
        videoUrl: testUrl,
      },
    });
  });

  it('should return 200 OK with cached noteId when generation was already completed', async () => {
    const completedNoteId = 'completed-uuid-555';

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          status: 'completed',
          note_id: completedNoteId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      rowCount: 1,
    } as any);

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: testUrl }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('completed');
    expect(body.noteId).toBe(completedNoteId);
    expect(body.cached).toBe(true);

    // Should NOT send Inngest event
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('should return 202 Accepted when a generation is already in progress', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          status: 'processing',
          note_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      rowCount: 1,
    } as any);

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: testUrl }),
    });

    const response = await POST(request);
    expect(response.status).toBe(202);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('processing');
    expect(body.message).toBe('Generation already in progress');

    // Should NOT create duplicate event send
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('should reclaim and re-send Inngest event for stale generation jobs (> 120s)', async () => {
    const staleDate = new Date(Date.now() - 150000).toISOString();

    // 1. Initial check returns stale processing row
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          status: 'processing',
          note_id: null,
          created_at: staleDate,
          updated_at: staleDate,
        },
      ],
      rowCount: 1,
    } as any);

    // 2. DB update to pending
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

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
    expect(body.message).toContain('Stale generation recovered');

    expect(inngest.send).toHaveBeenCalledTimes(1);
  });

  it('should retain durable DB pending row and return 202 if Inngest send encounters transient error', async () => {
    // 1. Check existing: no rows
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    // 2. Insert pending row
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

    // Mock Inngest send network failure
    vi.mocked(inngest.send).mockRejectedValueOnce(
      new Error('Inngest connection error')
    );

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
    expect(body.idempotencyKey).toBeDefined();

    // Verify delete query was NOT executed (pending record is preserved in DB for cron reconciliation)
    const deleteCall = vi.mocked(db.query).mock.calls.find((call) =>
      call[0].includes('DELETE FROM generation_idempotency')
    );
    expect(deleteCall).toBeUndefined();
  });
});
