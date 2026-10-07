import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/notes/route';
import * as db from '@/lib/db';
import * as auth from '@/lib/auth';
import { encodeCursor } from '@/lib/validations/notes';

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

describe('GET /api/notes - Keyset Pagination, Search, Sorting & Validation', () => {
  const mockUserId = 'user-123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 401 when user is unauthenticated', async () => {
    vi.mocked(auth.requireUser).mockRejectedValueOnce(new auth.UnauthorizedError());

    const response = await GET();
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body).toEqual({ error: 'Unauthorized' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('should return 200 with default pagination (limit=20, sort=created_at, order=desc)', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

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
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.notes[0]).toEqual({
      id: '123e4567-e89b-12d3-a456-426614174000',
      videoId: 'vid12345678',
      videoTitle: 'Learn TypeScript in 10 Minutes',
      thumbnailUrl: 'https://img.youtube.com/vi/vid12345678/maxresdefault.jpg',
      overview: 'A quick overview of TypeScript.',
      createdAt: '2026-09-23T10:00:00Z',
    });

    // Default limit 20 fetches limit + 1 = 21
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT $2'),
      [mockUserId, 21]
    );
  });

  it('should compute hasMore=true and generate opaque nextCursor when results exceed limit', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

    // Limit is 2; return 3 rows
    const mockDbRows = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        video_id: 'vid1',
        video_title: 'Title 1',
        thumbnail_url: null,
        overview: 'Overview 1',
        created_at: '2026-09-23T12:00:00.000Z',
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        video_id: 'vid2',
        video_title: 'Title 2',
        thumbnail_url: null,
        overview: 'Overview 2',
        created_at: '2026-09-23T11:00:00.000Z',
      },
      {
        id: '33333333-3333-3333-3333-333333333333',
        video_id: 'vid3',
        video_title: 'Title 3',
        thumbnail_url: null,
        overview: 'Overview 3',
        created_at: '2026-09-23T10:00:00.000Z',
      },
    ];

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: mockDbRows,
      rowCount: 3,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request('http://localhost/api/notes?limit=2');
    const response = await GET(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.notes).toHaveLength(2); // Sliced to limit
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBeDefined();
    expect(typeof body.nextCursor).toBe('string');
  });

  it('should accept valid cursor and append keyset WHERE condition in SQL', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

    const cursor = encodeCursor({
      sortValue: '2026-09-23T11:00:00.000Z',
      id: '22222222-2222-2222-2222-222222222222',
      sortField: 'created_at',
      sortOrder: 'desc',
    });

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request(`http://localhost/api/notes?cursor=${cursor}`);
    const response = await GET(request);
    expect(response.status).toBe(200);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('(created_at < $2::timestamptz OR (created_at = $2::timestamptz AND id < $3::uuid))'),
      [mockUserId, '2026-09-23T11:00:00.000Z', '22222222-2222-2222-2222-222222222222', 21]
    );
  });

  it('should return 400 when cursor is malformed or has invalid signature', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

    const request = new Request('http://localhost/api/notes?cursor=invalid-non-base64-json');
    const response = await GET(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('Malformed or invalid pagination cursor');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('should return 400 when cursor does not match requested sort or order', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

    // Cursor generated for created_at desc
    const cursor = encodeCursor({
      sortValue: '2026-09-23T11:00:00.000Z',
      id: '22222222-2222-2222-2222-222222222222',
      sortField: 'created_at',
      sortOrder: 'desc',
    });

    // Request specifies sort=video_title
    const request = new Request(`http://localhost/api/notes?cursor=${cursor}&sort=video_title`);
    const response = await GET(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('Malformed or invalid pagination cursor');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('should return 400 when limit exceeds maximum (50) or is negative', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

    const request = new Request('http://localhost/api/notes?limit=999');
    const response = await GET(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('Invalid query parameters');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('should support search query and escape ILIKE special characters', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request('http://localhost/api/notes?search=100%25_typescript');
    const response = await GET(request);
    expect(response.status).toBe(200);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("(video_title ILIKE $2 ESCAPE '\\' OR overview ILIKE $2 ESCAPE '\\')"),
      [mockUserId, '%100\\%\\_typescript%', 21]
    );
  });

  it('should support sorting by video_title ASC with deterministic id tie-breaker', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request('http://localhost/api/notes?sort=video_title&order=asc');
    const response = await GET(request);
    expect(response.status).toBe(200);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY video_title ASC, id ASC'),
      [mockUserId, 21]
    );
  });

  it('should support sorting by video_title DESC with keyset < comparison and deterministic id tie-breaker', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);

    const cursor = encodeCursor({
      sortValue: 'TypeScript Deep Dive',
      id: '22222222-2222-2222-2222-222222222222',
      sortField: 'video_title',
      sortOrder: 'desc',
    });

    const mockDbRows = [
      {
        id: '33333333-3333-3333-3333-333333333333',
        video_id: 'vid3',
        video_title: 'React 19 Tutorial',
        thumbnail_url: null,
        overview: 'React 19 overview',
        created_at: '2026-09-23T10:00:00.000Z',
      },
      {
        id: '44444444-4444-4444-4444-444444444444',
        video_id: 'vid4',
        video_title: 'Next.js 16 Guide',
        thumbnail_url: null,
        overview: 'Next.js guide',
        created_at: '2026-09-23T09:00:00.000Z',
      },
    ];

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: mockDbRows,
      rowCount: 2,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as any);

    const request = new Request(`http://localhost/api/notes?sort=video_title&order=desc&cursor=${cursor}&limit=1`);
    const response = await GET(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.notes).toHaveLength(1);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBeDefined();

    // Verify SQL generated uses < comparison for DESC and ORDER BY video_title DESC, id DESC
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('(video_title < $2::text OR (video_title = $2::text AND id < $3::uuid))'),
      [mockUserId, 'TypeScript Deep Dive', '22222222-2222-2222-2222-222222222222', 2]
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY video_title DESC, id DESC'),
      expect.any(Array)
    );
  });

  it('should return 500 when database query fails', async () => {
    vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);
    vi.mocked(db.query).mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    const response = await GET();
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body).toEqual({ error: 'Failed to fetch notes' });
  });
});
