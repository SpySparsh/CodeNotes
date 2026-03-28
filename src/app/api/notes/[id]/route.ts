import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> } // In Next 15, params must be awaited or treated as a Promise
) {
  try {
    const { id } = await params;
    const result = await query('SELECT * FROM notes WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 });
    }

    const row = result.rows[0];
    const note = {
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
    };

    return NextResponse.json({ success: true, note });
  } catch (error: any) {
    console.error('API Error /api/notes/[id]:', error);
    return NextResponse.json({ error: 'Failed to fetch the note' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await query('DELETE FROM notes WHERE id = $1', [id]);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('API Error DELETING /api/notes/[id]:', error);
    return NextResponse.json({ error: 'Failed to delete the note' }, { status: 500 });
  }
}
