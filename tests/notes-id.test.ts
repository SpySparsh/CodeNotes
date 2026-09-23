import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, DELETE } from '@/app/api/notes/[id]/route';
import * as db from '@/lib/db';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
}));

describe('GET /api/notes/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 with mapped note when note exists', async () => {
    const mockRow = {
      id: 'note-uuid-1234',
      video_id: 'vid12345678',
      video_title: 'Full Stack Guide',
      video_url: 'https://www.youtube.com/watch?v=vid12345678',
      thumbnail_url: 'https://img.youtube.com/vi/vid12345678/maxresdefault.jpg',
      overview: 'Comprehensive guide to full stack web development.',
      key_concepts: ['Frontend', 'Backend', 'Database'],
      detailed_notes: '## Topics\nDetailed content goes here.',
      shorthands: ['Use ORMs wisely'],
      created_at: '2026-09-23T12:00:00Z',
    };

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [mockRow],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request('http://localhost:3000/api/notes/note-uuid-1234');
    const response = await GET(request, { params: Promise.resolve({ id: 'note-uuid-1234' }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.note).toEqual({
      id: 'note-uuid-1234',
      videoId: 'vid12345678',
      videoTitle: 'Full Stack Guide',
      videoUrl: 'https://www.youtube.com/watch?v=vid12345678',
      thumbnailUrl: 'https://img.youtube.com/vi/vid12345678/maxresdefault.jpg',
      overview: 'Comprehensive guide to full stack web development.',
      keyConcepts: ['Frontend', 'Backend', 'Database'],
      detailedNotes: '## Topics\nDetailed content goes here.',
      shorthands: ['Use ORMs wisely'],
      createdAt: '2026-09-23T12:00:00Z',
    });

    expect(db.query).toHaveBeenCalledWith('SELECT * FROM notes WHERE id = $1', ['note-uuid-1234']);
  });

  it('should return 404 when note is not found', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request('http://localhost:3000/api/notes/non-existent-id');
    const response = await GET(request, { params: Promise.resolve({ id: 'non-existent-id' }) });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: 'Note not found' });
  });

  it('should return 500 when database query throws an error', async () => {
    vi.mocked(db.query).mockRejectedValueOnce(new Error('Database timeout'));

    const request = new Request('http://localhost:3000/api/notes/note-uuid-1234');
    const response = await GET(request, { params: Promise.resolve({ id: 'note-uuid-1234' }) });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: 'Failed to fetch the note' });
  });
});

describe('DELETE /api/notes/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 with success when deletion succeeds', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
      command: 'DELETE',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request('http://localhost:3000/api/notes/note-uuid-1234', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'note-uuid-1234' }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true });
    expect(db.query).toHaveBeenCalledWith('DELETE FROM notes WHERE id = $1', ['note-uuid-1234']);
  });

  it('should return 500 when database deletion throws an error', async () => {
    vi.mocked(db.query).mockRejectedValueOnce(new Error('Foreign key violation'));

    const request = new Request('http://localhost:3000/api/notes/note-uuid-1234', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'note-uuid-1234' }) });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: 'Failed to delete the note' });
  });
});
