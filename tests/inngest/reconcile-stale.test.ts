import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileStaleGenerationsFunction } from '@/inngest/functions/reconcile-stale';
import { inngest, generateDeterministicEventId } from '@/inngest/client';
import * as db from '@/lib/db';
import { registry } from '@/lib/metrics';

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
}));

vi.mock('@/inngest/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/inngest/client')>();
  return {
    ...actual,
    inngest: {
      send: vi.fn().mockResolvedValue({ ids: ['evt-123'] }),
      createFunction: actual.inngest.createFunction.bind(actual.inngest),
    },
  };
});

describe('Inngest Reconcile Stale Generations Cron Function', () => {
  const mockUserId = '123e4567-e89b-12d3-a456-426614174000';
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
    registry.resetMetrics();
  });

  it('is configured with a 5-minute cron schedule', () => {
    const fnTrigger = (reconcileStaleGenerationsFunction as any).opts?.triggers?.[0];
    // In Inngest cron trigger format
    expect(fnTrigger?.cron).toBe('*/5 * * * *');
  });

  it('scans stale pending DB records and re-dispatches missing Inngest events with metrics', async () => {
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

    // 1. Query for stale records
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: staleRecords,
      rowCount: 1,
    } as any);

    // 2. Update updated_at
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

    const metricsText = await registry.metrics();
    expect(metricsText).toContain('codenotes_reconciliation_runs_total{status="success"} 1');
    expect(metricsText).toContain('codenotes_stale_jobs_recovered_total 1');
  });

  it('handles empty stale records list cleanly and records success without incrementing recovery counter', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as any);

    const { step } = createMockStep();
    const fnHandler = (reconcileStaleGenerationsFunction as any).fn;
    const result = await fnHandler({ step });

    expect(result.scanned).toBe(0);
    expect(result.reDispatched).toBe(0);
    expect(result.errors).toBe(0);
    expect(inngest.send).not.toHaveBeenCalled();

    const metricsText = await registry.metrics();
    expect(metricsText).toContain('codenotes_reconciliation_runs_total{status="success"} 1');
    expect(metricsText).toContain('codenotes_stale_jobs_recovered_total 0');
  });

  it('records error metric when database scan query fails', async () => {
    vi.mocked(db.query).mockRejectedValueOnce(new Error('DB Connection Failure'));

    const { step } = createMockStep();
    const fnHandler = (reconcileStaleGenerationsFunction as any).fn;
    const result = await fnHandler({ step });

    expect(result.scanned).toBe(0);
    expect(result.errors).toBe(1);

    const metricsText = await registry.metrics();
    expect(metricsText).toContain('codenotes_reconciliation_runs_total{status="error"} 1');
    expect(metricsText).toContain('codenotes_stale_jobs_recovered_total 0');
  });
});
