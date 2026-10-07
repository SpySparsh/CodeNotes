import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, DELETE } from '@/app/api/notes/[id]/route';
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

describe('GET /api/notes/[id]', () => {
  const mockUserId = 'user-123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 401 when user is unauthenticated', async () => {
    vi.mocked(auth.requireUser).mockRejectedValueOnce(new auth.UnauthorizedError());

    const request = new Request('http://localhost:3000/api/notes/note-uuid-1234');
    const response = await GET(request, { params: Promise.resolve({ id: 'note-uuid-1234' }) });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: 'Unauthorized' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('should return 200 with mapped note when note exists and is owned by user', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

    const mockRow = {
      id: 'note-uuid-1234',
      user_id: mockUserId,
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
      userId: mockUserId,
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

    expect(db.query).toHaveBeenCalledWith('SELECT * FROM notes WHERE id = $1 AND user_id = $2', [
      'note-uuid-1234',
      mockUserId,
    ]);
  });

  it('should return 404 when note is not found or owned by another user (IDOR protection)', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request('http://localhost:3000/api/notes/other-user-note-id');
    const response = await GET(request, { params: Promise.resolve({ id: 'other-user-note-id' }) });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: 'Note not found' });
  });

  it('should return 500 when database query throws an error', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);
    vi.mocked(db.query).mockRejectedValueOnce(new Error('Database timeout'));

    const request = new Request('http://localhost:3000/api/notes/note-uuid-1234');
    const response = await GET(request, { params: Promise.resolve({ id: 'note-uuid-1234' }) });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: 'Failed to fetch the note' });
  });
});

describe('DELETE /api/notes/[id]', () => {
  const mockUserId = 'user-123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 401 when user is unauthenticated', async () => {
    vi.mocked(auth.requireUser).mockRejectedValueOnce(new auth.UnauthorizedError());

    const request = new Request('http://localhost:3000/api/notes/note-uuid-1234', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'note-uuid-1234' }) });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: 'Unauthorized' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('should return 200 with success when deletion of user-owned note succeeds', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

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
    expect(db.query).toHaveBeenCalledWith('DELETE FROM notes WHERE id = $1 AND user_id = $2', [
      'note-uuid-1234',
      mockUserId,
    ]);
  });

  it('should return 404 when attempting to delete note owned by another user or non-existent', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'DELETE',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request('http://localhost:3000/api/notes/other-user-note-id', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'other-user-note-id' }) });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: 'Note not found' });
  });

  it('should return 500 when database deletion throws an error', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);
    vi.mocked(db.query).mockRejectedValueOnce(new Error('Foreign key violation'));

    const request = new Request('http://localhost:3000/api/notes/note-uuid-1234', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'note-uuid-1234' }) });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: 'Failed to delete the note' });
  });
});
