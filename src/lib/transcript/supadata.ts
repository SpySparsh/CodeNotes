import { TranscriptError } from './types';
import { canonicalizeYouTubeUrl, extractVideoId } from './canonicalize';

export const SUPADATA_TIMEOUT_MS = 15000;
const SUPADATA_BASE_URL = 'https://api.supadata.ai/v1/transcript';

/**
 * Normalizes Supadata API response variants into a plain text transcript string.
 */
export function normalizeSupadataResponse(data: any): string {
  if (!data) return '';

  if (typeof data === 'string') {
    return data.trim();
  }

  // Handle { content: "..." } or { content: [ { text: "..." } ] }
  if (data.content !== undefined && data.content !== null) {
    if (typeof data.content === 'string') {
      return data.content.trim();
    }
    if (Array.isArray(data.content)) {
      return data.content
        .map((item: any) => {
          if (typeof item === 'string') return item.trim();
          if (item && typeof item.text === 'string') return item.text.trim();
          return '';
        })
        .filter(Boolean)
        .join(' ')
        .trim();
    }
  }

  // Handle { transcript: [ { text: "..." } ] }
  if (Array.isArray(data.transcript)) {
    return data.transcript
      .map((item: any) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item.text === 'string') return item.text.trim();
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  // Handle array of segments directly: [ { text: "..." } ]
  if (Array.isArray(data)) {
    return data
      .map((item: any) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item.text === 'string') return item.text.trim();
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  // Handle { text: "..." }
  if (typeof data.text === 'string') {
    return data.text.trim();
  }

  return '';
}

/**
 * Fetches transcript from Supadata API for a given YouTube URL.
 * Server-only native fetch with bounded timeout and comprehensive error classification.
 */
export async function fetchSupadataTranscript(
  url: string,
  apiKeyOverride?: string
): Promise<{ text: string; videoId: string }> {
  const apiKey = apiKeyOverride || process.env.SUPADATA_API_KEY;

  if (!apiKey || apiKey.trim() === '') {
    throw new TranscriptError(
      'TRANSCRIPT_PROVIDER_AUTH_ERROR',
      'SUPADATA_API_KEY is not configured',
      false,
      'supadata'
    );
  }

  const canonicalUrl = canonicalizeYouTubeUrl(url);
  const videoId = extractVideoId(canonicalUrl);

  if (!videoId) {
    throw new TranscriptError(
      'INVALID_URL',
      'Could not resolve video ID for Supadata request',
      false,
      'supadata'
    );
  }

  const requestUrl = `${SUPADATA_BASE_URL}?url=${encodeURIComponent(canonicalUrl)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUPADATA_TIMEOUT_MS);

  try {
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey.trim(),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const status = response.status;
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // Ignore body read errors
      }

      const lowerBody = errorBody.toLowerCase();

      // 401 / 403: Authentication or authorization error
      if (status === 401 || status === 403) {
        throw new TranscriptError(
          'TRANSCRIPT_PROVIDER_AUTH_ERROR',
          'Supadata authentication failed. Invalid or inactive API key.',
          false,
          'supadata'
        );
      }

      // 404: Captions unavailable for video
      if (status === 404) {
        throw new TranscriptError(
          'TRANSCRIPT_UNAVAILABLE',
          'Captions are disabled or unavailable for this video.',
          false,
          'supadata'
        );
      }

      // 429: Rate limit or Quota exhaustion
      if (status === 429) {
        const isQuota =
          lowerBody.includes('quota') ||
          lowerBody.includes('credit') ||
          lowerBody.includes('limit reached') ||
          lowerBody.includes('plan');

        if (isQuota) {
          throw new TranscriptError(
            'TRANSCRIPT_PROVIDER_QUOTA_EXCEEDED',
            'Supadata monthly quota exceeded.',
            false,
            'supadata'
          );
        }

        throw new TranscriptError(
          'TRANSCRIPT_PROVIDER_RATE_LIMITED',
          'Supadata rate limit exceeded. Please retry later.',
          true,
          'supadata'
        );
      }

      // 400: Client error (e.g. invalid video or unsupported format)
      if (status === 400) {
        throw new TranscriptError(
          'TRANSCRIPT_UNAVAILABLE',
          'Supadata could not retrieve transcript for this video.',
          false,
          'supadata'
        );
      }

      // 5xx: Provider server error
      if (status >= 500) {
        throw new TranscriptError(
          'TRANSCRIPT_PROVIDER_UNAVAILABLE',
          `Supadata server error (${status}).`,
          true,
          'supadata'
        );
      }

      throw new TranscriptError(
        'TRANSCRIPT_PROVIDER_UNAVAILABLE',
        `Supadata request failed with status ${status}.`,
        false,
        'supadata'
      );
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new TranscriptError(
        'TRANSCRIPT_INVALID_RESPONSE',
        'Supadata returned malformed JSON response.',
        false,
        'supadata'
      );
    }

    const text = normalizeSupadataResponse(json);

    if (!text || text.length === 0) {
      throw new TranscriptError(
        'TRANSCRIPT_INVALID_RESPONSE',
        'Supadata returned empty transcript content.',
        false,
        'supadata'
      );
    }

    return { text, videoId };
  } catch (err: any) {
    clearTimeout(timeoutId);

    if (err instanceof TranscriptError) {
      throw err;
    }

    const isTimeout =
      err.name === 'AbortError' ||
      err.name === 'TimeoutError' ||
      err.message?.includes('timeout') ||
      err.message?.includes('aborted');

    if (isTimeout) {
      throw new TranscriptError(
        'TRANSCRIPT_PROVIDER_UNAVAILABLE',
        `Supadata request timed out after ${SUPADATA_TIMEOUT_MS / 1000}s.`,
        true,
        'supadata'
      );
    }

    throw new TranscriptError(
      'TRANSCRIPT_PROVIDER_UNAVAILABLE',
      err.message || 'Supadata network communication failure',
      true,
      'supadata'
    );
  }
}
