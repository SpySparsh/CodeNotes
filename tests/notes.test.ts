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
        video_url: 'https://www.youtube.com/watch?v=vid12345678',
        thumbnail_url: 'https://img.youtube.com/vi/vid12345678/maxresdefault.jpg',
        overview: 'A quick overview of TypeScript.',
        key_concepts: ['Types', 'Interfaces'],
        detailed_notes: '# TypeScript Basics\n```typescript\nconst x: number = 1;\n```',
        shorthands: ['Use strict mode'],
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
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0]).toEqual({
      id: '123e4567-e89b-12d3-a456-426614174000',
      videoId: 'vid12345678',
      videoTitle: 'Learn TypeScript in 10 Minutes',
      videoUrl: 'https://www.youtube.com/watch?v=vid12345678',
      thumbnailUrl: 'https://img.youtube.com/vi/vid12345678/maxresdefault.jpg',
      overview: 'A quick overview of TypeScript.',
      keyConcepts: ['Types', 'Interfaces'],
      detailedNotes: '# TypeScript Basics\n```typescript\nconst x: number = 1;\n```',
      shorthands: ['Use strict mode'],
      createdAt: '2026-09-23T10:00:00Z',
    });

    expect(db.query).toHaveBeenCalledWith('SELECT * FROM notes ORDER BY created_at DESC');
  });

  it('should return 500 when database query fails', async () => {
    vi.mocked(db.query).mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    const response = await GET();
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body).toEqual({ error: 'Failed to fetch notes' });
  });
});
