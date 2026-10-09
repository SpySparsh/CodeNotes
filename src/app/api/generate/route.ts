import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { extractVideoId, validateYouTubeUrl } from '@/lib/transcript';
import { query } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/request-context';
import { recordHttpRequest, recordRateLimitRejection } from '@/lib/metrics';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { inngest, generateDeterministicEventId } from '@/inngest/client';
import { generateUrlSchema } from '@/lib/validations/generate';
import { checkRateLimit } from '@/lib/rate-limit';

export const STALE_IDEMPOTENCY_THRESHOLD_MS = 120000;

export async function POST(request: Request) {
  const startTime = performance.now();
  const requestId = getRequestId(request);
  let authenticatedUserId: string | null = null;

  try {
    const user = await requireUser();
    authenticatedUserId = user.id;

    const body = await request.json().catch(() => ({}));
    const parseResult = generateUrlSchema.safeParse(body);

    if (!parseResult.success) {
      const durationMs = performance.now() - startTime;
      recordHttpRequest('POST', '/api/generate', 400, durationMs / 1000);
      logger.warn('generate_request_validation_failed', {
        requestId,
        userId: authenticatedUserId,
        method: 'POST',
        path: '/api/generate',
        status: 400,
        durationMs,
        errors: parseResult.error.flatten(),
      });
      return NextResponse.json(
        { error: parseResult.error.issues[0]?.message || 'YouTube URL is required' },
        { status: 400, headers: { 'x-request-id': requestId } }
      );
    }

    const { url } = parseResult.data;

    try {
      validateYouTubeUrl(url);
    } catch {
      const durationMs = performance.now() - startTime;
      recordHttpRequest('POST', '/api/generate', 400, durationMs / 1000);
      return NextResponse.json(
        { error: 'Invalid YouTube URL' },
        { status: 400, headers: { 'x-request-id': requestId } }
      );
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      const durationMs = performance.now() - startTime;
      recordHttpRequest('POST', '/api/generate', 400, durationMs / 1000);
      return NextResponse.json(
        { error: 'Invalid YouTube URL' },
        { status: 400, headers: { 'x-request-id': requestId } }
      );
    }

    // Rate limiting: 5 generation requests per user per 60-second window
    const rateLimit = await checkRateLimit({
      key: `generate:${authenticatedUserId}`,
      limit: 5,
      windowSeconds: 60,
    });

    if (!rateLimit.allowed) {
      const durationMs = performance.now() - startTime;
      recordHttpRequest('POST', '/api/generate', 429, durationMs / 1000);
      recordRateLimitRejection('/api/generate');
      logger.warn('generate_request_rate_limited', {
        requestId,
        userId: authenticatedUserId,
        method: 'POST',
        path: '/api/generate',
        status: 429,
        durationMs,
        resetSeconds: rateLimit.resetSeconds,
      });

      return NextResponse.json(
        { error: 'Too many generation requests. Please try again later.' },
        {
          status: 429,
          headers: {
            'x-request-id': requestId,
            'Retry-After': rateLimit.resetSeconds.toString(),
          },
        }
      );
    }

    const clientProvidedKey = request.headers.get('Idempotency-Key')?.trim();
    const idempotencyKey =
      clientProvidedKey ||
      crypto.createHash('sha256').update(`${authenticatedUserId}:${videoId}`).digest('hex');

    const eventId = generateDeterministicEventId(authenticatedUserId, idempotencyKey);

    // Check existing idempotency state
    const existing = await query(
      `SELECT status, video_id, video_url, note_id, error_message, error_code, created_at, updated_at
       FROM generation_idempotency
       WHERE user_id = $1 AND key = $2`,
      [authenticatedUserId, idempotencyKey]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];

      // Mismatch check: verify same idempotency key is not reused for a different video
      if (row.video_id && row.video_id !== videoId) {
        const durationMs = performance.now() - startTime;
        recordHttpRequest('POST', '/api/generate', 422, durationMs / 1000);
        logger.warn('generation_idempotency_payload_mismatch', {
          requestId,
          userId: authenticatedUserId,
          idempotencyKey,
          existingVideoId: row.video_id,
          requestedVideoId: videoId,
        });
        return NextResponse.json(
          {
            error: 'Idempotency key already used for a different video',
            code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
          },
          { status: 422, headers: { 'x-request-id': requestId } }
        );
      }

      // 1. If completed: return cached noteId directly
      if (row.status === 'completed' && row.note_id) {
        const durationMs = performance.now() - startTime;
        recordHttpRequest('POST', '/api/generate', 200, durationMs / 1000);
        logger.info('generation_idempotency_replayed', {
          requestId,
          userId: authenticatedUserId,
          method: 'POST',
          path: '/api/generate',
          status: 200,
          durationMs,
          noteId: row.note_id,
        });
        return NextResponse.json(
          {
            success: true,
            status: 'completed',
            noteId: row.note_id,
            cached: true,
          },
          { status: 200, headers: { 'x-request-id': requestId } }
        );
      }

      // 2. If already pending or processing
      if (row.status === 'pending' || row.status === 'processing') {
        const lastUpdated = new Date(row.updated_at || row.created_at).getTime();
        const ageMs = Date.now() - lastUpdated;

        if (ageMs > STALE_IDEMPOTENCY_THRESHOLD_MS) {
          // Reclaim stale job and re-send event to Inngest
          await query(
            `UPDATE generation_idempotency
             SET status = 'pending',
                 updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $1 AND key = $2`,
            [authenticatedUserId, idempotencyKey]
          );

          try {
            await inngest.send({
              name: 'notes/generate.requested',
              id: eventId,
              data: {
                userId: authenticatedUserId,
                idempotencyKey,
                videoId,
                videoUrl: url,
              },
            });
          } catch (sendErr: any) {
            logger.warn('generation_stale_requeue_deferred', {
              eventId,
              userId: authenticatedUserId,
              errorMessage: sendErr.message,
            });
          }

          const durationMs = performance.now() - startTime;
          recordHttpRequest('POST', '/api/generate', 202, durationMs / 1000);
          logger.warn('generation_idempotency_stale_requeued', {
            requestId,
            userId: authenticatedUserId,
            eventId,
            ageMs,
          });

          return NextResponse.json(
            {
              success: true,
              status: 'pending',
              jobId: eventId,
              idempotencyKey,
              message: 'Stale generation recovered and queued',
            },
            { status: 202, headers: { 'x-request-id': requestId } }
          );
        }

        // Fresh pending/processing job in flight: return existing job info
        const durationMs = performance.now() - startTime;
        recordHttpRequest('POST', '/api/generate', 202, durationMs / 1000);
        logger.info('generation_idempotency_in_progress', {
          requestId,
          userId: authenticatedUserId,
          jobId: eventId,
          status: row.status,
        });

        return NextResponse.json(
          {
            success: true,
            status: row.status,
            jobId: eventId,
            idempotencyKey,
            message: 'Generation already in progress',
          },
          { status: 202, headers: { 'x-request-id': requestId } }
        );
      }

      // 3. If failed: allow re-triggering by updating status to pending
      if (row.status === 'failed') {
        await query(
          `UPDATE generation_idempotency
           SET status = 'pending',
               video_id = $3,
               video_url = $4,
               error_message = NULL,
               error_code = NULL,
               attempts = 0,
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $1 AND key = $2`,
          [authenticatedUserId, idempotencyKey, videoId, url]
        );

        try {
          await inngest.send({
            name: 'notes/generate.requested',
            id: eventId,
            data: {
              userId: authenticatedUserId,
              idempotencyKey,
              videoId,
              videoUrl: url,
            },
          });
        } catch (sendErr: any) {
          logger.warn('generation_retry_enqueue_deferred', {
            eventId,
            userId: authenticatedUserId,
            errorMessage: sendErr.message,
          });
        }

        const durationMs = performance.now() - startTime;
        recordHttpRequest('POST', '/api/generate', 202, durationMs / 1000);
        return NextResponse.json(
          {
            success: true,
            status: 'pending',
            jobId: eventId,
            idempotencyKey,
          },
          { status: 202, headers: { 'x-request-id': requestId } }
        );
      }
    }

    // 4. New generation request: insert pending row then dispatch Inngest event
    await query(
      `INSERT INTO generation_idempotency (user_id, key, status, video_id, video_url, created_at, updated_at)
       VALUES ($1, $2, 'pending', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, key) DO UPDATE
       SET updated_at = CURRENT_TIMESTAMP
       WHERE generation_idempotency.status != 'completed'`,
      [authenticatedUserId, idempotencyKey, videoId, url]
    );

    try {
      await inngest.send({
        name: 'notes/generate.requested',
        id: eventId,
        data: {
          userId: authenticatedUserId,
          idempotencyKey,
          videoId,
          videoUrl: url,
        },
      });
    } catch (inngestErr: any) {
      // Retain the durable PostgreSQL pending record. Do NOT delete it.
      // The background Inngest cron reconciler ensures crash-safe recovery.
      logger.error('generation_inngest_send_deferred', {
        requestId,
        userId: authenticatedUserId,
        idempotencyKey,
        errorMessage: inngestErr.message,
      });
    }

    const durationMs = performance.now() - startTime;
    recordHttpRequest('POST', '/api/generate', 202, durationMs / 1000);

    logger.info('generation_job_queued', {
      requestId,
      userId: authenticatedUserId,
      method: 'POST',
      path: '/api/generate',
      status: 202,
      durationMs,
      videoId,
      jobId: eventId,
      idempotencyKey,
    });

    return NextResponse.json(
      {
        success: true,
        status: 'pending',
        jobId: eventId,
        idempotencyKey,
      },
      { status: 202, headers: { 'x-request-id': requestId } }
    );
  } catch (error: any) {
    const durationMs = performance.now() - startTime;

    if (error instanceof UnauthorizedError || error.name === 'UnauthorizedError') {
      recordHttpRequest('POST', '/api/generate', 401, durationMs / 1000);
      logger.warn('generate_request_unauthorized', {
        requestId,
        method: 'POST',
        path: '/api/generate',
        status: 401,
        durationMs,
      });

      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: { 'x-request-id': requestId } }
      );
    }

    recordHttpRequest('POST', '/api/generate', 500, durationMs / 1000);
    logger.error('generate_request_failed', {
      requestId,
      userId: authenticatedUserId || undefined,
      method: 'POST',
      path: '/api/generate',
      status: 500,
      durationMs,
      errorMessage: error.message || 'Unknown error',
      errorStack: error.stack,
    });

    return NextResponse.json(
      { error: error.message || 'Failed to process generation request' },
      { status: 500, headers: { 'x-request-id': requestId } }
    );
  }
}
