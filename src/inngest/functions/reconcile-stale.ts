import { inngest, generateDeterministicEventId } from '../client';
import { query } from '@/lib/db';
import { logger } from '@/lib/logger';

export interface ReconciliationResult {
  scanned: number;
  reDispatched: number;
  errors: number;
}

export const reconcileStaleGenerationsFunction = inngest.createFunction(
  {
    id: 'reconcile-stale-generations',
    name: 'Reconcile Stale Note Generations',
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ step }) => {
    return await step.run('reconcile-stale-db-records', async (): Promise<ReconciliationResult> => {
      const result: ReconciliationResult = {
        scanned: 0,
        reDispatched: 0,
        errors: 0,
      };

      try {
        const staleRecords = await query(
          `SELECT user_id, key, status, video_id, video_url, created_at, updated_at, lease_until
           FROM generation_idempotency
           WHERE (status = 'pending' AND COALESCE(updated_at, created_at) < NOW() - INTERVAL '60 seconds')
              OR (status = 'processing' AND (lease_until IS NULL OR lease_until < NOW()))
           ORDER BY created_at ASC
           LIMIT 50`
        );

        result.scanned = staleRecords.rows.length;

        if (result.scanned === 0) {
          return result;
        }

        for (const row of staleRecords.rows) {
          try {
            const eventId = generateDeterministicEventId(row.user_id, row.key);

            await inngest.send({
              name: 'notes/generate.requested',
              id: eventId,
              data: {
                userId: row.user_id,
                idempotencyKey: row.key,
                videoId: row.video_id || 'unknown',
                videoUrl: row.video_url || `https://www.youtube.com/watch?v=${row.video_id}`,
              },
            });

            await query(
              `UPDATE generation_idempotency
               SET updated_at = CURRENT_TIMESTAMP
               WHERE user_id = $1 AND key = $2`,
              [row.user_id, row.key]
            );

            result.reDispatched++;
            logger.info('inngest_reconciliation_event_redispatched', {
              eventId,
              userId: row.user_id,
              idempotencyKey: row.key,
              previousStatus: row.status,
            });
          } catch (rowErr: any) {
            result.errors++;
            logger.error('inngest_reconciliation_row_failed', {
              userId: row.user_id,
              idempotencyKey: row.key,
              errorMessage: rowErr.message,
            });
          }
        }
      } catch (scanErr: any) {
        result.errors++;
        logger.error('inngest_reconciliation_scan_failed', {
          errorMessage: scanErr.message,
        });
      }

      return result;
    });
  }
);
