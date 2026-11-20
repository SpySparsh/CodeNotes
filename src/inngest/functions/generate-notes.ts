import { NonRetriableError } from 'inngest';
import crypto from 'crypto';
import { inngest } from '../client';
import {
  acquireTranscript,
  extractVideoTitle,
  extractVideoId,
  validateYouTubeUrl,
  TranscriptError,
} from '@/lib/transcript';
import {
  generateAiNotes,
  GeneratedNotes,
  AiClientError,
  generateChunkAiNotes,
  synthesizeSectionNotes,
  DEFAULT_AI_MODEL,
  type ChunkSummary,
} from '@/lib/ai-client';
import {
  planChunkManifest,
  sliceByCodePoints,
  getCodePointLength,
  MAX_CHUNK_CHARS,
  type ChunkManifest,
} from '@/lib/chunk-planner';
import {
  reserveQuota,
  markReservationDispatching,
  completeChunkAndCommitQuota,
  releaseQuotaReservation,
  releaseAbortedDispatch,
  QuotaError,
  isRateLimitExceeded,
} from '@/lib/quota-client';
import { query, withUserTransaction } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  recordGenerationJob,
  recordGenerationStageDuration,
  recordGenerationDuration,
} from '@/lib/metrics';
import { withSpan } from '@/lib/tracing';
import * as Sentry from '@sentry/nextjs';

