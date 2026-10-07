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
import { generateNotes, GeneratedNotes } from '@/lib/gemini';
import { query, withUserTransaction } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordQueueJobCompleted, recordQueueJobFailed } from '@/lib/metrics';

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
  if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('rate limit')) {
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
    timeouts: { finish: '10m' },
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

      if (userId && idempotencyKey) {
        try {
          await query(
            `UPDATE generation_idempotency
             SET status = 'failed',
                 error_message = $3,
                 error_code = $4,
                 lease_until = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $1 AND key = $2`,
            [userId, idempotencyKey, classification.message, classification.code]
          );
        } catch (dbErr: any) {
          logger.error('inngest_failed_to_update_failure_state', {
            userId,
            idempotencyKey,
            errorMessage: dbErr.message,
          });
        }
      }

      recordQueueJobFailed('note-generation', 0, classification.code);
    },
  },
  async ({ event, step }) => {
    const startTime = performance.now();
    const { userId, idempotencyKey, videoId, videoUrl } = event.data as any;

    logger.info('inngest_generation_function_started', {
      userId,
      idempotencyKey,
      videoId,
      videoUrl,
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

      return { claimed: true, skipped: false, videoId, videoUrl };
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
    });

    // Step 3: AI Generation with Gemini (Outside DB transaction)
    const generatedNotes = await step.run('generate-ai-notes', async () => {
      let aiNotes: GeneratedNotes;

      try {
        if (!mediaData.transcriptText) {
          throw new NonRetriableError('Transcript text is required for AI note generation.');
        }
        aiNotes = await generateNotes(mediaData.transcriptText, mediaData.videoTitle);
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
    });

    // Step 4: Atomic Persistence in Database with User Transaction & RLS
    const persistResult = await step.run('persist-notes', async () => {
      const noteId = crypto.randomUUID();
      const thumbnailUrl = `https://img.youtube.com/vi/${mediaData.resolvedVideoId}/maxresdefault.jpg`;

      await withUserTransaction(userId, async (client) => {
        // Re-check status inside transaction with row lock to avoid race conditions
        const checkRes = await client.query(
          `SELECT status, note_id FROM generation_idempotency WHERE user_id = $1 AND key = $2 FOR UPDATE`,
          [userId, idempotencyKey]
        );

        if (checkRes.rows.length > 0 && checkRes.rows[0].status === 'completed' && checkRes.rows[0].note_id) {
          return;
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

      const durationSeconds = (performance.now() - startTime) / 1000;
      recordQueueJobCompleted('note-generation', durationSeconds);

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
    });

    return persistResult;
  }
);
