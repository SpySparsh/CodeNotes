import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDeterministicEventId, inngest } from '@/inngest/client';
import { reconcileStaleGenerationsFunction } from '@/inngest/functions/reconcile-stale';
import * as db from '@/lib/db';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
}));

vi.mock('@/inngest/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/inngest/client')>();
  return {
    ...actual,
    inngest: {
      send: vi.fn().mockResolvedValue({ ids: ['inngest-evt-rec-1'] }),
      createFunction: actual.inngest.createFunction.bind(actual.inngest),
    },
  };
});

describe('DB -> Inngest Failure Recovery & Reconciliation', () => {
  const mockUserId = 'usr_001';
  const mockKey = 'idemp_orphaned_001';

  const createMockStep = () => {
    return {
      step: {
        run: vi.fn(async (_stepId: string, fn: () => Promise<any>) => {
          return await fn();
        }),
      },
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('guarantees deterministic event ID re-dispatch replaces or deduplicates orphaned jobs', () => {
    const eventIdFirstAttempt = generateDeterministicEventId(mockUserId, mockKey);
    const eventIdRecoveryAttempt = generateDeterministicEventId(mockUserId, mockKey);

    expect(eventIdFirstAttempt).toBe(eventIdRecoveryAttempt);
    expect(eventIdRecoveryAttempt).toBe(`gen-${mockUserId}-${mockKey}`);
  });

  it('preserves user isolation across multiple orphaned job recoveries', () => {
    const userA = 'user-a';
    const userB = 'user-b';
    const sharedKey = 'common-key';

    const eventA = generateDeterministicEventId(userA, sharedKey);
    const eventB = generateDeterministicEventId(userB, sharedKey);

    expect(eventA).not.toBe(eventB);
  });

  it('scans stale pending DB records and re-dispatches Inngest events (Case A)', async () => {
    const staleRecords = [
      {
        user_id: mockUserId,
        key: mockKey,
        status: 'pending',
        video_id: 'dQw4w9WgXcQ',
        video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        created_at: new Date(Date.now() - 90000).toISOString(),
        updated_at: new Date(Date.now() - 90000).toISOString(),
        lease_until: null,
      },
    ];

    // 1. SELECT stale records
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: staleRecords,
      rowCount: 1,
    } as any);

    // 2. UPDATE generation_idempotency updated_at
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    } as any);

    const { step } = createMockStep();
    const fnHandler = (reconcileStaleGenerationsFunction as any).fn;
    const result = await fnHandler({ step });

    expect(result.scanned).toBe(1);
    expect(result.reDispatched).toBe(1);
    expect(result.errors).toBe(0);

    const expectedEventId = generateDeterministicEventId(mockUserId, mockKey);
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'notes/generate.requested',
      id: expectedEventId,
      data: {
        userId: mockUserId,
        idempotencyKey: mockKey,
        videoId: 'dQw4w9WgXcQ',
        videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      },
    });
  });
});
