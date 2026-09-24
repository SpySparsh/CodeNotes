import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/request-context';
import { recordHttpRequest } from '@/lib/metrics';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> } // In Next 15, params must be awaited or treated as a Promise
) {
  const startTime = performance.now();
  const requestId = getRequestId(request);

  try {
    const { id } = await params;
    const result = await query('SELECT * FROM notes WHERE id = $1', [id]);
    const durationMs = performance.now() - startTime;
    
    if (result.rows.length === 0) {
      recordHttpRequest('GET', '/api/notes/[id]', 404, durationMs / 1000);
      logger.warn('get_note_not_found', {
        requestId,
        method: 'GET',
        path: `/api/notes/${id}`,
        status: 404,
        durationMs,
        noteId: id,
      });

      return NextResponse.json(
        { error: 'Note not found' },
        { status: 404, headers: { 'x-request-id': requestId } }
      );
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

    recordHttpRequest('GET', '/api/notes/[id]', 200, durationMs / 1000);
    logger.info('get_note_completed', {
      requestId,
      method: 'GET',
      path: `/api/notes/${id}`,
      status: 200,
      durationMs,
      noteId: id,
    });

    return NextResponse.json(
      { success: true, note },
      { headers: { 'x-request-id': requestId } }
    );
  } catch (error: any) {
    const durationMs = performance.now() - startTime;
    recordHttpRequest('GET', '/api/notes/[id]', 500, durationMs / 1000);
    logger.error('get_note_failed', {
      requestId,
      method: 'GET',
      path: '/api/notes/[id]',
      status: 500,
      durationMs,
      errorMessage: error.message || 'Unknown error',
      errorStack: error.stack,
    });

    return NextResponse.json(
      { error: 'Failed to fetch the note' },
      { status: 500, headers: { 'x-request-id': requestId } }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const startTime = performance.now();
  const requestId = getRequestId(request);

  try {
    const { id } = await params;
    await query('DELETE FROM notes WHERE id = $1', [id]);
    const durationMs = performance.now() - startTime;

    recordHttpRequest('DELETE', '/api/notes/[id]', 200, durationMs / 1000);
    logger.info('delete_note_completed', {
      requestId,
      method: 'DELETE',
      path: `/api/notes/${id}`,
      status: 200,
      durationMs,
      noteId: id,
    });

    return NextResponse.json(
      { success: true },
      { headers: { 'x-request-id': requestId } }
    );
  } catch (error: any) {
    const durationMs = performance.now() - startTime;
    recordHttpRequest('DELETE', '/api/notes/[id]', 500, durationMs / 1000);
    logger.error('delete_note_failed', {
      requestId,
      method: 'DELETE',
      path: '/api/notes/[id]',
      status: 500,
      durationMs,
      errorMessage: error.message || 'Unknown error',
      errorStack: error.stack,
    });

    return NextResponse.json(
      { error: 'Failed to delete the note' },
      { status: 500, headers: { 'x-request-id': requestId } }
    );
  }
}
