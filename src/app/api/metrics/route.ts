import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { registry } from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Safely compares two secret strings using constant-time equality.
 * Handles differing lengths without throwing RangeError.
 */
function safeCompareSecret(provided: string, expected: string): boolean {
  if (!provided || !expected) {
    return false;
  }
  const bufProvided = Buffer.from(provided, 'utf8');
  const bufExpected = Buffer.from(expected, 'utf8');
  if (bufProvided.length !== bufExpected.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufProvided, bufExpected);
}

export async function GET(request?: Request) {
  const metricsSecret = process.env.METRICS_SECRET?.trim() || null;
  const isProductionOrPreview =
    process.env.NODE_ENV === 'production' ||
    process.env.VERCEL_ENV === 'production' ||
    process.env.VERCEL_ENV === 'preview';

  // In production or preview deployments, fail closed if METRICS_SECRET is missing or blank
  if (isProductionOrPreview && !metricsSecret) {
    return new NextResponse('Service Unavailable', {
      status: 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    });
  }

  // Authentication is required if:
  // 1. Running in production or preview, OR
  // 2. METRICS_SECRET is explicitly configured (including in local development)
  const isAuthRequired = isProductionOrPreview || Boolean(metricsSecret);

  if (isAuthRequired) {
    const authHeader = request?.headers?.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new NextResponse('Unauthorized', {
        status: 401,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      });
    }

    const providedToken = authHeader.slice(7).trim();
    if (!providedToken || !metricsSecret || !safeCompareSecret(providedToken, metricsSecret)) {
      return new NextResponse('Unauthorized', {
        status: 401,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      });
    }
  }

  const metrics = await registry.metrics();
  return new NextResponse(metrics, {
    status: 200,
    headers: {
      'Content-Type': registry.contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    },
  });
}
