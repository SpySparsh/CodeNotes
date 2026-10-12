import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import posthog from 'posthog-js';
import {
  sanitizeEventProperties,
  sanitizeLanguage,
  sanitizeErrorCode,
  normalizeRoute,
  sanitizePostHogEventBeforeSend,
  PROHIBITED_PROPERTY_KEYS,
  UNSAFE_PROPERTIES_TO_REMOVE,
} from '../src/lib/analytics/events';
import {
  initPostHog,
  isPostHogEnabled,
  identifyUser,
  resetUser,
  captureEvent,
  capturePageView,
  __resetPostHogStateForTesting,
} from '../src/lib/analytics/posthog';
import {
  trackAuthSuccess,
  setOAuthFlowIntent,
  getAndClearOAuthFlowIntent,
  OAUTH_INTENT_STORAGE_KEY,
} from '../src/lib/analytics/auth';

vi.mock('posthog-js', () => ({
  default: {
    init: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    capture: vi.fn(),
  },
}));

describe('PostHog Product Analytics', () => {
  const originalEnv = process.env;

  // Mock sessionStorage in node environment
  let storageState: Record<string, string> = {};
  const mockSessionStorage = {
    getItem: vi.fn((key: string) => storageState[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      storageState[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete storageState[key];
    }),
    clear: vi.fn(() => {
      storageState = {};
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storageState = {};
    __resetPostHogStateForTesting();
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
    (globalThis as any).window = {};
    (globalThis as any).sessionStorage = mockSessionStorage;
  });

  afterEach(() => {
    process.env = originalEnv;
    delete (globalThis as any).window;
    delete (globalThis as any).sessionStorage;
  });

  describe('Route Normalization (normalizeRoute)', () => {
    it('normalizes root route', () => {
      expect(normalizeRoute('/')).toBe('/');
      expect(normalizeRoute('')).toBe('/');
    });

    it('preserves known static routes without params', () => {
      expect(normalizeRoute('/library')).toBe('/library');
      expect(normalizeRoute('/login')).toBe('/login');
      expect(normalizeRoute('/signup')).toBe('/signup');
    });

    it('strips query strings and hash fragments from static routes', () => {
      expect(normalizeRoute('/library?sort=asc&search=test')).toBe('/library');
      expect(normalizeRoute('/login?next=/library#anchor')).toBe('/login');
      expect(normalizeRoute('/signup?code=12345')).toBe('/signup');
    });

    it('replaces note dynamic IDs and UUIDs with [id]', () => {
      expect(normalizeRoute('/notes/550e8400-e29b-41d4-a716-446655440000')).toBe('/notes/[id]');
      expect(normalizeRoute('/notes/custom-slug-123')).toBe('/notes/[id]');
      expect(normalizeRoute('/notes/12345?tab=overview#section')).toBe('/notes/[id]');
    });

    it('normalizes full URLs with origins and protocols down to bounded route templates', () => {
      expect(normalizeRoute('https://unstuckstudy.com/notes/uuid-987?token=secret#part')).toBe('/notes/[id]');
      expect(normalizeRoute('http://localhost:3000/library?page=2')).toBe('/library');
      expect(normalizeRoute('https://app.com/login?next=/library')).toBe('/login');
      expect(normalizeRoute('https://app.com/signup?ref=promo')).toBe('/signup');
      expect(normalizeRoute('https://app.com/')).toBe('/');
    });

    it('collapses unknown or unexpected routes safely to root', () => {
      expect(normalizeRoute('/unknown/subpath/123')).toBe('/');
      expect(normalizeRoute('https://app.com/settings/profile')).toBe('/');
    });
  });

  describe('Language Sanitization (sanitizeLanguage)', () => {
    it('normalizes standard coding languages', () => {
      expect(sanitizeLanguage('TypeScript')).toBe('typescript');
      expect(sanitizeLanguage('Python')).toBe('python');
      expect(sanitizeLanguage('c++')).toBe('cpp');
      expect(sanitizeLanguage('C#')).toBe('csharp');
      expect(sanitizeLanguage('JSX')).toBe('jsx');
    });

    it('falls back to "text" for empty or non-string inputs', () => {
      expect(sanitizeLanguage('')).toBe('text');
      expect(sanitizeLanguage(null as any)).toBe('text');
      expect(sanitizeLanguage(undefined as any)).toBe('text');
    });

    it('falls back to "unknown" for malicious or overly long inputs', () => {
      expect(sanitizeLanguage('a'.repeat(40))).toBe('unknown');
      expect(sanitizeLanguage('<script>alert(1)</script>')).toBe('unknown');
    });
  });

  describe('Error Code Sanitization (sanitizeErrorCode)', () => {
    it('preserves known error codes directly', () => {
      expect(sanitizeErrorCode('TRANSCRIPT_UNAVAILABLE')).toBe('TRANSCRIPT_UNAVAILABLE');
      expect(sanitizeErrorCode('RATE_LIMITED')).toBe('RATE_LIMITED');
      expect(sanitizeErrorCode('TIMEOUT')).toBe('TIMEOUT');
      expect(sanitizeErrorCode('INVALID_URL')).toBe('INVALID_URL');
      expect(sanitizeErrorCode('MALFORMED_AI_OUTPUT')).toBe('MALFORMED_AI_OUTPUT');
      expect(sanitizeErrorCode('DB_TRANSIENT_ERROR')).toBe('DB_TRANSIENT_ERROR');
    });

    it('maps network and connection failures to bounded GENERATION_ERROR', () => {
      expect(sanitizeErrorCode('Failed to fetch from https://api.supabase.co')).toBe('GENERATION_ERROR');
      expect(sanitizeErrorCode('ECONNREFUSED 127.0.0.1')).toBe('GENERATION_ERROR');
      expect(sanitizeErrorCode('Network error occurred')).toBe('GENERATION_ERROR');
    });

    it('maps transcript errors to bounded TRANSCRIPT_UNAVAILABLE', () => {
      expect(sanitizeErrorCode('No transcripts available for video dQw4w9WgXcQ')).toBe('TRANSCRIPT_UNAVAILABLE');
      expect(sanitizeErrorCode('Subtitles disabled by owner')).toBe('TRANSCRIPT_UNAVAILABLE');
    });

    it('maps rate limits to RATE_LIMITED', () => {
      expect(sanitizeErrorCode('Rate limit exceeded: 429')).toBe('RATE_LIMITED');
    });

    it('maps timeout errors to TIMEOUT', () => {
      expect(sanitizeErrorCode('Execution timed out after 30000ms')).toBe('TIMEOUT');
    });

    it('maps Gemini / AI errors to bounded MALFORMED_AI_OUTPUT', () => {
      expect(sanitizeErrorCode('Gemini API returned error 500')).toBe('MALFORMED_AI_OUTPUT');
      expect(sanitizeErrorCode('AI service unavailable')).toBe('MALFORMED_AI_OUTPUT');
    });

    it('maps invalid video/URL to INVALID_URL', () => {
      expect(sanitizeErrorCode('Invalid YouTube URL provided')).toBe('INVALID_URL');
      expect(sanitizeErrorCode('Video not found')).toBe('INVALID_URL');
    });

    it('falls back to UNKNOWN_ERROR for unrecognized errors without leaking content', () => {
      expect(sanitizeErrorCode('Some random user internal secret leak: 12345')).toBe('UNKNOWN_ERROR');
      expect(sanitizeErrorCode('')).toBe('UNKNOWN_ERROR');
      expect(sanitizeErrorCode(null)).toBe('UNKNOWN_ERROR');
    });
  });

  describe('Property Sanitization & Privacy Guards (sanitizeEventProperties)', () => {
    it('strictly forbids prohibited property keys', () => {
      PROHIBITED_PROPERTY_KEYS.forEach((key) => {
        expect(() => {
          sanitizeEventProperties('generation_requested', { [key]: 'prohibited_value' } as any);
        }).toThrow(/prohibited property/i);
      });
    });

    it('strictly forbids user-supplied token property on all events', () => {
      expect(() => {
        sanitizeEventProperties('generation_requested', { token: 'phc_valid_project_key_xyz' } as any);
      }).toThrow(/prohibited property "token"/i);
    });

    it('allows valid duration properties for generation_completed', () => {
      const sanitized = sanitizeEventProperties('generation_completed', {
        duration_ms: 14500,
        duration_seconds: 14.5,
      });
      expect(sanitized).toEqual({ duration_ms: 14500, duration_seconds: 14.5 });
    });

    it('allows valid properties for generation_failed', () => {
      const sanitized = sanitizeEventProperties('generation_failed', {
        error_code: 'TRANSCRIPT_UNAVAILABLE',
      });
      expect(sanitized).toEqual({ error_code: 'TRANSCRIPT_UNAVAILABLE' });
    });

    it('allows valid properties for code_copied', () => {
      const sanitized = sanitizeEventProperties('code_copied', {
        language: 'python',
      });
      expect(sanitized).toEqual({ language: 'python' });
    });

    it('allows valid properties for user_logged_in and user_signed_up', () => {
      expect(sanitizeEventProperties('user_logged_in', { method: 'email' })).toEqual({ method: 'email' });
      expect(sanitizeEventProperties('user_logged_in', { method: 'google' })).toEqual({ method: 'google' });
      expect(sanitizeEventProperties('user_signed_up', { method: 'email' })).toEqual({ method: 'email' });
      expect(sanitizeEventProperties('user_signed_up', { method: 'google' })).toEqual({ method: 'google' });
    });

    it('drops unexpected properties not in the event allowlist', () => {
      const sanitized = sanitizeEventProperties('generation_requested', {
        extra_data: 'not_allowed',
      } as any);
      expect(sanitized).toEqual({});
    });
  });

  describe('Central PostHog before_send Privacy Filter', () => {
    it('drops unauthorized events entirely (returns null)', () => {
      const unauthorizedEvent = {
        event: 'random_unregistered_event',
        properties: { foo: 'bar' },
      };
      expect(sanitizePostHogEventBeforeSend(unauthorizedEvent as any)).toBeNull();
    });

    it('drops null or empty events', () => {
      expect(sanitizePostHogEventBeforeSend(null)).toBeNull();
      expect(sanitizePostHogEventBeforeSend(undefined)).toBeNull();
      expect(sanitizePostHogEventBeforeSend({ event: '' } as any)).toBeNull();
    });

    it('scrubs unsafe SDK default properties: referrers, entry/exit URLs, and UTM attribution', () => {
      const rawPayload = {
        uuid: 'test-uuid-1',
        event: '$pageview',
        properties: {
          $current_url: 'https://unstuckstudy.com/notes/550e8400-e29b-41d4-a716-446655440000?code=oauth123#frag',
          $pathname: '/notes/550e8400-e29b-41d4-a716-446655440000',
          $referrer: 'https://accounts.google.com/o/oauth2/auth?client_id=google123',
          $referring_domain: 'accounts.google.com',
          $initial_referrer: 'https://evil.com/leak',
          $initial_referring_domain: 'evil.com',
          $entry_referrer: 'https://referrer.example.com',
          $entry_current_url: 'https://unstuckstudy.com/entry?token=abc',
          $exit_current_url: 'https://unstuckstudy.com/exit',
          $search_engine: 'google',
          utm_source: 'campaign_email',
          utm_medium: 'cpc',
          utm_campaign: 'spring_sale',
          $initial_utm_source: 'adwords',
        } as Record<string, any>,
      };

      const sanitized = sanitizePostHogEventBeforeSend(rawPayload);
      expect(sanitized).not.toBeNull();
      expect(sanitized?.event).toBe('$pageview');

      // Unsafe default properties must be completely removed
      const sanitizedProps = sanitized?.properties as Record<string, any>;
      UNSAFE_PROPERTIES_TO_REMOVE.forEach((prop) => {
        expect(sanitizedProps?.[prop]).toBeUndefined();
      });

      // $current_url and $pathname must be normalized to safe route templates
      expect(sanitizedProps?.$current_url).toBe('/notes/[id]');
      expect(sanitizedProps?.$pathname).toBe('/notes/[id]');
      expect(sanitizedProps?.route).toBe('/notes/[id]');
    });

    it('removes prohibited property keys if injected by SDK or caller', () => {
      const rawPayload = {
        uuid: 'test-uuid-2',
        event: 'code_copied',
        properties: {
          language: 'typescript',
          video_id: 'dQw4w9WgXcQ',
          note_id: 'note-123',
          code: 'const secret = "pw";',
          prompt: 'generate notes for this video',
          transcript: 'full transcript text...',
          email: 'user@example.com',
          token: 'jwt-access-token',
        },
      };

      const sanitized = sanitizePostHogEventBeforeSend(rawPayload);
      expect(sanitized?.properties?.language).toBe('typescript');
      expect(sanitized?.properties?.video_id).toBeUndefined();
      expect(sanitized?.properties?.note_id).toBeUndefined();
      expect(sanitized?.properties?.code).toBeUndefined();
      expect(sanitized?.properties?.prompt).toBeUndefined();
      expect(sanitized?.properties?.transcript).toBeUndefined();
      expect(sanitized?.properties?.email).toBeUndefined();
      expect(sanitized?.properties?.token).toBeUndefined();
    });

    it('preserves the configured PostHog project token attached by the SDK for ingestion routing', () => {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_valid_project_key_xyz';
      const rawPayload = {
        uuid: 'test-uuid-sdk-token',
        event: '$pageview',
        properties: {
          route: '/',
          token: 'phc_valid_project_key_xyz',
        },
      };

      const sanitized = sanitizePostHogEventBeforeSend(rawPayload);
      expect(sanitized?.properties?.token).toBe('phc_valid_project_key_xyz');
      expect(sanitized?.properties?.route).toBe('/');
    });

    it('strips mismatched or unexpected tokens from properties', () => {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_valid_project_key_xyz';
      const rawPayload = {
        uuid: 'test-uuid-mismatched-token',
        event: '$pageview',
        properties: {
          route: '/',
          token: 'phc_other_or_stolen_token',
        },
      };

      const sanitized = sanitizePostHogEventBeforeSend(rawPayload);
      expect(sanitized?.properties?.token).toBeUndefined();
    });

    it('strips token when NEXT_PUBLIC_POSTHOG_KEY is not configured', () => {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
      const rawPayload = {
        uuid: 'test-uuid-no-env',
        event: '$pageview',
        properties: {
          route: '/',
          token: 'phc_some_token',
        },
      };

      const sanitized = sanitizePostHogEventBeforeSend(rawPayload);
      expect(sanitized?.properties?.token).toBeUndefined();
    });

    it('scrubs email addresses and OAuth codes from property values', () => {
      const rawPayload = {
        uuid: 'test-uuid-3',
        event: 'generation_completed',
        properties: {
          duration_ms: 5000,
          leaked_email: 'sensitive-user@domain.com',
          auth_leak: 'code=4/0AQl...&scope=email',
        },
      };

      const sanitized = sanitizePostHogEventBeforeSend(rawPayload);
      expect(sanitized?.properties?.duration_ms).toBe(5000);
      expect(sanitized?.properties?.leaked_email).toBeUndefined();
      expect(sanitized?.properties?.auth_leak).toBeUndefined();
    });

    it('sanitizes $set and $set_once person properties', () => {
      const rawPayload = {
        uuid: 'test-uuid-4',
        event: 'user_logged_in',
        properties: { method: 'google' },
        $set: {
          email: 'user@example.com',
          safe_prop: 'allowed',
          token: 'secret-token',
        },
        $set_once: {
          email: 'initial@example.com',
          created_via: 'web',
        },
      };

      const sanitized = sanitizePostHogEventBeforeSend(rawPayload as any);
      expect(sanitized?.$set?.email).toBeUndefined();
      expect(sanitized?.$set?.token).toBeUndefined();
      expect(sanitized?.$set?.safe_prop).toBe('allowed');

      expect(sanitized?.$set_once?.email).toBeUndefined();
      expect(sanitized?.$set_once?.created_via).toBe('web');
    });

    it('retains $identify events with safe identity linkage properties and route template', () => {
      const identifyPayload = {
        uuid: 'ident-uuid-1',
        event: '$identify',
        properties: {
          distinct_id: '123e4567-e89b-12d3-a456-426614174000',
          $anon_distinct_id: '018d4567-anon-client-uuid',
          $current_url: 'https://unstuckstudy.com/library?code=oauth123#frag',
          $pathname: '/library',
          $referrer: 'https://accounts.google.com/o/oauth2/auth',
          email: 'leaked@example.com',
          token: 'oauth-token',
        } as Record<string, any>,
      };

      const sanitized = sanitizePostHogEventBeforeSend(identifyPayload);
      expect(sanitized).not.toBeNull();
      expect(sanitized?.event).toBe('$identify');

      const sanitizedProps = sanitized?.properties as Record<string, any>;
      // Identity linkage properties must be preserved for user stitching
      expect(sanitizedProps?.distinct_id).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(sanitizedProps?.$anon_distinct_id).toBe('018d4567-anon-client-uuid');

      // URLs must be normalized and unsafe/prohibited data stripped
      expect(sanitizedProps?.$current_url).toBe('/library');
      expect(sanitizedProps?.$referrer).toBeUndefined();
      expect(sanitizedProps?.email).toBeUndefined();
      expect(sanitizedProps?.token).toBeUndefined();
    });

    it('drops $identify events if distinct_id contains an email address', () => {
      const emailIdentifyPayload = {
        uuid: 'ident-uuid-2',
        event: '$identify',
        properties: {
          distinct_id: 'user@example.com',
          $anon_distinct_id: '018d4567-anon-client-uuid',
        } as Record<string, any>,
      };

      expect(sanitizePostHogEventBeforeSend(emailIdentifyPayload)).toBeNull();
    });

    it('strictly blocks internal PostHog events other than $identify and $pageview', () => {
      const internalEvents = [
        '$feature_flag_called',
        '$rageclick',
        '$web_vitals',
        '$dead_click',
        '$set',
        '$exception',
        '$opt_in',
      ];

      internalEvents.forEach((internalEvent) => {
        const payload = {
          event: internalEvent,
          properties: { foo: 'bar' },
        };
        expect(sanitizePostHogEventBeforeSend(payload as any)).toBeNull();
      });
    });
  });

  describe('Google and Email Authentication Lifecycle Tracking (trackAuthSuccess)', () => {
    it('records and recovers initiating signup flow intent ("signup") for Google OAuth', () => {
      setOAuthFlowIntent('signup');

      const googleUser = {
        id: '123e4567-e89b-12d3-a456-426614174001',
        created_at: '2026-01-01T10:00:00Z',
        last_sign_in_at: '2026-10-11T12:00:00Z',
        app_metadata: { provider: 'google' },
      };

      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_mock_key';
      initPostHog();

      const result = trackAuthSuccess(googleUser);
      expect(result).toEqual({ event: 'user_signed_up', method: 'google' });
      expect(posthog.identify).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174001');
      expect(posthog.capture).toHaveBeenCalledWith('user_signed_up', { method: 'google' });

      // Verifies intent was cleared from storage immediately
      expect(getAndClearOAuthFlowIntent()).toBeNull();
    });

    it('records and recovers initiating login flow intent ("login") for Google OAuth', () => {
      setOAuthFlowIntent('login');

      const googleUser = {
        id: '123e4567-e89b-12d3-a456-426614174002',
        created_at: '2026-10-11T12:00:00Z',
        last_sign_in_at: '2026-10-11T12:00:02Z', // Timestamp looks new, but explicit intent is login!
        app_metadata: { provider: 'google' },
      };

      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_mock_key';
      initPostHog();

      const result = trackAuthSuccess(googleUser);
      expect(result).toEqual({ event: 'user_logged_in', method: 'google' });
      expect(posthog.identify).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174002');
      expect(posthog.capture).toHaveBeenCalledWith('user_logged_in', { method: 'google' });

      // Verifies intent was cleared
      expect(getAndClearOAuthFlowIntent()).toBeNull();
    });

    it('safely omits classified event when OAuth intent is stale (> 10 minutes) and does not guess from close timestamps', () => {
      // Simulate stale intent (> 10m old)
      const staleTimestamp = Date.now() - (15 * 60 * 1000);
      mockSessionStorage.setItem(
        OAUTH_INTENT_STORAGE_KEY,
        JSON.stringify({ intent: 'signup', timestamp: staleTimestamp })
      );

      // User has created_at and last_sign_in_at only 10ms apart
      const userWithCloseTimestamps = {
        id: '123e4567-e89b-12d3-a456-426614174003',
        created_at: '2026-10-11T12:00:00.000Z',
        last_sign_in_at: '2026-10-11T12:00:00.010Z',
        app_metadata: { provider: 'google' },
      };

      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_mock_key';
      initPostHog();

      const result = trackAuthSuccess(userWithCloseTimestamps);
      // Must NOT guess 'user_signed_up' merely because timestamps are close!
      expect(result).toBeNull();
      expect(posthog.capture).not.toHaveBeenCalled();

      // Must still identify user and clear stale intent
      expect(posthog.identify).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174003');
      expect(getAndClearOAuthFlowIntent()).toBeNull();
    });

    it('safely omits classified event when OAuth intent is missing and does not guess from close timestamps', () => {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_mock_key';
      initPostHog();

      // No intent in storage, but timestamps are virtually identical
      const userWithCloseTimestamps = {
        id: '123e4567-e89b-12d3-a456-426614174004',
        created_at: '2026-10-11T12:00:00.000Z',
        last_sign_in_at: '2026-10-11T12:00:00.005Z',
        app_metadata: { provider: 'google' },
      };

      const result = trackAuthSuccess(userWithCloseTimestamps);
      // Must NOT guess 'user_signed_up'
      expect(result).toBeNull();
      expect(posthog.capture).not.toHaveBeenCalled();

      // Must still identify user and preserve session deduplication
      expect(posthog.identify).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174004');

      // Subsequent call in same session deduplicates and returns null
      const secondCall = trackAuthSuccess(userWithCloseTimestamps);
      expect(secondCall).toBeNull();
    });

    it('tracks email login using authoritative originating flow', () => {
      const emailUser = {
        id: '123e4567-e89b-12d3-a456-426614174005',
        created_at: '2026-10-11T12:00:00Z',
        last_sign_in_at: '2026-10-11T12:00:01Z',
      };

      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_mock_key';
      initPostHog();

      const result = trackAuthSuccess(emailUser, 'email', 'login');
      expect(result).toEqual({ event: 'user_logged_in', method: 'email' });
      expect(posthog.identify).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174005');
      expect(posthog.capture).toHaveBeenCalledWith('user_logged_in', { method: 'email' });
    });

    it('tracks email signup using authoritative originating flow', () => {
      const emailUser = {
        id: '123e4567-e89b-12d3-a456-426614174006',
        created_at: '2026-01-01T10:00:00Z',
        last_sign_in_at: '2026-10-11T12:00:00Z',
      };

      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_mock_key';
      initPostHog();

      const result = trackAuthSuccess(emailUser, 'email', 'signup');
      expect(result).toEqual({ event: 'user_signed_up', method: 'email' });
      expect(posthog.identify).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174006');
      expect(posthog.capture).toHaveBeenCalledWith('user_signed_up', { method: 'email' });
    });

    it('deduplicates authentication events across multiple listeners / handlers', () => {
      const user = {
        id: '123e4567-e89b-12d3-a456-426614174222',
        created_at: '2026-01-01T10:00:00Z',
        last_sign_in_at: '2026-10-11T12:00:00Z',
        app_metadata: { provider: 'google' },
      };

      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_mock_key';
      initPostHog();
      setOAuthFlowIntent('login');

      // First trigger (e.g. from Navbar getUser)
      const firstResult = trackAuthSuccess(user);
      expect(firstResult).not.toBeNull();
      expect(posthog.capture).toHaveBeenCalledTimes(1);

      // Second trigger (e.g. from onAuthStateChange listener on same page)
      const secondResult = trackAuthSuccess(user);
      expect(secondResult).toBeNull();
      expect(posthog.capture).toHaveBeenCalledTimes(1); // Still 1

      // Third trigger (e.g. page refresh with same sign-in session)
      const thirdResult = trackAuthSuccess(user);
      expect(thirdResult).toBeNull();
      expect(posthog.capture).toHaveBeenCalledTimes(1); // Still 1
    });

    it('never sends email addresses or OAuth tokens in auth tracking', () => {
      const userWithPII = {
        id: '123e4567-e89b-12d3-a456-426614174333',
        email: 'secret@domain.com',
        user_metadata: { email: 'secret@domain.com', full_name: 'John Doe' },
        app_metadata: { provider: 'google' },
        last_sign_in_at: '2026-10-11T12:00:00Z',
        created_at: '2026-01-01T10:00:00Z',
      };

      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_mock_key';
      initPostHog();
      setOAuthFlowIntent('login');

      trackAuthSuccess(userWithPII as any);

      expect(posthog.identify).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174333');
      expect(posthog.capture).toHaveBeenCalledWith('user_logged_in', { method: 'google' });
      // Verify no property contained email
      expect(posthog.capture).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ email: expect.anything() }));
    });
  });

  describe('Note Event Accuracy (note_viewed & note_deleted)', () => {
    it('captures note_viewed once per unique note ID across client navigation', () => {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_mock_key';
      initPostHog();

      let lastTrackedNoteId: string | null = null;
      const simulateNoteLoad = (noteId: string) => {
        if (lastTrackedNoteId !== noteId) {
          lastTrackedNoteId = noteId;
          captureEvent('note_viewed');
        }
      };

      // 1. Visit note A
      simulateNoteLoad('note-aaa');
      expect(posthog.capture).toHaveBeenCalledTimes(1);
      expect(posthog.capture).toHaveBeenLastCalledWith('note_viewed', {});

      // 2. Component rerenders for note A (data refresh)
      simulateNoteLoad('note-aaa');
      simulateNoteLoad('note-aaa');
      expect(posthog.capture).toHaveBeenCalledTimes(1); // Still 1

      // 3. Client navigation to note B
      simulateNoteLoad('note-bbb');
      expect(posthog.capture).toHaveBeenCalledTimes(2); // Incremented for note B
      expect(posthog.capture).toHaveBeenLastCalledWith('note_viewed', {});

      // 4. Component rerenders for note B
      simulateNoteLoad('note-bbb');
      expect(posthog.capture).toHaveBeenCalledTimes(2);

      // 5. Client navigation to note C
      simulateNoteLoad('note-ccc');
      expect(posthog.capture).toHaveBeenCalledTimes(3);
    });

    it('captures note_deleted ONLY after deletion succeeds and never on failure', async () => {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_mock_key';
      initPostHog();

      const simulateDeleteFlow = async (shouldSucceed: boolean) => {
        const deleteAsync = async () => {
          if (!shouldSucceed) {
            throw new Error('500 Internal Server Error: Failed to delete note');
          }
          return { success: true };
        };

        try {
          await deleteAsync();
          captureEvent('note_deleted');
        } catch {
          // Handled error
        }
      };

      // 1. Deletion fails
      await simulateDeleteFlow(false);
      expect(posthog.capture).not.toHaveBeenCalled();

      // 2. Deletion succeeds
      await simulateDeleteFlow(true);
      expect(posthog.capture).toHaveBeenCalledTimes(1);
      expect(posthog.capture).toHaveBeenCalledWith('note_deleted', {});
    });
  });

  describe('PostHog Disabled Behavior (Zero Telemetry)', () => {
    it('isPostHogEnabled returns false when NEXT_PUBLIC_POSTHOG_KEY is not set', () => {
      expect(isPostHogEnabled()).toBe(false);
    });

    it('initPostHog performs no initialization when key is absent', () => {
      initPostHog();
      expect(posthog.init).not.toHaveBeenCalled();
    });

    it('captureEvent does not call posthog.capture when disabled', () => {
      captureEvent('generation_requested');
      expect(posthog.capture).not.toHaveBeenCalled();
    });

    it('identifyUser does not call posthog.identify when disabled', () => {
      identifyUser('550e8400-e29b-41d4-a716-446655440000');
      expect(posthog.identify).not.toHaveBeenCalled();
    });

    it('resetUser does not call posthog.reset when disabled', () => {
      resetUser();
      expect(posthog.reset).not.toHaveBeenCalled();
    });

    it('capturePageView does not call posthog.capture when disabled', () => {
      capturePageView('/library');
      expect(posthog.capture).not.toHaveBeenCalled();
    });
  });

  describe('PostHog Enabled Behavior & Privacy Configuration', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_mock_test_key_123';
      process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
      __resetPostHogStateForTesting();
    });

    it('isPostHogEnabled returns true when key is present', () => {
      expect(isPostHogEnabled()).toBe(true);
    });

    it('initPostHog passes strict privacy flags including before_send and save_referrer: false', () => {
      initPostHog();
      expect(posthog.init).toHaveBeenCalledWith(
        'phc_mock_test_key_123',
        expect.objectContaining({
          api_host: 'https://us.i.posthog.com',
          request_batching: false,
          autocapture: false,
          capture_pageview: false,
          capture_pageleave: false,
          disable_session_recording: true,
          disable_surveys: true,
          advanced_disable_decide: true,
          save_referrer: false,
          disable_capture_url_hashes: true,
          before_send: sanitizePostHogEventBeforeSend,
          persistence: 'localStorage',
        })
      );
    });

    it('initPostHog disables request batching to prevent queue starvation during client hydration', () => {
      initPostHog();
      expect(posthog.init).toHaveBeenCalledWith(
        'phc_mock_test_key_123',
        expect.objectContaining({
          request_batching: false,
        })
      );
    });

    it('identifyUser accepts valid opaque user UUID', () => {
      identifyUser('c3b8a1c0-0f2d-4d7a-8f5b-1e2a3b4c5d6e');
      expect(posthog.identify).toHaveBeenCalledWith('c3b8a1c0-0f2d-4d7a-8f5b-1e2a3b4c5d6e');
    });

    it('identifyUser rejects email addresses to protect PII', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      identifyUser('user@example.com');
      expect(posthog.identify).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('identifyUser rejected: userId appears to contain an email or invalid format.')
      );
      consoleWarnSpy.mockRestore();
    });

    it('resetUser calls posthog.reset on logout', () => {
      resetUser();
      expect(posthog.reset).toHaveBeenCalled();
    });

    it('captureEvent captures valid event with sanitized properties', () => {
      captureEvent('generation_completed', { duration_seconds: 12.4 });
      expect(posthog.capture).toHaveBeenCalledWith('generation_completed', { duration_seconds: 12.4 });
    });

    it('capturePageView captures $pageview with normalized route template only', () => {
      capturePageView('/notes/999?ref=home');
      expect(posthog.capture).toHaveBeenCalledWith('$pageview', {
        route: '/notes/[id]',
        $current_url: '/notes/[id]',
      });
    });

    it('deduplicates terminal events across multiple status polling ticks', () => {
      let terminalFired = false;
      const simulatePollingTick = (status: 'completed' | 'failed') => {
        if (!terminalFired) {
          terminalFired = true;
          if (status === 'completed') {
            captureEvent('generation_completed', { duration_seconds: 10 });
          } else {
            captureEvent('generation_failed', { error_code: 'TIMEOUT' });
          }
        }
      };

      for (let i = 0; i < 5; i++) {
        simulatePollingTick('completed');
      }

      expect(posthog.capture).toHaveBeenCalledTimes(1);
      expect(posthog.capture).toHaveBeenCalledWith('generation_completed', { duration_seconds: 10 });
    });
  });
});
