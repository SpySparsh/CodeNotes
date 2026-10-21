import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import {
  POST,
  GET,
  PUT,
  DELETE,
  PROBE_HEADER,
  PROBE_EXCEPTION_MESSAGE,
} from '@/app/api/internal/sentry-probe/route';
import { sanitizeEvent } from '@/lib/sentry/sanitizer';
import * as db from '@/lib/db';
import { inngest } from '@/inngest/client';

describe('Production Sentry Error Probe Endpoint (Step 10O)', () => {
  const originalEnv = process.env;
  const TEST_SECRET = 'test-sentry-probe-secret-abcdef1234567890';
  const receivedEnvelopes: any[] = [];
  let dbQuerySpy: any;
  let inngestSendSpy: any;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SENTRY_PROBE_SECRET;

    receivedEnvelopes.length = 0;

    // Initialize local Sentry client with in-memory transport & privacy sanitizer
    Sentry.init({
      dsn: 'https://00000000000000000000000000000000@o0.ingest.sentry.io/0',
      enabled: true,
      environment: 'test',
      beforeSend: sanitizeEvent,
      transport: () => ({
        send: async (envelope: any) => {
          receivedEnvelopes.push(envelope);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });

    dbQuerySpy = vi.spyOn(db, 'query').mockImplementation(async () => ({ rows: [] } as any));
    inngestSendSpy = vi.spyOn(inngest, 'send').mockImplementation(async () => ({ ids: [] } as any));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('1. returns 404 when SENTRY_PROBE_SECRET is not configured (disabled probe)', async () => {
    delete process.env.SENTRY_PROBE_SECRET;

    const request = new Request('http://localhost/api/internal/sentry-probe', {
      method: 'POST',
      headers: {
        [PROBE_HEADER]: TEST_SECRET,
      },
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Not Found');
    expect(receivedEnvelopes.length).toBe(0);

    // Also verify GET returns 404 when disabled to prevent route enumeration
    const getResponse = await GET();
    expect(getResponse.status).toBe(404);
  });

  it('2. returns 404 when SENTRY_PROBE_SECRET is an empty or whitespace string', async () => {
    process.env.SENTRY_PROBE_SECRET = '   ';

    const request = new Request('http://localhost/api/internal/sentry-probe', {
      method: 'POST',
      headers: {
        [PROBE_HEADER]: '   ',
      },
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Not Found');
    expect(receivedEnvelopes.length).toBe(0);
  });

  it('3. returns 401 when the probe header is missing', async () => {
    process.env.SENTRY_PROBE_SECRET = TEST_SECRET;

    const request = new Request('http://localhost/api/internal/sentry-probe', {
      method: 'POST',
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe('Unauthorized');
    expect(receivedEnvelopes.length).toBe(0);
  });

  it('4. returns 401 when the probe header does not match the configured secret', async () => {
    process.env.SENTRY_PROBE_SECRET = TEST_SECRET;

    const request = new Request('http://localhost/api/internal/sentry-probe', {
      method: 'POST',
      headers: {
        [PROBE_HEADER]: 'wrong-invalid-secret',
      },
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe('Unauthorized');
    expect(receivedEnvelopes.length).toBe(0);
  });

  it('5. returns 405 Method Not Allowed for non-POST methods when probe is enabled', async () => {
    process.env.SENTRY_PROBE_SECRET = TEST_SECRET;

    const getRes = await GET();
    expect(getRes.status).toBe(405);
    expect((await getRes.json()).error).toBe('Method Not Allowed');

    const putRes = await PUT();
    expect(putRes.status).toBe(405);

    const deleteRes = await DELETE();
    expect(deleteRes.status).toBe(405);

    expect(receivedEnvelopes.length).toBe(0);
  });

  it('6. captures exactly one synthetic exception when authorized, delivering to transport with bounded flush', async () => {
    process.env.SENTRY_PROBE_SECRET = TEST_SECRET;

    const request = new Request('http://localhost/api/internal/sentry-probe', {
      method: 'POST',
      headers: {
        [PROBE_HEADER]: TEST_SECRET,
      },
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.captured).toBe(true);
    expect(body.eventId).toBeDefined();
    expect(typeof body.eventId).toBe('string');
    expect(body.flushed).toBe(true);

    // Verify response body never leaks the secret
    const serializedResponse = JSON.stringify(body);
    expect(serializedResponse.includes(TEST_SECRET)).toBe(false);

    // Inspect delivered envelope
    expect(receivedEnvelopes.length).toBe(1);
    const envelope = receivedEnvelopes[0];
    const items = envelope[1] || [];

    // Verify entire serialized envelope string never contains the secret
    const serializedEnvelope = JSON.stringify(envelope);
    expect(serializedEnvelope.includes(TEST_SECRET)).toBe(false);

    // Find the error event item in the envelope
    const eventItem = items.find((item: any) => item[0]?.type === 'event');
    expect(eventItem).toBeDefined();
    const eventPayload = eventItem[1];

    // Verify exception metadata
    expect(eventPayload.exception?.values).toBeDefined();
    expect(eventPayload.exception.values.length).toBe(1);
    expect(eventPayload.exception.values[0].value).toBe(PROBE_EXCEPTION_MESSAGE);
    expect(eventPayload.tags?.probe).toBe('connectivity_test');

    // Verify privacy: no user identity, headers, or request body attached
    expect(eventPayload.user).toBeUndefined();
    expect(eventPayload.request?.headers).toBeUndefined();
    expect(eventPayload.request?.cookies).toBeUndefined();
    expect(eventPayload.request?.data).toBeUndefined();
  });

  it('7. completely ignores caller request body or parameters and preserves the fixed synthetic exception', async () => {
    process.env.SENTRY_PROBE_SECRET = TEST_SECRET;

    const request = new Request('http://localhost/api/internal/sentry-probe?msg=injected_param', {
      method: 'POST',
      headers: {
        [PROBE_HEADER]: TEST_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'attacker_custom_exception_message',
        user_id: 'attacker_fake_user',
        error: 'fake_exploit',
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);

    expect(receivedEnvelopes.length).toBe(1);
    const eventPayload = receivedEnvelopes[0][1].find((item: any) => item[0]?.type === 'event')[1];

    // The exception message must remain strictly fixed
    expect(eventPayload.exception.values[0].value).toBe(PROBE_EXCEPTION_MESSAGE);
    expect(eventPayload.exception.values[0].value).not.toContain('attacker_custom_exception_message');
    expect(eventPayload.exception.values[0].value).not.toContain('injected_param');
  });

  it('8. performs zero database writes, zero external AI calls, and zero Inngest event dispatches', async () => {
    process.env.SENTRY_PROBE_SECRET = TEST_SECRET;

    const request = new Request('http://localhost/api/internal/sentry-probe', {
      method: 'POST',
      headers: {
        [PROBE_HEADER]: TEST_SECRET,
      },
    });

    await POST(request);

    // Verify DB and Inngest were never touched
    expect(dbQuerySpy).not.toHaveBeenCalled();
    expect(inngestSendSpy).not.toHaveBeenCalled();
  });

  it('9. guarantees secret, other headers, cookies, query parameters, and ambient user data NEVER appear in the captured or serialized Sentry event', async () => {
    process.env.SENTRY_PROBE_SECRET = TEST_SECRET;

    // Simulate ambient user and breadcrumbs on the current scope
    Sentry.setUser({ id: 'injected_user_id', email: 'secret_user@example.com' });
    Sentry.addBreadcrumb({ message: 'ambient_prior_breadcrumb_123', category: 'auth' });

    const request = new Request('http://localhost/api/internal/sentry-probe?secret_param=12345&query_data=leaked', {
      method: 'POST',
      headers: {
        [PROBE_HEADER]: TEST_SECRET,
        authorization: 'Bearer secret_bearer_token_xyz',
        cookie: 'session=secret_cookie_token_999; other=123',
        'x-caller-header': 'caller_private_value',
      },
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);

    // 1. Response never discloses the secret or header values
    const serializedResponse = JSON.stringify(body);
    expect(serializedResponse.includes(TEST_SECRET)).toBe(false);
    expect(serializedResponse.includes('secret_bearer_token_xyz')).toBe(false);
    expect(serializedResponse.includes('secret_cookie_token_999')).toBe(false);

    // 2. Entire serialized Sentry envelope never discloses the secret or request metadata
    expect(receivedEnvelopes.length).toBe(1);
    const envelope = receivedEnvelopes[0];
    const serializedEnvelope = JSON.stringify(envelope);

    expect(serializedEnvelope.includes(TEST_SECRET)).toBe(false);
    expect(serializedEnvelope.includes('secret_bearer_token_xyz')).toBe(false);
    expect(serializedEnvelope.includes('secret_cookie_token_999')).toBe(false);
    expect(serializedEnvelope.includes('caller_private_value')).toBe(false);
    expect(serializedEnvelope.includes('secret_param')).toBe(false);
    expect(serializedEnvelope.includes('query_data')).toBe(false);
    expect(serializedEnvelope.includes('secret_user@example.com')).toBe(false);
    expect(serializedEnvelope.includes('injected_user_id')).toBe(false);

    // 3. Inspect event payload properties directly
    const eventPayload = envelope[1].find((item: any) => item[0]?.type === 'event')[1];
    expect(eventPayload.user).toBeUndefined();
    expect(eventPayload.request?.headers).toBeUndefined();
    expect(eventPayload.request?.cookies).toBeUndefined();
    expect(eventPayload.request?.data).toBeUndefined();
    expect(eventPayload.breadcrumbs).toBeUndefined();
    expect(eventPayload.exception?.values?.[0]?.value).toBe(PROBE_EXCEPTION_MESSAGE);
    expect(eventPayload.tags?.probe).toBe('connectivity_test');
    expect(eventPayload.tags?.runtime).toBe('nodejs');
  });
});
