import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getNoteById, DELETE as deleteNoteById } from '@/app/api/notes/[id]/route';
import { GET as getNotesList } from '@/app/api/notes/route';
import * as db from '@/lib/db';
import * as auth from '@/lib/auth';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  withUserTransaction: vi.fn(),
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

describe('User Isolation & IDOR Protection (User A vs User B)', () => {
  const USER_A_ID = '11111111-1111-1111-1111-111111111111';
  const USER_B_ID = '22222222-2222-2222-2222-222222222222';
  const NOTE_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  const NOTE_A_RECORD = {
    id: NOTE_A_ID,
    user_id: USER_A_ID,
    video_id: 'vid12345678',
    video_title: 'User A Secret Tech Note',
    video_url: 'https://www.youtube.com/watch?v=vid12345678',
    thumbnail_url: null,
    overview: 'Confidential study notes belonging to User A.',
    key_concepts: ['Architecture', 'Security'],
    detailed_notes: '# Notes\nPrivate to User A',
    shorthands: ['Do not leak'],
    created_at: '2026-03-01T10:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('User A can successfully retrieve their own note (GET /api/notes/[id])', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: USER_A_ID } as any);

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [NOTE_A_RECORD],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request(`http://localhost:3000/api/notes/${NOTE_A_ID}`);
    const response = await getNoteById(request, { params: Promise.resolve({ id: NOTE_A_ID }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.note.id).toBe(NOTE_A_ID);
    expect(body.note.userId).toBe(USER_A_ID);
    expect(db.query).toHaveBeenCalledWith('SELECT * FROM notes WHERE id = $1 AND user_id = $2', [
      NOTE_A_ID,
      USER_A_ID,
    ]);
  });

  it('User B is denied access when attempting to retrieve User A note (GET /api/notes/[id] -> 404)', async () => {
    // User B is authenticated
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: USER_B_ID } as any);

    // Database query with user_id = USER_B_ID returns 0 rows because note belongs to USER_A_ID
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request(`http://localhost:3000/api/notes/${NOTE_A_ID}`);
    const response = await getNoteById(request, { params: Promise.resolve({ id: NOTE_A_ID }) });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: 'Note not found' });
    expect(db.query).toHaveBeenCalledWith('SELECT * FROM notes WHERE id = $1 AND user_id = $2', [
      NOTE_A_ID,
      USER_B_ID,
    ]);
  });

  it('User B is denied from deleting User A note (DELETE /api/notes/[id] -> 404)', async () => {
    // User B is authenticated
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: USER_B_ID } as any);

    // Database delete returns rowCount = 0
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'DELETE',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request(`http://localhost:3000/api/notes/${NOTE_A_ID}`, { method: 'DELETE' });
    const response = await deleteNoteById(request, { params: Promise.resolve({ id: NOTE_A_ID }) });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: 'Note not found' });
    expect(db.query).toHaveBeenCalledWith('DELETE FROM notes WHERE id = $1 AND user_id = $2', [
      NOTE_A_ID,
      USER_B_ID,
    ]);
  });

  it('User B notes listing never includes User A notes (GET /api/notes)', async () => {
    // User B requests their library
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: USER_B_ID } as any);

    const userBNotes = [
      {
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        video_id: 'vidB',
        video_title: 'User B Note',
        thumbnail_url: null,
        overview: 'User B note',
        created_at: '2026-03-01T12:00:00Z',
      },
    ];

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: userBNotes,
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const response = await getNotesList();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(body.notes.some((n: any) => n.id === NOTE_A_ID)).toBe(false);

    // Verify SQL strictly filters by User B's user_id
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE user_id = $1'),
      expect.arrayContaining([USER_B_ID])
    );
  });
});
