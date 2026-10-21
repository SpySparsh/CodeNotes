import * as Sentry from '@sentry/nextjs';
import type { Span } from '@sentry/nextjs';
import { isProhibitedAttribute, sanitizeErrorMessage } from '@/lib/tracing';
import { isSensitiveKey, sanitizeText } from '@/lib/sentry/sanitizer';

/**
 * Strict allowlist of approved span attribute keys for normal API routes.
 * Any key not explicitly in this set is rejected.
 */
export const ALLOWED_SPAN_ATTRIBUTE_KEYS = new Set([
  'http.method',
  'http.route',
  'http.status_code',
  'http.response.status_code',
  'operation',
  'operation.status',
  'notes.sort_field',
  'notes.sort_order',
  'notes.is_search_applied',
  'notes.has_cursor',
  'notes.returned_count',
  'rate_limit.allowed',
  'error.type',
]);

const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const VALID_SORT_FIELDS = new Set(['created_at', 'video_title']);
const VALID_SORT_ORDERS = new Set(['asc', 'desc']);

/**
 * Validates whether an attribute key and value conform to the strict privacy allowlist.
 */
export function isAllowedSpanAttribute(key: string, value: unknown): boolean {
  if (!key || typeof key !== 'string') return false;
  if (value === null || value === undefined) return false;

  // Reject anything prohibited or matching credential patterns
  if (isProhibitedAttribute(key) || isSensitiveKey(key)) {
    return false;
  }

  if (!ALLOWED_SPAN_ATTRIBUTE_KEYS.has(key)) {
    return false;
  }

  switch (key) {
    case 'http.method':
      return typeof value === 'string' && VALID_HTTP_METHODS.has(value);

    case 'http.route':
      return (
        typeof value === 'string' &&
        value.startsWith('/api/') &&
        !value.includes('?') &&
        !value.includes('&') &&
        value.length <= 128
      );

    case 'http.status_code':
    case 'http.response.status_code':
      return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;

    case 'operation':
    case 'operation.status':
      return typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value);

    case 'notes.sort_field':
      return typeof value === 'string' && VALID_SORT_FIELDS.has(value);

    case 'notes.sort_order':
      return typeof value === 'string' && VALID_SORT_ORDERS.has(value);

    case 'notes.is_search_applied':
    case 'notes.has_cursor':
    case 'rate_limit.allowed':
      return typeof value === 'boolean';

    case 'notes.returned_count':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0;

    case 'error.type':
      return typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value);

    default:
      return false;
  }
}

/**
 * Filters a dictionary of attributes against the strict allowlist.
 */
export function filterSafeAttributes(
  attributes?: Record<string, unknown>
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  if (!attributes || typeof attributes !== 'object') return safe;

  for (const [key, value] of Object.entries(attributes)) {
    if (isAllowedSpanAttribute(key, value)) {
      safe[key] = value as string | number | boolean;
    }
  }
  return safe;
}

/**
 * Wraps a Sentry Span with a defensive Proxy that silences any attempts
 * to set non-allowlisted or sensitive attributes.
 */
