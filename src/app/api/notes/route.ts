import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/request-context';
import { recordHttpRequest } from '@/lib/metrics';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import {
  notesQuerySchema,
  decodeCursor,
  encodeCursor,
  SortField,
  SortOrder,
} from '@/lib/validations/notes';

export async function GET(request?: Request) {
  const startTime = performance.now();
  const requestId = getRequestId(request);

  try {
    const user = await requireUser();

    // Parse URL search parameters
    const url = request ? new URL(request.url) : new URL('http://localhost/api/notes');
    const rawParams = {
      cursor: url.searchParams.get('cursor') || undefined,
      limit: url.searchParams.get('limit') || undefined,
      search: url.searchParams.get('search') || undefined,
      sort: url.searchParams.get('sort') || undefined,
      order: url.searchParams.get('order') || undefined,
    };

    const parsedQuery = notesQuerySchema.safeParse(rawParams);
    if (!parsedQuery.success) {
      const durationMs = performance.now() - startTime;
      recordHttpRequest('GET', '/api/notes', 400, durationMs / 1000);
      logger.warn('get_notes_invalid_params', {
        requestId,
        userId: user.id,
        errors: parsedQuery.error.flatten(),
      });
      return NextResponse.json(
        { error: 'Invalid query parameters', details: parsedQuery.error.flatten() },
        { status: 400, headers: { 'x-request-id': requestId } }
      );
    }

    const { cursor, limit, search, sort, order } = parsedQuery.data;

    // Decode and validate cursor if present
    let decodedCursor: { sortValue: string; id: string; sortField: SortField; sortOrder: SortOrder } | null = null;
    if (cursor) {
      decodedCursor = decodeCursor(cursor, sort, order);
      if (!decodedCursor) {
        const durationMs = performance.now() - startTime;
        recordHttpRequest('GET', '/api/notes', 400, durationMs / 1000);
        logger.warn('get_notes_invalid_cursor', {
          requestId,
          userId: user.id,
          cursor,
        });
        return NextResponse.json(
          { error: 'Malformed or invalid pagination cursor' },
          { status: 400, headers: { 'x-request-id': requestId } }
        );
      }
    }

    // Build parameterized keyset query
    const sqlParams: any[] = [user.id];
    const whereConditions: string[] = ['user_id = $1'];

    // Search filter (ILIKE on video_title and overview)
    if (search) {
      // Escape ILIKE special characters for literal substring semantics
      const escapedSearch = search.replace(/[%_\\]/g, '\\$&');
      sqlParams.push(`%${escapedSearch}%`);
      const searchParamIndex = sqlParams.length;
      whereConditions.push(
        `(video_title ILIKE $${searchParamIndex} ESCAPE '\\' OR overview ILIKE $${searchParamIndex} ESCAPE '\\')`
      );
    }

    // Keyset pagination condition
    if (decodedCursor) {
      const sortColumn = sort === 'created_at' ? 'created_at' : 'video_title';
      const castType = sort === 'created_at' ? '::timestamptz' : '::text';

      sqlParams.push(decodedCursor.sortValue);
      const valParamIdx = sqlParams.length;
      sqlParams.push(decodedCursor.id);
      const idParamIdx = sqlParams.length;

      if (order === 'desc') {
        whereConditions.push(
          `(${sortColumn} < $${valParamIdx}${castType} OR (${sortColumn} = $${valParamIdx}${castType} AND id < $${idParamIdx}::uuid))`
        );
      } else {
        whereConditions.push(
          `(${sortColumn} > $${valParamIdx}${castType} OR (${sortColumn} = $${valParamIdx}${castType} AND id > $${idParamIdx}::uuid))`
        );
      }
    }

    // Determine deterministic ORDER BY clause using whitelisted sort fields
    const orderClause =
      sort === 'created_at'
        ? order === 'desc'
          ? 'ORDER BY created_at DESC, id DESC'
          : 'ORDER BY created_at ASC, id ASC'
        : order === 'desc'
        ? 'ORDER BY video_title DESC, id DESC'
        : 'ORDER BY video_title ASC, id ASC';

    // Query limit + 1 to detect hasMore without a count query
    const fetchLimit = limit + 1;
    sqlParams.push(fetchLimit);
    const limitParamIdx = sqlParams.length;

    const queryString = `
      SELECT id, video_id, video_title, thumbnail_url, overview, created_at
      FROM notes
      WHERE ${whereConditions.join(' AND ')}
      ${orderClause}
      LIMIT $${limitParamIdx}
    `;

    const result = await query(queryString, sqlParams);
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

    let nextCursor: string | null = null;
    if (hasMore && rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const sortValue =
        sort === 'created_at'
          ? (lastRow.created_at instanceof Date ? lastRow.created_at.toISOString() : new Date(lastRow.created_at).toISOString())
          : String(lastRow.video_title);

      nextCursor = encodeCursor({
        sortValue,
        id: lastRow.id,
        sortField: sort,
        sortOrder: order,
      });
    }

    const notes = rows.map((row) => ({
      id: row.id,
      videoId: row.video_id,
      videoTitle: row.video_title,
      thumbnailUrl: row.thumbnail_url,
      overview: row.overview,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    }));

    const durationMs = performance.now() - startTime;
    recordHttpRequest('GET', '/api/notes', 200, durationMs / 1000);
    logger.info('get_notes_completed', {
      requestId,
      userId: user.id,
      method: 'GET',
      path: '/api/notes',
      status: 200,
      durationMs,
      count: notes.length,
      hasMore,
      search: search || undefined,
      sort,
      order,
    });

    return NextResponse.json(
      { success: true, notes, nextCursor, hasMore },
      { headers: { 'x-request-id': requestId } }
    );
  } catch (error: any) {
    const durationMs = performance.now() - startTime;

    if (error instanceof UnauthorizedError || error.name === 'UnauthorizedError') {
      recordHttpRequest('GET', '/api/notes', 401, durationMs / 1000);
      logger.warn('get_notes_unauthorized', {
        requestId,
        method: 'GET',
        path: '/api/notes',
        status: 401,
        durationMs,
      });

      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: { 'x-request-id': requestId } }
      );
    }

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
