import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sanitizeUrl,
  sanitizeHeaders,
  sanitizeText,
  sanitizeObject,
  sanitizeBreadcrumb,
  sanitizeEvent,
} from '../src/lib/sentry/sanitizer';
import * as Sentry from '@sentry/nextjs';

describe('Sentry Sanitizer & Privacy Protections', () => {
  describe('sanitizeUrl', () => {
    it('redacts sensitive query parameters (case-insensitive key, token, secret, password, apikey, jwt, session, code)', () => {
      const url =
        'https://api.example.com/v1/generate?api_key=secret123&Token=abc-xyz&password=p@ss&key=AIzaSyD-12345&session=sess99&jwt=eyJh.b.c&code=oauthcode123&videoId=dQw4w9WgXcQ';
      const sanitized = sanitizeUrl(url);

      expect(sanitized).toContain('api_key=%5BREDACTED%5D');
      expect(sanitized).toContain('Token=%5BREDACTED%5D');
      expect(sanitized).toContain('password=%5BREDACTED%5D');
      expect(sanitized).toContain('key=%5BREDACTED%5D');
      expect(sanitized).toContain('session=%5BREDACTED%5D');
      expect(sanitized).toContain('jwt=%5BREDACTED%5D');
      expect(sanitized).toContain('code=%5BREDACTED%5D');
      expect(sanitized).not.toContain('secret123');
      expect(sanitized).not.toContain('p@ss');
      expect(sanitized).not.toContain('AIzaSyD-12345');
      expect(sanitized).not.toContain('sess99');
      // Preserves safe routing params
      expect(sanitized).toContain('videoId=dQw4w9WgXcQ');
    });

    it('handles relative URLs correctly without breaking path structure', () => {
      const relativeUrl = '/api/generate?auth=bearer-token-123&sort=desc';
      const sanitized = sanitizeUrl(relativeUrl);

      expect(sanitized).toContain('/api/generate');
      expect(sanitized).toContain('auth=%5BREDACTED%5D');
      expect(sanitized).toContain('sort=desc');
      expect(sanitized).not.toContain('bearer-token-123');
    });

    it('handles empty or malformed URLs gracefully', () => {
      expect(sanitizeUrl('')).toBe('');
      expect(sanitizeUrl(undefined)).toBe('');
    });
  });

  describe('sanitizeHeaders', () => {
    it('removes sensitive authentication and cookie headers', () => {
      const headers = {
        'authorization': 'Bearer super-secret-token',
        'cookie': 'session_token=12345; user_id=usr_001',
        'set-cookie': 'refresh_token=xyz987',
        'x-api-key': 'supadata_live_key',
        'x-inngest-signature': 't=12345,s=sig67890',
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 Chrome/120',
      };

      const sanitized = sanitizeHeaders(headers);

      expect(sanitized).not.toHaveProperty('authorization');
      expect(sanitized).not.toHaveProperty('cookie');
      expect(sanitized).not.toHaveProperty('set-cookie');
      expect(sanitized).not.toHaveProperty('x-api-key');
      expect(sanitized).not.toHaveProperty('x-inngest-signature');
      // Safe headers preserved
      expect(sanitized['content-type']).toBe('application/json');
      expect(sanitized['user-agent']).toBe('Mozilla/5.0 Chrome/120');
    });
  });

  describe('sanitizeText', () => {
    it('redacts Bearer tokens, Gemini API keys, Supadata keys, JWTs, and database connection strings from error messages', () => {
      const textWithSecrets =
        'Failed connecting to postgresql://postgres:mypassword123@db.example.com:5432/codenotes with key AIzaSyA1234567890123456789012345678901, Supadata key sd_1234567890abcdef1234567890abcdef, and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.do_not_leak';

      const sanitized = sanitizeText(textWithSecrets);

      expect(sanitized).not.toContain('mypassword123');
      expect(sanitized).not.toContain('AIzaSyA1234567890123456789012345678901');
      expect(sanitized).not.toContain('sd_1234567890abcdef1234567890abcdef');
      expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(sanitized).toContain('[REDACTED_SECRET]');
    });
  });

  describe('sanitizeObject (Recursive)', () => {
    it('recursively scrubs deep nested objects, arrays, secret tokens, and excludes payload fields', () => {
      const complexMaliciousFixture = {
        meta: {
          requestId: 'req-123',
          nested: {
            apiKey: 'AIzaSyA9876543210987654321098765432109',
            token: 'secret-token',
            password: 'plaintext-pass',
            dbUrl: 'postgresql://admin:secretpass@localhost:5432/codenotes',
            safeCount: 10,
          },
          items: [
            { transcript: 'Confidential transcript' },
            { prompt: 'Confidential system prompt' },
            { aiNotes: { overview: 'Secret notes' } },
            { safeItem: 'valid_data' },
          ],
        },
        payload: { body: 'request body payload' },
        rawOutput: 'AI raw generation string',
      };

      const sanitized = sanitizeObject(complexMaliciousFixture);

      expect(sanitized.meta.requestId).toBe('req-123');
      expect(sanitized.meta.nested.apiKey).toBe('[REDACTED]');
      expect(sanitized.meta.nested.token).toBe('[REDACTED]');
      expect(sanitized.meta.nested.password).toBe('[REDACTED]');
      expect(sanitized.meta.nested.dbUrl).not.toContain('secretpass');
      expect(sanitized.meta.nested.safeCount).toBe(10);

      // Excluded payload items dropped
      expect(sanitized.meta.items[0].transcript).toBeUndefined();
      expect(sanitized.meta.items[1].prompt).toBeUndefined();
      expect(sanitized.meta.items[2].aiNotes).toBeUndefined();
      expect(sanitized.meta.items[3].safeItem).toBe('valid_data');
      expect(sanitized.payload).toBeUndefined();
      expect(sanitized.rawOutput).toBeUndefined();
    });
  });

  describe('sanitizeBreadcrumb', () => {
    it('strips request payloads, transcripts, prompts, and sanitizes HTTP breadcrumb URLs and headers', () => {
      const breadcrumb = {
        category: 'http',
        message: 'Request to https://example.com/api?token=secret-token-value',
        data: {
          url: 'https://example.com/api?token=secret-token-value',
          headers: {
            authorization: 'Bearer token-123',
            'content-type': 'application/json',
          },
          body: { videoUrl: 'https://youtube.com/watch?v=dQw4w9WgXcQ' },
          transcript: 'Full confidential transcript text...',
          prompt: 'Generate detailed notes from this transcript...',
          notes: { overview: 'Secret notes content' },
        },
      };

      const sanitized = sanitizeBreadcrumb(breadcrumb);

      expect(sanitized.data.url).not.toContain('secret-token-value');
      expect(sanitized.data.headers).not.toHaveProperty('authorization');
      expect(sanitized.data.headers['content-type']).toBe('application/json');
      expect(sanitized.data.body).toBeUndefined();
      expect(sanitized.data.transcript).toBeUndefined();
      expect(sanitized.data.prompt).toBeUndefined();
      expect(sanitized.data.notes).toBeUndefined();
    });
  });

  describe('sanitizeEvent', () => {
    it('removes user PII, sanitizes request, redacts exception text, and removes extra payloads', () => {
      const rawEvent = {
        user: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          email: 'student@example.com',
          ip_address: '192.168.1.1',
        },
        request: {
          url: 'https://codenotes.app/api/generate?api_key=my-api-key',
          headers: {
            authorization: 'Bearer user-auth-token',
            cookie: 'sb-access-token=jwt-val',
            'content-type': 'application/json',
          },
          data: { prompt: 'Secret AI prompt' },
          cookies: { session: 'session-cookie-val' },
        },
        exception: {
          values: [
            {
              type: 'Error',
              value:
                'Database connection failed: postgresql://admin:secretpass@localhost:5432/codenotes with Bearer token_secret_123',
              stacktrace: { frames: [{ filename: 'generate.ts', lineno: 42 }] },
            },
          ],
        },
        extra: {
          transcript: 'Raw video transcript lines 1 to 5000',
          prompt: 'System prompt instructions...',
          aiNotes: { overview: 'Generated content' },
          safeMetricCount: 42,
          nestedDetails: {
            authSecret: 'super-secret',
            transcriptText: 'transcript payload',
          },
        },
        contexts: {
          generation: {
            videoId: 'dQw4w9WgXcQ',
            transcriptText: 'Raw transcript in context',
            idempotencyKey: 'idem-123',
          },
        },
        breadcrumbs: [
          {
            category: 'xhr',
            data: {
              url: 'https://api.gemini.google.com/v1?key=AIzaSyA1234567890123456789012345678901',
              headers: { authorization: 'Bearer gemini-key' },
            },
          },
        ],
      };

      const sanitized = sanitizeEvent(rawEvent);

      // User PII completely erased
      expect(sanitized.user).toBeUndefined();

      // Request data & cookies erased; headers and URL sanitized
      expect(sanitized.request.data).toBeUndefined();
      expect(sanitized.request.cookies).toBeUndefined();
      expect(sanitized.request.headers).not.toHaveProperty('authorization');
      expect(sanitized.request.headers).not.toHaveProperty('cookie');
      expect(sanitized.request.headers['content-type']).toBe('application/json');
      expect(sanitized.request.url).not.toContain('my-api-key');

      // Exception value sanitized while stack trace preserved
      expect(sanitized.exception.values[0].value).not.toContain('secretpass');
      expect(sanitized.exception.values[0].value).not.toContain('token_secret_123');
      expect(sanitized.exception.values[0].stacktrace.frames[0].lineno).toBe(42);

      // Extra payloads stripped while safe metadata remains
      expect(sanitized.extra.transcript).toBeUndefined();
      expect(sanitized.extra.prompt).toBeUndefined();
      expect(sanitized.extra.aiNotes).toBeUndefined();
      expect(sanitized.extra.safeMetricCount).toBe(42);
      expect(sanitized.extra.nestedDetails.authSecret).toBe('[REDACTED]');
      expect(sanitized.extra.nestedDetails.transcriptText).toBeUndefined();

      // Context stripped of transcript text
      expect(sanitized.contexts.generation.transcriptText).toBeUndefined();
      expect(sanitized.contexts.generation.videoId).toBe('dQw4w9WgXcQ');
      expect(sanitized.contexts.generation.idempotencyKey).toBe('idem-123');

      // Breadcrumbs sanitized
      expect(sanitized.breadcrumbs[0].data.url).not.toContain('AIzaSyA');
      expect(sanitized.breadcrumbs[0].data.headers).not.toHaveProperty('authorization');
    });
  });

  describe('Optional Sentry Initialization & Zero-Submission Guarantees', () => {
    afterEach(() => {
      // Clean up any client state to prevent global state leaks across test suites
      try {
        const client = Sentry.getClient();
        if (client) {
          (client as any).close?.();
        }
      } catch {}
    });

    it('server runtime: with SENTRY_DSN unset, initializes disabled and sends 0 events via transport', () => {
      const savedDsn = process.env.SENTRY_DSN;
      delete process.env.SENTRY_DSN;

      const mockSend = vi.fn().mockResolvedValue({ status: 'success' });
      const mockTransport = () => ({
        send: mockSend,
        flush: vi.fn().mockResolvedValue(true),
      });

      const serverDsn = process.env.SENTRY_DSN;
      expect(serverDsn).toBeUndefined();

      Sentry.init({
        dsn: serverDsn,
        enabled: Boolean(serverDsn),
        environment: 'test',
        beforeSend: sanitizeEvent,
        beforeBreadcrumb: sanitizeBreadcrumb,
        transport: mockTransport as any,
      });

      Sentry.captureException(new Error('Server test exception with unset DSN'));

      // Assert that transport send was never invoked (0 events submitted)
      expect(mockSend).not.toHaveBeenCalled();

      if (savedDsn !== undefined) {
        process.env.SENTRY_DSN = savedDsn;
      }
    });

    it('client runtime: with NEXT_PUBLIC_SENTRY_DSN unset, initializes disabled and sends 0 events via transport', () => {
      const savedDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
      delete process.env.NEXT_PUBLIC_SENTRY_DSN;

      const mockSend = vi.fn().mockResolvedValue({ status: 'success' });
      const mockTransport = () => ({
        send: mockSend,
        flush: vi.fn().mockResolvedValue(true),
      });

      const clientDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
      expect(clientDsn).toBeUndefined();

      Sentry.init({
        dsn: clientDsn,
        enabled: Boolean(clientDsn),
        environment: 'test',
        beforeSend: sanitizeEvent,
        beforeBreadcrumb: sanitizeBreadcrumb,
        transport: mockTransport as any,
      });

      Sentry.captureException(new Error('Client test exception with unset DSN'));

      // Assert that transport send was never invoked (0 events submitted)
      expect(mockSend).not.toHaveBeenCalled();

      if (savedDsn !== undefined) {
        process.env.NEXT_PUBLIC_SENTRY_DSN = savedDsn;
      }
    });

    it('capturing an exception in disabled state does not throw or crash runtime', () => {
      expect(() => {
        Sentry.captureException(new Error('Sample test error in disabled state'));
      }).not.toThrow();
    });
  });
});
