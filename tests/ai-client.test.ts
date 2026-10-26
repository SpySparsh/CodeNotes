import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
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
import { logger } from '@/lib/logger';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { initTracing, TRACER_NAME } from '@/lib/tracing';

describe('AI Client Adapter (src/lib/ai-client.ts)', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
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
    process.env = { ...originalEnv };
    process.env.FASTAPI_SERVICE_URL = validServiceUrl;
    process.env.FASTAPI_SERVICE_SECRET = validSecret;
    delete process.env.FASTAPI_VERCEL_PROTECTION_BYPASS;
    delete process.env.FASTAPI_REQUIRE_VERCEL_PROTECTION_BYPASS;
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
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

  describe('Vercel Deployment Protection Bypass Header & Security', () => {
    const validBypassSecret = 'mock-vercel-bypass-token-777';

    it('sends both Authorization: Bearer and x-vercel-protection-bypass headers when bypass is configured', async () => {
      process.env.FASTAPI_VERCEL_PROTECTION_BYPASS = validBypassSecret;
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = vi.fn(async (_url: any, init: any) => {
        capturedInit = init;
        return new Response(JSON.stringify(sampleValidResponse), { status: 200 });
      });

      await generateAiNotes(mockTranscript, mockTitle, {
        requestId: 'trace-both-headers-123',
      });

      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${validSecret}`);
      expect(headers['x-vercel-protection-bypass']).toBe(validBypassSecret);
      expect(headers['X-Request-ID']).toBe('trace-both-headers-123');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('does not send x-vercel-protection-bypass header when bypass is unset in standard environment', async () => {
      delete process.env.FASTAPI_VERCEL_PROTECTION_BYPASS;
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = vi.fn(async (_url: any, init: any) => {
        capturedInit = init;
        return new Response(JSON.stringify(sampleValidResponse), { status: 200 });
      });

      await generateAiNotes(mockTranscript, mockTitle);

      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${validSecret}`);
      expect(headers['x-vercel-protection-bypass']).toBeUndefined();
    });

    it('allows passing vercelProtectionBypass explicitly in options', async () => {
      delete process.env.FASTAPI_VERCEL_PROTECTION_BYPASS;
      let capturedInit: RequestInit | undefined;

      globalThis.fetch = vi.fn(async (_url: any, init: any) => {
        capturedInit = init;
        return new Response(JSON.stringify(sampleValidResponse), { status: 200 });
      });

      await generateAiNotes(mockTranscript, mockTitle, {
        vercelProtectionBypass: 'explicit-option-bypass-secret',
      });

      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${validSecret}`);
      expect(headers['x-vercel-protection-bypass']).toBe('explicit-option-bypass-secret');
    });

    it('throws CONFIG_ERROR when FASTAPI_VERCEL_PROTECTION_BYPASS is a placeholder string', () => {
      process.env.FASTAPI_VERCEL_PROTECTION_BYPASS = 'your_vercel_protection_bypass_secret_here';
      expect(() => getAiClientConfig()).toThrowError(AiClientError);
      try {
        getAiClientConfig();
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain('placeholder');
      }

      process.env.FASTAPI_VERCEL_PROTECTION_BYPASS = 'change_me_to_a_secure_random_string';
      expect(() => getAiClientConfig()).toThrowError(AiClientError);
    });

    it('throws CONFIG_ERROR in Vercel preview environment when bypass secret is missing for remote target', () => {
      process.env.VERCEL_ENV = 'preview';
      process.env.FASTAPI_SERVICE_URL = 'https://codenotes-ai-generator.vercel.app';
      delete process.env.FASTAPI_VERCEL_PROTECTION_BYPASS;

      expect(() => getAiClientConfig()).toThrowError(AiClientError);
      try {
        getAiClientConfig();
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain('FASTAPI_VERCEL_PROTECTION_BYPASS is required');
      }
    });

    it('throws CONFIG_ERROR when FASTAPI_REQUIRE_VERCEL_PROTECTION_BYPASS is true and bypass is missing', () => {
      process.env.FASTAPI_REQUIRE_VERCEL_PROTECTION_BYPASS = 'true';
      delete process.env.FASTAPI_VERCEL_PROTECTION_BYPASS;

      expect(() => getAiClientConfig()).toThrowError(AiClientError);
      try {
        getAiClientConfig();
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain('FASTAPI_VERCEL_PROTECTION_BYPASS is required');
      }
    });

    it('throws CONFIG_ERROR when options.requireVercelProtectionBypass is true and bypass is missing', () => {
      delete process.env.FASTAPI_VERCEL_PROTECTION_BYPASS;

      expect(() => getAiClientConfig({ requireVercelProtectionBypass: true })).toThrowError(AiClientError);
      try {
        getAiClientConfig({ requireVercelProtectionBypass: true });
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain('FASTAPI_VERCEL_PROTECTION_BYPASS is required');
      }
    });

    it('throws CONFIG_ERROR when target URL matches Vercel preview branch pattern and bypass is missing', () => {
      process.env.FASTAPI_SERVICE_URL = 'https://codenotes-ai-generator-git-feat-preview.vercel.app';
      delete process.env.FASTAPI_VERCEL_PROTECTION_BYPASS;

      expect(() => getAiClientConfig()).toThrowError(AiClientError);
      try {
        getAiClientConfig();
      } catch (err: any) {
        expect(err.code).toBe('CONFIG_ERROR');
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain('FASTAPI_VERCEL_PROTECTION_BYPASS is required');
      }
    });

    it('does not require bypass secret for local development targets even if VERCEL_ENV is set', () => {
      process.env.VERCEL_ENV = 'preview';
      process.env.FASTAPI_SERVICE_URL = 'http://127.0.0.1:8000';
      delete process.env.FASTAPI_VERCEL_PROTECTION_BYPASS;

      expect(() => getAiClientConfig()).not.toThrow();
    });

    it('strictly protects secrets: never emits FASTAPI_SERVICE_SECRET or FASTAPI_VERCEL_PROTECTION_BYPASS to logs', async () => {
      const sensitiveServiceSecret = 'super-secret-service-token-999-xyz';
      const sensitiveBypassSecret = 'super-secret-bypass-token-888-abc';

      process.env.FASTAPI_SERVICE_SECRET = sensitiveServiceSecret;
      process.env.FASTAPI_VERCEL_PROTECTION_BYPASS = sensitiveBypassSecret;

      const loggedCalls: string[] = [];
      const captureLog = (...args: any[]) => {
        loggedCalls.push(JSON.stringify(args));
      };

      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(captureLog as any);
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(captureLog as any);
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(captureLog as any);

      // 1. Success case
      globalThis.fetch = vi.fn(async () => {
        return new Response(JSON.stringify(sampleValidResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-ok' },
        });
      });
      await generateAiNotes(mockTranscript, mockTitle);

      // 2. HTTP 401 error case
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Auth failed' } }),
          { status: 401 }
        );
      });
      await expect(generateAiNotes(mockTranscript, mockTitle)).rejects.toThrow();

      // 3. Network error case
      globalThis.fetch = vi.fn(async () => {
        throw new Error('Connection reset by peer');
      });
      await expect(generateAiNotes(mockTranscript, mockTitle)).rejects.toThrow();

      // 4. Schema validation failure case
      globalThis.fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ malformed: true }), { status: 200 });
      });
      await expect(generateAiNotes(mockTranscript, mockTitle)).rejects.toThrow();

      // Verify neither secret is in any logged payload
      const allLogs = loggedCalls.join('\n');
      expect(allLogs).not.toContain(sensitiveServiceSecret);
      expect(allLogs).not.toContain(sensitiveBypassSecret);

      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('Nested OpenTelemetry Tracing Integration', () => {
    beforeAll(() => {
      initTracing();
    });

    it('creates child span fastapi.http_request nested under ai.generate_notes on successful request', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      globalThis.fetch = vi.fn(async () => {
        return new Response(JSON.stringify(sampleValidResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'x-request-id': 'trace-req-001' },
        });
      });

      const result = await generateAiNotes(mockTranscript, mockTitle, { requestId: 'trace-req-001' });
      expect(result).toBeDefined();

      tracerSpy.mockRestore();

      const spans = exporter.getFinishedSpans();
      const aiSpan = spans.find((s) => s.name === 'ai.generate_notes');
      const httpSpan = spans.find((s) => s.name === 'fastapi.http_request');

      expect(aiSpan).toBeDefined();
      expect(httpSpan).toBeDefined();

      // Parent-child relationship
      const getParentId = (s: any) => s?.parentSpanContext?.spanId ?? s?.parentSpanId;
      expect(getParentId(httpSpan)).toBe(aiSpan?.spanContext().spanId);
      expect(httpSpan?.spanContext().traceId).toBe(aiSpan?.spanContext().traceId);

      // Low-risk HTTP attributes
      expect(httpSpan?.attributes['http.request.method']).toBe('POST');
      expect(httpSpan?.attributes['http.route']).toBe('/api/v1/generate');
      expect(httpSpan?.attributes['http.response.status_code']).toBe(200);
      expect(httpSpan?.status.code).toBe(SpanStatusCode.OK);

      // Privacy: no secrets or transcripts in attributes
      expect(httpSpan?.attributes['token']).toBeUndefined();
      expect(httpSpan?.attributes['secret']).toBeUndefined();
      expect(httpSpan?.attributes['authorization']).toBeUndefined();
      expect(httpSpan?.attributes['transcript']).toBeUndefined();
    });

    it('records http.response.status_code on non-200 responses and propagates error mapping', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Rate limited' } }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      });

      await expect(generateAiNotes(mockTranscript, mockTitle)).rejects.toThrowError(AiClientError);

      tracerSpy.mockRestore();

      const spans = exporter.getFinishedSpans();
      const aiSpan = spans.find((s) => s.name === 'ai.generate_notes');
      const httpSpan = spans.find((s) => s.name === 'fastapi.http_request');

      expect(aiSpan).toBeDefined();
      expect(httpSpan).toBeDefined();

      const getParentId = (s: any) => s?.parentSpanContext?.spanId ?? s?.parentSpanId;
      expect(getParentId(httpSpan)).toBe(aiSpan?.spanContext().spanId);
      expect(httpSpan?.attributes['http.response.status_code']).toBe(429);
      expect(httpSpan?.status.code).toBe(SpanStatusCode.ERROR);
      expect(httpSpan?.status.message).toBe('HTTP 429');
      expect(aiSpan?.status.code).toBe(SpanStatusCode.ERROR);
    });

    it('records error status on child span when network throws before HTTP response is received', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      const connError = new Error('ECONNREFUSED');
      (connError as any).code = 'ECONNREFUSED';
      globalThis.fetch = vi.fn(async () => {
        throw connError;
      });

      await expect(generateAiNotes(mockTranscript, mockTitle)).rejects.toThrowError(AiClientError);

      tracerSpy.mockRestore();

      const spans = exporter.getFinishedSpans();
      const aiSpan = spans.find((s) => s.name === 'ai.generate_notes');
      const httpSpan = spans.find((s) => s.name === 'fastapi.http_request');

      expect(aiSpan).toBeDefined();
      expect(httpSpan).toBeDefined();

      const getParentId = (s: any) => s?.parentSpanContext?.spanId ?? s?.parentSpanId;
      expect(getParentId(httpSpan)).toBe(aiSpan?.spanContext().spanId);
      expect(httpSpan?.status.code).toBe(SpanStatusCode.ERROR);
      expect(httpSpan?.events.some((e) => e.name === 'exception')).toBe(true);
      expect(httpSpan?.ended).toBe(true);
      expect(aiSpan?.ended).toBe(true);
    });
  });
});
