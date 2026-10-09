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

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
}));

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

describe('POST /api/generate - Idempotency Key Payload Mismatch Protection', () => {
  const mockUserId = '123e4567-e89b-12d3-a456-426614174000';
  const sharedKey = 'reused-custom-idempotency-key';
  const videoAUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const videoBUrl = 'https://www.youtube.com/watch?v=9bZkp7q19f0';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.requireUser).mockResolvedValue({ id: mockUserId } as any);
  });

  it('rejects with HTTP 422 when same user and idempotency key are reused with a DIFFERENT video', async () => {
    // Mock DB record having video_id = 'dQw4w9WgXcQ' (Video A)
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          status: 'completed',
          video_id: 'dQw4w9WgXcQ',
          note_id: 'note-uuid-for-video-a',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      rowCount: 1,
    } as any);

    // Request submits Video B ('9bZkp7q19f0') with the same idempotency key
    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': sharedKey,
      },
      body: JSON.stringify({ url: videoBUrl }),
    });

    const response = await POST(request);
    expect(response.status).toBe(422);

    const body = await response.json();
    expect(body.error).toContain('Idempotency key already used for a different video');
    expect(body.code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');

    // Should NOT dispatch Inngest event
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('accepts and replays cached note when same user and idempotency key are submitted with the SAME video', async () => {
    const existingNoteId = 'note-uuid-for-video-a';

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          status: 'completed',
          video_id: 'dQw4w9WgXcQ',
          note_id: existingNoteId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      rowCount: 1,
    } as any);

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': sharedKey,
      },
      body: JSON.stringify({ url: videoAUrl }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('completed');
    expect(body.noteId).toBe(existingNoteId);
    expect(body.cached).toBe(true);
  });
});
