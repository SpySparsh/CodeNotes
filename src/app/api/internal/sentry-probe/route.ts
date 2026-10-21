import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PROBE_HEADER = 'x-sentry-probe-secret';
export const PROBE_EXCEPTION_MESSAGE = 'CodeNotes production Sentry connectivity probe';

/**
 * Validates whether the temporary probe endpoint is enabled via environment variable.
 */
function isProbeEnabled(): boolean {
  const secret = process.env.SENTRY_PROBE_SECRET;
  return typeof secret === 'string' && secret.trim().length > 0;
}

/**
 * Safely compares two secret strings using constant-time evaluation to prevent timing attacks.
 * Hashing both values to SHA-256 guarantees equal length buffers without leaking length information.
 */
function safeCompareSecrets(provided: string, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const providedHash = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();

  return crypto.timingSafeEqual(providedHash, expectedHash);
}

/**
 * Handles non-POST requests to ensure method restriction while returning 404
 * when the probe is disabled (preventing route enumeration).
 */
function handleUnsupportedMethod(): NextResponse {
  if (!isProbeEnabled()) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }
  return NextResponse.json({ error: 'Method Not Allowed' }, { status: 405 });
}

export async function GET(): Promise<NextResponse> {
  return handleUnsupportedMethod();
}

export async function PUT(): Promise<NextResponse> {
  return handleUnsupportedMethod();
}

export async function DELETE(): Promise<NextResponse> {
  return handleUnsupportedMethod();
}

export async function PATCH(): Promise<NextResponse> {
  return handleUnsupportedMethod();
}

export async function POST(request: Request): Promise<NextResponse> {
  // 1. If probe is disabled, return 404 to avoid route enumeration
  const configuredSecret = process.env.SENTRY_PROBE_SECRET;
  if (!configuredSecret || typeof configuredSecret !== 'string' || configuredSecret.trim().length === 0) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  // 2. Validate authentication header using constant-time comparison
  const providedSecret = request.headers.get(PROBE_HEADER);
  if (!providedSecret || !safeCompareSecrets(providedSecret, configuredSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 3. Authenticated: capture exactly one fixed synthetic exception in an isolated scope
  try {
    const probeError = new Error(PROBE_EXCEPTION_MESSAGE);

    // Isolate scope to ensure ambient request headers, cookies, query params, and breadcrumbs are never attached
    const eventId = Sentry.withScope((scope) => {
      if (typeof scope.clearBreadcrumbs === 'function') {
        scope.clearBreadcrumbs();
      }
      if (typeof scope.setTag === 'function') {
        scope.setTag('probe', 'connectivity_test');
        scope.setTag('runtime', 'nodejs');
      }
      if (typeof scope.addEventProcessor === 'function') {
        scope.addEventProcessor((event) => {
          if (event.request) {
            delete event.request.headers;
            delete event.request.cookies;
            delete event.request.data;
            if (typeof event.request.url === 'string') {
              try {
                const parsed = new URL(event.request.url, 'http://localhost');
                event.request.url = parsed.pathname;
              } catch {
                event.request.url = '/api/internal/sentry-probe';
              }
            }
          }
          event.user = undefined;
          delete event.breadcrumbs;
          delete event.extra;
          if (event.exception?.values) {
            for (const exc of event.exception.values) {
              if (exc.stacktrace?.frames) {
                for (const frame of exc.stacktrace.frames) {
                  delete frame.pre_context;
                  delete frame.context_line;
                  delete frame.post_context;
                }
              }
            }
          }
          return event;
        });
      }

      return Sentry.captureException(probeError);
    });

    // 4. Bounded flush of Sentry client to ensure envelope delivery before response
    const client = Sentry.getClient();
    let flushed = false;
    if (client) {
      try {
        flushed = await Promise.resolve(client.flush(5000)).catch(() => false);
      } catch {
        flushed = false;
      }
    }

    return NextResponse.json(
      {
        ok: true,
        captured: Boolean(eventId),
        eventId: eventId || null,
        flushed,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      }
    );
  } catch {
    // Defensively isolate any probe errors without disclosing internals or secrets
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
