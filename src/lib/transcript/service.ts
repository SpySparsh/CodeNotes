import { logger } from '@/lib/logger';
import { query } from '@/lib/db';
import { recordTranscriptRequest, recordTranscriptDuration } from '@/lib/metrics';
import { TranscriptError, TranscriptResult } from './types';
import { canonicalizeYouTubeUrl, extractVideoId, validateYouTubeUrl } from './canonicalize';
import { fetchSupadataTranscript } from './supadata';
import { fetchYouTubeTranscriptScraper } from './youtube-transcript';

export const TRANSCRIPT_TIMEOUT_MS = 15000;

/**
 * High-level transcript acquisition service implementing:
 * 1. Global PostgreSQL transcript cache lookup (fail-open on read error).
 * 2. On Cache Hit: returns cached transcript immediately without calling external providers.
 * 3. On Cache Miss:
 *    a. SUPADATA_API_KEY validation (fail fast with non-retriable auth error if missing).
 *    b. Supadata (Primary provider).
 *    c. youtube-transcript (One fallback attempt on Supadata runtime/transient failures).
 *    d. Terminal TRANSCRIPT_UNAVAILABLE domain failure if both providers fail.
 * 4. On Successful Provider Acquisition: writes transcript to youtube_transcripts cache with
 *    ON CONFLICT (video_id) DO NOTHING (fail-open on write error).
 *
 * Never exposes API keys or transcript text to logs.
 */
