import { logger } from '@/lib/logger';
import { TranscriptError, TranscriptResult } from './types';
import { canonicalizeYouTubeUrl, extractVideoId, validateYouTubeUrl } from './canonicalize';
import { fetchSupadataTranscript } from './supadata';
import { fetchYouTubeTranscriptScraper } from './youtube-transcript';

export const TRANSCRIPT_TIMEOUT_MS = 15000;

/**
 * High-level transcript acquisition service implementing the provider hierarchy:
 * 1. SUPADATA_API_KEY validation: If missing, raises a clear non-retriable error (no silent fallback).
 * 2. Supadata (Primary provider)
 * 3. youtube-transcript (One fallback attempt on Supadata runtime/transient failures)
 * 4. Terminal TRANSCRIPT_UNAVAILABLE domain failure if both providers fail.
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

  // 1. SUPADATA_API_KEY validation: fail fast with non-retriable auth error if missing
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

  // 2. Primary Provider: Supadata
  try {
    const result = await fetchSupadataTranscript(canonicalUrl);
    logger.info('transcript_acquisition_success', {
      videoId,
      provider: 'supadata',
      textLength: result.text.length,
    });
    return {
      text: result.text,
      videoId,
      provider: 'supadata',
    };
  } catch (err: any) {
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
  }

  // 3. Fallback Attempt: youtube-transcript
  try {
    const result = await fetchYouTubeTranscriptScraper(canonicalUrl);
    logger.info('transcript_acquisition_success', {
      videoId,
      provider: 'youtube-transcript',
      textLength: result.text.length,
    });
    return {
      text: result.text,
      videoId,
      provider: 'youtube-transcript',
    };
  } catch (secondaryErr: any) {
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
  }
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