export function classifyError(error: any): { isUnrecoverable: boolean; code: string; message: string } {
  if (error instanceof NonRetriableError) {
    return {
      isUnrecoverable: true,
      code: 'NON_RETRIABLE_ERROR',
      message: error.message,
    };
  }

  if (error instanceof TranscriptError) {
    return {
      isUnrecoverable: !error.isRetryable,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof AiClientError || error?.name === 'AiClientError') {
    return {
      isUnrecoverable: !error.isRetryable,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof QuotaError || error?.name === 'QuotaError') {
    return {
      isUnrecoverable: !error.isRetryable,
      code: error.statusCode,
      message: error.message,
    };
  }

  const msg = error?.message || 'Unknown error occurred during note generation';

  // Domain non-retryable errors
  if (msg.includes('Idempotency key payload mismatch')) {
    return {
      isUnrecoverable: true,
      code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
      message: 'Idempotency key already used for a different video',
    };
  }

  if (msg.includes('Invalid YouTube URL') || msg.includes('not a valid YouTube video')) {
    return {
      isUnrecoverable: true,
      code: 'INVALID_URL',
      message: 'The provided URL is not a valid YouTube video.',
    };
  }

  if (
    msg.includes('Failed to fetch video transcript') ||
    msg.includes('Captions are disabled or unavailable') ||
    msg.includes('Transcript unavailable')
  ) {
    if (!msg.includes('timed out') && !msg.includes('ETIMEDOUT')) {
      return {
        isUnrecoverable: true,
        code: 'TRANSCRIPT_UNAVAILABLE',
        message: 'Captions are disabled or unavailable for this video.',
      };
    }
  }

  if (msg.includes('AI returned malformed data')) {
    return {
      isUnrecoverable: true,
      code: 'MALFORMED_AI_OUTPUT',
      message: 'The AI model output could not be parsed into notes format.',
    };
  }

  if (msg.includes('API key is missing') || msg.includes('SUPADATA_API_KEY is not configured')) {
    return {
      isUnrecoverable: true,
      code: 'CONFIG_ERROR',
      message: 'AI generation service is not properly configured.',
    };
  }

  // Quota exhausted - non-retryable
  if (msg.includes('monthly quota exceeded') || msg.includes('quota exceeded')) {
    return {
      isUnrecoverable: true,
      code: 'TRANSCRIPT_PROVIDER_QUOTA_EXCEEDED',
      message: 'Transcript provider quota exceeded.',
    };
  }

  // Rate limit / Quota errors - retryable
  if (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('rate limit') ||
    msg.includes('RATE_LIMIT') ||
    msg.includes('Quota reservation failed') ||
    isRateLimitExceeded(msg)
  ) {
    return {
      isUnrecoverable: false,
      code: 'RATE_LIMITED',
      message: 'Generation service is temporarily busy. Retrying...',
    };
  }

  // Timeout / Network errors - retryable
  if (msg.includes('timed out') || msg.includes('timeout') || msg.includes('ECONNRESET')) {
    return {
      isUnrecoverable: false,
      code: 'TIMEOUT',
      message: 'Request timed out while contacting external services. Retrying...',
    };
  }

  // Database transient failures - retryable
  if (msg.includes('Connection terminated') || msg.includes('connection timeout')) {
    return {
      isUnrecoverable: false,
      code: 'DB_TRANSIENT_ERROR',
      message: 'Temporary database connectivity issue. Retrying...',
    };
  }

  return {
    isUnrecoverable: false,
    code: 'GENERATION_ERROR',
    message: msg,
  };
}

export const generateNotesFunction = inngest.createFunction(
  {
    id: 'generate-notes',
    name: 'Generate Notes from YouTube Video',
    triggers: [{ event: 'notes/generate.requested' }],
    retries: 2,
    timeouts: { finish: '30m' },
    onFailure: async ({ event, error }: { event: any; error: any }) => {
      const originalEvent = event.data?.event || event;
      const { userId, idempotencyKey, videoId } = originalEvent.data || {};
      const classification = classifyError(error);

      logger.error('inngest_generation_failed_permanently', {
        userId,
        idempotencyKey,
        videoId,
        errorCode: classification.code,
        errorMessage: classification.message,
      });

      try {
        Sentry.withScope((scope) => {
          scope.setTag('inngest.function', 'generate-notes');
          scope.setTag('error.code', classification.code);
          scope.setTag('error.unrecoverable', String(classification.isUnrecoverable));
          const sentryError = error instanceof Error ? error : new Error(classification.message);
          Sentry.captureException(sentryError);
        });
        await Sentry.flush(1500).catch(() => {});
      } catch {
        // Failsafe: Sentry reporting failure never interrupts generation recovery
      }

      let createdAtDate: Date | null = null;

      if (userId && idempotencyKey) {
        try {
          const updateRes = await query(
            `UPDATE generation_idempotency
             SET status = 'failed',
                 error_message = $3,
                 error_code = $4,
                 lease_until = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $1 AND key = $2
             RETURNING created_at`,
            [userId, idempotencyKey, classification.message, classification.code]
          );
          if (updateRes.rows.length > 0 && updateRes.rows[0].created_at) {
            createdAtDate = new Date(updateRes.rows[0].created_at);
          }
        } catch (dbErr: any) {
          logger.error('inngest_failed_to_update_failure_state', {
            userId,
            idempotencyKey,
            errorMessage: dbErr.message,
          });
        }
      }

      recordGenerationJob('failed');
      if (createdAtDate) {
        const durationSeconds = Math.max(0, (Date.now() - createdAtDate.getTime()) / 1000);
        recordGenerationDuration('failed', durationSeconds);
      }
    },
  },
  async ({ event, step }) => {
    const { userId, idempotencyKey, videoId, videoUrl } = event.data as any;

    logger.info('inngest_generation_function_started', {
      userId,
      idempotencyKey,
      videoId,
    });

    // Step 1: Atomic Claim and Idempotency Validation
    const claimResult = await step.run('claim-generation-processing', async (): Promise<{
      claimed: boolean;
      skipped: boolean;
      noteId?: string;
      reason?: string;
      videoId?: string;
      videoUrl?: string;
    }> => {
      const stageStart = performance.now();
      try {
        return await withSpan('db.claim_generation_processing', async (span) => {
          span.setAttribute('operation', 'claim_generation_processing');

          const existing = await query(
            `SELECT status, video_id, note_id, lease_until FROM generation_idempotency WHERE user_id = $1 AND key = $2`,
            [userId, idempotencyKey]
          );

          if (existing.rows.length === 0) {
            logger.warn('inngest_missing_idempotency_record', { userId, idempotencyKey, videoId });
            throw new NonRetriableError('Idempotency record not found in database');
          }

          const record = existing.rows[0];

          // Payload mismatch validation
          if (record.video_id && videoId && record.video_id !== videoId) {
            logger.error('inngest_payload_mismatch', {
              userId,
              idempotencyKey,
              existingVideoId: record.video_id,
              requestedVideoId: videoId,
            });
            throw new NonRetriableError('Idempotency key payload mismatch: video ID mismatch');
          }

          // If already completed, skip duplicate work
          if (record.status === 'completed' && record.note_id) {
            logger.info('inngest_job_already_completed', {
              userId,
              idempotencyKey,
              noteId: record.note_id,
            });
            span.setAttribute('status', 'skipped_already_completed');
            return { claimed: false, skipped: true, noteId: record.note_id };
          }

          // Check lease: if already processing with active future lease, skip
          if (
            record.status === 'processing' &&
            record.lease_until &&
            new Date(record.lease_until).getTime() > Date.now()
          ) {
            logger.info('inngest_active_lease_held', {
              userId,
              idempotencyKey,
              leaseUntil: record.lease_until,
            });
            span.setAttribute('status', 'skipped_active_lease');
            return { claimed: false, skipped: true, reason: 'Active lease held by another execution' };
          }

          // Claim lease for 15 minutes
          await query(
            `UPDATE generation_idempotency
             SET status = 'processing',
                 video_id = COALESCE(video_id, $3),
                 video_url = COALESCE(video_url, $4),
                 attempts = COALESCE(attempts, 0) + 1,
                 lease_until = NOW() + INTERVAL '15 minutes',
                 updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $1 AND key = $2`,
            [userId, idempotencyKey, videoId, videoUrl]
          );

          span.setAttribute('status', 'success');
          return { claimed: true, skipped: false, videoId, videoUrl };
        });
      } finally {
        recordGenerationStageDuration('claim', (performance.now() - stageStart) / 1000);
      }
    });

    if (claimResult.skipped) {
      return claimResult;
    }

    // Step 2: Fetch Transcript and Video Title (Outside DB transaction)
    const mediaData = await step.run('fetch-transcript-and-title', async (): Promise<{
      resolvedVideoId: string;
      videoTitle: string;
      transcriptText: string;
      transcriptProvider: string;
    }> => {
      const stageStart = performance.now();
      try {
        try {
          validateYouTubeUrl(videoUrl);
        } catch (err: any) {
          throw new NonRetriableError(err.message || 'Invalid YouTube URL');
        }

        const resolvedVideoId = videoId || extractVideoId(videoUrl);
        if (!resolvedVideoId) {
          throw new NonRetriableError('Invalid YouTube URL: could not extract video ID');
        }

        let transcriptResult: { text: string; videoId: string; provider: string };
        let videoTitle = 'Unknown Video';

        try {
          const [transRes, titleRes] = await Promise.all([
            acquireTranscript(videoUrl),
            extractVideoTitle(videoUrl).catch(() => 'Unknown Video'),
          ]);
          transcriptResult = transRes;
          videoTitle = titleRes;
        } catch (err: any) {
          const classification = classifyError(err);
          if (classification.isUnrecoverable) {
            throw new NonRetriableError(classification.message);
          }
          throw err;
        }

        if (!transcriptResult || !transcriptResult.text || transcriptResult.text.trim().length === 0) {
          throw new NonRetriableError('Captions are disabled or unavailable for this video.');
        }

        return {
          resolvedVideoId: transcriptResult.videoId || resolvedVideoId,
          videoTitle,
          transcriptText: transcriptResult.text,
          transcriptProvider: transcriptResult.provider,
        };
      } finally {
        recordGenerationStageDuration('transcript_fetch', (performance.now() - stageStart) / 1000);
      }
    });

    const totalCodePoints = getCodePointLength(mediaData.transcriptText);
    const isMultiChunk = totalCodePoints > MAX_CHUNK_CHARS;

    // -------------------------------------------------------------------------
    // BRANCH A: Single-Chunk Monolithic Path (Backward Compatibility)
    // -------------------------------------------------------------------------
    if (!isMultiChunk) {
      // Step 3: AI Generation with FastAPI AI Service (Outside DB transaction)
      const generatedNotes = await step.run('generate-ai-notes', async () => {
        const stageStart = performance.now();
        try {
          let aiNotes: GeneratedNotes;

          try {
            if (!mediaData.transcriptText) {
              throw new NonRetriableError('Transcript text is required for AI note generation.');
            }
            aiNotes = await withSpan('fastapi.http_request', async (span) => {
              return await generateAiNotes(mediaData.transcriptText, mediaData.videoTitle, {
                requestId: idempotencyKey,
                span,
              });
            });
          } catch (err: any) {
            const classification = classifyError(err);
            if (classification.isUnrecoverable) {
              throw new NonRetriableError(classification.message);
            }
            throw err;
          }

          if (!aiNotes || !aiNotes.overview) {
            throw new NonRetriableError('AI returned malformed data.');
          }

          return {
            aiNotes,
            generationMethod: 'transcript' as const,
            transcriptProvider: mediaData.transcriptProvider,
          };
        } finally {
          recordGenerationStageDuration('gemini_inference', (performance.now() - stageStart) / 1000);
        }
      });

      // Step 4: Atomic Persistence in Database with User Transaction & RLS
      const persistResult = await step.run('persist-notes', async () => {
        const stageStart = performance.now();
        try {
          const noteId = crypto.randomUUID();
          const thumbnailUrl = `https://img.youtube.com/vi/${mediaData.resolvedVideoId}/maxresdefault.jpg`;

          let createdAtEpochMs: number | null = null;

          await withSpan('db.persist_notes_transaction', async (span) => {
            span.setAttribute('operation', 'persist_notes');
            await withUserTransaction(userId, async (client) => {
              // Re-check status inside transaction with row lock to avoid race conditions
              const checkRes = await client.query(
                `SELECT status, note_id, created_at FROM generation_idempotency WHERE user_id = $1 AND key = $2 FOR UPDATE`,
                [userId, idempotencyKey]
              );

              if (checkRes.rows.length > 0) {
                createdAtEpochMs = checkRes.rows[0].created_at ? new Date(checkRes.rows[0].created_at).getTime() : null;
                if (checkRes.rows[0].status === 'completed' && checkRes.rows[0].note_id) {
                  span.setAttribute('status', 'skipped_already_completed');
                  return;
                }
              }

              await client.query(
                `INSERT INTO notes (id, user_id, video_id, video_title, video_url, thumbnail_url, overview, key_concepts, detailed_notes, shorthands)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                  noteId,
                  userId,
                  mediaData.resolvedVideoId,
                  mediaData.videoTitle,
                  videoUrl,
                  thumbnailUrl,
                  generatedNotes.aiNotes.overview,
                  generatedNotes.aiNotes.keyConcepts,
                  generatedNotes.aiNotes.detailedNotes,
                  generatedNotes.aiNotes.shorthands,
                ]
              );

              await client.query(
                `UPDATE generation_idempotency
                 SET status = 'completed',
                     note_id = $3,
                     error_message = NULL,
                     error_code = NULL,
                     lease_until = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $1 AND key = $2`,
                [userId, idempotencyKey, noteId]
              );
            });
            span.setAttribute('status', 'success');
          });

          recordGenerationJob('completed');

          const durationSeconds = typeof createdAtEpochMs === 'number'
            ? Math.max(0, (Date.now() - (createdAtEpochMs as number)) / 1000)
            : (performance.now() - stageStart) / 1000;
          recordGenerationDuration('completed', durationSeconds);

          logger.info('inngest_generation_completed_successfully', {
            userId,
            videoId: mediaData.resolvedVideoId,
            idempotencyKey,
            noteId,
            generationMethod: generatedNotes.generationMethod,
            transcriptProvider: generatedNotes.transcriptProvider,
            durationSeconds,
          });

          return { success: true, noteId };
        } finally {
          recordGenerationStageDuration('db_persist', (performance.now() - stageStart) / 1000);
        }
      });

      return persistResult;
    }

    // -------------------------------------------------------------------------
    // BRANCH B: Adaptive Multi-Chunk Orchestration (>1 chunk)
    // -------------------------------------------------------------------------
    // Step 3a: Plan Chunk Manifest
    const manifest = await step.run('plan-chunk-manifest', async (): Promise<ChunkManifest> => {
      logger.info('inngest_planning_chunk_manifest', {
        userId,
        idempotencyKey,
        videoId: mediaData.resolvedVideoId,
        totalCodePoints,
      });
      return planChunkManifest(mediaData.resolvedVideoId, mediaData.transcriptText);
    });

    // Step 3b: Parallel Fan-Out Generation for each chunk
    const chunkPromises = manifest.chunks.map((chunk) => {
      return step.run(`generate-chunk-${chunk.chunkIndex}`, async () => {
        const workerId = crypto.randomUUID();
        const chunkText = sliceByCodePoints(mediaData.transcriptText, chunk.startChar, chunk.endChar);

        logger.info('inngest_chunk_generation_started', {
          userId,
          idempotencyKey,
          chunkIndex: chunk.chunkIndex,
          totalChunks: manifest.totalChunks,
          codePointCount: chunk.codePointCount,
          workerId,
        });

        // 1. Reserve Quota
        let reserveRes;
        try {
          reserveRes = await reserveQuota({
            userId,
            parentKey: idempotencyKey,
            chunkIndex: chunk.chunkIndex,
            projectId: 'codenotes',
            quotaScope: DEFAULT_AI_MODEL,
            modelName: DEFAULT_AI_MODEL,
            workerId,
            estimatedTokens: chunk.estimatedTokens,
            leaseDurationInterval: '300 seconds',
          });
        } catch (resErr: any) {
          logger.error('inngest_quota_reservation_call_error', {
            userId,
            idempotencyKey,
            chunkIndex: chunk.chunkIndex,
            errorMessage: resErr?.message,
          });
          throw resErr;
        }

        if (reserveRes.statusCode === 'ALREADY_COMMITTED') {
          logger.info('inngest_chunk_already_committed', {
            userId,
            idempotencyKey,
            chunkIndex: chunk.chunkIndex,
          });
          const existingChunk = await query(
            `SELECT chunk_notes, prompt_tokens, candidate_tokens, thoughts_tokens, total_tokens
             FROM public.chunk_generations
             WHERE user_id = $1 AND parent_key = $2 AND chunk_index = $3`,
            [userId, idempotencyKey, chunk.chunkIndex]
          );
          if (existingChunk.rows.length > 0) {
            const row = existingChunk.rows[0];
            return {
              chunkIndex: chunk.chunkIndex,
              overview: row.chunk_notes.overview,
              keyConcepts: row.chunk_notes.keyConcepts || [],
              shorthands: row.chunk_notes.shorthands || [],
              detailedNotes: row.chunk_notes.detailedNotes,
              tokens: {
                promptTokens: row.prompt_tokens,
                candidateTokens: row.candidate_tokens,
                thoughtsTokens: row.thoughts_tokens,
                totalTokens: row.total_tokens,
              },
            };
          }
        }

        if (!reserveRes.allowed || !reserveRes.reservationToken || !reserveRes.leaseToken) {
          logger.warn('inngest_quota_reservation_rejected', {
            userId,
            idempotencyKey,
            chunkIndex: chunk.chunkIndex,
            statusCode: reserveRes.statusCode,
          });
          throw new Error(`Quota reservation failed: ${reserveRes.statusCode}`);
        }

        const reservationToken = reserveRes.reservationToken;
        const leaseToken = reserveRes.leaseToken;
        const generation = reserveRes.generation ?? 1;

        // 2. Mark Dispatching
        const dispatchRes = await markReservationDispatching({
          reservationToken,
          leaseToken,
          workerId,
          generation,
          leaseDurationInterval: '300 seconds',
        });

        if (!dispatchRes.success) {
          await releaseQuotaReservation({
            reservationToken,
            leaseToken,
            workerId,
            generation,
          }).catch((relErr) => {
            logger.error('inngest_release_reservation_error', { err: relErr?.message });
          });
          throw new Error(`Mark reservation dispatching failed: ${dispatchRes.statusCode}`);
        }

        // 3. Generate Chunk AI Notes
        let chunkNotes;
        try {
          chunkNotes = await generateChunkAiNotes(
            chunkText,
            mediaData.videoTitle,
            chunk.chunkIndex,
            manifest.totalChunks,
            {
              requestId: `${idempotencyKey}-chunk-${chunk.chunkIndex}`,
            }
          );
        } catch (genErr: any) {
          logger.error('inngest_chunk_ai_generation_failed', {
            userId,
            idempotencyKey,
            chunkIndex: chunk.chunkIndex,
            errorMessage: genErr?.message,
          });
          await releaseAbortedDispatch({
            reservationToken,
            leaseToken,
            workerId,
            generation,
            reason: genErr?.message || 'Chunk AI generation failure',
          }).catch((relErr) => {
            logger.error('inngest_release_aborted_dispatch_error', { err: relErr?.message });
          });
          throw genErr;
        }

        // 4. Complete Chunk and Commit Quota
        const commitRes = await completeChunkAndCommitQuota({
          userId,
          parentKey: idempotencyKey,
          chunkIndex: chunk.chunkIndex,
          reservationToken,
          leaseToken,
          workerId,
          fencingGeneration: generation,
          chunkNotes: {
            overview: chunkNotes.overview,
            keyConcepts: chunkNotes.keyConcepts,
            detailedNotes: chunkNotes.detailedNotes,
            shorthands: chunkNotes.shorthands,
          },
          totalTokens: chunkNotes.usage?.totalTokens ?? chunkNotes.totalTokens ?? 0,
          promptTokens: chunkNotes.usage?.promptTokens ?? chunkNotes.promptTokens ?? 0,
          candidateTokens: chunkNotes.usage?.candidateTokens ?? chunkNotes.candidateTokens ?? 0,
          thoughtsTokens: chunkNotes.usage?.thoughtsTokens ?? chunkNotes.thoughtsTokens ?? 0,
          modelName: DEFAULT_AI_MODEL,
        });

        if (!commitRes.success) {
          throw new Error(`Complete chunk and commit quota failed: ${commitRes.statusCode}`);
        }

        logger.info('inngest_chunk_committed_successfully', {
          userId,
          idempotencyKey,
          chunkIndex: chunk.chunkIndex,
        });

        return {
          chunkIndex: chunk.chunkIndex,
          overview: chunkNotes.overview,
          keyConcepts: chunkNotes.keyConcepts,
          shorthands: chunkNotes.shorthands,
          detailedNotes: chunkNotes.detailedNotes,
          tokens: {
            promptTokens: chunkNotes.usage?.promptTokens ?? chunkNotes.promptTokens ?? 0,
            candidateTokens: chunkNotes.usage?.candidateTokens ?? chunkNotes.candidateTokens ?? 0,
            thoughtsTokens: chunkNotes.usage?.thoughtsTokens ?? chunkNotes.thoughtsTokens ?? 0,
            totalTokens: chunkNotes.usage?.totalTokens ?? chunkNotes.totalTokens ?? 0,
          },
        };
      });
    });

    const chunkResults = await Promise.all(chunkPromises);

    // Step 3c: Hierarchical Synthesis
    const synthesizedNotes = await step.run('hierarchical-synthesis', async () => {
      const summaries: ChunkSummary[] = chunkResults
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((cr) => ({
          chunkIndex: cr.chunkIndex,
          overview: cr.overview,
          keyConcepts: cr.keyConcepts,
          shorthands: cr.shorthands,
        }));

      logger.info('inngest_synthesizing_master_guide', {
        userId,
        idempotencyKey,
        chunkSummariesCount: summaries.length,
      });

      return await synthesizeSectionNotes(summaries, mediaData.videoTitle, {
        requestId: `${idempotencyKey}-synthesis`,
      });
    });

    // Step 3d: Persist Adaptive Notes
    const persistResult = await step.run('persist-adaptive-notes', async () => {
      const stageStart = performance.now();
      try {
        const noteId = crypto.randomUUID();
        const thumbnailUrl = `https://img.youtube.com/vi/${mediaData.resolvedVideoId}/maxresdefault.jpg`;

        // Assemble ordered detailed notes from all chunks
        const sortedChunks = [...chunkResults].sort((a, b) => a.chunkIndex - b.chunkIndex);
        const combinedDetailedNotes = sortedChunks
          .map((cr, idx) => {
            const sectionTitle = synthesizedNotes.tableOfContents[idx] || `Part ${idx + 1}`;
            return `## ${sectionTitle}\n\n${cr.detailedNotes}`;
          })
          .join('\n\n---\n\n');

        let createdAtEpochMs: number | null = null;

        await withSpan('db.persist_adaptive_notes_transaction', async (span) => {
          span.setAttribute('operation', 'persist_adaptive_notes');
          await withUserTransaction(userId, async (client) => {
            const checkRes = await client.query(
              `SELECT status, note_id, created_at FROM generation_idempotency WHERE user_id = $1 AND key = $2 FOR UPDATE`,
              [userId, idempotencyKey]
            );

            if (checkRes.rows.length > 0) {
              createdAtEpochMs = checkRes.rows[0].created_at ? new Date(checkRes.rows[0].created_at).getTime() : null;
              if (checkRes.rows[0].status === 'completed' && checkRes.rows[0].note_id) {
                span.setAttribute('status', 'skipped_already_completed');
                return;
              }
            }

            await client.query(
              `INSERT INTO notes (id, user_id, video_id, video_title, video_url, thumbnail_url, overview, key_concepts, detailed_notes, shorthands)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                noteId,
                userId,
                mediaData.resolvedVideoId,
                mediaData.videoTitle,
                videoUrl,
                thumbnailUrl,
                synthesizedNotes.overview,
                synthesizedNotes.keyConcepts,
                combinedDetailedNotes,
                synthesizedNotes.shorthands,
              ]
            );

            await client.query(
              `UPDATE generation_idempotency
               SET status = 'completed',
                   note_id = $3,
                   error_message = NULL,
                   error_code = NULL,
                   lease_until = NULL,
                   updated_at = CURRENT_TIMESTAMP
               WHERE user_id = $1 AND key = $2`,
              [userId, idempotencyKey, noteId]
            );
          });
          span.setAttribute('status', 'success');
        });

        recordGenerationJob('completed');

        const durationSeconds = typeof createdAtEpochMs === 'number'
          ? Math.max(0, (Date.now() - (createdAtEpochMs as number)) / 1000)
          : (performance.now() - stageStart) / 1000;
        recordGenerationDuration('completed', durationSeconds);

        logger.info('inngest_adaptive_generation_completed_successfully', {
          userId,
          videoId: mediaData.resolvedVideoId,
          idempotencyKey,
          noteId,
          totalChunks: manifest.totalChunks,
          durationSeconds,
        });

        return { success: true, noteId };
      } finally {
        recordGenerationStageDuration('db_persist', (performance.now() - stageStart) / 1000);
      }
    });

    return persistResult;
  }
);
