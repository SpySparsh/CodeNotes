import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/request-context';
import { recordHttpRequest } from '@/lib/metrics';
import { requireUser, UnauthorizedError } from '@/lib/auth';

export async function GET(request: Request) {
  const startTime = performance.now();
  const requestId = getRequestId(request);
  const url = new URL(request.url);
  const key = url.searchParams.get('key')?.trim();

  let authenticatedUserId: string | null = null;

  try {
    const user = await requireUser();
    authenticatedUserId = user.id;

    if (!key) {
      const durationMs = performance.now() - startTime;
      recordHttpRequest('GET', '/api/generate/status', 400, durationMs / 1000);
      return NextResponse.json(
        { error: 'Idempotency key parameter (key) is required' },
        { status: 400, headers: { 'x-request-id': requestId } }
      );
    }

    const result = await query(
      `SELECT status, note_id, error_message, error_code, attempts
       FROM generation_idempotency
       WHERE user_id = $1 AND key = $2`,
      [authenticatedUserId, key]
    );

    if (result.rows.length === 0) {
      const durationMs = performance.now() - startTime;
      recordHttpRequest('GET', '/api/generate/status', 404, durationMs / 1000);
      return NextResponse.json(
        { error: 'Generation record not found' },
        { status: 404, headers: { 'x-request-id': requestId } }
      );
    }

    const row = result.rows[0];
    const durationMs = performance.now() - startTime;
    recordHttpRequest('GET', '/api/generate/status', 200, durationMs / 1000);

    logger.info('generate_status_polled', {
      requestId,
      userId: authenticatedUserId,
      key,
      status: row.status,
      durationMs,
    });

    if (row.status === 'completed') {
      return NextResponse.json(
        {
          status: 'completed',
          noteId: row.note_id,
        },
        { status: 200, headers: { 'x-request-id': requestId } }
      );
    }

    if (row.status === 'processing') {
      return NextResponse.json(
        {
          status: 'processing',
          attempts: row.attempts || 1,
        },
        { status: 200, headers: { 'x-request-id': requestId } }
      );
    }

    if (row.status === 'failed') {
      return NextResponse.json(
        {
          status: 'failed',
          error: row.error_message || 'Note generation failed. Please try again.',
          code: row.error_code || 'GENERATION_FAILED',
        },
        { status: 200, headers: { 'x-request-id': requestId } }
      );
    }

    // Default: pending
    return NextResponse.json(
      {
        status: 'pending',
      },
      { status: 200, headers: { 'x-request-id': requestId } }
    );
  } catch (error: any) {
    const durationMs = performance.now() - startTime;

    if (error instanceof UnauthorizedError || error.name === 'UnauthorizedError') {
      recordHttpRequest('GET', '/api/generate/status', 401, durationMs / 1000);
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: { 'x-request-id': requestId } }
      );
    }

    recordHttpRequest('GET', '/api/generate/status', 500, durationMs / 1000);
    logger.error('generate_status_failed', {
      requestId,
      userId: authenticatedUserId || undefined,
      key,
      errorMessage: error.message,
    });

    return NextResponse.json(
      { error: 'Failed to retrieve generation status' },
      { status: 500, headers: { 'x-request-id': requestId } }
    );
  }
}
