import { NextResponse } from 'next/server';
import { fetchTranscript, extractVideoTitle } from '@/lib/transcript';
import { generateNotes } from '@/lib/gemini';
import { query } from '@/lib/db';
import crypto from 'crypto';

export async function POST(request: Request) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json({ error: 'YouTube URL is required' }, { status: 400 });
    }

    // 1. Fetch transcript and video ID
    const { text, videoId } = await fetchTranscript(url);

    // 2. Fetch video title
    const videoTitle = await extractVideoTitle(url);

    // 3. Generate notes using Gemini
    const aiNotes = await generateNotes(text, videoTitle);

    // 4. Save to DB
    const noteId = crypto.randomUUID();
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    
    const insertQuery = `
      INSERT INTO notes (id, video_id, video_title, video_url, thumbnail_url, overview, key_concepts, detailed_notes, shorthands)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;
    
    await query(insertQuery, [
      noteId,
      videoId,
      videoTitle,
      url,
      thumbnailUrl,
      aiNotes.overview,
      aiNotes.keyConcepts,
      aiNotes.detailedNotes,
      aiNotes.shorthands
    ]);

    return NextResponse.json({ success: true, noteId });
  } catch (error: any) {
    console.error('API Error:', error);
    return NextResponse.json({ error: error.message || 'Something went wrong' }, { status: 500 });
  }
}
