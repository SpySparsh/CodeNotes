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
  fetchTranscript: vi.fn(),
  extractVideoTitle: vi.fn(),
  extractVideoId: vi.fn((url: string) => {
    const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
    return match ? match[1] : null;
  }),
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
    const error = new Error('Failed to fetch video transcript. The video might not have captions enabled.');
    const result = classifyError(error);
    expect(result.isUnrecoverable).toBe(true);
    expect(result.code).toBe('NO_TRANSCRIPT');
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
    // Verify trigger event or options
    const fnOpts = (generateNotesFunction as any).opts;
    expect(fnOpts.id).toBe('generate-notes');
    expect(fnOpts.retries).toBe(2);
  });

  it('executes full 4-step generation and persists notes under withUserTransaction', async () => {
    const { step, executedSteps } = createMockStep();

    const mockTranscript = 'Transcript text for Inngest tutorial';
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

    // Step 2: Transcript & title
    vi.mocked(transcript.fetchTranscript).mockResolvedValueOnce({
      text: mockTranscript,
      videoId: mockVideoId,
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

    expect(transcript.fetchTranscript).not.toHaveBeenCalled();
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

    expect(transcript.fetchTranscript).not.toHaveBeenCalled();
    expect(gemini.generateNotes).not.toHaveBeenCalled();
  });

  it('falls back to generateNotesFromVideoUrl when captions are unavailable', async () => {
    const { step } = createMockStep();
    const mockTitle = 'Video Without Captions';
    const mockAiNotes = {
      overview: 'Direct video overview',
      keyConcepts: ['Direct Concept 1'],
      detailedNotes: '# Direct Video Notes',
      shorthands: ['Direct Shorthand 1'],
    };

    // Step 1
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ status: 'pending', note_id: null, lease_until: null }],
      rowCount: 1,
    } as any);
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

    // Step 2: Transcript fails, title succeeds
    vi.mocked(transcript.fetchTranscript).mockRejectedValueOnce(
      new Error('Failed to fetch video transcript. Captions disabled.')
    );
    vi.mocked(transcript.extractVideoTitle).mockResolvedValueOnce(mockTitle);

    // Step 3: Direct video inference
    vi.mocked(gemini.generateNotesFromVideoUrl).mockResolvedValueOnce(mockAiNotes);

    // Step 4: withUserTransaction
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
    expect(gemini.generateNotes).not.toHaveBeenCalled();
    expect(gemini.generateNotesFromVideoUrl).toHaveBeenCalledWith(mockVideoUrl, mockTitle);
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