export function createSafeSentrySpan(span: Span): Span {
  if (!span) return span;

  return new Proxy(span, {
    get(target, prop, receiver) {
      if (prop === 'setAttribute') {
        return (key: string, value: any) => {
          if (isAllowedSpanAttribute(key, value)) {
            target.setAttribute(key, value);
          }
          return receiver;
        };
      }
      if (prop === 'setAttributes') {
        return (attributes: Record<string, any>) => {
          if (attributes && typeof attributes === 'object') {
            for (const [key, value] of Object.entries(attributes)) {
              if (isAllowedSpanAttribute(key, value)) {
                target.setAttribute(key, value);
              }
            }
          }
          return receiver;
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

export interface RouteSpanOptions {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  route: string;
}

/**
 * Wraps an HTTP route handler execution in a root Sentry transaction span.
 * Guarantees proper status recording, error propagation, and sensitive data exclusion.
 */
export async function withSentryRouteSpan<T extends { status?: number }>(
  options: RouteSpanOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  // If Sentry.startSpan is not available (e.g. in test environments with minimal Sentry mocks),
  // fallback gracefully to executing the handler directly with a no-op safe span.
  if (typeof Sentry.startSpan !== 'function') {
    const noopSpan: any = {
      setAttribute: () => noopSpan,
      setAttributes: () => noopSpan,
      setStatus: () => noopSpan,
      end: () => {},
    };
    return fn(noopSpan);
  }

  // Normalize span name to avoid dynamic identifiers
  const safeName = options.name.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '[id]'
  );

  return Sentry.startSpan(
    {
      name: safeName,
      op: 'http.server',
      forceTransaction: true,
      attributes: {
        'http.method': options.method,
        'http.route': options.route,
      },
    },
    async (rawSpan) => {
      const safeSpan = createSafeSentrySpan(rawSpan);
      try {
        const response = await fn(safeSpan);
        const status = typeof response?.status === 'number' ? response.status : 200;
        safeSpan.setAttribute('http.status_code', status);
        if (typeof Sentry.setHttpStatus === 'function') {
          Sentry.setHttpStatus(rawSpan, status);
        }
        if (status >= 500) {
          safeSpan.setStatus({ code: 2, message: 'internal_error' });
        }
        return response;
      } catch (error: any) {
        const safeMessage = sanitizeErrorMessage(error?.message);
        safeSpan.setAttribute('http.status_code', 500);
        if (typeof Sentry.setHttpStatus === 'function') {
          Sentry.setHttpStatus(rawSpan, 500);
        }
        safeSpan.setStatus({
          code: 2,
          message: safeMessage,
        });
        throw error;
      }
    }
  );
}

export interface ChildSpanOptions {
  op?: string;
  attributes?: Record<string, unknown>;
}

/**
 * Wraps a synchronous or asynchronous sub-operation in an active child span under the current Sentry span.
 */
export async function withSentryChildSpan<T>(
  name: string,
  options: ChildSpanOptions | undefined,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  // If Sentry.startSpan is not available, execute directly with a no-op span.
  if (typeof Sentry.startSpan !== 'function') {
    const noopSpan: any = {
      setAttribute: () => noopSpan,
      setAttributes: () => noopSpan,
      setStatus: () => noopSpan,
      end: () => {},
    };
    return fn(noopSpan);
  }

  const initialAttributes = filterSafeAttributes(options?.attributes);

  return Sentry.startSpan(
    {
      name,
      op: options?.op,
      attributes: initialAttributes,
    },
    async (rawSpan) => {
      const safeSpan = createSafeSentrySpan(rawSpan);
      try {
        const result = await fn(safeSpan);
        safeSpan.setStatus({ code: 1 });
        return result;
      } catch (error: any) {
        const safeMessage = sanitizeErrorMessage(error?.message);
        safeSpan.setStatus({
          code: 2,
          message: safeMessage,
        });
        throw error;
      }
    }
  );
}

export const TARGET_INSTRUMENTED_ROUTES = new Set([
  'GET /api/notes',
  'GET /api/notes/[id]',
  'DELETE /api/notes/[id]',
  'POST /api/generate',
]);

export const TARGET_API_ROUTES = new Set([
  '/api/notes',
  '/api/notes/[id]',
  '/api/generate',
]);

export const EXCLUDED_TRACING_ROUTES = new Set([
  '/api/health',
  '/api/metrics',
  '/api/inngest',
  '/auth/callback',
]);

/**
 * Extracts the normalized route path from a span name or route string.
 * Supports "METHOD /path" and direct "/path" formats while stripping query parameters or fragments.
 */
export function extractRoutePath(spanName?: string): string | null {
  if (!spanName || typeof spanName !== 'string') return null;
  const trimmed = spanName.trim();
  const match = trimmed.match(/^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)/i);
  const rawPath = match ? match[1] : (trimmed.startsWith('/') ? trimmed : null);
  if (!rawPath) return null;
  return rawPath.split(/[?#]/)[0];
}

/**
 * Server-side tracesSampler policy for Sentry performance monitoring.
 * Excludes health, metrics, inngest, and oauth routes unconditionally (even if parentSampled is true).
 * Uses exact route matching rather than substring inclusion to avoid false positives.
 * For non-excluded routes, honors inherited parentSampled decisions.
 * Samples ~10% of high-value instrumented API routes, returning 0 for all other paths.
 */
export function serverTracesSampler(samplingContext: any): number | boolean {
  const spanName = (samplingContext?.name as string) || '';
  const routeAttr = samplingContext?.attributes?.['http.route'] as string | undefined;

  const normalizedRouteAttr = routeAttr ? routeAttr.split(/[?#]/)[0] : undefined;
  const extractedPath = extractRoutePath(spanName);

  // 1. Unconditionally exclude exact health, metrics, inngest, and oauth routes
  // Prefer exact match against http.route attribute when available, or exact route path from span name
  if (normalizedRouteAttr && EXCLUDED_TRACING_ROUTES.has(normalizedRouteAttr)) {
    return 0;
  }
  if (extractedPath && EXCLUDED_TRACING_ROUTES.has(extractedPath)) {
    return 0;
  }

  // 2. For non-excluded routes, honor explicit parent sampling decision
  if (samplingContext?.parentSampled !== undefined) {
    return samplingContext.parentSampled;
  }

  // 3. Sample targeted high-value API routes at ~10%
  if (
    TARGET_INSTRUMENTED_ROUTES.has(spanName) ||
    (normalizedRouteAttr && TARGET_API_ROUTES.has(normalizedRouteAttr))
  ) {
    return 0.1;
  }

  // 4. Default unsampled for any other route
  return 0;
}

/**
 * Outgoing span sanitization hook for Sentry `beforeSendSpan`.
 * Strips prohibited keys, enforces the allowlist on user attributes,
 * and ensures no dynamic identifiers leak in span names.
 */
export function sanitizeSpan(span: any): any {
  if (!span) return span;

  if (typeof span.name === 'string') {
    span.name = span.name.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[id]'
    );
  }

  if (span.attributes && typeof span.attributes === 'object') {
    const clean: Record<string, any> = {};
    for (const [key, value] of Object.entries(span.attributes)) {
      if (key.startsWith('sentry.')) {
        clean[key] = value;
        continue;
      }

      if (
        key.startsWith('device.') ||
        key.startsWith('app.') ||
        key.startsWith('process.') ||
        key.startsWith('culture.') ||
        key.startsWith('os.')
      ) {
        clean[key] = value;
        continue;
      }

      if (isProhibitedAttribute(key) || isSensitiveKey(key)) {
        continue;
      }

      if (ALLOWED_SPAN_ATTRIBUTE_KEYS.has(key) && isAllowedSpanAttribute(key, value)) {
        clean[key] = typeof value === 'string' ? sanitizeText(value) : value;
      }
    }
    span.attributes = clean;
  }

  return span;
}
