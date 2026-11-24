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
  computeCanonicalManifestHash,
  sliceByCodePoints,
  getCodePointLength,
  MAX_CHUNK_CHARS,
  type ChunkManifest,
} from '@/lib/chunk-planner';
import {
  reserveQuota,
  markReservationDispatching,
  releaseQuotaReservation,
  releaseAbortedDispatch,
  claimOrAdoptDispatchSlot,
  completeDispatchAttempt,
  settleFailedDispatchUsage,
  reportStaleAttemptOutcome,
  classifyAttemptOutcome,
  DispatchAuthorizationTicket,
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
      // Step 3: AI Generation with FastAPI AI Service (Guarded by Dispatch Ticket)
      const generatedNotes = await step.run('generate-ai-notes', async () => {
        const stageStart = performance.now();
        try {
          if (!mediaData.transcriptText) {
            throw new NonRetriableError('Transcript text is required for AI note generation.');
          }

          const workerId = crypto.randomUUID();
          const estimatedTokens = Math.max(1000, Math.ceil(mediaData.transcriptText.length / 4) + 1500);

          // 1. Reserve Quota for Monolithic Generation
          const reserveRes = await reserveQuota({
            userId,
            parentKey: idempotencyKey,
            chunkIndex: -1,
            projectId: 'codenotes',
            quotaScope: DEFAULT_AI_MODEL,
            modelName: DEFAULT_AI_MODEL,
            workerId,
            estimatedTokens,
            operationType: 'monolithic',
          });

          if (
            !reserveRes.allowed ||
            !reserveRes.reservationToken ||
            !reserveRes.leaseToken ||
            typeof reserveRes.generation !== 'number'
          ) {
            throw new Error(`Monolithic quota reservation rejected: ${reserveRes.statusCode}`);
          }

          // 2. Claim Dispatch Slot or Adopt Existing Result
          const slotRes = await claimOrAdoptDispatchSlot({
            userId,
            parentKey: idempotencyKey,
            operationType: 'monolithic',
            chunkIndex: -1,
            reservationToken: reserveRes.reservationToken,
            leaseToken: reserveRes.leaseToken,
            workerId,
            generation: reserveRes.generation,
            projectId: 'codenotes',
            quotaScope: DEFAULT_AI_MODEL,
            modelName: DEFAULT_AI_MODEL,
            estimatedTokens,
          });

          let aiNotes: GeneratedNotes;

          if (slotRes.adopted && slotRes.adoptedPayload) {
            aiNotes = slotRes.adoptedPayload;
          } else {
            if (!slotRes.allowed || !slotRes.ticket) {
              throw new Error(`Monolithic dispatch quota rejected: ${slotRes.statusCode}`);
            }

            try {
              aiNotes = await withSpan('fastapi.http_request', async (span) => {
                return await generateAiNotes(slotRes.ticket!, mediaData.transcriptText, mediaData.videoTitle, {
                  requestId: idempotencyKey,
                  span,
                });
              });
            } catch (err: any) {
              if (slotRes.attemptId && reserveRes.reservationToken) {
                if (err?.code === 'MALFORMED_AI_OUTPUT' && err.usageEvidence?.totalTokens !== undefined && reserveRes.leaseToken) {
                  await settleFailedDispatchUsage({
                    attemptId: slotRes.attemptId,
                    reservationToken: reserveRes.reservationToken,
                    leaseToken: reserveRes.leaseToken,
                    workerId,
                    fencingGeneration: reserveRes.generation || 1,
                    totalTokens: err.usageEvidence.totalTokens,
                    promptTokens: err.usageEvidence.promptTokens ?? null,
                    candidateTokens: err.usageEvidence.candidateTokens ?? null,
                    thoughtsTokens: err.usageEvidence.thoughtsTokens ?? null,
                    errorCode: 'MALFORMED_OUTPUT',
                    errorMessage: err?.message,
                    evidencePayload: err.usageEvidence,
                  }).catch((settleErr) => {
                    logger.error('settle_failed_dispatch_usage_error', {
                      error: settleErr?.message,
                    });
                  });
                } else {
                  const outcome = classifyAttemptOutcome(err);
                  await reportStaleAttemptOutcome({
                    attemptId: slotRes.attemptId,
                    reservationToken: reserveRes.reservationToken,
                    workerId,
                    outcomeStatus: outcome,
                    errorCode: err?.code || 'MONOLITHIC_AI_FAILURE',
                    errorMessage: err?.message,
                  }).catch(() => {});
                }
              }
              const classification = classifyError(err);
              if (classification.isUnrecoverable) {
                throw new NonRetriableError(classification.message);
              }
              throw err;
            }

            if (!aiNotes || !aiNotes.overview) {
              throw new NonRetriableError('AI returned malformed data.');
            }

            // Extract usage metadata from provider response
            const rawUsage = (aiNotes as any)?.usage;
            const totalTokens = typeof rawUsage?.totalTokens === 'number'
              ? rawUsage.totalTokens
              : (typeof (aiNotes as any)?.totalTokens === 'number' ? (aiNotes as any).totalTokens : undefined);
            const promptTokens = typeof rawUsage?.promptTokens === 'number'
              ? rawUsage.promptTokens
              : (typeof (aiNotes as any)?.promptTokens === 'number' ? (aiNotes as any).promptTokens : 0);
            const candidateTokens = typeof rawUsage?.candidateTokens === 'number'
              ? rawUsage.candidateTokens
              : (typeof (aiNotes as any)?.candidateTokens === 'number' ? (aiNotes as any).candidateTokens : 0);
            const thoughtsTokens = typeof rawUsage?.thoughtsTokens === 'number'
              ? rawUsage.thoughtsTokens
              : (typeof (aiNotes as any)?.thoughtsTokens === 'number' ? (aiNotes as any).thoughtsTokens : 0);

            if (typeof totalTokens !== 'number' || isNaN(totalTokens)) {
              throw new NonRetriableError(
                'USAGE_METADATA_MISSING: Monolithic generation requires actual provider token usage metadata'
              );
            }

            // 3. Complete Dispatch Attempt and Commit Quota
            if (slotRes.attemptId && reserveRes.reservationToken && reserveRes.leaseToken) {
              await completeDispatchAttempt({
                attemptId: slotRes.attemptId,
                reservationToken: reserveRes.reservationToken,
                leaseToken: reserveRes.leaseToken,
                workerId,
                fencingGeneration: reserveRes.generation,
                operationType: 'monolithic',
                responsePayload: aiNotes,
                totalTokens,
                promptTokens,
                candidateTokens,
                thoughtsTokens,
                modelName: DEFAULT_AI_MODEL,
                userId,
                parentKey: idempotencyKey,
                videoId: mediaData.resolvedVideoId,
                videoTitle: mediaData.videoTitle,
                videoUrl,
                thumbnailUrl: `https://img.youtube.com/vi/${mediaData.resolvedVideoId}/maxresdefault.jpg`,
              }).catch((compErr) => {
                logger.warn('inngest_monolithic_complete_dispatch_warning', { err: compErr?.message });
              });
            }
          }

          if (!aiNotes || !aiNotes.overview) {
            throw new NonRetriableError('AI returned malformed data.');
          }

          const rawUsage = (aiNotes as any)?.usage;
          const totalTokens = typeof rawUsage?.totalTokens === 'number'
            ? rawUsage.totalTokens
            : (typeof (aiNotes as any)?.totalTokens === 'number' ? (aiNotes as any).totalTokens : undefined);
          const promptTokens = typeof rawUsage?.promptTokens === 'number'
            ? rawUsage.promptTokens
            : (typeof (aiNotes as any)?.promptTokens === 'number' ? (aiNotes as any).promptTokens : 0);
          const candidateTokens = typeof rawUsage?.candidateTokens === 'number'
            ? rawUsage.candidateTokens
            : (typeof (aiNotes as any)?.candidateTokens === 'number' ? (aiNotes as any).candidateTokens : 0);
          const thoughtsTokens = typeof rawUsage?.thoughtsTokens === 'number'
            ? rawUsage.thoughtsTokens
            : (typeof (aiNotes as any)?.thoughtsTokens === 'number' ? (aiNotes as any).thoughtsTokens : 0);

          if (!slotRes.adopted && (typeof totalTokens !== 'number' || isNaN(totalTokens))) {
            throw new NonRetriableError(
              'USAGE_METADATA_MISSING: Monolithic generation requires actual provider token usage metadata'
            );
          }

          return {
            aiNotes,
            generationMethod: 'transcript' as const,
            transcriptProvider: mediaData.transcriptProvider,
            attemptId: slotRes.attemptId,
            reservationToken: reserveRes.reservationToken,
            leaseToken: reserveRes.leaseToken,
            workerId,
            generation: reserveRes.generation,
            usage: typeof totalTokens === 'number'
              ? {
                  totalTokens,
                  promptTokens,
                  candidateTokens,
                  thoughtsTokens,
                }
              : undefined,
          };
        } finally {
          recordGenerationStageDuration('gemini_inference', (performance.now() - stageStart) / 1000);
        }
      });

      // Step 4: Atomic Persistence in Database with User Transaction & RLS
      const persistResult = await step.run('persist-notes', async () => {
        const stageStart = performance.now();
        try {
          let finalNoteId: string | null = null;
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
                  finalNoteId = checkRes.rows[0].note_id;
                  return;
                }
              }

              // Fallback completion path:
              // Must never publish an unlinked note bypassing complete_dispatch_attempt.
              // Must use the existing authorized monolithic dispatch attempt identity.
              const attemptId = (generatedNotes as any)?.attemptId;
              const reservationToken = (generatedNotes as any)?.reservationToken;
              const leaseToken = (generatedNotes as any)?.leaseToken;
              const workerId = (generatedNotes as any)?.workerId;
              const generation = (generatedNotes as any)?.generation;

              if (
                !attemptId ||
                typeof attemptId !== 'string' ||
                !reservationToken ||
                typeof reservationToken !== 'string' ||
                !leaseToken ||
                typeof leaseToken !== 'string'
              ) {
                throw new NonRetriableError(
                  'PERSIST_FAILED: Cannot publish monolithic note without verified dispatch attempt and reservation'
                );
              }

              if (typeof generation !== 'number' || isNaN(generation)) {
                throw new NonRetriableError(
                  'FENCING_IDENTITY_MISSING: Cannot complete monolithic dispatch without valid reservation generation'
                );
              }

              if (typeof workerId !== 'string' || workerId.trim().length === 0) {
                throw new NonRetriableError(
                  'WORKER_IDENTITY_MISSING: Cannot complete monolithic dispatch without original worker identity'
                );
              }

              const rawUsage = (generatedNotes as any)?.usage || (generatedNotes as any)?.aiNotes?.usage;
              const totalTokens = typeof rawUsage?.totalTokens === 'number'
                ? rawUsage.totalTokens
                : (typeof (generatedNotes as any)?.aiNotes?.totalTokens === 'number'
                  ? (generatedNotes as any).aiNotes.totalTokens
                  : undefined);
              const promptTokens = typeof rawUsage?.promptTokens === 'number'
                ? rawUsage.promptTokens
                : (typeof (generatedNotes as any)?.aiNotes?.promptTokens === 'number'
                  ? (generatedNotes as any).aiNotes.promptTokens
                  : 0);
              const candidateTokens = typeof rawUsage?.candidateTokens === 'number'
                ? rawUsage.candidateTokens
                : (typeof (generatedNotes as any)?.aiNotes?.candidateTokens === 'number'
                  ? (generatedNotes as any).aiNotes.candidateTokens
                  : 0);
              const thoughtsTokens = typeof rawUsage?.thoughtsTokens === 'number'
                ? rawUsage.thoughtsTokens
                : (typeof (generatedNotes as any)?.aiNotes?.thoughtsTokens === 'number'
                  ? (generatedNotes as any).aiNotes.thoughtsTokens
                  : 0);

              if (typeof totalTokens !== 'number' || isNaN(totalTokens)) {
                throw new NonRetriableError(
                  'USAGE_METADATA_MISSING: Cannot complete monolithic dispatch without actual usage metadata'
                );
              }

              const compRes = await completeDispatchAttempt({
                attemptId,
                reservationToken,
                leaseToken,
                workerId,
                fencingGeneration: generation,
                operationType: 'monolithic',
                responsePayload: generatedNotes.aiNotes,
                totalTokens,
                promptTokens,
                candidateTokens,
                thoughtsTokens,
                modelName: DEFAULT_AI_MODEL,
                userId,
                parentKey: idempotencyKey,
                videoId: mediaData.resolvedVideoId,
                videoTitle: mediaData.videoTitle,
                videoUrl,
                thumbnailUrl,
              });

              if (!compRes.success && compRes.statusCode !== 'ALREADY_COMPLETED') {
                throw new NonRetriableError(
                  `PERSIST_FAILED: Atomic complete_dispatch_attempt failed with ${compRes.statusCode}`
                );
              }

              const verifyRes = await client.query(
                `SELECT status, note_id FROM generation_idempotency WHERE user_id = $1 AND key = $2`,
                [userId, idempotencyKey]
              );
              const verifiedRow = verifyRes.rows[0];
              if (!verifiedRow || verifiedRow.status !== 'completed' || !verifiedRow.note_id) {
                throw new NonRetriableError(
                  'PERSIST_VERIFICATION_FAILED: Monolithic generation recovery could not be verified completed with a valid note_id'
                );
              }

              finalNoteId = verifiedRow.note_id;
            });
            span.setAttribute('status', 'success');
          });

          if (!finalNoteId) {
            throw new NonRetriableError(
              'PERSIST_FAILED: Monolithic generation could not verify note persistence'
            );
          }

          recordGenerationJob('completed');

          const durationSeconds = typeof createdAtEpochMs === 'number'
            ? Math.max(0, (Date.now() - (createdAtEpochMs as number)) / 1000)
            : (performance.now() - stageStart) / 1000;
          recordGenerationDuration('completed', durationSeconds);

          logger.info('inngest_generation_completed_successfully', {
            userId,
            videoId: mediaData.resolvedVideoId,
            idempotencyKey,
            noteId: finalNoteId,
            generationMethod: generatedNotes.generationMethod,
            transcriptProvider: generatedNotes.transcriptProvider,
            durationSeconds,
          });

          return { success: true, noteId: finalNoteId };
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
      const planned = planChunkManifest(mediaData.resolvedVideoId, mediaData.transcriptText);
      const manifestHash = computeCanonicalManifestHash(planned);
      await query(
        `UPDATE public.generation_idempotency
         SET total_chunks = $3, manifest_hash = $4, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND key = $2`,
        [userId, idempotencyKey, planned.totalChunks, manifestHash]
      );
      return planned;
    });

    // Step 3b: Bounded Concurrency Fan-Out Generation for each chunk (max 2 concurrent to respect Gemini 15 RPM limit)
    const CONCURRENCY_LIMIT = 2;
    const chunkResults: any[] = [];
    for (let i = 0; i < manifest.chunks.length; i += CONCURRENCY_LIMIT) {
      const chunkBatch = manifest.chunks.slice(i, i + CONCURRENCY_LIMIT);
      const batchResults = await Promise.all(
        chunkBatch.map((chunk) => {
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

        // 1. Reserve Quota with backoff on rate limiting
        let reserveRes: any;
        for (let attempt = 0; attempt < 15; attempt++) {
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

          if (reserveRes.allowed || reserveRes.statusCode === 'ALREADY_COMMITTED') {
            break;
          }

          if (reserveRes.statusCode?.startsWith('RATE_LIMIT_EXCEEDED_')) {
            logger.info('inngest_quota_rate_limited_waiting', {
              chunkIndex: chunk.chunkIndex,
              attempt,
              statusCode: reserveRes.statusCode,
            });
            await new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 1000));
            continue;
          }

          break;
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

        // 3. Generate Chunk AI Notes (Claim slot per attempt and pass single-use ticket)
        let chunkNotes: any;
        let lastAttemptId: string | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const slotRes = await claimOrAdoptDispatchSlot({
            userId,
            parentKey: idempotencyKey,
            operationType: 'chunk',
            chunkIndex: chunk.chunkIndex,
            reservationToken,
            leaseToken,
            workerId,
            generation,
            projectId: 'codenotes',
            quotaScope: DEFAULT_AI_MODEL,
            modelName: DEFAULT_AI_MODEL,
            estimatedTokens: chunk.estimatedTokens,
          });

          if (slotRes.adopted && slotRes.adoptedPayload) {
            chunkNotes = slotRes.adoptedPayload;
            lastAttemptId = slotRes.attemptId;
            break;
          }

          if (!slotRes.allowed || !slotRes.ticket) {
            if (isRateLimitExceeded(slotRes.statusCode) && attempt < 4) {
              await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
              continue;
            }
            throw new Error(`Chunk dispatch slot rejected: ${slotRes.statusCode}`);
          }

          lastAttemptId = slotRes.attemptId;

          try {
            chunkNotes = await generateChunkAiNotes(
              slotRes.ticket,
              chunkText,
              mediaData.videoTitle,
              chunk.chunkIndex,
              manifest.totalChunks,
              {
                requestId: `${idempotencyKey}-chunk-${chunk.chunkIndex}-att${attempt}`,
              }
            );
            break;
          } catch (genErr: any) {
            if (slotRes.attemptId) {
              if (genErr?.code === 'MALFORMED_AI_OUTPUT' && genErr.usageEvidence?.totalTokens !== undefined && leaseToken) {
                await settleFailedDispatchUsage({
                  attemptId: slotRes.attemptId,
                  reservationToken,
                  leaseToken,
                  workerId,
                  fencingGeneration: generation,
                  totalTokens: genErr.usageEvidence.totalTokens,
                  promptTokens: genErr.usageEvidence.promptTokens ?? null,
                  candidateTokens: genErr.usageEvidence.candidateTokens ?? null,
                  thoughtsTokens: genErr.usageEvidence.thoughtsTokens ?? null,
                  errorCode: 'MALFORMED_OUTPUT',
                  errorMessage: genErr?.message,
                  evidencePayload: genErr.usageEvidence,
                }).catch((settleErr) => {
                  logger.error('settle_failed_dispatch_usage_error', {
                    error: settleErr?.message,
                  });
                });
                throw new NonRetriableError(genErr?.message || 'Chunk AI output was malformed.');
              } else {
                const outcome = classifyAttemptOutcome(genErr);
                await reportStaleAttemptOutcome({
                  attemptId: slotRes.attemptId,
                  reservationToken,
                  workerId,
                  outcomeStatus: outcome,
                  errorCode: genErr?.code || 'CHUNK_AI_FAILURE',
                  errorMessage: genErr?.message,
                }).catch(() => {});
              }
            }
            if (genErr?.isRetryable && attempt < 4) {
              logger.warn('inngest_chunk_ai_generation_retry', {
                chunkIndex: chunk.chunkIndex,
                attempt,
                errorMessage: genErr.message,
              });
              await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
              continue;
            }
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
        }

        // 4. Complete Chunk and Commit Quota (Canonical Attempt Ledger & Chunk Generations Settlement)
        if (!lastAttemptId) {
          throw new Error(`Cannot settle chunk ${chunk.chunkIndex}: missing dispatch attempt identity`);
        }

        const compRes = await completeDispatchAttempt({
          attemptId: lastAttemptId,
          reservationToken,
          leaseToken,
          workerId,
          fencingGeneration: generation,
          operationType: 'chunk',
          responsePayload: {
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
          userId,
          parentKey: idempotencyKey,
        });

        if (!compRes.success && compRes.statusCode !== 'ALREADY_COMPLETED') {
          throw new Error(`Complete chunk dispatch attempt failed: ${compRes.statusCode}`);
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
    })
  );
  chunkResults.push(...batchResults);
}

    // Step 3c: Hierarchical Synthesis
    const synthesizedNotes = await step.run('hierarchical-synthesis', async () => {
      // 1. Verify Parent Generation & Manifest from Database
      const parentRes = await query(
        `SELECT total_chunks, manifest_hash, status
         FROM public.generation_idempotency
         WHERE user_id = $1 AND key = $2`,
        [userId, idempotencyKey]
      );
      if (parentRes.rows.length === 0) {
        throw new NonRetriableError('MANIFEST_VERIFICATION_FAILED: Parent generation record not found in database');
      }
      const parentRow = parentRes.rows[0];
      if (parentRow.total_chunks !== manifest.totalChunks) {
        throw new NonRetriableError(
          `MANIFEST_VERIFICATION_FAILED: total_chunks mismatch (db: ${parentRow.total_chunks}, planned: ${manifest.totalChunks})`
        );
      }
      const expectedHash = computeCanonicalManifestHash(manifest);
      if (parentRow.manifest_hash !== expectedHash) {
        throw new NonRetriableError(
          `MANIFEST_VERIFICATION_FAILED: manifest_hash mismatch (db: ${parentRow.manifest_hash}, expected: ${expectedHash})`
        );
      }

      // 2. Load and verify completed chunks from Database
      const chunksRes = await query(
        `SELECT chunk_index, chunk_notes, status
         FROM public.chunk_generations
         WHERE user_id = $1 AND parent_key = $2 AND status = 'completed'
         ORDER BY chunk_index ASC`,
        [userId, idempotencyKey]
      );

      if (!chunksRes.rows || chunksRes.rows.length !== manifest.totalChunks) {
        throw new NonRetriableError(
          `MANIFEST_VERIFICATION_FAILED: Expected ${manifest.totalChunks} completed chunks in database, found ${chunksRes.rows?.length || 0}`
        );
      }

      // Verify exact contiguous indices 0 .. totalChunks - 1 and valid chunk notes
      for (let idx = 0; idx < manifest.totalChunks; idx++) {
        const row = chunksRes.rows[idx];
        if (!row || row.chunk_index !== idx) {
          throw new NonRetriableError(
            `MANIFEST_VERIFICATION_FAILED: Missing or non-contiguous chunk index ${idx} in database`
          );
        }
        if (!row.chunk_notes || typeof row.chunk_notes.overview !== 'string') {
          throw new NonRetriableError(
            `MANIFEST_VERIFICATION_FAILED: Invalid or corrupted chunk notes payload for chunk ${idx}`
          );
        }
      }

      // Build summaries strictly from verified database records
      const summaries: ChunkSummary[] = chunksRes.rows.map((row: any) => ({
        chunkIndex: row.chunk_index,
        overview: row.chunk_notes.overview,
        keyConcepts: row.chunk_notes.keyConcepts || [],
        shorthands: row.chunk_notes.shorthands || [],
      }));

      logger.info('inngest_synthesizing_master_guide', {
        userId,
        idempotencyKey,
        chunkSummariesCount: summaries.length,
      });

      const synthWorkerId = crypto.randomUUID();
      const synthEstimatedTokens = Math.max(1000, summaries.length * 400 + 1000);

      // Reserve and claim slot for synthesis under operation_type = 'synthesis'
      const synthReserve = await reserveQuota({
        userId,
        parentKey: idempotencyKey,
        chunkIndex: -1,
        projectId: 'codenotes',
        quotaScope: DEFAULT_AI_MODEL,
        modelName: DEFAULT_AI_MODEL,
        workerId: synthWorkerId,
        estimatedTokens: synthEstimatedTokens,
        operationType: 'synthesis',
      });

      const synthSlot = await claimOrAdoptDispatchSlot({
        userId,
        parentKey: idempotencyKey,
        operationType: 'synthesis',
        chunkIndex: -1,
        reservationToken: synthReserve.reservationToken || crypto.randomUUID(),
        leaseToken: synthReserve.leaseToken || crypto.randomUUID(),
        workerId: synthWorkerId,
        generation: synthReserve.generation || 1,
        projectId: 'codenotes',
        quotaScope: DEFAULT_AI_MODEL,
        modelName: DEFAULT_AI_MODEL,
        estimatedTokens: synthEstimatedTokens,
      });

      if (synthSlot.adopted && synthSlot.adoptedPayload) {
        return {
          notes: synthSlot.adoptedPayload,
          synthAttemptId: synthSlot.attemptId,
          synthReservationToken: synthReserve.reservationToken,
        };
      }

      if (!synthSlot.allowed || !synthSlot.ticket) {
        throw new Error(`Synthesis dispatch quota rejected: ${synthSlot.statusCode}`);
      }

      let notes: any;
      try {
        notes = await synthesizeSectionNotes(synthSlot.ticket, summaries, mediaData.videoTitle, {
          requestId: `${idempotencyKey}-synthesis`,
        });
      } catch (err: any) {
        if (synthSlot.attemptId && synthReserve.reservationToken) {
          if (err?.code === 'MALFORMED_AI_OUTPUT' && err.usageEvidence?.totalTokens !== undefined && synthReserve.leaseToken) {
            await settleFailedDispatchUsage({
              attemptId: synthSlot.attemptId,
              reservationToken: synthReserve.reservationToken,
              leaseToken: synthReserve.leaseToken,
              workerId: synthWorkerId,
              fencingGeneration: synthReserve.generation || 1,
              totalTokens: err.usageEvidence.totalTokens,
              promptTokens: err.usageEvidence.promptTokens ?? null,
              candidateTokens: err.usageEvidence.candidateTokens ?? null,
              thoughtsTokens: err.usageEvidence.thoughtsTokens ?? null,
              errorCode: 'MALFORMED_OUTPUT',
              errorMessage: err?.message,
              evidencePayload: err.usageEvidence,
            }).catch((settleErr) => {
              logger.error('settle_failed_dispatch_usage_error', {
                error: settleErr?.message,
              });
            });
            throw new NonRetriableError(err?.message || 'Synthesis AI output was malformed.');
          } else {
            const outcome = classifyAttemptOutcome(err);
            await reportStaleAttemptOutcome({
              attemptId: synthSlot.attemptId,
              reservationToken: synthReserve.reservationToken,
              workerId: synthWorkerId,
              outcomeStatus: outcome,
              errorCode: err?.code || 'SYNTHESIS_AI_FAILURE',
              errorMessage: err?.message,
            }).catch(() => {});
          }
        }
        throw err;
      }

      if (synthSlot.attemptId && synthReserve.reservationToken && synthReserve.leaseToken) {
        await completeDispatchAttempt({
          attemptId: synthSlot.attemptId,
          reservationToken: synthReserve.reservationToken,
          leaseToken: synthReserve.leaseToken,
          workerId: synthWorkerId,
          fencingGeneration: synthReserve.generation || 1,
          operationType: 'synthesis',
          responsePayload: notes,
          totalTokens: notes.usage?.totalTokens ?? 0,
          promptTokens: notes.usage?.promptTokens ?? 0,
          candidateTokens: notes.usage?.candidateTokens ?? 0,
          thoughtsTokens: notes.usage?.thoughtsTokens ?? 0,
          modelName: DEFAULT_AI_MODEL,
          userId,
          parentKey: idempotencyKey,
        }).catch(() => {});
      }

      return {
        notes,
        synthAttemptId: synthSlot.attemptId,
        synthReservationToken: synthReserve.reservationToken,
      };
    });

    // Step 3d: Persist Adaptive Notes
    const persistResult = await step.run('persist-adaptive-notes', async () => {
      const stageStart = performance.now();
      try {
        const noteId = crypto.randomUUID();
        const thumbnailUrl = `https://img.youtube.com/vi/${mediaData.resolvedVideoId}/maxresdefault.jpg`;

        // 1. Verify Manifest from Database
        const parentRes = await query(
          `SELECT total_chunks, manifest_hash, status
           FROM public.generation_idempotency
           WHERE user_id = $1 AND key = $2`,
          [userId, idempotencyKey]
        );
        if (parentRes.rows.length === 0) {
          throw new NonRetriableError('DATABASE_CHUNKS_INCOMPLETE: Parent generation record not found');
        }
        const expectedHash = computeCanonicalManifestHash(manifest);
        if (parentRes.rows[0].manifest_hash !== expectedHash) {
          throw new NonRetriableError(
            'DATABASE_CHUNKS_INCOMPLETE: Manifest hash mismatch before publication'
          );
        }

        // 2. Database chunk verification & assembly (Strictly from database rows)
        const chunksRes = await query(
          `SELECT chunk_index, chunk_notes
           FROM public.chunk_generations
           WHERE user_id = $1 AND parent_key = $2 AND status = 'completed'
           ORDER BY chunk_index ASC`,
          [userId, idempotencyKey]
        );

        if (!chunksRes.rows || chunksRes.rows.length !== manifest.totalChunks) {
          throw new NonRetriableError(
            `DATABASE_CHUNKS_INCOMPLETE: Expected ${manifest.totalChunks} completed chunks in database, found ${chunksRes.rows?.length || 0}`
          );
        }

        for (let idx = 0; idx < manifest.totalChunks; idx++) {
          const row = chunksRes.rows[idx];
          if (!row || row.chunk_index !== idx || !row.chunk_notes?.detailedNotes) {
            throw new NonRetriableError(
              `DATABASE_CHUNKS_INCOMPLETE: Missing or invalid database chunk row at index ${idx}`
            );
          }
        }

        const actualSynthesizedNotes = (synthesizedNotes as any)?.notes || synthesizedNotes;
        const synthAttemptId = (synthesizedNotes as any)?.synthAttemptId || null;

        const combinedDetailedNotes = chunksRes.rows
          .map((row: any, idx: number) => {
            const sectionTitle = actualSynthesizedNotes.tableOfContents?.[idx] || `Part ${idx + 1}`;
            return `## ${sectionTitle}\n\n${row.chunk_notes.detailedNotes}`;
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
              `INSERT INTO notes (id, user_id, parent_key, attempt_id, video_id, video_title, video_url, thumbnail_url, overview, key_concepts, detailed_notes, shorthands)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                noteId,
                userId,
                idempotencyKey,
                synthAttemptId,
                mediaData.resolvedVideoId,
                mediaData.videoTitle,
                videoUrl,
                thumbnailUrl,
                actualSynthesizedNotes.overview,
                actualSynthesizedNotes.keyConcepts,
                combinedDetailedNotes,
                actualSynthesizedNotes.shorthands,
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
