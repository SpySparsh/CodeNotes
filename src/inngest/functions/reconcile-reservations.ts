import { inngest } from '../client';
import { reconcileStaleReservations, reconcileDayBoundaryRollover } from '@/lib/quota-client';
import { logger } from '@/lib/logger';

/**
 * Periodically scans and cleans up stale quota reservations left behind by crashed or timed-out workers.
 * Runs every 2 minutes.
 */
export const reconcileStaleReservationsFunction = inngest.createFunction(
  {
    id: 'reconcile-stale-reservations',
    name: 'Reconcile Stale Quota Reservations',
    triggers: [{ cron: '*/2 * * * *' }],
  },
  async ({ step }) => {
    return await step.run('reconcile-stale-reservations-batch', async () => {
      try {
        const count = await reconcileStaleReservations(50);
        logger.info('inngest_reconcile_stale_reservations_completed', {
          reconciledCount: count,
        });
        return { reconciledCount: count };
      } catch (err: any) {
        logger.error('inngest_reconcile_stale_reservations_failed', {
          errorMessage: err?.message,
        });
        throw err;
      }
    });
  }
);

/**
 * Reconciles day-boundary rolling quota counters at midnight Pacific / UTC rollover.
 * Runs daily at midnight UTC.
 */
export const reconcileDayBoundaryRolloverFunction = inngest.createFunction(
  {
    id: 'reconcile-day-boundary-rollover',
    name: 'Reconcile Day Boundary Quota Rollover',
    triggers: [{ cron: '0 0 * * *' }],
  },
  async ({ step }) => {
    return await step.run('reconcile-day-boundary-batch', async () => {
      try {
        const count = await reconcileDayBoundaryRollover(50);
        logger.info('inngest_reconcile_day_boundary_rollover_completed', {
          reconciledCount: count,
        });
        return { reconciledCount: count };
      } catch (err: any) {
        logger.error('inngest_reconcile_day_boundary_rollover_failed', {
          errorMessage: err?.message,
        });
        throw err;
      }
    });
  }
);
