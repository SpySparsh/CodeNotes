import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/request-context';
import { recordHttpRequest } from '@/lib/metrics';

// Temporary safety cap: prevents unbounded full-table transfers until explicit
// cursor/offset pagination is implemented on this endpoint.
const MAX_NOTES_RETURNED = 200;

export async function GET(request?: Request) {
  const startTime = performance.now();
  const requestId = getRequestId(request);

  try {
    const result = await query(
      'SELECT id, video_id, video_title, thumbnail_url, overview, created_at FROM notes ORDER BY created_at DESC LIMIT $1',
      [MAX_NOTES_RETURNED]
    );

    const notes = result.rows.map(row => ({
      id: row.id,
      videoId: row.video_id,
      videoTitle: row.video_title,
      thumbnailUrl: row.thumbnail_url,
      overview: row.overview,
      createdAt: row.created_at
    }));

    const durationMs = performance.now() - startTime;
    recordHttpRequest('GET', '/api/notes', 200, durationMs / 1000);
    logger.info('get_notes_completed', {
      requestId,
      method: 'GET',
      path: '/api/notes',
      status: 200,
      durationMs,
      count: notes.length,
    });

    return NextResponse.json(
      { success: true, notes },
      { headers: { 'x-request-id': requestId } }
    );
  } catch (error: any) {
    const durationMs = performance.now() - startTime;
    recordHttpRequest('GET', '/api/notes', 500, durationMs / 1000);
    logger.error('get_notes_failed', {
      requestId,
      method: 'GET',
      path: '/api/notes',
      status: 500,
      durationMs,
      errorMessage: error.message || 'Unknown error',
      errorStack: error.stack,
    });

    return NextResponse.json(
      { error: 'Failed to fetch notes' },
      { status: 500, headers: { 'x-request-id': requestId } }
    );
  }
}
