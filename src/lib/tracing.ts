import { trace, context, propagation, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InngestSpanProcessor } from 'inngest/experimental';
import { inngest } from '@/inngest/client';
import { sanitizeText } from '@/lib/sentry/sanitizer';

export const TRACER_NAME = 'codenotes';
export { SpanStatusCode };

const globalForTracing = globalThis as unknown as {
  tracingInitialized?: boolean;
  globalProcessor?: InngestSpanProcessor | null;
  globalProvider?: BasicTracerProvider | null;
};

// Explicit denylist of normalized attribute keys to strictly enforce privacy
const PROHIBITED_ATTRIBUTE_KEYS = new Set([
  'user',
  'userid',
  'user_id',
  'email',
  'videoid',
  'video_id',
  'videourl',
  'video_url',
  'url',
  'transcript',
  'transcripttext',
  'transcript_text',
  'prompt',
  'notes',
  'ainotes',
  'ai_notes',
  'detailednotes',
  'detailed_notes',
  'key',
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'cookie',
  'authorization',
  'auth',
  'credential',
  'note',
  'noteid',
  'note_id',
  'notesid',
  'notes_id',
  'idempotencykey',
  'idempotency_key',
  'jobid',
  'job_id',
]);

export function isProhibitedAttribute(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  if (PROHIBITED_ATTRIBUTE_KEYS.has(key.toLowerCase()) || PROHIBITED_ATTRIBUTE_KEYS.has(normalized)) {
    return true;
  }
  return false;
}

/**
 * Wraps a raw OpenTelemetry Span with a defensive proxy that drops any attempts
 * to dynamically record prohibited attributes (identifiers, credentials, payloads).
 */
export function createSafeSpan(span: Span): Span {
  let explicitStatusCode: SpanStatusCode | undefined;

  return new Proxy(span, {
    get(target, prop, receiver) {
      if (prop === 'setAttribute') {
        return (key: string, value: any) => {
          if (!isProhibitedAttribute(key) && value !== undefined && value !== null) {
            target.setAttribute(key, value);
          }
          return receiver;
        };
      }
      if (prop === 'setAttributes') {
        return (attributes: Record<string, any>) => {
          for (const [key, value] of Object.entries(attributes)) {
            if (!isProhibitedAttribute(key) && value !== undefined && value !== null) {
              target.setAttribute(key, value);
            }
          }
          return receiver;
        };
      }
      if (prop === 'setStatus') {
        return (status: { code: SpanStatusCode; message?: string }) => {
          if (status && typeof status.code === 'number') {
            explicitStatusCode = status.code;
            const sanitizedStatus = {
              code: status.code,
              message: status.message ? sanitizeErrorMessage(status.message) : undefined,
            };
            target.setStatus(sanitizedStatus);
          }
          return receiver;
        };
      }
      if (prop === 'status') {
        const baseStatus = (target as any).status;
        if (explicitStatusCode !== undefined) {
          return { ...baseStatus, code: explicitStatusCode };
        }
        return baseStatus;
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

/**
 * Initializes the OpenTelemetry provider and async context manager.
 * Must be called in Next.js instrumentation before importing Sentry or application modules.
 */
export function initTracing(): { provider: BasicTracerProvider | null; processor: InngestSpanProcessor | null } {
  if (globalForTracing.tracingInitialized) {
    return { provider: globalForTracing.globalProvider ?? null, processor: globalForTracing.globalProcessor ?? null };
  }

  // Only run in Node.js server/serverless environments
  if (typeof window !== 'undefined' || process.env.NEXT_RUNTIME === 'edge') {
    return { provider: null, processor: null };
  }

  try {
    const contextManager = new AsyncHooksContextManager().enable();
    context.setGlobalContextManager(contextManager);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    const processor = new InngestSpanProcessor(inngest);
    const provider = new BasicTracerProvider({
      spanProcessors: [processor],
    });

    trace.setGlobalTracerProvider(provider);
    globalForTracing.globalProcessor = processor;
    globalForTracing.globalProvider = provider;
    globalForTracing.tracingInitialized = true;
  } catch (error) {
    // Surface failure without silently swallowing, while not crashing non-server contexts
    console.error('Failed to initialize OpenTelemetry tracing provider:', error);
    throw error;
  }

  return { provider: globalForTracing.globalProvider ?? null, processor: globalForTracing.globalProcessor ?? null };
}

/**
 * Explicitly flushes the Inngest span processor batcher.
 */
export async function flushTracing(): Promise<void> {
  const processor = globalForTracing.globalProcessor;
  if (processor) {
    try {
      await processor.forceFlush();
    } catch {
      // Ignore background flush failures
    }
  }
}

/**
 * Returns the application tracer.
 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Sanitizes exception messages to guarantee that no secret keys, tokens, JWTs,
 * passwords, database URLs, emails, video URLs, or identifiers are exposed in span status or events.
 */
export function sanitizeErrorMessage(msg?: string): string {
  if (!msg || typeof msg !== 'string') return 'Operation failed';
  let s = sanitizeText(msg);
  // Redact email addresses
  s = s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]');
  // Redact YouTube / video URLs
  s = s.replace(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s]+/gi, '[REDACTED_URL]');
  // Redact partial or full JWT tokens
  s = s.replace(/eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+(\.[A-Za-z0-9\-_]+)?/g, '[REDACTED_SECRET]');
  // Redact parameter assignments like key=xyz, token xyz, password: xyz, user_id=xyz, note_id=xyz, video_id=xyz
  s = s.replace(
    /(api_?key|token|secret|password|key|auth|session|jwt|user_?id|video_?id|note_?id|idempotency_?key)[\s:=]+([^\s&,;]+)/gi,
    '$1=[REDACTED]'
  );
  return s;
}

/**
 * Wraps an asynchronous operation within a named OpenTelemetry active span.
 * Preserves parent-child context across async/await and guarantees span termination in finally.
 * Enforces strict attribute privacy.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  initialAttributes?: Record<string, string | number | boolean | undefined | null>
): Promise<T> {
  const tracer = getTracer();

  return tracer.startActiveSpan(name, async (span) => {
    const safeSpan = createSafeSpan(span);

    if (initialAttributes) {
      for (const [key, value] of Object.entries(initialAttributes)) {
        if (value !== undefined && value !== null) {
          safeSpan.setAttribute(key, value);
        }
      }
    }

    try {
      const result = await fn(safeSpan);
      const currentStatus = (safeSpan as any).status ?? (span as any).status;
      if (currentStatus?.code !== SpanStatusCode.ERROR) {
        safeSpan.setStatus({ code: SpanStatusCode.OK });
      }
      return result;
    } catch (error: any) {
      const safeCode = typeof error?.code === 'string' ? error.code : (error?.name || 'Error');
      const safeMessage = sanitizeErrorMessage(error?.message);

      safeSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: safeMessage,
      });

      // Record bounded, sanitized exception event without exposing raw stack or unscrubbed message
      safeSpan.recordException({
        name: safeCode,
        message: safeMessage,
      });

      throw error;
    } finally {
      safeSpan.end();
    }
  });
}
