import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { InngestSpanProcessor } from 'inngest/experimental';
import { inngest } from '@/inngest/client';
import { initTracing, withSpan, getTracer, TRACER_NAME } from '@/lib/tracing';
import * as Sentry from '@sentry/nextjs';

describe('OpenTelemetry Tracing & Inngest Span Integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Provider Initialization & Registration', () => {
    it('initializes BasicTracerProvider with InngestSpanProcessor and AsyncHooksContextManager', () => {
      const result = initTracing();

      expect(result.provider).toBeDefined();
      expect(result.provider?.constructor.name).toBe('BasicTracerProvider');
      expect(result.processor).toBeDefined();
      expect(result.processor?.constructor.name).toBe('PublicInngestSpanProcessor');

      const globalProvider = trace.getTracerProvider();
      expect(globalProvider).toBeDefined();

      const tracer = getTracer();
      expect(tracer).toBeDefined();
    });

    it('is idempotent on repeated initialization calls', () => {
      const first = initTracing();
      const second = initTracing();
      expect(first.provider).toBe(second.provider);
      expect(first.processor).toBe(second.processor);
    });
  });

  describe('Span Hierarchy & Asynchronous Context Propagation', () => {
    it('preserves parent-child relationships across nested asynchronous operations', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      await testTracer.startActiveSpan('parent.step', async (parentSpan) => {
        // Async child operation 1
        await new Promise((resolve) => setTimeout(resolve, 20));
        await withSpan('child.op1', async (child1) => {
          child1.setAttribute('provider', 'supadata');
          await new Promise((resolve) => setTimeout(resolve, 10));
        });

        // Async child operation 2
        await withSpan('child.op2', async (child2) => {
          child2.setAttribute('model', 'gemini-2.5-flash');
          await new Promise((resolve) => setTimeout(resolve, 10));
        });

        parentSpan.end();
      });

      tracerSpy.mockRestore();

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(3);

      const parentSpan = spans.find((s) => s.name === 'parent.step');
      const child1 = spans.find((s) => s.name === 'child.op1');
      const child2 = spans.find((s) => s.name === 'child.op2');

      expect(parentSpan).toBeDefined();
      expect(child1).toBeDefined();
      expect(child2).toBeDefined();

      // Verify strict parent-child nesting
      const child1ParentId = child1?.parentSpanContext?.spanId ?? (child1 as any)?.parentSpanId;
      const child2ParentId = child2?.parentSpanContext?.spanId ?? (child2 as any)?.parentSpanId;
      expect(child1ParentId).toBe(parentSpan?.spanContext().spanId);
      expect(child2ParentId).toBe(parentSpan?.spanContext().spanId);
      expect(child1?.spanContext().traceId).toBe(parentSpan?.spanContext().traceId);
      expect(child2?.spanContext().traceId).toBe(parentSpan?.spanContext().traceId);
    });

    it('records success status and ends spans on resolved operations', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      const result = await withSpan('test.success_op', async (span) => {
        span.setAttribute('output_length', 120);
        return 'success_result';
      });

      tracerSpy.mockRestore();

      expect(result).toBe('success_result');
      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('test.success_op');
      expect(spans[0].status.code).toBe(SpanStatusCode.OK);
      expect(spans[0].attributes['output_length']).toBe(120);
      expect(spans[0].ended).toBe(true);
    });

    it('records error status and exception, always ends span in finally, and rethrows original error', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      const sampleError = new Error('Database connection reset');

      await expect(
        withSpan('test.failing_op', async () => {
          throw sampleError;
        })
      ).rejects.toThrow('Database connection reset');

      tracerSpy.mockRestore();

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('test.failing_op');
      expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0].status.message).toBe('Database connection reset');
      expect(spans[0].events.some((e) => e.name === 'exception')).toBe(true);
      expect(spans[0].ended).toBe(true);
    });
  });

  describe('Privacy Protections & Denylist Enforcement', () => {
    it('drops prohibited sensitive attributes and retains only safe operational metadata', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      await withSpan(
        'test.privacy_scrubbed',
        async (span) => {
          span.setAttribute('status', 'success');
        },
        {
          // Permitted attributes
          provider: 'supadata',
          model: 'gemini-2.5-flash',
          cache_hit: false,
          output_length: 500,
          // Prohibited attributes (must be dropped)
          user_id: 'usr-12345',
          email: 'student@example.com',
          videoId: 'dQw4w9WgXcQ',
          videoUrl: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
          transcript: 'Confidential transcript lines',
          prompt: 'You are a senior full-stack engineer...',
          token: 'secret_token_123',
          apiKey: 'AIzaSyKey',
        }
      );

      tracerSpy.mockRestore();

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      const attrs = spans[0].attributes;

      // Permitted attributes exist
      expect(attrs['provider']).toBe('supadata');
      expect(attrs['model']).toBe('gemini-2.5-flash');
      expect(attrs['cache_hit']).toBe(false);
      expect(attrs['output_length']).toBe(500);
      expect(attrs['status']).toBe('success');

      // Prohibited attributes must NOT exist
      expect(attrs['user_id']).toBeUndefined();
      expect(attrs['email']).toBeUndefined();
      expect(attrs['videoId']).toBeUndefined();
      expect(attrs['videoUrl']).toBeUndefined();
      expect(attrs['transcript']).toBeUndefined();
      expect(attrs['prompt']).toBeUndefined();
      expect(attrs['token']).toBeUndefined();
      expect(attrs['apiKey']).toBeUndefined();
    });

    it('blocks prohibited identifiers (user_id, video_id, note_id, etc.) set dynamically via span.setAttribute and span.setAttributes', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      await withSpan('test.dynamic_attributes_scrubbed', async (span) => {
        // Safe operational attributes
        span.setAttribute('operation', 'persist_notes');
        span.setAttribute('status', 'success');
        span.setAttribute('output_length', 1024);

        // Prohibited identifiers attempted dynamically via span.setAttribute
        span.setAttribute('user_id', 'usr-999-forbidden');
        span.setAttribute('userId', 'usr-999-forbidden');
        span.setAttribute('video_id', 'dQw4w9WgXcQ');
        span.setAttribute('videoId', 'dQw4w9WgXcQ');
        span.setAttribute('note_id', 'note-secret-uuid');
        span.setAttribute('noteId', 'note-secret-uuid');
        span.setAttribute('notes_id', 'note-secret-uuid');
        span.setAttribute('idempotency_key', 'idem-secret-key');
        span.setAttribute('job_id', 'job-secret-id');
        span.setAttribute('prompt', 'System prompt contents');
        span.setAttribute('transcript', 'Full transcript body');

        // Prohibited identifiers attempted dynamically via span.setAttributes
        span.setAttributes({
          token: 'jwt-or-bearer-token',
          secret: 'top-secret',
          url: 'https://youtube.com/watch?v=secret',
        });
      });

      tracerSpy.mockRestore();

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      const attrs = spans[0].attributes;

      // Safe operational attributes are preserved
      expect(attrs['operation']).toBe('persist_notes');
      expect(attrs['status']).toBe('success');
      expect(attrs['output_length']).toBe(1024);

      // Prohibited identifiers are strictly absent
      expect(attrs['user_id']).toBeUndefined();
      expect(attrs['userId']).toBeUndefined();
      expect(attrs['video_id']).toBeUndefined();
      expect(attrs['videoId']).toBeUndefined();
      expect(attrs['note_id']).toBeUndefined();
      expect(attrs['noteId']).toBeUndefined();
      expect(attrs['notes_id']).toBeUndefined();
      expect(attrs['idempotency_key']).toBeUndefined();
      expect(attrs['job_id']).toBeUndefined();
      expect(attrs['prompt']).toBeUndefined();
      expect(attrs['transcript']).toBeUndefined();
      expect(attrs['token']).toBeUndefined();
      expect(attrs['secret']).toBeUndefined();
      expect(attrs['url']).toBeUndefined();
    });

    it('verifies fallback spans and database persistence/claim spans strictly omit prohibited identifiers', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      // 1. Fallback span simulation (as in transcript.fetch_fallback)
      await withSpan('transcript.fetch_fallback', async (span) => {
        span.setAttribute('provider', 'youtube-transcript');
        span.setAttribute('status', 'success');
        span.setAttribute('output_length', 3200);
      });

      // 2. Database claim span simulation (as in db.claim_generation_processing)
      await withSpan('db.claim_generation_processing', async (span) => {
        span.setAttribute('operation', 'claim_generation_processing');
        span.setAttribute('status', 'success');
      });

      // 3. Database persistence span simulation (as in db.persist_notes_transaction)
      await withSpan('db.persist_notes_transaction', async (span) => {
        span.setAttribute('operation', 'persist_notes');
        span.setAttribute('status', 'success');
      });

      tracerSpy.mockRestore();

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(3);

      const fallbackSpan = spans.find((s) => s.name === 'transcript.fetch_fallback');
      const claimSpan = spans.find((s) => s.name === 'db.claim_generation_processing');
      const dbSpan = spans.find((s) => s.name === 'db.persist_notes_transaction');

      expect(fallbackSpan).toBeDefined();
      expect(claimSpan).toBeDefined();
      expect(dbSpan).toBeDefined();

      // Assert operational attributes
      expect(fallbackSpan?.attributes['provider']).toBe('youtube-transcript');
      expect(fallbackSpan?.attributes['status']).toBe('success');
      expect(fallbackSpan?.attributes['output_length']).toBe(3200);

      expect(claimSpan?.attributes['operation']).toBe('claim_generation_processing');
      expect(claimSpan?.attributes['status']).toBe('success');

      expect(dbSpan?.attributes['operation']).toBe('persist_notes');
      expect(dbSpan?.attributes['status']).toBe('success');

      // Assert prohibited identifiers are strictly absent in all spans
      for (const span of [fallbackSpan, claimSpan, dbSpan]) {
        const attrs = span!.attributes;
        expect(attrs['user_id']).toBeUndefined();
        expect(attrs['userId']).toBeUndefined();
        expect(attrs['video_id']).toBeUndefined();
        expect(attrs['videoId']).toBeUndefined();
        expect(attrs['note_id']).toBeUndefined();
        expect(attrs['noteId']).toBeUndefined();
        expect(attrs['notes_id']).toBeUndefined();
        expect(attrs['idempotency_key']).toBeUndefined();
        expect(attrs['url']).toBeUndefined();
        expect(attrs['transcript']).toBeUndefined();
        expect(attrs['prompt']).toBeUndefined();
      }
    });

    it('sanitizes exception status messages and exception events to prevent leakage of credentials, URLs, emails, and identifiers', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      const distinctiveSecret = 'my_super_secret_db_pass_99';
      const distinctiveToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive_payload_bytes';
      const distinctiveApiKey = 'AIzaSyA9876543210987654321098765432109';
      const distinctiveEmail = 'private_student_123@example.com';
      const distinctiveUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const distinctiveUserId = 'usr-distinctive-12345';
      const distinctiveVideoId = 'vid-distinctive-67890';
      const distinctiveNoteId = 'note-distinctive-abcde';

      const sensitiveError = new Error(
        `Failed connecting to postgresql://admin:${distinctiveSecret}@db.internal:5432/notes ` +
        `with API key ${distinctiveApiKey} and token ${distinctiveToken} for user ${distinctiveEmail} at ${distinctiveUrl} ` +
        `details: user_id=${distinctiveUserId} video_id=${distinctiveVideoId} note_id=${distinctiveNoteId}`
      );

      // Verify that withSpan rejects with the original error object (unmutated for app & Sentry error handling)
      let caughtError: any;
      try {
        await withSpan('test.failing_with_secrets', async () => {
          throw sensitiveError;
        });
      } catch (err) {
        caughtError = err;
      }

      tracerSpy.mockRestore();

      // Original error is unchanged for application/Sentry handlers
      expect(caughtError).toBe(sensitiveError);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      const span = spans[0];

      // Span status code is ERROR
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      const statusMsg = span.status.message || '';

      // Verify NO sensitive strings or identifiers exist in span status message
      expect(statusMsg).not.toContain(distinctiveSecret);
      expect(statusMsg).not.toContain(distinctiveToken);
      expect(statusMsg).not.toContain(distinctiveApiKey);
      expect(statusMsg).not.toContain(distinctiveEmail);
      expect(statusMsg).not.toContain(distinctiveUrl);
      expect(statusMsg).not.toContain(distinctiveUserId);
      expect(statusMsg).not.toContain(distinctiveVideoId);
      expect(statusMsg).not.toContain(distinctiveNoteId);
      expect(statusMsg).toContain('[REDACTED_SECRET]');
      expect(statusMsg).toContain('[REDACTED_EMAIL]');
      expect(statusMsg).toContain('[REDACTED_URL]');
      expect(statusMsg).toContain('user_id=[REDACTED]');
      expect(statusMsg).toContain('video_id=[REDACTED]');
      expect(statusMsg).toContain('note_id=[REDACTED]');

      // Verify exception events
      const exceptionEvent = span.events.find((e) => e.name === 'exception');
      expect(exceptionEvent).toBeDefined();
      const eventAttrs = exceptionEvent?.attributes || {};

      const eventMsg = String(eventAttrs['exception.message'] || '');
      expect(eventMsg).not.toContain(distinctiveSecret);
      expect(eventMsg).not.toContain(distinctiveToken);
      expect(eventMsg).not.toContain(distinctiveApiKey);
      expect(eventMsg).not.toContain(distinctiveEmail);
      expect(eventMsg).not.toContain(distinctiveUrl);
      expect(eventMsg).not.toContain(distinctiveUserId);
      expect(eventMsg).not.toContain(distinctiveVideoId);
      expect(eventMsg).not.toContain(distinctiveNoteId);

      // Verify raw stack trace is omitted to prevent stack-based leakage
      expect(eventAttrs['exception.stacktrace']).toBeUndefined();
    });
  });

  describe('Sentry Compatibility & Coexistence', () => {
    it(
      'allows Sentry to capture exceptions and scope tags with BasicTracerProvider active',
      async () => {
        let capturedEvent: any = null;

        Sentry.init({
          dsn: 'https://examplePublicKey@o0.ingest.sentry.io/0',
          tracesSampleRate: 0,
          beforeSend: (event) => {
            capturedEvent = event;
            return event;
          },
        });

        Sentry.withScope((scope) => {
          scope.setTag('inngest.function', 'generate-notes');
          scope.setTag('error.code', 'TRACING_TEST_ERROR');
          Sentry.captureException(new Error('Verified Sentry Exception'));
        });

        await Sentry.flush(1000);

        expect(capturedEvent).toBeDefined();
        expect(capturedEvent?.exception?.values?.[0]?.value).toBe('Verified Sentry Exception');
        expect(capturedEvent?.tags?.['inngest.function']).toBe('generate-notes');
        expect(capturedEvent?.tags?.['error.code']).toBe('TRACING_TEST_ERROR');
      },
      20000
    );
  });

  describe('Inngest Client & Flush Failure Resilience', () => {
    it('Inngest client is configured with extendedTracesMiddleware and does not crash on flush errors', async () => {
      expect(inngest).toBeDefined();
      expect(inngest.id).toBe('codenotes');

      const processor = new InngestSpanProcessor(inngest);
      // forceFlush should resolve smoothly without throwing unhandled rejections
      await expect(processor.forceFlush()).resolves.toBeUndefined();
    });
  });

  describe('Generation Workflow Operations & Nested Span Execution', () => {
    it('generates nested child spans for all critical generation operations under step context', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      // Simulate Step 1: claim-generation-processing
      await testTracer.startActiveSpan('step.claim-generation-processing', async (stepSpan) => {
        await withSpan('db.claim_generation_processing', async (span) => {
          span.setAttribute('operation', 'claim_generation_processing');
          span.setAttribute('status', 'success');
        });
        stepSpan.end();
      });

      // Simulate Step 2: fetch-transcript-and-title
      await testTracer.startActiveSpan('step.fetch-transcript-and-title', async (stepSpan) => {
        // Cache lookup
        await withSpan('transcript.cache_lookup', async (span) => {
          span.setAttribute('cache_hit', false);
        });

        // Title fetch
        await withSpan('transcript.fetch_title', async (span) => {
          span.setAttribute('provider', 'noembed');
          span.setAttribute('output_length', 25);
          span.setAttribute('status', 'success');
        });

        // Primary provider fetch
        await withSpan('transcript.fetch_primary', async (span) => {
          span.setAttribute('provider', 'supadata');
          span.setAttribute('output_length', 1500);
          span.setAttribute('status', 'success');
        });

        stepSpan.end();
      });

      // Simulate Step 3: generate-ai-notes
      await testTracer.startActiveSpan('step.generate-ai-notes', async (stepSpan) => {
        // Gemini generation
        await withSpan('ai.gemini_generate', async (span) => {
          span.setAttribute('model', 'gemini-2.5-flash');
          span.setAttribute('output_length', 2500);
          span.setAttribute('status', 'success');
        });

        // JSON parsing
        await withSpan('ai.json_parse', async (span) => {
          span.setAttribute('model', 'gemini-2.5-flash');
          span.setAttribute('output_length', 2480);
          span.setAttribute('status', 'success');
        });

        stepSpan.end();
      });

      // Simulate Step 4: persist-notes
      await testTracer.startActiveSpan('step.persist-notes', async (stepSpan) => {
        await withSpan('db.persist_notes_transaction', async (span) => {
          span.setAttribute('operation', 'persist_notes');
          span.setAttribute('status', 'success');
        });

        stepSpan.end();
      });

      tracerSpy.mockRestore();

      const spans = exporter.getFinishedSpans();
      // Total: 4 steps + 7 nested operation spans = 11 spans
      expect(spans.length).toBe(11);

      const step1 = spans.find((s) => s.name === 'step.claim-generation-processing');
      const step2 = spans.find((s) => s.name === 'step.fetch-transcript-and-title');
      const step3 = spans.find((s) => s.name === 'step.generate-ai-notes');
      const step4 = spans.find((s) => s.name === 'step.persist-notes');

      expect(step1).toBeDefined();
      expect(step2).toBeDefined();
      expect(step3).toBeDefined();
      expect(step4).toBeDefined();

      const claimSpan = spans.find((s) => s.name === 'db.claim_generation_processing');
      const cacheLookup = spans.find((s) => s.name === 'transcript.cache_lookup');
      const fetchTitle = spans.find((s) => s.name === 'transcript.fetch_title');
      const fetchPrimary = spans.find((s) => s.name === 'transcript.fetch_primary');
      const geminiGenerate = spans.find((s) => s.name === 'ai.gemini_generate');
      const jsonParse = spans.find((s) => s.name === 'ai.json_parse');
      const persistTx = spans.find((s) => s.name === 'db.persist_notes_transaction');

      expect(claimSpan).toBeDefined();
      expect(cacheLookup).toBeDefined();
      expect(fetchTitle).toBeDefined();
      expect(fetchPrimary).toBeDefined();
      expect(geminiGenerate).toBeDefined();
      expect(jsonParse).toBeDefined();
      expect(persistTx).toBeDefined();

      // Verify Step 1 children
      const getParentId = (s: any) => s?.parentSpanContext?.spanId ?? s?.parentSpanId;
      expect(getParentId(claimSpan)).toBe(step1?.spanContext().spanId);

      // Verify Step 2 children
      expect(getParentId(cacheLookup)).toBe(step2?.spanContext().spanId);
      expect(getParentId(fetchTitle)).toBe(step2?.spanContext().spanId);
      expect(getParentId(fetchPrimary)).toBe(step2?.spanContext().spanId);

      // Verify Step 3 children
      expect(getParentId(geminiGenerate)).toBe(step3?.spanContext().spanId);
      expect(getParentId(jsonParse)).toBe(step3?.spanContext().spanId);

      // Verify Step 4 children
      expect(getParentId(persistTx)).toBe(step4?.spanContext().spanId);

      // Verify attributes
      expect(claimSpan?.attributes['operation']).toBe('claim_generation_processing');
      expect(claimSpan?.attributes['status']).toBe('success');
      expect(cacheLookup?.attributes['cache_hit']).toBe(false);
      expect(fetchTitle?.attributes['provider']).toBe('noembed');
      expect(fetchPrimary?.attributes['provider']).toBe('supadata');
      expect(geminiGenerate?.attributes['model']).toBe('gemini-2.5-flash');
      expect(jsonParse?.attributes['model']).toBe('gemini-2.5-flash');
      expect(persistTx?.attributes['operation']).toBe('persist_notes');

      // Verify that across all generated nested spans, prohibited identifiers are strictly absent
      const prohibitedKeys = [
        'user_id',
        'userId',
        'video_id',
        'videoId',
        'note_id',
        'noteId',
        'notes_id',
        'idempotency_key',
        'idempotencyKey',
        'job_id',
        'jobId',
        'token',
        'secret',
        'prompt',
        'transcript',
        'url',
      ];
      for (const span of [claimSpan, cacheLookup, fetchTitle, fetchPrimary, geminiGenerate, jsonParse, persistTx]) {
        for (const key of prohibitedKeys) {
          expect(span?.attributes[key]).toBeUndefined();
        }
      }
    });
  });

  describe('Claim Step Instrumentation (db.claim_generation_processing)', () => {
    it('creates db.claim_generation_processing on successful claim with safe attributes', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      const claimResult = await withSpan('db.claim_generation_processing', async (span) => {
        span.setAttribute('operation', 'claim_generation_processing');
        span.setAttribute('status', 'success');
        return { claimed: true, skipped: false, videoId: 'vid-123', videoUrl: 'https://youtube.com/watch?v=vid-123' };
      });

      tracerSpy.mockRestore();

      expect(claimResult).toEqual({
        claimed: true,
        skipped: false,
        videoId: 'vid-123',
        videoUrl: 'https://youtube.com/watch?v=vid-123',
      });

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('db.claim_generation_processing');
      expect(spans[0].status.code).toBe(SpanStatusCode.OK);
      expect(spans[0].attributes['operation']).toBe('claim_generation_processing');
      expect(spans[0].attributes['status']).toBe('success');
    });

    it('records skipped_already_completed and skipped_active_lease statuses without altering return values', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      // Case A: already completed
      const completedResult = await withSpan('db.claim_generation_processing', async (span) => {
        span.setAttribute('operation', 'claim_generation_processing');
        span.setAttribute('status', 'skipped_already_completed');
        return { claimed: false, skipped: true, noteId: 'note-cached-uuid' };
      });

      // Case B: active lease held
      const activeLeaseResult = await withSpan('db.claim_generation_processing', async (span) => {
        span.setAttribute('operation', 'claim_generation_processing');
        span.setAttribute('status', 'skipped_active_lease');
        return { claimed: false, skipped: true, reason: 'Active lease held by another execution' };
      });

      tracerSpy.mockRestore();

      expect(completedResult).toEqual({ claimed: false, skipped: true, noteId: 'note-cached-uuid' });
      expect(activeLeaseResult).toEqual({ claimed: false, skipped: true, reason: 'Active lease held by another execution' });

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(2);

      expect(spans[0].attributes['operation']).toBe('claim_generation_processing');
      expect(spans[0].attributes['status']).toBe('skipped_already_completed');
      expect(spans[0].status.code).toBe(SpanStatusCode.OK);

      expect(spans[1].attributes['operation']).toBe('claim_generation_processing');
      expect(spans[1].attributes['status']).toBe('skipped_active_lease');
      expect(spans[1].status.code).toBe(SpanStatusCode.OK);
    });

    it('records error status and exception event when claim encounters an exception', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      await expect(
        withSpan('db.claim_generation_processing', async (span) => {
          span.setAttribute('operation', 'claim_generation_processing');
          throw new Error('Idempotency record not found in database');
        })
      ).rejects.toThrow('Idempotency record not found in database');

      tracerSpy.mockRestore();

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].name).toBe('db.claim_generation_processing');
      expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0].status.message).toBe('Idempotency record not found in database');
      expect(spans[0].events.some((e) => e.name === 'exception')).toBe(true);
    });

    it('strictly drops prohibited identifiers attempted on claim span', async () => {
      const exporter = new InMemorySpanExporter();
      const testProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const testTracer = testProvider.getTracer(TRACER_NAME);
      const tracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue(testTracer);

      await withSpan('db.claim_generation_processing', async (span) => {
        span.setAttribute('operation', 'claim_generation_processing');
        span.setAttribute('status', 'success');
        // Prohibited keys attempted on claim span
        span.setAttribute('user_id', 'usr-test-1234');
        span.setAttribute('userId', 'usr-test-1234');
        span.setAttribute('video_id', 'dQw4w9WgXcQ');
        span.setAttribute('videoId', 'dQw4w9WgXcQ');
        span.setAttribute('idempotency_key', 'idem-key-999');
        span.setAttribute('idempotencyKey', 'idem-key-999');
        span.setAttribute('url', 'https://youtube.com/watch?v=dQw4w9WgXcQ');
        span.setAttribute('token', 'secret-token');
      });

      tracerSpy.mockRestore();

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBe(1);
      const attrs = spans[0].attributes;

      expect(attrs['operation']).toBe('claim_generation_processing');
      expect(attrs['status']).toBe('success');

      expect(attrs['user_id']).toBeUndefined();
      expect(attrs['userId']).toBeUndefined();
      expect(attrs['video_id']).toBeUndefined();
      expect(attrs['videoId']).toBeUndefined();
      expect(attrs['idempotency_key']).toBeUndefined();
      expect(attrs['idempotencyKey']).toBeUndefined();
      expect(attrs['url']).toBeUndefined();
      expect(attrs['token']).toBeUndefined();
    });
  });
});
