import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NonRetriableError } from 'inngest';

vi.mock('youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
  fetchTranscript: vi.fn(),
}));

import {
  generateNotesFunction,
  classifyError,
} from '@/inngest/functions/generate-notes';
import * as transcript from '@/lib/transcript';
import * as gemini from '@/lib/gemini';
import * as db from '@/lib/db';

vi.mock('@/lib/transcript', () => ({
  validateYouTubeUrl: vi.fn((url: string) => {
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      throw new Error('Invalid YouTube URL');
    }
  }),
  acquireTranscript: vi.fn(),
  fetchTranscript: vi.fn(),
  extractVideoTitle: vi.fn(),
  extractVideoId: vi.fn((url: string) => {
    const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
    return match ? match[1] : null;
  }),
  canonicalizeYouTubeUrl: vi.fn((url: string) => url),
  TranscriptError: class TranscriptError extends Error {
    readonly code: string;
    readonly isRetryable: boolean;
    readonly provider?: string;
    constructor(code: string, message: string, isRetryable = false, provider?: string) {
      super(message);
      this.name = 'TranscriptError';
      this.code = code;
      this.isRetryable = isRetryable;
      this.provider = provider;
    }
  },
}));

vi.mock('@/lib/gemini', () => ({
  generateNotes: vi.fn(),
  generateNotesFromVideoUrl: vi.fn(),
}));

vi.mock('@/lib/db', () => {
  const queryFn = vi.fn();
  const withUserTransactionFn = vi.fn(async (_userId, cb) => {
    return cb({ query: queryFn });
  });
  return {
    query: queryFn,
    withUserTransaction: withUserTransactionFn,
  };
});

describe('Inngest Error Classification (classifyError)', () => {
  it('classifies Invalid YouTube URL as unrecoverable non-retryable error', () => {
    const error = new Error('Invalid YouTube URL');
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(true);
    expect(result.code).toBe('INVALID_URL');
  });

  it('classifies missing captions as unrecoverable non-retryable error', () => {
    const error = new Error('Captions are disabled or unavailable for this video.');
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(true);
    expect(result.code).toBe('TRANSCRIPT_UNAVAILABLE');
  });

  it('classifies TranscriptError TRANSCRIPT_UNAVAILABLE as unrecoverable', () => {
    const error = new (transcript as any).TranscriptError('TRANSCRIPT_UNAVAILABLE', 'Captions unavailable', false);
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(true);
    expect(result.code).toBe('TRANSCRIPT_UNAVAILABLE');
  });

  it('classifies TranscriptError TRANSCRIPT_PROVIDER_AUTH_ERROR as unrecoverable', () => {
    const error = new (transcript as any).TranscriptError('TRANSCRIPT_PROVIDER_AUTH_ERROR', 'Invalid API key', false);
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(true);
    expect(result.code).toBe('TRANSCRIPT_PROVIDER_AUTH_ERROR');
  });

  it('classifies TranscriptError TRANSCRIPT_PROVIDER_QUOTA_EXCEEDED as unrecoverable', () => {
    const error = new (transcript as any).TranscriptError('TRANSCRIPT_PROVIDER_QUOTA_EXCEEDED', 'Monthly quota exceeded', false);
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(true);
    expect(result.code).toBe('TRANSCRIPT_PROVIDER_QUOTA_EXCEEDED');
  });

  it('classifies TranscriptError TRANSCRIPT_PROVIDER_RATE_LIMITED as retryable', () => {
    const error = new (transcript as any).TranscriptError('TRANSCRIPT_PROVIDER_RATE_LIMITED', 'Rate limited', true);
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(false);
    expect(result.code).toBe('TRANSCRIPT_PROVIDER_RATE_LIMITED');
  });

  it('classifies AI malformed JSON as unrecoverable error', () => {
    const error = new Error('AI returned malformed data.');
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(true);
    expect(result.code).toBe('MALFORMED_AI_OUTPUT');
  });

  it('classifies missing API key as unrecoverable configuration error', () => {
    const error = new Error('Gemini API key is missing or invalid. Please check .env.local');
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(true);
    expect(result.code).toBe('CONFIG_ERROR');
  });

  it('classifies Gemini 429 rate limit as retryable error', () => {
    const error = new Error('[GoogleGenerativeAI Error]: [429 Too Many Requests] RESOURCE_EXHAUSTED');
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(false);
    expect(result.code).toBe('RATE_LIMITED');
  });

  it('classifies network timeout as retryable error', () => {
    const error = new Error('AI generation timed out after 75 seconds.');
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(false);
    expect(result.code).toBe('TIMEOUT');
  });

  it('classifies transient database connection termination as retryable error', () => {
    const error = new Error('Connection terminated unexpectedly');
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(false);
    expect(result.code).toBe('DB_TRANSIENT_ERROR');
  });
});

