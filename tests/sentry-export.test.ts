import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import {
  withSentryRouteSpan,
  withSentryChildSpan,
  sanitizeSpan,
  scheduleOrAwaitSentryFlush,
} from '@/lib/sentry-tracing';

const { mockAfter, afterState } = vi.hoisted(() => {
  const afterState = {
    simulateRequestScope: false,
    scheduledCallback: null as (() => Promise<void>) | null,
  };
  const mockAfter = vi.fn((fn: () => Promise<void>) => {
    if (afterState.simulateRequestScope) {
      afterState.scheduledCallback = fn;
    } else {
      throw new Error(
        '`after` was called outside a request scope. For more information, see: https://nextjs.org/docs/messages/next-after-called-outside-request-scope'
      );
    }
  });
  return { mockAfter, afterState };
});

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: mockAfter,
  };
});

function getAttrValue(attr: any) {
  if (attr && typeof attr === 'object' && 'value' in attr) {
    return attr.value;
  }
  return attr;
}

describe('Sentry API Tracing Span Export Integration (Step 10J)', () => {
  const receivedEnvelopes: any[] = [];
  let flushCallCount = 0;
  let rootSpanStateAtFlush: { ended: boolean; hasEndTime: boolean } | null = null;
  let capturedRootSpan: any = null;

  beforeEach(() => {
    vi.restoreAllMocks();
    afterState.simulateRequestScope = false;
    afterState.scheduledCallback = null;
    mockAfter.mockClear();
    receivedEnvelopes.length = 0;
    flushCallCount = 0;
    rootSpanStateAtFlush = null;
    capturedRootSpan = null;

    Sentry.init({
      dsn: 'https://00000000000000000000000000000000@o0.ingest.sentry.io/0',
      enabled: true,
      environment: 'test',
      tracesSampleRate: 1.0,
      beforeSendSpan: sanitizeSpan,
      transport: () => ({
        send: async (envelope: any) => {
          receivedEnvelopes.push(envelope);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });

    const client = Sentry.getClient();
    if (client) {
      const originalFlush = client.flush.bind(client);
      vi.spyOn(client, 'flush').mockImplementation(async (timeout?: number) => {
        flushCallCount++;
        if (capturedRootSpan) {
          rootSpanStateAtFlush = {
            ended: !capturedRootSpan.isRecording(),
            hasEndTime: capturedRootSpan._endTime !== undefined,
          };
        }
        return originalFlush(timeout);
      });
    }
  });

  it('1. exports both root span and child span to the test transport on successful execution', async () => {
    const response = await withSentryRouteSpan(
      { name: 'GET /api/notes', method: 'GET', route: '/api/notes' },
      async (span: any) => {
        capturedRootSpan = span;
        const authResult = await withSentryChildSpan('auth.require_user', { op: 'auth' }, async (childSpan) => {
          childSpan.setAttribute('operation', 'auth_check');
          return { userId: 'mock-user-id' };
        });

        span.setAttribute('notes.returned_count', 5);
        return { status: 200, data: authResult };
      }
    );

    // Verify response is preserved
    expect(response.status).toBe(200);
    expect(response.data.userId).toBe('mock-user-id');

    // Verify flush was called and executed
    expect(flushCallCount).toBeGreaterThanOrEqual(1);

    // Verify transport received at least one envelope
    expect(receivedEnvelopes.length).toBeGreaterThanOrEqual(1);

    // Inspect envelope items
    const allSpanItems: any[] = [];
    for (const envelope of receivedEnvelopes) {
      const items = envelope[1] || [];
      for (const item of items) {
        if (item[0]?.type === 'span' && Array.isArray(item[1]?.items)) {
          allSpanItems.push(...item[1].items);
        }
      }
    }

    const rootSpan = allSpanItems.find((s) => s.name === 'GET /api/notes');
    const childSpan = allSpanItems.find((s) => s.name === 'auth.require_user');

    expect(rootSpan).toBeDefined();
    expect(rootSpan.is_segment).toBe(true);
    expect(rootSpan.status).toBe('ok');
    expect(getAttrValue(rootSpan.attributes['http.method'])).toBe('GET');
    expect(getAttrValue(rootSpan.attributes['http.route'])).toBe('/api/notes');
    expect(getAttrValue(rootSpan.attributes['http.status_code'])).toBe(200);
    expect(getAttrValue(rootSpan.attributes['notes.returned_count'])).toBe(5);

    expect(childSpan).toBeDefined();
    expect(childSpan.name).toBe('auth.require_user');
    expect(getAttrValue(childSpan.attributes['sentry.op'])).toBe('auth');
    expect(getAttrValue(childSpan.attributes['operation'])).toBe('auth_check');
  });

  it('2. guarantees the root span is fully ended BEFORE the final flush is scheduled', async () => {
    await withSentryRouteSpan(
      { name: 'GET /api/notes/[id]', method: 'GET', route: '/api/notes/[id]' },
      async (span: any) => {
        capturedRootSpan = span;
        return { status: 200 };
      }
    );

    expect(rootSpanStateAtFlush).not.toBeNull();
    expect(rootSpanStateAtFlush?.ended).toBe(true);
    expect(rootSpanStateAtFlush?.hasEndTime).toBe(true);
  });

  it('3. propagates route exceptions unchanged while ensuring the error span is exported', async () => {
    let thrownError: any = null;

    try {
      await withSentryRouteSpan(
        { name: 'POST /api/generate', method: 'POST', route: '/api/generate' },
        async (span: any) => {
          capturedRootSpan = span;
          throw new Error('Database pool exhaustion');
        }
      );
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toBe('Database pool exhaustion');

    // Flush was still called in finally block
    expect(flushCallCount).toBeGreaterThanOrEqual(1);
    expect(receivedEnvelopes.length).toBeGreaterThanOrEqual(1);

    const allSpanItems = receivedEnvelopes.flatMap((env) =>
      (env[1] || []).flatMap((i: any) => i[1]?.items || [])
    );
    const errorSpan = allSpanItems.find((s) => s.name === 'POST /api/generate');
    expect(errorSpan).toBeDefined();
    expect(errorSpan.status).toBe('error');
    expect(getAttrValue(errorSpan.attributes['http.status_code'])).toBe(500);
  });

  it('4. ensures flush failure never replaces a successful response or masks an original error', async () => {
    const client = Sentry.getClient();
    if (client) {
      vi.spyOn(client, 'flush').mockRejectedValue(new Error('Flushing network timeout'));
    }

    // Success path is not broken by flush rejection
    const successRes = await withSentryRouteSpan(
      { name: 'GET /api/notes', method: 'GET', route: '/api/notes' },
      async () => ({ status: 200, ok: true })
    );
    expect(successRes).toEqual({ status: 200, ok: true });

    // Exception path is not masked by flush rejection
    let caughtError: any = null;
    try {
      await withSentryRouteSpan(
        { name: 'GET /api/notes', method: 'GET', route: '/api/notes' },
        async () => {
          throw new Error('Application level business failure');
        }
      );
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError?.message).toBe('Application level business failure');
  });

  it('5. enforces outgoing span sanitization and drops unauthorized or sensitive attributes in export', async () => {
    await withSentryRouteSpan(
      { name: 'DELETE /api/notes/[id]', method: 'DELETE', route: '/api/notes/[id]' },
      async (span: any) => {
        // Safe allowed attribute
        span.setAttribute('operation.status', 'note_deleted');
        // Unapproved and sensitive attributes that must never appear in export
        span.setAttribute('user_id', 'sensitive-user-uuid');
        span.setAttribute('secret_api_key', 'AIzaSy123456789');
        span.setAttribute('unapproved_custom_field', 'leaked_data');
        return { status: 200 };
      }
    );

    const allSpanItems = receivedEnvelopes.flatMap((env) =>
      (env[1] || []).flatMap((i: any) => i[1]?.items || [])
    );
    const rootSpan = allSpanItems.find((s) => s.name === 'DELETE /api/notes/[id]');
    expect(rootSpan).toBeDefined();

    // Approved attribute is retained
    expect(getAttrValue(rootSpan.attributes['operation.status'])).toBe('note_deleted');

    // Sensitive & unapproved attributes are stripped
    expect(rootSpan.attributes).not.toHaveProperty('user_id');
    expect(rootSpan.attributes).not.toHaveProperty('secret_api_key');
    expect(rootSpan.attributes).not.toHaveProperty('unapproved_custom_field');
  });

  it('6. schedules flush via Next.js after() without delaying response, and delivers to transport upon execution', async () => {
    afterState.simulateRequestScope = true;

    const start = performance.now();
    const response = await withSentryRouteSpan(
      { name: 'GET /api/notes', method: 'GET', route: '/api/notes' },
      async () => ({ status: 200, data: 'fast-response' })
    );
    const duration = performance.now() - start;

    // Response returns immediately without blocking on flush execution
    expect(response.status).toBe(200);
    expect(response.data).toBe('fast-response');
    expect(afterState.scheduledCallback).not.toBeNull();
    expect(duration).toBeLessThan(50);

    // Envelopes have not yet been sent to transport prior to background after() task execution
    expect(receivedEnvelopes.length).toBe(0);

    // Execute the scheduled after() task as Next.js does in the background
    await afterState.scheduledCallback!();

    // Verify envelopes are delivered to the transport
    expect(receivedEnvelopes.length).toBeGreaterThanOrEqual(1);
    const allSpanItems = receivedEnvelopes.flatMap((env) =>
      (env[1] || []).flatMap((i: any) => i[1]?.items || [])
    );
    const rootSpan = allSpanItems.find((s) => s.name === 'GET /api/notes');
    expect(rootSpan).toBeDefined();
    expect(getAttrValue(rootSpan.attributes['http.route'])).toBe('/api/notes');
  });

  it('7. safely falls back to directly awaiting bounded flush when outside Next.js request scope', async () => {
    // When outside request context, after() throws; scheduleOrAwaitSentryFlush catches and falls back
    afterState.simulateRequestScope = false;

    const start = performance.now();
    const response = await withSentryRouteSpan(
      { name: 'GET /api/notes', method: 'GET', route: '/api/notes' },
      async () => ({ status: 200 })
    );
    const durationMs = performance.now() - start;

    expect(response.status).toBe(200);
    expect(durationMs).toBeLessThan(100);

    // Verifies envelopes are immediately received in the local/test fallback
    expect(receivedEnvelopes.length).toBeGreaterThanOrEqual(1);
    const allSpanItems = receivedEnvelopes.flatMap((env) =>
      (env[1] || []).flatMap((i: any) => i[1]?.items || [])
    );
    const rootSpan = allSpanItems.find((s) => s.name === 'GET /api/notes');
    expect(rootSpan).toBeDefined();
  });
});
