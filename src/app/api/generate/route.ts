import { NextResponse } from 'next/server';
import { fetchTranscript, extractVideoTitle } from '@/lib/transcript';
import { generateNotes } from '@/lib/gemini';
import { query, withTransaction } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/request-context';
import { recordHttpRequest, recordGenerateStageDuration } from '@/lib/metrics';
import crypto from 'crypto';

export const STALE_IDEMPOTENCY_THRESHOLD_MS = 120000;

export async function POST(request: Request) {
  const startTime = performance.now();
  const requestId = getRequestId(request);
  const idempotencyKey = request.headers.get('Idempotency-Key')?.trim() || null;

  try {
    const { url } = await request.json();

    if (!url) {
      const durationMs = performance.now() - startTime;
      recordHttpRequest('POST', '/api/generate', 400, durationMs / 1000);
      logger.warn('generate_request_validation_failed', {
        requestId,
        method: 'POST',
        path: '/api/generate',
        status: 400,
        durationMs,
        reason: 'Missing YouTube URL',
      });
      return NextResponse.json(
        { error: 'YouTube URL is required' },
        { status: 400, headers: { 'x-request-id': requestId } }
      );
    }

    if (idempotencyKey) {
      const acquireResult = await query(
        `INSERT INTO generation_idempotency (key, status)
         VALUES ($1, 'processing')
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [idempotencyKey]
      );

      if (acquireResult.rows.length > 0) {
        logger.info('generation_idempotency_acquired', {
          requestId,
          method: 'POST',
          path: '/api/generate',
        });
      } else {
        const existingRecord = await query(
          `SELECT status, note_id, created_at, updated_at
           FROM generation_idempotency
           WHERE key = $1`,
          [idempotencyKey]
        );

        if (existingRecord.rows.length > 0) {
          const row = existingRecord.rows[0];

          if (row.status === 'completed') {
            const durationMs = performance.now() - startTime;
            recordHttpRequest('POST', '/api/generate', 200, durationMs / 1000);
            logger.info('generation_idempotency_replayed', {
              requestId,
              method: 'POST',
              path: '/api/generate',
              status: 200,
              durationMs,
              noteId: row.note_id,
            });
            return NextResponse.json(
              { success: true, noteId: row.note_id },
              { headers: { 'x-request-id': requestId } }
            );
          }

          if (row.status === 'processing') {
            const lastUpdatedTime = new Date(row.updated_at || row.created_at).getTime();
            const ageMs = Date.now() - lastUpdatedTime;

            if (ageMs > STALE_IDEMPOTENCY_THRESHOLD_MS) {
              const cutoffDate = new Date(Date.now() - STALE_IDEMPOTENCY_THRESHOLD_MS);

              const reclaimResult = await query(
                `UPDATE generation_idempotency
                 SET status = 'processing', updated_at = CURRENT_TIMESTAMP
                 WHERE key = $1 AND status = 'processing' AND COALESCE(updated_at, created_at) < $2
                 RETURNING key`,
                [idempotencyKey, cutoffDate]
              );

              if (reclaimResult.rows.length > 0) {
                logger.warn('generation_idempotency_stale_reclaimed', {
                  requestId,
                  method: 'POST',
                  path: '/api/generate',
                  staleAgeMs: ageMs,
                });
              } else {
                // Lost the atomic reclaim race: re-read state
                const rereadRecord = await query(
                  `SELECT status, note_id FROM generation_idempotency WHERE key = $1`,
                  [idempotencyKey]
                );

                if (rereadRecord.rows.length > 0 && rereadRecord.rows[0].status === 'completed') {
                  const durationMs = performance.now() - startTime;
                  recordHttpRequest('POST', '/api/generate', 200, durationMs / 1000);
                  logger.info('generation_idempotency_replayed', {
                    requestId,
                    method: 'POST',
                    path: '/api/generate',
                    status: 200,
                    durationMs,
                    noteId: rereadRecord.rows[0].note_id,
                  });
                  return NextResponse.json(
                    { success: true, noteId: rereadRecord.rows[0].note_id },
                    { headers: { 'x-request-id': requestId } }
                  );
                }

                const durationMs = performance.now() - startTime;
                recordHttpRequest('POST', '/api/generate', 409, durationMs / 1000);
                logger.warn('generation_idempotency_in_progress', {
                  requestId,
                  method: 'POST',
                  path: '/api/generate',
                  status: 409,
                  durationMs,
                });
                return NextResponse.json(
                  { success: false, error: 'Generation already in progress' },
                  { status: 409, headers: { 'x-request-id': requestId } }
                );
              }
            } else {
              const durationMs = performance.now() - startTime;
              recordHttpRequest('POST', '/api/generate', 409, durationMs / 1000);
              logger.warn('generation_idempotency_in_progress', {
                requestId,
                method: 'POST',
                path: '/api/generate',
                status: 409,
                durationMs,
              });
              return NextResponse.json(
                { success: false, error: 'Generation already in progress' },
                { status: 409, headers: { 'x-request-id': requestId } }
              );
            }
          }
        }
      }
    }

    // 1 & 2. Concurrently fetch transcript and video title
    let transcriptDurationMs = 0;
    let titleDurationMs = 0;

    const transcriptPromise = (async () => {
      const t0 = performance.now();
      const res = await fetchTranscript(url);
      transcriptDurationMs = performance.now() - t0;
      recordGenerateStageDuration('transcript_fetch', transcriptDurationMs / 1000);
      return res;
    })();

    const titlePromise = (async () => {
      const t0 = performance.now();
      const res = await extractVideoTitle(url);
      titleDurationMs = performance.now() - t0;
      recordGenerateStageDuration('title_fetch', titleDurationMs / 1000);
      return res;
    })();

    const [{ text, videoId }, videoTitle] = await Promise.all([
      transcriptPromise,
      titlePromise,
    ]);

    // 3. Generate notes using Gemini
    const t0Gemini = performance.now();
    const aiNotes = await generateNotes(text, videoTitle);
    const geminiDurationMs = performance.now() - t0Gemini;
    recordGenerateStageDuration('gemini_inference', geminiDurationMs / 1000);

    // 4. Save to DB atomically using a PostgreSQL transaction
    const noteId = crypto.randomUUID();
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

    const insertQuery = `
      INSERT INTO notes (id, video_id, video_title, video_url, thumbnail_url, overview, key_concepts, detailed_notes, shorthands)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;

    const t0Db = performance.now();

    await withTransaction(async (client) => {
      await client.query(insertQuery, [
        noteId,
        videoId,
        videoTitle,
        url,
        thumbnailUrl,
        aiNotes.overview,
        aiNotes.keyConcepts,
        aiNotes.detailedNotes,
        aiNotes.shorthands
      ]);

      if (idempotencyKey) {
        await client.query(
          `UPDATE generation_idempotency
           SET status = 'completed',
               note_id = $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE key = $1`,
          [idempotencyKey, noteId]
        );
      }
    });

    const dbDurationMs = performance.now() - t0Db;
    recordGenerateStageDuration('db_insert', dbDurationMs / 1000);

    const totalDurationMs = performance.now() - startTime;
    recordHttpRequest('POST', '/api/generate', 200, totalDurationMs / 1000);

    logger.info('generate_request_completed', {
      requestId,
      method: 'POST',
      path: '/api/generate',
      status: 200,
      durationMs: totalDurationMs,
      videoId,
      timings: {
        transcriptFetchMs: Math.round(transcriptDurationMs * 100) / 100,
        titleFetchMs: Math.round(titleDurationMs * 100) / 100,
        geminiInferenceMs: Math.round(geminiDurationMs * 100) / 100,
        dbInsertMs: Math.round(dbDurationMs * 100) / 100,
      },
    });

    return NextResponse.json(
      { success: true, noteId },
      { headers: { 'x-request-id': requestId } }
    );
  } catch (error: any) {
    if (idempotencyKey) {
      try {
        await query(
          `DELETE FROM generation_idempotency WHERE key = $1 AND status != 'completed'`,
          [idempotencyKey]
        );
        logger.info('generation_idempotency_failed', {
          requestId,
          method: 'POST',
          path: '/api/generate',
        });
      } catch (cleanupErr: any) {
        logger.error('generation_idempotency_cleanup_error', {
          requestId,
          method: 'POST',
          path: '/api/generate',
          errorMessage: cleanupErr.message,
        });
      }
    }

    const durationMs = performance.now() - startTime;
    recordHttpRequest('POST', '/api/generate', 500, durationMs / 1000);
    logger.error('generate_request_failed', {
      requestId,
      method: 'POST',
      path: '/api/generate',
      status: 500,
      durationMs,
      errorMessage: error.message || 'Unknown error',
      errorStack: error.stack,
    });

    let clientErrorMessage = 'Something went wrong while generating your notes. Please try again.';

    if (error.message?.includes('AI generation timed out')) {
      clientErrorMessage = 'Note generation timed out. Please try again with a shorter video.';
    } else if (error.message?.includes('Failed to fetch video transcript')) {
      clientErrorMessage = error.message;
    } else if (error.message?.includes('Invalid YouTube URL')) {
      clientErrorMessage = error.message;
    }

    return NextResponse.json(
      { error: clientErrorMessage },
      { status: 500, headers: { 'x-request-id': requestId } }
    );
  }
}