describe('Inngest generateNotesFunction', () => {
  const mockUserId = '123e4567-e89b-12d3-a456-426614174000';
  const mockKey = 'idem-key-inngest-1';
  const mockVideoId = 'dQw4w9WgXcQ';
  const mockVideoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  const mockEvent = {
    name: 'notes/generate.requested' as const,
    data: {
      userId: mockUserId,
      idempotencyKey: mockKey,
      videoId: mockVideoId,
      videoUrl: mockVideoUrl,
    },
  };

  // Helper step runner to execute Inngest handler steps directly
  const createMockStep = () => {
    const executedSteps: string[] = [];
    return {
      executedSteps,
      step: {
        run: vi.fn(async (stepId: string, fn: () => Promise<any>) => {
          executedSteps.push(stepId);
          return await fn();
        }),
      },
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct function configuration metadata', () => {
    expect(generateNotesFunction).toBeDefined();
    const fnOpts = (generateNotesFunction as any).opts;
    expect(fnOpts.id).toBe('generate-notes');
    expect(fnOpts.retries).toBe(2);
  });

  it('executes full 4-step generation using acquireTranscript and persists notes under withUserTransaction', async () => {
    const { step, executedSteps } = createMockStep();

    const mockTranscript = 'Transcript text for Supadata / Inngest tutorial';
    const mockTitle = 'Inngest Tutorial Title';
    const mockAiNotes = {
      overview: 'Great Inngest overview',
      keyConcepts: ['Concept 1', 'Concept 2'],
      detailedNotes: '# Detailed Notes',
      shorthands: ['Shorthand 1'],
    };

    // Step 1: Claim DB queries (SELECT then UPDATE lease)
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ status: 'pending', note_id: null, lease_until: null }],
      rowCount: 1,
    } as any);
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

    // Step 2: Transcript & title via acquireTranscript
    vi.mocked(transcript.acquireTranscript).mockResolvedValueOnce({
      text: mockTranscript,
      videoId: mockVideoId,
      provider: 'supadata',
      cached: false,
    });
    vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce(mockTitle);

    // Step 3: Gemini inference
    vi.mocked(gemini.generateNotes).mockResolvedValueOnce(mockAiNotes);

    // Step 4: withUserTransaction queries (check lock -> insert note -> update completed)
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ status: 'processing', note_id: null }],
      rowCount: 1,
    } as any);
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

    const fnHandler = (generateNotesFunction as any).fn;
    const result = await fnHandler({ event: mockEvent, step });

    expect(result.success).toBe(true);
    expect(result.noteId).toBeDefined();

    expect(executedSteps).toEqual([
      'claim-generation-processing',
      'fetch-transcript-and-title',
      'generate-ai-notes',
      'persist-notes',
    ]);

    expect(db.withUserTransaction).toHaveBeenCalledWith(mockUserId, expect.any(Function));
    expect(gemini.generateNotes).toHaveBeenCalledWith(mockTranscript, mockTitle);
    expect(gemini.generateNotesFromVideoUrl).not.toHaveBeenCalled();
  });

  it('supports shared cached transcript reuse across different users while isolating user notes under RLS', async () => {
    const userA = 'user-uuid-aaaa-1111';
    const userB = 'user-uuid-bbbb-2222';
    const cachedTranscript = 'Shared cached transcript across users';
    const sharedTitle = 'Shared Video Title';
    const mockAiNotes = {
      overview: 'Shared overview',
      keyConcepts: ['Concept 1'],
      detailedNotes: '# Detailed Notes',
      shorthands: ['Shorthand 1'],
    };

    // User A Generation (Cache Miss -> Acquired)
    const { step: stepA } = createMockStep();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ status: 'pending', note_id: null, lease_until: null }] } as any);
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);
    vi.mocked(transcript.acquireTranscript).mockResolvedValueOnce({
      text: cachedTranscript,
      videoId: mockVideoId,
      provider: 'supadata',
      cached: false,
    });
    vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce(sharedTitle);
    vi.mocked(gemini.generateNotes).mockResolvedValueOnce(mockAiNotes);
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ status: 'processing', note_id: null }] } as any);
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);

    const fnHandler = (generateNotesFunction as any).fn;
    const resA = await fnHandler({
      event: { name: 'notes/generate.requested', data: { userId: userA, idempotencyKey: 'key-a', videoId: mockVideoId, videoUrl: mockVideoUrl } },
      step: stepA,
    });

    expect(resA.success).toBe(true);
    expect(db.withUserTransaction).toHaveBeenCalledWith(userA, expect.any(Function));

    // User B Generation (Cache Hit -> Reused cached transcript)
    const { step: stepB } = createMockStep();
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ status: 'pending', note_id: null, lease_until: null }] } as any);
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);
    vi.mocked(transcript.acquireTranscript).mockResolvedValueOnce({
      text: cachedTranscript,
      videoId: mockVideoId,
      provider: 'supadata',
      cached: true,
    });
    vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce(sharedTitle);
    vi.mocked(gemini.generateNotes).mockResolvedValueOnce(mockAiNotes);
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ status: 'processing', note_id: null }] } as any);
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);

    const resB = await fnHandler({
      event: { name: 'notes/generate.requested', data: { userId: userB, idempotencyKey: 'key-b', videoId: mockVideoId, videoUrl: mockVideoUrl } },
      step: stepB,
    });

    expect(resB.success).toBe(true);
    expect(db.withUserTransaction).toHaveBeenCalledWith(userB, expect.any(Function));
    expect(resA.noteId).not.toEqual(resB.noteId);
  });

  it('skips remaining steps if claim detects job is already completed', async () => {
    const { step, executedSteps } = createMockStep();
    const existingNoteId = 'existing-uuid-123';

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ status: 'completed', note_id: existingNoteId, lease_until: null }],
      rowCount: 1,
    } as any);

    const fnHandler = (generateNotesFunction as any).fn;
    const result = await fnHandler({ event: mockEvent, step });

    expect(result.skipped).toBe(true);
    expect(result.noteId).toBe(existingNoteId);
    expect(executedSteps).toEqual(['claim-generation-processing']);

    expect(transcript.acquireTranscript).not.toHaveBeenCalled();
    expect(gemini.generateNotes).not.toHaveBeenCalled();
    expect(db.withUserTransaction).not.toHaveBeenCalled();
  });

  it('skips execution if an active future lease is held by another worker', async () => {
    const { step, executedSteps } = createMockStep();
    const futureLease = new Date(Date.now() + 180000).toISOString();

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ status: 'processing', note_id: null, lease_until: futureLease }],
      rowCount: 1,
    } as any);

    const fnHandler = (generateNotesFunction as any).fn;
    const result = await fnHandler({ event: mockEvent, step });

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('Active lease held');
    expect(executedSteps).toEqual(['claim-generation-processing']);

    expect(transcript.acquireTranscript).not.toHaveBeenCalled();
    expect(gemini.generateNotes).not.toHaveBeenCalled();
  });

  it('fails cleanly with NonRetriableError when transcript is unavailable without calling direct video fallback', async () => {
    const { step } = createMockStep();
    const mockTitle = 'Video Without Captions';

    // Step 1
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ status: 'pending', note_id: null, lease_until: null }],
      rowCount: 1,
    } as any);
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

    // Step 2: Transcript fails with domain error
    vi.mocked(transcript.acquireTranscript).mockRejectedValueOnce(
      new (transcript as any).TranscriptError('TRANSCRIPT_UNAVAILABLE', 'Captions are disabled or unavailable for this video.', false)
    );
    vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce(mockTitle);

    const fnHandler = (generateNotesFunction as any).fn;
    await expect(fnHandler({ event: mockEvent, step })).rejects.toThrow(NonRetriableError);

    // Verify direct video fallback is NEVER called
    expect(gemini.generateNotesFromVideoUrl).not.toHaveBeenCalled();
    expect(gemini.generateNotes).not.toHaveBeenCalled();
  });

  it('throws NonRetriableError on payload mismatch', async () => {
    const { step } = createMockStep();

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ status: 'pending', video_id: 'DIFFERENT_VIDEO_ID', note_id: null }],
      rowCount: 1,
    } as any);

    const fnHandler = (generateNotesFunction as any).fn;
    await expect(fnHandler({ event: mockEvent, step })).rejects.toThrow(NonRetriableError);
  });

  it('throws NonRetriableError if DB record is missing', async () => {
    const { step } = createMockStep();

    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    const fnHandler = (generateNotesFunction as any).fn;
    await expect(fnHandler({ event: mockEvent, step })).rejects.toThrow(NonRetriableError);
  });

  it('onFailure handler updates generation_idempotency status to failed in DB', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

    const onFailureHandler = (generateNotesFunction as any).opts.onFailure;
    expect(onFailureHandler).toBeDefined();

    await onFailureHandler({
      event: { data: { event: mockEvent } },
      error: new Error('Invalid YouTube URL'),
    });

    const updateCall = vi.mocked(db.query).mock.calls.find((call) =>
      call[0].includes("status = 'failed'")
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toContain('INVALID_URL');
  });
});
