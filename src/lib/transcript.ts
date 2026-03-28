import { YoutubeTranscript } from 'youtube-transcript';

export interface VideoMetadata {
  videoId: string;
  title: string;
}

export async function fetchTranscript(url: string): Promise<{ text: string; videoId: string }> {
  try {
    const videoIdMatch = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;

    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
    const fullText = transcriptItems.map(item => item.text).join(' ');

    return { text: fullText, videoId };
  } catch (error) {
    console.error('Error fetching transcript:', error);
    throw new Error('Failed to fetch video transcript. The video might not have captions enabled.');
  }
}

export async function extractVideoTitle(url: string): Promise<string> {
  try {
    const response = await fetch(`https://noembed.com/embed?url=${url}`);
    const data = await response.json();
    return data.title || 'Unknown Video';
  } catch (error) {
    console.error('Error fetching video metadata:', error);
    return 'Unknown Video';
  }
}
