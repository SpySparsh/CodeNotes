export const SENSITIVE_PARAM_REGEX =
  /^(api_?key|auth(orization)?|token|access_?token|refresh_?token|secret|password|pwd|credential|cookie|sig|signature|key|session|jwt|code)$/i;

export const SENSITIVE_HEADER_REGEX =
  /^(authorization|cookie|set-cookie|x-api-key|apikey|proxy-authorization|x-inngest-signature|x-inngest-env|x-supabase-auth|bearer|x-auth-token)$/i;

export const SECRET_PATTERN_REGEXES = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /AIza[0-9A-Za-z\-_]{30,}/g, // Google / Gemini API keys
  /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, // JWTs
  /postgres(ql)?:\/\/[^:]+:[^@]+@[^\s/]+/gi, // DB Connection strings with credentials
  /sd_[0-9a-f]{32}/g, // Supadata API keys
];

export const EXCLUDED_PAYLOAD_FIELDS = new Set([
  'transcript',
  'transcripttext',
  'prompt',
  'systemprompt',
  'ainotes',
  'notes',
  'body',
  'requestbody',
  'responsebody',
  'data',
  'payload',
  'rawoutput',
  'rawoutputpreview',
  'shorthands',
  'keyconcepts',
  'detailednotes',
  'overview',
]);

/**
 * Checks if a parameter, header, or property key represents sensitive credentials or tokens.
 */
export function isSensitiveKey(key: string): boolean {
  if (!key) return false;
  if (SENSITIVE_PARAM_REGEX.test(key) || SENSITIVE_HEADER_REGEX.test(key)) {
    return true;
  }
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  return /secret|password|passwd|token|apikey|auth|credential|cookie|signature|jwt|session/.test(normalized);
}

/**
 * Sanitizes URLs by redacting sensitive query parameters while preserving safe routing context.
 */
export function sanitizeUrl(urlStr?: string): string {
  if (!urlStr || typeof urlStr !== 'string') return '';

  try {
    const isRelative = urlStr.startsWith('/') || !urlStr.includes('://');
    const base = 'http://localhost';
    const parsed = new URL(urlStr, base);

    const keysToRedact: string[] = [];
    parsed.searchParams.forEach((_, key) => {
      if (isSensitiveKey(key)) {
        keysToRedact.push(key);
      }
    });

    for (const key of keysToRedact) {
      parsed.searchParams.set(key, '[REDACTED]');
    }

    if (isRelative) {
      return parsed.pathname + (parsed.search ? parsed.search : '') + (parsed.hash ? parsed.hash : '');
    }

    return parsed.toString();
  } catch {
    // If URL parsing fails, fallback to regex-based query parameter redaction
    return urlStr.replace(/([?&][^=]+)=([^&]*)/g, (match, key) => {
      const cleanKey = key.replace(/^[?&]/, '');
      if (isSensitiveKey(cleanKey)) {
        return `${key.startsWith('?') ? '?' : '&'}${cleanKey}=[REDACTED]`;
      }
      return match;
    });
  }
}

/**
 * Strips sensitive HTTP headers like Authorization, Cookies, API keys, and Inngest signatures.
 */
export function sanitizeHeaders(headers?: Record<string, any>): Record<string, any> {
  if (!headers || typeof headers !== 'object') return {};

  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    clean[key] = typeof value === 'string' ? sanitizeText(value) : value;
  }
  return clean;
}

/**
 * Redacts secret patterns (Bearer tokens, API keys, DB connection credentials, JWTs) from text.
 */
export function sanitizeText(text?: string): string {
  if (!text || typeof text !== 'string') return '';

  let result = text;
  for (const pattern of SECRET_PATTERN_REGEXES) {
    result = result.replace(pattern, '[REDACTED_SECRET]');
  }
  return result;
}

/**
 * Recursively sanitizes objects and dictionaries, stripping sensitive keys, transcripts,
 * prompts, and redacting secret strings.
 */
export function sanitizeObject(obj: any, depth = 0): any {
  if (depth > 6 || obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeText(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, depth + 1));
  }
  if (typeof obj === 'object') {
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      const normalizedKey = k.toLowerCase().replace(/[-_]/g, '');
      if (EXCLUDED_PAYLOAD_FIELDS.has(normalizedKey)) {
        continue; // Explicitly drop transcripts, prompts, raw notes, payloads
      }
      if (isSensitiveKey(k)) {
        clean[k] = '[REDACTED]';
        continue;
      }
      clean[k] = sanitizeObject(v, depth + 1);
    }
    return clean;
  }
  return obj;
}

/**
 * Sentry beforeBreadcrumb hook: removes cookies, auth headers, and redacts sensitive URLs.
 */
export function sanitizeBreadcrumb(breadcrumb: any): any | null {
  if (!breadcrumb) return null;

  if (breadcrumb.data && typeof breadcrumb.data === 'object') {
    if (typeof breadcrumb.data.url === 'string') {
      breadcrumb.data.url = sanitizeUrl(breadcrumb.data.url);
    }
    if (breadcrumb.data.headers) {
      breadcrumb.data.headers = sanitizeHeaders(breadcrumb.data.headers);
    }
    breadcrumb.data = sanitizeObject(breadcrumb.data);
  }

  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = sanitizeText(breadcrumb.message);
  }

  return breadcrumb;
}

/**
 * Sentry beforeSend hook: ensures zero PII, removes request bodies, sanitizes headers/URLs,
 * and strips transcript text or prompt payloads from extra and contexts.
 */
export function sanitizeEvent(event: any, hint?: any): any | null {
  if (!event) return null;

  // 1. Strip user identity (No email, no raw user UUID, no IP address)
  event.user = undefined;

  // 2. Sanitize request metadata if present
  if (event.request) {
    if (typeof event.request.url === 'string') {
      event.request.url = sanitizeUrl(event.request.url);
    }
    if (event.request.headers) {
      event.request.headers = sanitizeHeaders(event.request.headers);
    }
    // Never send request bodies, cookies, or raw data payloads
    delete event.request.data;
    delete event.request.cookies;
  }

  // 3. Sanitize exception messages and values
  if (event.exception?.values && Array.isArray(event.exception.values)) {
    for (const exc of event.exception.values) {
      if (typeof exc.value === 'string') {
        exc.value = sanitizeText(exc.value);
      }
    }
  }

  // 4. Sanitize breadcrumbs
  if (event.breadcrumbs && Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs
      .map((b: any) => sanitizeBreadcrumb(b))
      .filter(Boolean);
  }

  // 5. Sanitize extra data & contexts: strip large/sensitive AI or transcript fields recursively
  if (event.extra && typeof event.extra === 'object') {
    event.extra = sanitizeObject(event.extra);
  }

  if (event.contexts && typeof event.contexts === 'object') {
    for (const ctxKey of Object.keys(event.contexts)) {
      event.contexts[ctxKey] = sanitizeObject(event.contexts[ctxKey]);
    }
  }

  return event;
}
