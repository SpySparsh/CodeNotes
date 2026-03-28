import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET() {
  try {
    const result = await query('SELECT * FROM notes ORDER BY created_at DESC');
    
    const notes = result.rows.map(row => ({
      id: row.id,
      videoId: row.video_id,
      videoTitle: row.video_title,
      videoUrl: row.video_url,
      thumbnailUrl: row.thumbnail_url,
      overview: row.overview,
      keyConcepts: row.key_concepts,
      detailedNotes: row.detailed_notes,
      shorthands: row.shorthands,
      createdAt: row.created_at
    }));

    return NextResponse.json({ success: true, notes });
  } catch (error: any) {
    console.error('API Error /api/notes:', error);
    return NextResponse.json({ error: 'Failed to fetch notes' }, { status: 500 });
  }
}
