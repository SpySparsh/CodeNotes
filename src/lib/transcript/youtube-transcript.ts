import { YoutubeTranscript } from 'youtube-transcript';
import { TranscriptError } from './types';
import { extractVideoId, canonicalizeYouTubeUrl } from './canonicalize';

export const YOUTUBE_TRANSCRIPT_TIMEOUT_MS = 15000;

/**
 * Fallback scraper client using the youtube-transcript library.
 */
export async function fetchYouTubeTranscriptScraper(
  url: string
): Promise<{ text: string; videoId: string }> {
  const canonicalUrl = canonicalizeYouTubeUrl(url);
  const videoId = extractVideoId(canonicalUrl);

  if (!videoId) {
    throw new TranscriptError(
      'INVALID_URL',
      'Could not extract video ID for youtube-transcript scraper',
      false,
      'youtube-transcript'
    );
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new TranscriptError(
          'TRANSCRIPT_PROVIDER_UNAVAILABLE',
          `youtube-transcript fetch timed out after ${YOUTUBE_TRANSCRIPT_TIMEOUT_MS / 1000}s.`,
          true,
          'youtube-transcript'
        )
      );
    }, YOUTUBE_TRANSCRIPT_TIMEOUT_MS);
  });

  try {
    const transcriptItems = await Promise.race([
      YoutubeTranscript.fetchTranscript(videoId),
      timeoutPromise,
    ]).finally(() => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    });

    if (!transcriptItems || !Array.isArray(transcriptItems) || transcriptItems.length === 0) {
      throw new TranscriptError(
        'TRANSCRIPT_UNAVAILABLE',
        'Captions are disabled or unavailable for this video.',
        false,
        'youtube-transcript'
      );
    }

    const fullText = transcriptItems
      .map((item) => (item?.text ? item.text.trim() : ''))
      .filter(Boolean)
      .join(' ')
      .trim();

    if (!fullText) {
      throw new TranscriptError(
        'TRANSCRIPT_INVALID_RESPONSE',
        'youtube-transcript returned empty content.',
        false,
        'youtube-transcript'
      );
    }

    return { text: fullText, videoId };
  } catch (error: any) {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (error instanceof TranscriptError) {
      throw error;
    }

    const msg = error?.message || '';
    if (msg.includes('timed out')) {
      throw new TranscriptError(
        'TRANSCRIPT_PROVIDER_UNAVAILABLE',
        'Transcript fetch operation timed out.',
        true,
        'youtube-transcript'
      );
    }

    // Default scraper failure (captions disabled, blocked, or unavailable)
    throw new TranscriptError(
      'TRANSCRIPT_UNAVAILABLE',
      'Captions are disabled or unavailable for this video.',
      false,
      'youtube-transcript'
    );
  }
}
