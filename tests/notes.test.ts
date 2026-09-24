import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/notes/route';
import * as db from '@/lib/db';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
}));

describe('GET /api/notes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 with mapped camelCase notes on success', async () => {
    const mockDbRows = [
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        video_id: 'vid12345678',
        video_title: 'Learn TypeScript in 10 Minutes',
        thumbnail_url: 'https://img.youtube.com/vi/vid12345678/maxresdefault.jpg',
        overview: 'A quick overview of TypeScript.',
        created_at: '2026-09-23T10:00:00Z',
      },
    ];

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: mockDbRows,
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0]).toEqual({
      id: '123e4567-e89b-12d3-a456-426614174000',
      videoId: 'vid12345678',
      videoTitle: 'Learn TypeScript in 10 Minutes',
      thumbnailUrl: 'https://img.youtube.com/vi/vid12345678/maxresdefault.jpg',
      overview: 'A quick overview of TypeScript.',
      createdAt: '2026-09-23T10:00:00Z',
    });

    expect(db.query).toHaveBeenCalledWith(
      'SELECT id, video_id, video_title, thumbnail_url, overview, created_at FROM notes ORDER BY created_at DESC LIMIT $1',
      [200]
    );
  });

  it('should return 500 when database query fails', async () => {
    vi.mocked(db.query).mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    const response = await GET();
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body).toEqual({ error: 'Failed to fetch notes' });
  });
});
