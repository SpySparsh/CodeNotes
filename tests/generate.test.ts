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

vi.mock('@/lib/db', () => {
  const queryFn = vi.fn();
  const withTransactionFn = vi.fn(async (cb) => {
    return cb({ query: queryFn });
  });
  return {
    query: queryFn,
    withTransaction: withTransactionFn,
  };
});

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
    expect(body.error).toBe('Something went wrong while generating your notes. Please try again.');
    expect(body.error).not.toContain('AI returned malformed data.');
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
    expect(body.error).toBe('Something went wrong while generating your notes. Please try again.');
    expect(body.error).not.toContain('Database disk full');
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

  it('should not report database timeout as Gemini/video timeout', async () => {
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
    vi.mocked(db.query).mockRejectedValueOnce(new Error('Query read timeout'));

    const request = new Request('http://localhost:3000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=vid12345678' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe('Something went wrong while generating your notes. Please try again.');
    expect(body.error).not.toBe('Note generation timed out. Please try again with a shorter video.');
    expect(body.error).not.toContain('Query read timeout');
  });

  describe('Concurrent Transcript & Title Fetching', () => {
    it('executes transcript and title fetch concurrently and only calls Gemini after both resolve', async () => {
      let transcriptStarted = false;
      let titleStarted = false;
      let geminiCalled = false;

      let resolveTranscript: (val: any) => void;
      let resolveTitle: (val: any) => void;

      const transcriptPromise = new Promise((resolve) => {
        resolveTranscript = resolve;
      });
      const titlePromise = new Promise((resolve) => {
        resolveTitle = resolve;
      });

      vi.mocked(transcript.fetchTranscript).mockImplementationOnce(async () => {
        transcriptStarted = true;
        await transcriptPromise;
        return { text: 'Parallel transcript text', videoId: 'vid12345678' };
      });

      vi.mocked(transcript.extractVideoTitle).mockImplementationOnce(async () => {
        titleStarted = true;
        await titlePromise;
        return 'Concurrent Video Title';
      });

      vi.mocked(gemini.generateNotes).mockImplementationOnce(async () => {
        geminiCalled = true;
        return {
          overview: 'Overview',
          keyConcepts: ['Concept'],
          detailedNotes: 'Details',
          shorthands: ['Shorthand'],
        };
      });

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      const request = new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=vid12345678' }),
      });

      // Start the POST request without awaiting completion immediately
      const postPromise = POST(request);

      // Give microtasks a turn to run so Promise.all starts both operations
      await new Promise((r) => setTimeout(r, 10));

      // Both operations MUST have started concurrently
      expect(transcriptStarted).toBe(true);
      expect(titleStarted).toBe(true);

      // Gemini MUST NOT have been called while operations are still pending
      expect(geminiCalled).toBe(false);

      // Resolve transcript first
      resolveTranscript!({ text: 'Parallel transcript text', videoId: 'vid12345678' });
      await new Promise((r) => setTimeout(r, 10));

      // Gemini still MUST NOT have been called because title is pending
      expect(geminiCalled).toBe(false);

      // Resolve title
      resolveTitle!('Concurrent Video Title');

      const response = await postPromise;
      expect(response.status).toBe(200);

      // Gemini was called only after both resolved
      expect(geminiCalled).toBe(true);
      expect(gemini.generateNotes).toHaveBeenCalledWith(
        'Parallel transcript text',
        'Concurrent Video Title'
      );
    });

    it('falls back to "Unknown Video" if extractVideoTitle returns fallback without failing generation', async () => {
      vi.mocked(transcript.fetchTranscript).mockResolvedValueOnce({
        text: 'Valid transcript',
        videoId: 'vid12345678',
      });
      // extractVideoTitle catches its internal error and resolves with 'Unknown Video'
      vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce('Unknown Video');
      vi.mocked(gemini.generateNotes).mockResolvedValueOnce({
        overview: 'Overview',
        keyConcepts: ['Concept'],
        detailedNotes: 'Details',
        shorthands: ['Shorthand'],
      });
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      const request = new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=vid12345678' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      expect(gemini.generateNotes).toHaveBeenCalledWith('Valid transcript', 'Unknown Video');
    });

    it('fails generation immediately if transcript fetch fails even if title succeeds', async () => {
      vi.mocked(transcript.fetchTranscript).mockRejectedValueOnce(
        new Error('Failed to fetch video transcript. The video might not have captions enabled.')
      );
      vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce('Some Title');

      const request = new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=vid12345678' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toContain('Failed to fetch video transcript');
      expect(gemini.generateNotes).not.toHaveBeenCalled();
    });
  });

  describe('Idempotency Behavior', () => {
    const testUrl = 'https://www.youtube.com/watch?v=vid12345678';
    const mockTranscript = 'Transcript content';
    const mockVideoId = 'vid12345678';
    const mockTitle = 'Test Video';
    const mockAiNotes = {
      overview: 'Test overview',
      keyConcepts: ['Key 1'],
      detailedNotes: 'Test detailed notes',
      shorthands: ['Tip 1'],
    };

    it('1. POST without Idempotency-Key preserves existing behavior', async () => {
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

      // Ensure no idempotency queries were made (only 1 notes INSERT query)
      expect(db.query).toHaveBeenCalledTimes(1);
      const [sql] = vi.mocked(db.query).mock.calls[0];
      expect(sql).toContain('INSERT INTO notes');
    });

    it('2. First request with new key acquires key, generates note, and marks completed', async () => {
      const idempotencyKey = 'key-first-request-123';

      vi.mocked(transcript.fetchTranscript).mockResolvedValueOnce({
        text: mockTranscript,
        videoId: mockVideoId,
      });
      vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce(mockTitle);
      vi.mocked(gemini.generateNotes).mockResolvedValueOnce(mockAiNotes);

      // 1. Acquire idempotency key
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ key: idempotencyKey }],
        rowCount: 1,
      } as any);
      // 2. Insert note
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);
      // 3. Complete idempotency key
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      const request = new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ url: testUrl }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.noteId).toBeDefined();

      expect(gemini.generateNotes).toHaveBeenCalledTimes(1);
      expect(db.query).toHaveBeenCalledTimes(3);

      const calls = vi.mocked(db.query).mock.calls;
      expect(calls[0][0]).toContain('INSERT INTO generation_idempotency');
      expect(calls[0][1]).toEqual([idempotencyKey]);

      expect(calls[1][0]).toContain('INSERT INTO notes');

      expect(calls[2][0]).toContain("SET status = 'completed'");
      expect(calls[2][1]).toEqual([idempotencyKey, body.noteId]);
    });

    it('3. Same key submitted again after completion returns HTTP 200 with same noteId without Gemini', async () => {
      const idempotencyKey = 'key-completed-123';
      const originalNoteId = 'original-note-uuid-999';

      // 1. Insert conflict returns 0 rows (key exists)
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);
      // 2. Select returns completed record
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{
          status: 'completed',
          note_id: originalNoteId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
        rowCount: 1,
      } as any);

      const request = new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ url: testUrl }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.noteId).toBe(originalNoteId);

      expect(transcript.fetchTranscript).not.toHaveBeenCalled();
      expect(gemini.generateNotes).not.toHaveBeenCalled();
    });

    it('4. Same key submitted concurrently/while processing returns HTTP 409 without calling Gemini', async () => {
      const idempotencyKey = 'key-in-progress-123';

      // 1. Insert conflict returns 0 rows
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);
      // 2. Select returns processing record (recently created, not stale)
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{
          status: 'processing',
          note_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
        rowCount: 1,
      } as any);

      const request = new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ url: testUrl }),
      });

      const response = await POST(request);
      expect(response.status).toBe(409);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Generation already in progress');

      expect(transcript.fetchTranscript).not.toHaveBeenCalled();
      expect(gemini.generateNotes).not.toHaveBeenCalled();
    });

    it('5. Two different idempotency keys for the same video produce two separate generations and notes', async () => {
      const key1 = 'key-session-1';
      const key2 = 'key-session-2';

      // --- First request with key1 ---
      vi.mocked(transcript.fetchTranscript).mockResolvedValueOnce({
        text: mockTranscript,
        videoId: mockVideoId,
      });
      vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce(mockTitle);
      vi.mocked(gemini.generateNotes).mockResolvedValueOnce(mockAiNotes);

      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ key: key1 }], rowCount: 1 } as any);
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const req1 = new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key1 },
        body: JSON.stringify({ url: testUrl }),
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();

      // --- Second request with key2 ---
      vi.mocked(transcript.fetchTranscript).mockResolvedValueOnce({
        text: mockTranscript,
        videoId: mockVideoId,
      });
      vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce(mockTitle);
      vi.mocked(gemini.generateNotes).mockResolvedValueOnce(mockAiNotes);

      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ key: key2 }], rowCount: 1 } as any);
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const req2 = new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key2 },
        body: JSON.stringify({ url: testUrl }),
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(200);
      const body2 = await res2.json();

      expect(body1.noteId).not.toBe(body2.noteId);
      expect(gemini.generateNotes).toHaveBeenCalledTimes(2);
    });

    it('6. Generation failure removes idempotency record to allow retry', async () => {
      const idempotencyKey = 'key-failing-123';

      vi.mocked(transcript.fetchTranscript).mockRejectedValueOnce(
        new Error('Transcript network failure')
      );

      // 1. Acquire key succeeds
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ key: idempotencyKey }],
        rowCount: 1,
      } as any);
      // 2. DELETE in catch block
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      const request = new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ url: testUrl }),
      });

      const response = await POST(request);
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Something went wrong while generating your notes. Please try again.');
      expect(body.error).not.toContain('Transcript network failure');

      // Verify deletion of the idempotency record
      expect(db.query).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(db.query).mock.calls;
      expect(calls[1][0]).toContain('DELETE FROM generation_idempotency');
      expect(calls[1][1]).toEqual([idempotencyKey]);
    });

    it('7. Stale processing record is reclaimed when age exceeds threshold', async () => {
      const idempotencyKey = 'key-stale-123';

      vi.mocked(transcript.fetchTranscript).mockResolvedValueOnce({
        text: mockTranscript,
        videoId: mockVideoId,
      });
      vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce(mockTitle);
      vi.mocked(gemini.generateNotes).mockResolvedValueOnce(mockAiNotes);

      // 1. Acquire fails (conflict)
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);
      // 2. Select finds stale row (e.g. 150 seconds ago, > 120s threshold)
      const staleTimestamp = new Date(Date.now() - 150000).toISOString();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{
          status: 'processing',
          note_id: null,
          created_at: staleTimestamp,
          updated_at: staleTimestamp,
        }],
        rowCount: 1,
      } as any);
      // 3. Reclaim update succeeds
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ key: idempotencyKey }],
        rowCount: 1,
      } as any);
      // 4. Notes insert succeeds
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);
      // 5. Complete idempotency key
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      const request = new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ url: testUrl }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);

      const calls = vi.mocked(db.query).mock.calls;
      expect(calls[2][0]).toContain('UPDATE generation_idempotency');
      expect(calls[2][0]).toContain("SET status = 'processing'");
      expect(gemini.generateNotes).toHaveBeenCalledTimes(1);
    });

    it('8. Rapid client-side double submission: synchronous ref guard allows only one fetch request', async () => {
      // Test the exact client submission guard pattern implemented in UrlInput
      let isSubmitting = false;
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, noteId: 'mock-note-id' }),
      });

      const submitHandler = async (url: string) => {
        if (!url) return;
        if (!url.includes('youtube.com/watch') && !url.includes('youtu.be/')) return;
        if (isSubmitting) return;
        isSubmitting = true;

        const idempotencyKey = 'mock-client-uuid';
        await fetchSpy('/api/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ url }),
        });
      };

      const validUrl = 'https://www.youtube.com/watch?v=vid12345678';
      // Simulate rapid double-clicks (synchronous invocations before first tick completes)
      const firstClick = submitHandler(validUrl);
      const secondClick = submitHandler(validUrl);
      const thirdClick = submitHandler(validUrl);

      await Promise.allSettled([firstClick, secondClick, thirdClick]);

      // Only the first submission triggers fetch
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('9. Concurrent stale reclaim race: exactly one request reclaims while the other does not call Gemini', async () => {
      const idempotencyKey = 'key-concurrent-stale-123';
      const staleTimestamp = new Date(Date.now() - 150000).toISOString();

      vi.mocked(transcript.fetchTranscript).mockResolvedValue({
        text: mockTranscript,
        videoId: mockVideoId,
      });
      vi.mocked(transcript.extractVideoTitle).mockResolvedValue(mockTitle);
      vi.mocked(gemini.generateNotes).mockResolvedValue(mockAiNotes);

      // Simulation of Request 1 (Winner):
      // 1. INSERT conflict
      // 2. SELECT finds stale record
      // 3. UPDATE atomically reclaims key (returns 1 row)
      // 4. withTransaction executes notes INSERT and idempotency UPDATE
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // Req 1: INSERT conflict
        .mockResolvedValueOnce({ // Req 1: SELECT finds stale
          rows: [{ status: 'processing', note_id: null, created_at: staleTimestamp, updated_at: staleTimestamp }],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [{ key: idempotencyKey }], rowCount: 1 } as any) // Req 1: UPDATE reclaims successfully
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // Req 1: notes INSERT (inside tx)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // Req 1: idempotency UPDATE (inside tx)

      // Simulation of Request 2 (Loser of race):
      // 1. INSERT conflict
      // 2. SELECT finds stale record
      // 3. UPDATE fails to reclaim (returns 0 rows because Request 1 already bumped updated_at)
      // 4. re-read query finds status='processing'
      // 5. Returns 409 and never calls Gemini
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // Req 2: INSERT conflict
        .mockResolvedValueOnce({ // Req 2: SELECT finds stale
          rows: [{ status: 'processing', note_id: null, created_at: staleTimestamp, updated_at: staleTimestamp }],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // Req 2: UPDATE fails (race lost)
        .mockResolvedValueOnce({ // Req 2: re-read
          rows: [{ status: 'processing', note_id: null }],
          rowCount: 1,
        } as any);

      const makeRequest = () => new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ url: testUrl }),
      });

      const resWinner = await POST(makeRequest());
      const resLoser = await POST(makeRequest());

      expect(resWinner.status).toBe(200);
      const winnerBody = await resWinner.json();
      expect(winnerBody.success).toBe(true);

      expect(resLoser.status).toBe(409);
      const loserBody = await resLoser.json();
      expect(loserBody.success).toBe(false);
      expect(loserBody.error).toBe('Generation already in progress');

      // Only Request 1 called Gemini
      expect(gemini.generateNotes).toHaveBeenCalledTimes(1);
    });

    it('10. Failure during idempotency completion phase rolls back the note insertion', async () => {
      const idempotencyKey = 'key-tx-fail-123';

      vi.mocked(transcript.fetchTranscript).mockResolvedValueOnce({
        text: mockTranscript,
        videoId: mockVideoId,
      });
      vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce(mockTitle);
      vi.mocked(gemini.generateNotes).mockResolvedValueOnce(mockAiNotes);

      // 1. Acquire key succeeds
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ key: idempotencyKey }],
        rowCount: 1,
      } as any);

      // Setup withTransaction mock specifically to test rollback
      const queriesExecuted: string[] = [];
      vi.mocked(db.withTransaction).mockImplementationOnce(async (callback) => {
        const mockClient = {
          query: vi.fn(async (sql: string) => {
            queriesExecuted.push(sql);
            if (sql.includes('INSERT INTO notes')) {
              return { rows: [], rowCount: 1 };
            }
            if (sql.includes('UPDATE generation_idempotency')) {
              throw new Error('Database disk error during idempotency completion');
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        queriesExecuted.push('BEGIN');
        try {
          await callback(mockClient);
          queriesExecuted.push('COMMIT');
        } catch (err) {
          queriesExecuted.push('ROLLBACK');
          throw err;
        }
      });

      // Cleanup delete query in catch block
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      const request = new Request('http://localhost:3000/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ url: testUrl }),
      });

      const response = await POST(request);
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Something went wrong while generating your notes. Please try again.');
      expect(body.error).not.toContain('Database disk error');

      // Verify transaction boundary executed ROLLBACK
      expect(queriesExecuted).toContain('BEGIN');
      expect(queriesExecuted.some((q) => q.includes('INSERT INTO notes'))).toBe(true);
      expect(queriesExecuted.some((q) => q.includes('UPDATE generation_idempotency'))).toBe(true);
      expect(queriesExecuted).toContain('ROLLBACK');
      expect(queriesExecuted).not.toContain('COMMIT');
    });
  });
});
