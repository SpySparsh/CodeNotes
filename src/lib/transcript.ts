import { YoutubeTranscript } from 'youtube-transcript';

export interface VideoMetadata {
  videoId: string;
  title: string;
}

export const TRANSCRIPT_TIMEOUT_MS = 15000;

export async function fetchTranscript(url: string): Promise<{ text: string; videoId: string }> {
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
    console.error('Error fetching transcript:', error);
    if (error.message?.includes('timed out')) {
      throw new Error('Failed to fetch video transcript: Operation timed out. Please try again.');
    }
    throw new Error('Failed to fetch video transcript. The video might not have captions enabled.');
  }
}

export async function extractVideoTitle(url: string): Promise<string> {
  try {
    const response = await fetch(`https://noembed.com/embed?url=${url}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return 'Unknown Video';
    }
    const data = await response.json();
    return data.title || 'Unknown Video';
  } catch (error) {
    console.error('Error fetching video metadata:', error);
    return 'Unknown Video';
  }
}
