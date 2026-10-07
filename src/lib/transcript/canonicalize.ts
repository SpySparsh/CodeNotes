import { TranscriptError } from './types';

// Accepted YouTube hostnames. Covers standard watch, shorts, and embed URL forms.
const YOUTUBE_HOSTNAMES = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

/**
 * Validates that a URL's hostname is an accepted YouTube domain.
 * Throws 'Invalid YouTube URL' for non-YouTube or malformed URLs.
 * Called before any network request so invalid URLs never reach external services.
 */
export function validateYouTubeUrl(url: string): void {
  if (!url || typeof url !== 'string') {
    throw new TranscriptError('INVALID_URL', 'Invalid YouTube URL', false);
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new TranscriptError('INVALID_URL', 'Invalid YouTube URL', false);
  }

  if (!YOUTUBE_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    throw new TranscriptError('INVALID_URL', 'Invalid YouTube URL', false);
  }
}

/**
 * Extracts the 11-character YouTube video ID from various supported URL formats:
 * - youtube.com/watch?v=ID
 * - youtube.com/watch?v=ID&t=...
 * - youtu.be/ID
 * - youtube.com/shorts/ID
 * - youtube.com/embed/ID
 * - youtube.com/v/ID
 */
export function extractVideoId(url: string): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }

  try {
    const trimmed = url.trim();
    // Match watch?v=ID or /shorts/ID or /embed/ID or /v/ID or youtu.be/ID
    const match = trimmed.match(/(?:v=|\/embed\/|\/shorts\/|\/v\/|^https?:\/\/youtu\.be\/|\/)([0-9A-Za-z_-]{11})(?:[?&#/]|$)/);
    if (match && match[1]) {
      return match[1];
    }
    // Fallback general pattern
    const generalMatch = trimmed.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
    return generalMatch ? generalMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * Normalizes any valid YouTube URL format into a clean canonical URL:
 * https://www.youtube.com/watch?v=<VIDEO_ID>
 * Strips tracking parameters, timestamps, playlists, etc.
 */
export function canonicalizeYouTubeUrl(url: string): string {
  validateYouTubeUrl(url);
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new TranscriptError('INVALID_URL', 'Invalid YouTube URL: could not extract video ID', false);
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}
