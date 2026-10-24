import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateAiNotes,
  getAiClientConfig,
  generatedNotesSchema,
  normalizeRequestId,
  SAFE_REQUEST_ID_REGEX,
  AiClientError,
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_AI_MODEL,
} from '@/lib/ai-client';
import { registry } from '@/lib/metrics';

describe('AI Client Adapter (src/lib/ai-client.ts)', () => {
  const originalFetch = globalThis.fetch;
  const mockTranscript = 'In this tutorial we learn interfaces and generics in TypeScript.';
  const mockTitle = 'TypeScript Generics Masterclass';
  const validServiceUrl = 'http://127.0.0.1:8000';
  const validSecret = 'valid-test-service-secret';

  const sampleValidResponse = {
    overview: 'A compelling overview of TypeScript generics.',
    keyConcepts: ['Interfaces', 'Generics', 'Type Constraints'],
    detailedNotes: '# Detailed Notes\n\n```typescript\nfunction id<T>(arg: T): T { return arg; }\n```',
    shorthands: ['Use interfaces for object shapes', 'Use generics for reusable code'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registry.resetMetrics();
    process.env.FASTAPI_SERVICE_URL = validServiceUrl;
    process.env.FASTAPI_SERVICE_SECRET = validSecret;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('Configuration & Security Validation', () => {
    it('throws CONFIG_ERROR when FASTAPI_SERVICE_URL is missing or blank', () => {
      delete process.env.FASTAPI_SERVICE_URL;
      expect(() => getAiClientConfig()).toThrowError(AiClientError);
      try {
        getAiClientConfig();
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain('FASTAPI_SERVICE_URL is not configured');
      }
    });

    it('throws CONFIG_ERROR when FASTAPI_SERVICE_SECRET is missing or blank', () => {
      delete process.env.FASTAPI_SERVICE_SECRET;
      expect(() => getAiClientConfig()).toThrowError(AiClientError);
      try {
        getAiClientConfig();
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain('FASTAPI_SERVICE_SECRET is not configured');
      }
    });

    it('throws CONFIG_ERROR when FASTAPI_SERVICE_SECRET is a placeholder', () => {
      process.env.FASTAPI_SERVICE_SECRET = 'your_fastapi_service_secret_here';
      try {
        getAiClientConfig();
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain('placeholder');
      }
    });

    it('throws CONFIG_ERROR when FASTAPI_SERVICE_URL is not a valid URL', () => {
      process.env.FASTAPI_SERVICE_URL = 'invalid-url-format';
      try {
        getAiClientConfig();
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain('not a valid URL');
      }
    });

    it('allows http:// for localhost, 127.0.0.1, and [::1]', () => {
      process.env.FASTAPI_SERVICE_URL = 'http://localhost:8000';
      expect(() => getAiClientConfig()).not.toThrow();

      process.env.FASTAPI_SERVICE_URL = 'http://127.0.0.1:8000';
      expect(() => getAiClientConfig()).not.toThrow();

      process.env.FASTAPI_SERVICE_URL = 'http://[::1]:8000';
      expect(() => getAiClientConfig()).not.toThrow();
    });

    it('enforces https:// for remote non-local URLs to protect bearer credentials', () => {
      process.env.FASTAPI_SERVICE_URL = 'http://api.internal.mycompany.com:8000';
      try {
        getAiClientConfig();
        expect.unreachable('Should have thrown for remote http');
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain('must use HTTPS for remote endpoints');
      }

      process.env.FASTAPI_SERVICE_URL = 'https://api.internal.mycompany.com';
      expect(() => getAiClientConfig()).not.toThrow();
    });

    it('strips trailing slashes from service URL', () => {
      process.env.FASTAPI_SERVICE_URL = 'http://localhost:8000///';
      const config = getAiClientConfig();
      expect(config.serviceUrl).toBe('http://localhost:8000');
    });

    it('defaults timeout to 85 seconds when unconfigured', () => {
      delete process.env.FASTAPI_TIMEOUT_MS;
      const config = getAiClientConfig();
      expect(config.timeoutMs).toBe(DEFAULT_AI_TIMEOUT_MS);
      expect(config.timeoutMs).toBe(85000);
    });
  });

  describe('Runtime Schema Validation (generatedNotesSchema)', () => {
    it('validates a complete response matching all 4 fields', () => {
      const parsed = generatedNotesSchema.parse(sampleValidResponse);
      expect(parsed).toEqual(sampleValidResponse);
    });

    it('allows keyConcepts to be an empty array []', () => {
      const data = { ...sampleValidResponse, keyConcepts: [] };
      const parsed = generatedNotesSchema.parse(data);
      expect(parsed.keyConcepts).toEqual([]);
    });

    it('allows shorthands to be an empty array []', () => {
      const data = { ...sampleValidResponse, shorthands: [] };
      const parsed = generatedNotesSchema.parse(data);
      expect(parsed.shorthands).toEqual([]);
    });

    it('rejects response missing overview', () => {
      const { overview, ...rest } = sampleValidResponse;
      const result = generatedNotesSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects response missing detailedNotes', () => {
      const { detailedNotes, ...rest } = sampleValidResponse;
      const result = generatedNotesSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects response missing keyConcepts', () => {
      const { keyConcepts, ...rest } = sampleValidResponse;
      const result = generatedNotesSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects response missing shorthands', () => {
      const { shorthands, ...rest } = sampleValidResponse;
      const result = generatedNotesSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects non-string array items in keyConcepts', () => {
      const data = { ...sampleValidResponse, keyConcepts: [1, 2, 3] };
      const result = generatedNotesSchema.safeParse(data);
      expect(result.success).toBe(false);
    });
  });

  describe('Input Parameter Validation', () => {
    it('rejects empty or whitespace transcript with INVALID_REQUEST', async () => {
      await expect(generateAiNotes('', mockTitle)).rejects.toThrowError(AiClientError);
      try {
        await generateAiNotes('   ', mockTitle);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_REQUEST');
        expect(err.isRetryable).toBe(false);
      }
    });

    it('rejects empty or whitespace videoTitle with INVALID_REQUEST', async () => {
      await expect(generateAiNotes(mockTranscript, '')).rejects.toThrowError(AiClientError);
      try {
        await generateAiNotes(mockTranscript, '   ');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_REQUEST');
        expect(err.isRetryable).toBe(false);
      }
    });
  });

  describe('Successful Invocation & HTTP Contracts', () => {
    it('sends POST to /api/v1/generate with exact headers and JSON payload', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = vi.fn(async (url: any, init: any) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(JSON.stringify(sampleValidResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-123' },
        });
      });

      const result = await generateAiNotes(mockTranscript, mockTitle, {
        requestId: 'custom-req-trace-456',
      });

      expect(result).toEqual(sampleValidResponse);
      expect(capturedUrl).toBe('http://127.0.0.1:8000/api/v1/generate');
      expect(capturedInit?.method).toBe('POST');

      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe(`Bearer ${validSecret}`);
      expect(headers['X-Request-ID']).toBe('custom-req-trace-456');

      const body = JSON.parse(capturedInit?.body as string);
      expect(body.transcript).toBe(mockTranscript);
      expect(body.videoTitle).toBe(mockTitle);
    });

    it('records success metrics and duration on valid 200 OK response', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(JSON.stringify(sampleValidResponse), { status: 200 });
      });

      await generateAiNotes(mockTranscript, mockTitle);

      const metricsText = await registry.metrics();
      expect(metricsText).toContain(`codenotes_ai_requests_total{model="${DEFAULT_AI_MODEL}",status="success"} 1`);
      expect(metricsText).toContain(`codenotes_ai_duration_seconds_count{model="${DEFAULT_AI_MODEL}"} 1`);
    });
  });

  describe('Error Classification & Status Code Mapping', () => {
    it('maps HTTP 401 Unauthorized to non-retryable CONFIG_ERROR', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }),
          { status: 401 }
        );
      });

      await expect(generateAiNotes(mockTranscript, mockTitle)).rejects.toThrowError(AiClientError);
      try {
        await generateAiNotes(mockTranscript, mockTitle);
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.statusCode).toBe(401);
      }

      const metricsText = await registry.metrics();
      expect(metricsText).toContain(`codenotes_ai_requests_total{model="${DEFAULT_AI_MODEL}",status="error"} 2`);
    });

    it('maps HTTP 422 Invalid Request to non-retryable INVALID_REQUEST', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Transcript too long' } }),
          { status: 422 }
        );
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_REQUEST');
        expect(err.isRetryable).toBe(false);
        expect(err.statusCode).toBe(422);
        expect(err.message).toBe('Transcript too long');
      }
    });

    it('maps HTTP 429 Rate Limited to retryable RATE_LIMITED', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Upstream quota exhausted' } }),
          { status: 429 }
        );
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('RATE_LIMITED');
        expect(err.isRetryable).toBe(true);
        expect(err.statusCode).toBe(429);
      }
    });

    it('maps HTTP 502 with MALFORMED_OUTPUT to non-retryable MALFORMED_AI_OUTPUT', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: { code: 'MALFORMED_OUTPUT', message: 'AI returned unparseable text' },
          }),
          { status: 502 }
        );
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('MALFORMED_AI_OUTPUT');
        expect(err.isRetryable).toBe(false);
        expect(err.statusCode).toBe(502);
      }

      const metricsText = await registry.metrics();
      expect(metricsText).toContain(
        `codenotes_ai_requests_total{model="${DEFAULT_AI_MODEL}",status="malformed_output"} 1`
      );
    });

    it('maps HTTP 502 with UPSTREAM_ERROR to retryable UPSTREAM_ERROR', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: { code: 'UPSTREAM_ERROR', message: 'Upstream provider overloaded' },
          }),
          { status: 502 }
        );
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('UPSTREAM_ERROR');
        expect(err.isRetryable).toBe(true);
        expect(err.statusCode).toBe(502);
      }

      const metricsText = await registry.metrics();
      expect(metricsText).toContain(`codenotes_ai_requests_total{model="${DEFAULT_AI_MODEL}",status="error"} 1`);
    });

    it('maps HTTP 503 with CONFIG_ERROR to non-retryable CONFIG_ERROR', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: { code: 'CONFIG_ERROR', message: 'Gemini API key missing on server' },
          }),
          { status: 503 }
        );
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.statusCode).toBe(503);
      }
    });

    it('maps HTTP 503 without CONFIG_ERROR to retryable UPSTREAM_ERROR', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: { code: 'SERVICE_UNAVAILABLE', message: 'Server warming up' },
          }),
          { status: 503 }
        );
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('UPSTREAM_ERROR');
        expect(err.isRetryable).toBe(true);
        expect(err.statusCode).toBe(503);
      }
    });

    it('maps HTTP 504 Gateway Timeout to retryable TIMEOUT', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: { code: 'TIMEOUT', message: 'AI generation timed out after 75 seconds.' },
          }),
          { status: 504 }
        );
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('TIMEOUT');
        expect(err.isRetryable).toBe(true);
        expect(err.statusCode).toBe(504);
      }
    });

    it('handles HTML 502 from reverse proxy (non-JSON body) safely', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('UPSTREAM_ERROR');
        expect(err.isRetryable).toBe(true);
        expect(err.statusCode).toBe(502);
      }
    });

    it('rejects HTTP 200 with invalid schema as non-retryable MALFORMED_AI_OUTPUT', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            overview: 'Valid overview',
            // Missing keyConcepts, detailedNotes, shorthands
          }),
          { status: 200 }
        );
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('MALFORMED_AI_OUTPUT');
        expect(err.isRetryable).toBe(false);
      }

      const metricsText = await registry.metrics();
      expect(metricsText).toContain(
        `codenotes_ai_requests_total{model="${DEFAULT_AI_MODEL}",status="malformed_output"} 1`
      );
    });

    it('rejects HTTP 200 with unparseable text as non-retryable MALFORMED_AI_OUTPUT', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response('NOT_A_VALID_JSON_STRING', { status: 200 });
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('MALFORMED_AI_OUTPUT');
        expect(err.isRetryable).toBe(false);
      }
    });
  });

  describe('Timeout and Network Resiliency', () => {
    it('classifies AbortError/TimeoutError as retryable TIMEOUT', async () => {
      globalThis.fetch = vi.fn(async () => {
        const timeoutError = new Error('The operation was aborted due to timeout');
        timeoutError.name = 'AbortError';
        throw timeoutError;
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle, { timeoutMs: 500 });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('TIMEOUT');
        expect(err.isRetryable).toBe(true);
        expect(err.message).toContain('timed out');
      }

      const metricsText = await registry.metrics();
      expect(metricsText).toContain(`codenotes_ai_requests_total{model="${DEFAULT_AI_MODEL}",status="error"} 1`);
    });

    it('classifies ECONNREFUSED as retryable NETWORK_ERROR', async () => {
      globalThis.fetch = vi.fn(async () => {
        const netErr: any = new TypeError('fetch failed');
        netErr.cause = { code: 'ECONNREFUSED' };
        throw netErr;
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('NETWORK_ERROR');
        expect(err.isRetryable).toBe(true);
        expect(err.message).toContain('refused');
      }
    });

    it('classifies ENOTFOUND DNS failure as non-retryable CONFIG_ERROR', async () => {
      globalThis.fetch = vi.fn(async () => {
        const netErr: any = new TypeError('fetch failed');
        netErr.cause = { code: 'ENOTFOUND' };
        throw netErr;
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain('Failed to resolve');
      }
    });

    it('classifies ECONNRESET as retryable TIMEOUT', async () => {
      globalThis.fetch = vi.fn(async () => {
        const netErr: any = new TypeError('fetch failed');
        netErr.cause = { code: 'ECONNRESET' };
        throw netErr;
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('TIMEOUT');
        expect(err.isRetryable).toBe(true);
        expect(err.message).toContain('reset');
      }
    });
  });

  describe('Privacy & Observability Integrity', () => {
    it('never leaks secret token or raw transcript in error messages or logs', async () => {
      const sensitiveSecret = 'SUPER_SECRET_BEARER_TOKEN_99999';
      process.env.FASTAPI_SERVICE_SECRET = sensitiveSecret;

      globalThis.fetch = vi.fn(async () => {
        throw new Error('Connection failed completely');
      });

      try {
        await generateAiNotes('Super secret transcript content', mockTitle);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).not.toContain(sensitiveSecret);
        expect(err.message).not.toContain('Super secret transcript content');
      }
    });
  });

  describe('Request ID Sanitization & Tracing Correlation', () => {
    it('preserves valid alphanumeric request IDs', () => {
      const validId = 'idem-req-abc_123.test';
      expect(normalizeRequestId(validId)).toBe(validId);
    });

    it('generates a valid UUID when request ID is omitted or blank', () => {
      const id1 = normalizeRequestId();
      const id2 = normalizeRequestId('   ');
      expect(SAFE_REQUEST_ID_REGEX.test(id1)).toBe(true);
      expect(SAFE_REQUEST_ID_REGEX.test(id2)).toBe(true);
      expect(id1).not.toBe(id2);
    });

    it('sanitizes special characters and whitespace into underscores', () => {
      const dirty = 'req:user 123/notes#456@v1!';
      const sanitized = normalizeRequestId(dirty);
      expect(SAFE_REQUEST_ID_REGEX.test(sanitized)).toBe(true);
      expect(sanitized).toBe('req_user_123_notes_456_v1_');
    });

    it('truncates excessively long request IDs to 64 characters', () => {
      const longId = 'a'.repeat(100);
      const sanitized = normalizeRequestId(longId);
      expect(sanitized.length).toBe(64);
      expect(SAFE_REQUEST_ID_REGEX.test(sanitized)).toBe(true);
    });

    it('sends sanitized X-Request-ID to FastAPI and adopts server-returned ID if divergent', async () => {
      let capturedInit: RequestInit | undefined;
      const serverId = 'server-generated-trace-id-999';

      globalThis.fetch = vi.fn(async (url: any, init: any) => {
        capturedInit = init;
        return new Response(
          JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Busy' } }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'x-request-id': serverId },
          }
        );
      });

      try {
        await generateAiNotes(mockTranscript, mockTitle, {
          requestId: 'dirty:custom trace',
        });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('RATE_LIMITED');
        // Outbound header was sanitized
        const headers = capturedInit?.headers as Record<string, string>;
        expect(headers['X-Request-ID']).toBe('dirty_custom_trace');
        // Client error adopted the server-returned trace ID
        expect(err.requestId).toBe(serverId);
      }
    });
  });
});
