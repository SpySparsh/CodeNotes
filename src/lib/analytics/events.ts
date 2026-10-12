/**
 * src/lib/analytics/events.ts
 *
 * Strict event allowlist, bounded property schemas, and sanitization for PostHog product analytics.
 * Enforces privacy guarantees by construction:
 * - Prohibits PII: video_id, note_id, raw URLs, transcripts, prompts, note contents,
 *   code snippets, emails, passwords, OAuth tokens, and unbounded error messages.
 */

export const KNOWN_ERROR_CODES = [
  'INVALID_URL',
  'TRANSCRIPT_UNAVAILABLE',
  'RATE_LIMITED',
  'CONFIG_ERROR',
  'TIMEOUT',
  'DB_TRANSIENT_ERROR',
  'MALFORMED_AI_OUTPUT',
  'TRANSCRIPT_PROVIDER_QUOTA_EXCEEDED',
  'TRANSCRIPT_PROVIDER_AUTH_ERROR',
  'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
  'NON_RETRIABLE_ERROR',
  'GENERATION_ERROR',
  'UNKNOWN_ERROR',
] as const;

export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number];

export const ALLOWED_AUTH_METHODS = ['email', 'google'] as const;
export type AllowedAuthMethod = (typeof ALLOWED_AUTH_METHODS)[number];

export const ALLOWED_ROUTES = ['/', '/library', '/login', '/signup', '/notes/[id]'] as const;
export type AllowedRoute = (typeof ALLOWED_ROUTES)[number];

/**
 * Prohibited property keys that must NEVER be passed to PostHog.
 * An explicit denial set is asserted in addition to strict property allowlisting.
 */
export const PROHIBITED_PROPERTY_KEYS = new Set([
  'video_id',
  'videoId',
  'note_id',
  'noteId',
  'url',
  'video_url',
  'videoUrl',
  'transcript',
  'transcript_text',
  'prompt',
  'notes',
  'overview',
  'key_concepts',
  'detailed_notes',
  'shorthands',
  'code',
  'code_snippet',
  'snippet',
  'email',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'code_verifier',
  'apiKey',
  'api_key',
]);

export interface EventPropertiesMap {
  user_signed_up: { method: AllowedAuthMethod };
  user_logged_in: { method: AllowedAuthMethod };
  generation_requested: Record<string, never>;
  generation_completed: { duration_ms?: number; duration_seconds?: number };
  generation_failed: { error_code: KnownErrorCode };
  note_viewed: Record<string, never>;
  code_copied: { language: string };
  note_deleted: Record<string, never>;
  $pageview: { route: AllowedRoute; $current_url?: string };
  $identify: { distinct_id?: string; $anon_distinct_id?: string };
}

export type EventName = keyof EventPropertiesMap;

export const ALLOWED_EVENTS = new Set<EventName>([
  'user_signed_up',
  'user_logged_in',
  'generation_requested',
  'generation_completed',
  'generation_failed',
  'note_viewed',
  'code_copied',
  'note_deleted',
  '$pageview',
  '$identify',
]);

/**
 * Normalizes an arbitrary error code into a bounded, known error code string.
 */
export function sanitizeErrorCode(rawCode: unknown): KnownErrorCode {
  if (typeof rawCode !== 'string' || !rawCode.trim()) {
    return 'UNKNOWN_ERROR';
  }
  const clean = rawCode.trim();
  const normalized = clean.toUpperCase();
  if ((KNOWN_ERROR_CODES as readonly string[]).includes(normalized)) {
    return normalized as KnownErrorCode;
  }

  // Bounded classification heuristics for unmapped errors
  if (/TRANSCRIPT|SUBTITLE/i.test(clean)) return 'TRANSCRIPT_UNAVAILABLE';
  if (/RATE.*LIMIT|429/i.test(clean)) return 'RATE_LIMITED';
  if (/TIMEOUT|TIMED OUT/i.test(clean)) return 'TIMEOUT';
  if (/INVALID.*(URL|VIDEO)|VIDEO.*NOT.*FOUND/i.test(clean)) return 'INVALID_URL';
  if (/GEMINI|\bAI\b/i.test(clean)) return 'MALFORMED_AI_OUTPUT';
  if (/FETCH|NETWORK|ECONN/i.test(clean)) return 'GENERATION_ERROR';
  if (/DB|DATABASE|POSTGRES/i.test(clean)) return 'DB_TRANSIENT_ERROR';

  return 'UNKNOWN_ERROR';
}

/**
 * Normalizes a programming language identifier to a bounded, safe string (max 30 chars).
 */
