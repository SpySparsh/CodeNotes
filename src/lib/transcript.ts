import { YoutubeTranscript } from 'youtube-transcript';
import { logger } from '@/lib/logger';

export interface VideoMetadata {
  videoId: string;
  title: string;
}

export const TRANSCRIPT_TIMEOUT_MS = 15000;

// Accepted YouTube hostnames. Covers standard watch, shorts, and embed URL forms.
const YOUTUBE_HOSTNAMES = new Set(['youtube.com', 'www.youtube.com', 'youtu.be']);

/**
 * Validates that a URL's hostname is an accepted YouTube domain.
 * Throws 'Invalid YouTube URL' for non-YouTube or malformed URLs.
 * Called before any network request so invalid URLs never reach external services.
 */
export function validateYouTubeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid YouTube URL');
  }
  if (!YOUTUBE_HOSTNAMES.has(parsed.hostname)) {
    throw new Error('Invalid YouTube URL');
  }
}

export async function fetchTranscript(url: string): Promise<{ text: string; videoId: string }> {
  // Validate before the try/catch so 'Invalid YouTube URL' propagates directly to the caller.
  validateYouTubeUrl(url);

  try {
    const videoIdMatch = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;

    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Transcript fetch timed out after ${TRANSCRIPT_TIMEOUT_MS / 1000} seconds.`));
      }, TRANSCRIPT_TIMEOUT_MS);
    });

    const transcriptItems = await Promise.race([
      YoutubeTranscript.fetchTranscript(videoId),
      timeoutPromise,
    ]).finally(() => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    });

    const fullText = transcriptItems.map(item => item.text).join(' ');

    return { text: fullText, videoId };
  } catch (error: any) {
    logger.error('transcript_fetch_failed', { errorMessage: error.message });
    if (error.message?.includes('timed out')) {
      throw new Error('Failed to fetch video transcript: Operation timed out. Please try again.');
    }
    throw new Error('Failed to fetch video transcript. The video might not have captions enabled.');
  }
}

export async function extractVideoTitle(url: string): Promise<string> {
  // Reject non-YouTube URLs before making any NoEmbed request.
  try {
    validateYouTubeUrl(url);
  } catch {
    return 'Unknown Video';
  }

  try {
    const response = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return 'Unknown Video';
    }
    const data = await response.json();
    return data.title || 'Unknown Video';
  } catch (error) {
    logger.error('noembed_fetch_failed', { errorMessage: (error as any)?.message });
    return 'Unknown Video';
  }
}
