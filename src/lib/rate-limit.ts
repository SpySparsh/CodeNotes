import { query } from '@/lib/db';
import { logger } from '@/lib/logger';

export interface RateLimitOptions {
  key: string;
  limit?: number;
  windowSeconds?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  currentCount: number;
}

/**
 * PostgreSQL-backed atomic fixed-window rate limiter.
 *
 * Uses an atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING count
 * against the rate_limit_buckets table.
 *
 * Guarantees:
 * - Atomic check & increment (race condition free under high concurrency).
 * - Multi-instance synchronization (backed by shared PostgreSQL).
 * - Bounded database growth (indexed expires_at with opportunistic cleanup).
 * - Fail-open behavior on transient database errors.
 */
export async function checkRateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
  const { key, limit = 5, windowSeconds = 60 } = options;

  const nowMs = Date.now();
  const windowMs = windowSeconds * 1000;
  const currentWindowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  const windowStartDate = new Date(currentWindowStartMs);
  const expiresAtDate = new Date(currentWindowStartMs + windowMs * 2);

  const resetSeconds = Math.max(1, Math.ceil((currentWindowStartMs + windowMs - nowMs) / 1000));

  try {
    const result = await query(
      `INSERT INTO rate_limit_buckets (key, window_start, count, expires_at)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (key, window_start) DO UPDATE
       SET count = rate_limit_buckets.count + 1
       RETURNING count`,
      [key, windowStartDate.toISOString(), expiresAtDate.toISOString()]
    );

    const count = result.rows.length > 0 ? Number(result.rows[0].count) : 1;
    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);

    // Opportunistic cleanup of stale buckets (5% sampling rate)
    if (Math.random() < 0.05) {
      query(`DELETE FROM rate_limit_buckets WHERE expires_at < NOW()`).catch((cleanupErr: any) => {
        logger.warn('rate_limit_cleanup_failed', { errorMessage: cleanupErr?.message });
      });
    }

    return {
      allowed,
      limit,
      remaining,
      resetSeconds,
      currentCount: count,
    };
  } catch (error: any) {
    logger.error('rate_limit_check_error', {
      keyPrefix: key.split(':')[0],
      errorMessage: error?.message,
    });

    // Fail-open: do not block legitimate requests if rate-limiting infrastructure encounters a transient DB error
    return {
      allowed: true,
      limit,
      remaining: 1,
      resetSeconds,
      currentCount: 1,
    };
  }
}
