import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/request-context';
import { recordHttpRequest } from '@/lib/metrics';

export async function GET(request?: Request) {
  const startTime = performance.now();
  const requestId = getRequestId(request);

  try {
    await query('SELECT 1');
    const durationMs = performance.now() - startTime;
    recordHttpRequest('GET', '/api/health', 200, durationMs / 1000);

    logger.info('health_check_passed', {
      requestId,
      method: 'GET',
      path: '/api/health',
      status: 200,
      durationMs,
      database: 'healthy',
    });

    return NextResponse.json(
      {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: 'connected',
      },
      {
        status: 200,
        headers: { 'x-request-id': requestId },
      }
    );
  } catch (error: any) {
    const durationMs = performance.now() - startTime;
    recordHttpRequest('GET', '/api/health', 503, durationMs / 1000);

    logger.error('health_check_failed', {
      requestId,
      method: 'GET',
      path: '/api/health',
      status: 503,
      durationMs,
      errorMessage: error.message || 'Database unavailable',
    });

    return NextResponse.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
      },
      {
        status: 503,
        headers: { 'x-request-id': requestId },
      }
    );
  }
}
