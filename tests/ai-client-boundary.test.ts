import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateAiNotes,
  generateChunkAiNotes,
  synthesizeSectionNotes,
  AiClientError,
} from '@/lib/ai-client';
import {
  createDispatchTicket,
  QuotaError,
} from '@/lib/quota-client';

describe('AI Client Provider-Boundary & Ticket Enforcement', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const mockAttemptId = 'e0a80101-0000-0000-0000-000000000001';
  const mockResToken = 'f0a80101-0000-0000-0000-000000000002';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.FASTAPI_SERVICE_URL = 'http://127.0.0.1:8000';
    process.env.FASTAPI_SERVICE_SECRET = 'mock-secret';
    process.env.ENFORCE_DISPATCH_TICKET = 'true';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('rejects unguarded monolithic dispatch when ticket enforcement is enabled', async () => {
    await expect(
      (generateAiNotes as any)('test transcript', 'test title')
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED_DISPATCH',
      isRetryable: false,
    });
  });

  it('rejects unguarded chunk dispatch when ticket enforcement is enabled', async () => {
    await expect(
      (generateChunkAiNotes as any)('test chunk', 'test title')
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED_DISPATCH',
      isRetryable: false,
    });
  });

  it('rejects unguarded synthesis dispatch when ticket enforcement is enabled', async () => {
    await expect(
      (synthesizeSectionNotes as any)([{ chunkIndex: 0, overview: 'o', keyConcepts: [], shorthands: [] }], 'test title')
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED_DISPATCH',
      isRetryable: false,
    });
  });

  it('rejects forged plain object tickets', async () => {
    const forgedTicket = {
      attemptId: mockAttemptId,
      reservationToken: mockResToken,
      generation: 1,
      attemptNumber: 1,
      operationType: 'chunk',
      consume: vi.fn(),
    };

    await expect(
      (generateChunkAiNotes as any)(forgedTicket as any, 'chunk text', 'title')
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED_DISPATCH',
    });
  });

  it('permits authorized dispatch with valid ticket and consumes it once', async () => {
    const ticket = createDispatchTicket(
      mockAttemptId,
      mockResToken,
      1,
      1,
      'chunk'
    );

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          overview: 'Overview',
          keyConcepts: ['Key'],
          detailedNotes: 'Details',
          shorthands: ['Short'],
          usage: { promptTokens: 10, candidateTokens: 20, thoughtsTokens: 5, totalTokens: 35 },
          promptTokens: 10,
          candidateTokens: 20,
          thoughtsTokens: 5,
          totalTokens: 35,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const notes = await generateChunkAiNotes(ticket, 'chunk text', 'title');
    expect(notes.overview).toBe('Overview');
    expect(ticket.isConsumed).toBe(true);

    // Reusing the ticket for a second call must fail before fetch
    const fetchCallCount = (globalThis.fetch as any).mock.calls.length;
    await expect(
      generateChunkAiNotes(ticket, 'another chunk', 'title')
    ).rejects.toThrow(QuotaError);

    // Verify fetch was NOT called a second time
    expect((globalThis.fetch as any).mock.calls.length).toBe(fetchCallCount);
  });
});