export function sanitizeLanguage(rawLanguage: unknown): string {
  if (typeof rawLanguage !== 'string' || !rawLanguage.trim()) {
    return 'text';
  }
  const raw = rawLanguage.trim();
  if (raw.length > 30 || /[^a-zA-Z0-9_\-+.]/.test(raw)) {
    // If it contains atypical characters like HTML or angle brackets, reject to unknown
    if (/[<>{}$`'"]/.test(raw) || raw.length > 30) {
      return 'unknown';
    }
  }

  const cleaned = raw
    .toLowerCase()
    .replace(/\+\+/g, 'pp')
    .replace(/#/g, 'sharp')
    .replace(/[^a-z0-9_\-.]/g, '')
    .slice(0, 30);

  return cleaned || 'text';
}

/**
 * Normalizes a URL pathname or full URL to a bounded template route.
 * Strips all query parameters, hashes, dynamic IDs, and tokens.
 */
export function normalizeRoute(rawUrlOrPath: string | null | undefined): AllowedRoute {
  if (!rawUrlOrPath || typeof rawUrlOrPath !== 'string') {
    return '/';
  }
  let path = rawUrlOrPath.trim();
  try {
    if (path.startsWith('http://') || path.startsWith('https://')) {
      const parsed = new URL(path);
      path = parsed.pathname;
    } else {
      path = path.split('?')[0].split('#')[0].trim();
    }
  } catch {
    path = path.split('?')[0].split('#')[0].trim();
  }

  if (path === '' || path === '/') return '/';
  if (path === '/library') return '/library';
  if (path === '/login') return '/login';
  if (path === '/signup') return '/signup';
  if (path.startsWith('/notes/')) return '/notes/[id]';

  return '/';
}

export const UNSAFE_PROPERTIES_TO_REMOVE = new Set([
  '$referrer',
  '$referring_domain',
  '$initial_referrer',
  '$initial_referring_domain',
  '$entry_referrer',
  '$initial_current_url',
  '$entry_current_url',
  '$entry_pathname',
  '$exit_current_url',
  '$exit_pathname',
  '$search_engine',
  '$search_engine_hostname',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  '$initial_utm_source',
  '$initial_utm_medium',
  '$initial_utm_campaign',
  '$initial_utm_term',
  '$initial_utm_content',
]);

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

export interface PostHogRawEvent {
  uuid?: string;
  event: string;
  properties?: Record<string, any>;
  $set?: Record<string, any>;
  $set_once?: Record<string, any>;
  $unset?: string[];
  timestamp?: Date;
}

/**
 * Central PostHog before_send privacy filter.
 * Intercepts every event captured by PostHog before transmission.
 *
 * Guarantees:
 * - Drops any event not in ALLOWED_EVENTS (returns null).
 * - Strips all prohibited keys (video_id, note_id, url, prompt, transcript, code, etc.).
 * - Strips all referrer, search engine, and attribution/UTM properties.
 * - Strips session entry and exit URL properties.
 * - Normalizes $current_url and $pathname into bounded route templates (e.g. /notes/[id]),
 *   ensuring no query parameters, OAuth codes, fragments, or UUIDs are sent.
 * - Sanitizes $set and $set_once person properties to ensure zero PII/email leakage.
 */
export function sanitizePostHogEventBeforeSend<T extends PostHogRawEvent>(
  rawEvent: T | null | undefined
): T | null {
  if (!rawEvent || !rawEvent.event) {
    return null;
  }

  // Drop unauthorized events
  if (!ALLOWED_EVENTS.has(rawEvent.event as EventName)) {
    return null;
  }

  // Security guard: For $identify, ensure distinct_id does not leak an email address
  if (rawEvent.event === '$identify') {
    const distinctId = rawEvent.properties?.distinct_id;
    if (typeof distinctId === 'string' && distinctId.includes('@')) {
      return null;
    }
  }

  const sanitizedEvent = { ...rawEvent };
  const rawProps = { ...(sanitizedEvent.properties || {}) };

  // Remove unsafe properties (referrers, entry/exit URLs, UTM tracking)
  for (const unsafeKey of UNSAFE_PROPERTIES_TO_REMOVE) {
    delete rawProps[unsafeKey];
  }

  const configuredProjectToken = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() || null;

  // Remove explicit prohibited property keys
  for (const prohibitedKey of PROHIBITED_PROPERTY_KEYS) {
    if (
      prohibitedKey === 'token' &&
      configuredProjectToken &&
      rawProps.token === configuredProjectToken
    ) {
      // Preserve PostHog SDK's required project ingestion token
      continue;
    }
    delete rawProps[prohibitedKey];
  }

  // Normalize URL properties:
  // PostHog SDK attaches $current_url and $pathname by default.
  // We sanitize them strictly to the normalized route template.
  const routeCandidate =
    typeof rawProps.$current_url === 'string'
      ? rawProps.$current_url
      : typeof rawProps.route === 'string'
        ? rawProps.route
        : typeof rawProps.$pathname === 'string'
          ? rawProps.$pathname
          : '/';

  const normalizedRoute = normalizeRoute(routeCandidate);

  if (rawEvent.event === '$pageview') {
    rawProps.$current_url = normalizedRoute;
    rawProps.route = normalizedRoute;
    if (rawProps.$pathname !== undefined) {
      rawProps.$pathname = normalizedRoute;
    }
  } else {
    // For non-pageview events: if $current_url or $pathname exist, normalize them
    if (rawProps.$current_url !== undefined) {
      rawProps.$current_url = normalizedRoute;
    }
    if (rawProps.$pathname !== undefined) {
      rawProps.$pathname = normalizedRoute;
    }
  }

  // Scrub any string value that leaks an email or OAuth token/code
  for (const key of Object.keys(rawProps)) {
    const val = rawProps[key];
    if (typeof val === 'string') {
      if (EMAIL_REGEX.test(val)) {
        delete rawProps[key];
        continue;
      }
      if (/code=|access_token=|bearer\s/i.test(val)) {
        delete rawProps[key];
        continue;
      }
    }
  }

  sanitizedEvent.properties = rawProps;

  // Sanitize person properties ($set, $set_once)
  if (sanitizedEvent.$set && typeof sanitizedEvent.$set === 'object') {
    const setProps = { ...sanitizedEvent.$set };
    for (const key of Object.keys(setProps)) {
      if (
        PROHIBITED_PROPERTY_KEYS.has(key) ||
        (typeof setProps[key] === 'string' && EMAIL_REGEX.test(setProps[key]))
      ) {
        delete setProps[key];
      }
    }
    sanitizedEvent.$set = setProps;
  }

  if (sanitizedEvent.$set_once && typeof sanitizedEvent.$set_once === 'object') {
    const setOnceProps = { ...sanitizedEvent.$set_once };
    for (const key of Object.keys(setOnceProps)) {
      if (
        PROHIBITED_PROPERTY_KEYS.has(key) ||
        (typeof setOnceProps[key] === 'string' && EMAIL_REGEX.test(setOnceProps[key]))
      ) {
        delete setOnceProps[key];
      }
    }
    sanitizedEvent.$set_once = setOnceProps;
  }

  return sanitizedEvent;
}

/**
 * Validates and strictly allowlists event properties.
 * Throws or strips any prohibited or unauthorized property keys.
 */
export function sanitizeEventProperties<T extends EventName>(
  eventName: T,
  rawProps?: unknown
): Record<string, unknown> {
  if (!ALLOWED_EVENTS.has(eventName)) {
    throw new Error(`Unauthorized analytics event: "${String(eventName)}"`);
  }

  if (!rawProps || typeof rawProps !== 'object' || Array.isArray(rawProps)) {
    return {};
  }

  // Check for explicit prohibited keys
  for (const key of Object.keys(rawProps)) {
    if (PROHIBITED_PROPERTY_KEYS.has(key)) {
      throw new Error(
        `Security violation: prohibited property "${key}" rejected from analytics event "${eventName}"`
      );
    }
  }

  const props = rawProps as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  switch (eventName) {
    case 'user_signed_up':
    case 'user_logged_in': {
      const method = typeof props.method === 'string' && props.method.toLowerCase() === 'google'
        ? 'google'
        : 'email';
      sanitized.method = method;
      break;
    }

    case 'generation_completed': {
      if (typeof props.duration_ms === 'number' && Number.isFinite(props.duration_ms) && props.duration_ms >= 0) {
        sanitized.duration_ms = Math.round(props.duration_ms);
      }
      if (typeof props.duration_seconds === 'number' && Number.isFinite(props.duration_seconds) && props.duration_seconds >= 0) {
        sanitized.duration_seconds = Math.round(props.duration_seconds * 10) / 10;
      }
      break;
    }

    case 'generation_failed': {
      sanitized.error_code = sanitizeErrorCode(props.error_code);
      break;
    }

    case 'code_copied': {
      sanitized.language = sanitizeLanguage(props.language);
      break;
    }

    case '$pageview': {
      const rawRouteCandidate = typeof props.route === 'string'
        ? props.route
        : typeof props.$current_url === 'string'
          ? props.$current_url
          : '/';
      const route = normalizeRoute(rawRouteCandidate);
      sanitized.route = route;
      sanitized.$current_url = route;
      break;
    }

    case '$identify': {
      if (typeof props.distinct_id === 'string' && !props.distinct_id.includes('@')) {
        sanitized.distinct_id = props.distinct_id;
      }
      if (typeof props.$anon_distinct_id === 'string' && !props.$anon_distinct_id.includes('@')) {
        sanitized.$anon_distinct_id = props.$anon_distinct_id;
      }
      break;
    }

    case 'generation_requested':
    case 'note_viewed':
    case 'note_deleted':
      // These events have no authorized payload properties
      break;
  }

  return sanitized;
}
