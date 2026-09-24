import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/generate/route';
import * as transcript from '@/lib/transcript';
import * as gemini from '@/lib/gemini';
import * as db from '@/lib/db';

vi.mock('@/lib/transcript', () => ({
  fetchTranscript: vi.fn(),
  extractVideoTitle: vi.fn(),
}));

vi.mock('@/lib/gemini', () => ({
  generateNotes: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
}));

describe('POST /api/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(body).toEqual({ error: 'YouTube URL is required' });
  });

  it('should return 200 with noteId on successful generation', async () => {
    const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const mockTranscript = 'In this tutorial we will learn React 19 fundamentals.';
    const mockVideoId = 'dQw4w9WgXcQ';
    const mockTitle = 'React 19 Tutorial';
    const mockAiNotes = {
      overview: 'A complete overview of React 19 features.',
      keyConcepts: ['Actions', 'useOptimistic', 'Server Actions'],
      detailedNotes: '## Detailed Section\n```jsx\nconst [state, formAction] = useActionState();\n```',
      shorthands: ['Use Server Actions for form mutation'],
    };

    vi.mocked(transcript.fetchTranscript).mockResolvedValueOnce({
      text: mockTranscript,
      videoId: mockVideoId,
    });
    vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce(mockTitle);
    vi.mocked(gemini.generateNotes).mockResolvedValueOnce(mockAiNotes);
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
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
    expect(body.noteId).toBeDefined();
    expect(typeof body.noteId).toBe('string');
    // Ensure UUID format
    expect(body.noteId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    expect(transcript.fetchTranscript).toHaveBeenCalledWith(testUrl);
    expect(transcript.extractVideoTitle).toHaveBeenCalledWith(testUrl);
    expect(gemini.generateNotes).toHaveBeenCalledWith(mockTranscript, mockTitle);
    expect(db.query).toHaveBeenCalledTimes(1);

    const dbCall = vi.mocked(db.query).mock.calls[0];
    const [sqlQuery, sqlParams] = dbCall;
    expect(sqlQuery).toContain('INSERT INTO notes');
    expect(sqlParams).toBeDefined();
    expect(sqlParams![1]).toBe(mockVideoId);
    expect(sqlParams![2]).toBe(mockTitle);
    expect(sqlParams![3]).toBe(testUrl);
    expect(sqlParams![4]).toBe(`https://img.youtube.com/vi/${mockVideoId}/maxresdefault.jpg`);
    expect(sqlParams![5]).toBe(mockAiNotes.overview);
    expect(sqlParams![6]).toEqual(mockAiNotes.keyConcepts);
    expect(sqlParams![7]).toBe(mockAiNotes.detailedNotes);
    expect(sqlParams![8]).toEqual(mockAiNotes.shorthands);
  });

  it('should return 500 when fetchTranscript fails', async () => {
    vi.mocked(transcript.fetchTranscript).mockRejectedValueOnce(
      new Error('Failed to fetch video transcript. The video might not have captions enabled.')
    );

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=nocaptions12' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toContain('Failed to fetch video transcript');
  });

  it('should return 500 when Gemini note generation fails', async () => {
    vi.mocked(transcript.fetchTranscript).mockResolvedValueOnce({
      text: 'Transcript text',
      videoId: 'vid12345678',
    });
    vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce('Sample Video');
    vi.mocked(gemini.generateNotes).mockRejectedValueOnce(new Error('AI returned malformed data.'));

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=vid12345678' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe('AI returned malformed data.');
  });

  it('should return 500 when database insertion fails', async () => {
    vi.mocked(transcript.fetchTranscript).mockResolvedValueOnce({
      text: 'Transcript text',
      videoId: 'vid12345678',
    });
    vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce('Sample Video');
    vi.mocked(gemini.generateNotes).mockResolvedValueOnce({
      overview: 'Overview',
      keyConcepts: ['Concept'],
      detailedNotes: 'Details',
      shorthands: ['Shorthand'],
    });
    vi.mocked(db.query).mockRejectedValueOnce(new Error('Database disk full'));

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=vid12345678' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe('Database disk full');
  });

  it('should return 500 with user-friendly error when Gemini times out', async () => {
    vi.mocked(transcript.fetchTranscript).mockResolvedValueOnce({
      text: 'Transcript text',
      videoId: 'vid12345678',
    });
    vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce('Sample Video');
    vi.mocked(gemini.generateNotes).mockRejectedValueOnce(
      new Error('AI generation timed out after 75 seconds.')
    );

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=vid12345678' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe('Note generation timed out. Please try again with a shorter video.');
  });
});