export async function acquireTranscript(url: string): Promise<TranscriptResult> {
  validateYouTubeUrl(url);
  const canonicalUrl = canonicalizeYouTubeUrl(url);
  const videoId = extractVideoId(canonicalUrl);

  if (!videoId) {
    throw new TranscriptError('INVALID_URL', 'Invalid YouTube video URL', false);
  }

  // 1. Shared Cache Lookup (Fail-open)
  try {
    const cacheRes = await query(
      `SELECT transcript_text, language, provider
       FROM youtube_transcripts
       WHERE video_id = $1`,
      [videoId]
    );

    if (cacheRes.rows.length > 0) {
      const cachedRow = cacheRes.rows[0];
      recordTranscriptRequest('cache_hit', 'success');
      logger.info('transcript_cache_hit', {
        videoId,
        provider: cachedRow.provider,
        textLength: cachedRow.transcript_text.length,
      });

      return {
        text: cachedRow.transcript_text,
        videoId,
        provider: cachedRow.provider as any,
        language: cachedRow.language || undefined,
        cached: true,
      };
    }

    logger.info('transcript_cache_miss', { videoId });
  } catch (cacheReadErr: any) {
    logger.warn('transcript_cache_read_error', {
      videoId,
      errorMessage: cacheReadErr.message,
    });
    // Fail-open: continue to provider acquisition
  }

  // 2. SUPADATA_API_KEY validation: fail fast with non-retriable auth error if missing
  if (!process.env.SUPADATA_API_KEY || process.env.SUPADATA_API_KEY.trim() === '') {
    logger.error('transcript_supadata_key_missing', { videoId });
    throw new TranscriptError(
      'TRANSCRIPT_PROVIDER_AUTH_ERROR',
      'SUPADATA_API_KEY is not configured. Please set SUPADATA_API_KEY in environment variables.',
      false,
      'supadata'
    );
  }

  logger.info('transcript_acquisition_started', {
    videoId,
  });

  let primaryError: TranscriptError | Error | null = null;
  let acquiredResult: { text: string; videoId: string; provider: 'supadata' | 'youtube-transcript' } | null = null;

  // 3. Primary Provider: Supadata
  const supadataStart = performance.now();
  try {
    const result = await fetchSupadataTranscript(canonicalUrl);
    recordTranscriptRequest('supadata', 'success');
    logger.info('transcript_acquisition_success', {
      videoId,
      provider: 'supadata',
      textLength: result.text.length,
    });
    acquiredResult = {
      text: result.text,
      videoId,
      provider: 'supadata',
    };
  } catch (err: any) {
    recordTranscriptRequest('supadata', 'error');
    primaryError = err;
    const errorCode = err instanceof TranscriptError ? err.code : 'TRANSCRIPT_PROVIDER_UNAVAILABLE';

    // Explicit Auth Error (401/403 invalid key) -> do NOT silently fallback, fail immediately
    if (err instanceof TranscriptError && err.code === 'TRANSCRIPT_PROVIDER_AUTH_ERROR') {
      logger.error('transcript_supadata_auth_failed', {
        videoId,
        errorMessage: err.message,
      });
      throw err;
    }

    logger.warn('transcript_fallback_used', {
      videoId,
      primaryProvider: 'supadata',
      fallbackProvider: 'youtube-transcript',
      primaryErrorCode: errorCode,
      errorMessage: err.message,
    });
  } finally {
    recordTranscriptDuration('supadata', (performance.now() - supadataStart) / 1000);
  }

  // 4. Fallback Attempt: youtube-transcript
  if (!acquiredResult) {
    const fallbackStart = performance.now();
    try {
      const result = await fetchYouTubeTranscriptScraper(canonicalUrl);
      recordTranscriptRequest('youtube_transcript_fallback', 'success');
      logger.info('transcript_acquisition_success', {
        videoId,
        provider: 'youtube-transcript',
        textLength: result.text.length,
      });
      acquiredResult = {
        text: result.text,
        videoId,
        provider: 'youtube-transcript',
      };
    } catch (secondaryErr: any) {
      recordTranscriptRequest('youtube_transcript_fallback', 'error');
      const secondaryCode =
        secondaryErr instanceof TranscriptError ? secondaryErr.code : 'TRANSCRIPT_UNAVAILABLE';

      logger.error('transcript_acquisition_failed', {
        videoId,
        primaryErrorCode: primaryError instanceof TranscriptError ? primaryError.code : undefined,
        secondaryErrorCode: secondaryCode,
        secondaryErrorMessage: secondaryErr.message,
      });

      // If Supadata failed with quota exhaustion and fallback also failed, do not retry
      if (primaryError instanceof TranscriptError && primaryError.code === 'TRANSCRIPT_PROVIDER_QUOTA_EXCEEDED') {
        throw primaryError;
      }

      // Both providers failed: throw clean non-retriable TRANSCRIPT_UNAVAILABLE
      throw new TranscriptError(
        'TRANSCRIPT_UNAVAILABLE',
        'Captions are disabled or unavailable for this video.',
        false
      );
    } finally {
      recordTranscriptDuration('youtube_transcript', (performance.now() - fallbackStart) / 1000);
    }
  }

  // 5. Shared Cache Write (Fail-open)
  try {
    await query(
      `INSERT INTO youtube_transcripts (
         video_id,
         transcript_text,
         language,
         provider
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (video_id) DO NOTHING`,
      [videoId, acquiredResult.text, null, acquiredResult.provider]
    );
  } catch (cacheWriteErr: any) {
    logger.warn('transcript_cache_write_error', {
      videoId,
      errorMessage: cacheWriteErr.message,
    });
    // Fail-open: do not fail generation since transcript was successfully obtained
  }

  return {
    text: acquiredResult.text,
    videoId: acquiredResult.videoId,
    provider: acquiredResult.provider,
    cached: false,
  };
}

/**
 * Extracts video title from YouTube via NoEmbed.
 * Safe timeout and fallback to 'Unknown Video'.
 */
export async function extractVideoTitle(url: string): Promise<string> {
  try {
    validateYouTubeUrl(url);
  } catch {
    return 'Unknown Video';
  }

  try {
    const canonical = canonicalizeYouTubeUrl(url);
    const response = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(canonical)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return 'Unknown Video';
    }
    const data = await response.json();
    return data.title || 'Unknown Video';
  } catch (error: any) {
    logger.warn('noembed_fetch_failed', { errorMessage: error?.message });
    return 'Unknown Video';
  }
}

/**
 * Backward compatibility helper for existing direct callers.
 */
export async function fetchTranscript(url: string): Promise<{ text: string; videoId: string }> {
  const result = await acquireTranscript(url);
  return { text: result.text, videoId: result.videoId };
}
