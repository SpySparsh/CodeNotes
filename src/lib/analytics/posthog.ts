/**
 * src/lib/analytics/posthog.ts
 *
 * Lightweight, privacy-first PostHog client integration for CodeNotes.
 *
 * Privacy Guarantees:
 * - Autocapture: DISABLED
 * - Automatic pageviews/pageleaves: DISABLED
 * - Session recording: DISABLED
 * - Feature flags / surveys / heatmaps: DISABLED
 * - When NEXT_PUBLIC_POSTHOG_KEY is unset or blank: strictly disabled, zero network calls.
 * - Identifies users exclusively by UUID, never email addresses.
 */

import posthog from 'posthog-js';
import {
  EventName,
  EventPropertiesMap,
  sanitizeEventProperties,
  normalizeRoute,
  AllowedRoute,
  sanitizePostHogEventBeforeSend,
} from './events';

let isInitialized = false;

export function getPostHogConfig(): { apiKey: string | null; apiHost: string } {
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() || null;
  const apiHost =
    process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || 'https://us.i.posthog.com';

  return { apiKey, apiHost };
}

export function isPostHogEnabled(): boolean {
  return Boolean(getPostHogConfig().apiKey);
}

/**
 * Initializes PostHog in the browser if NEXT_PUBLIC_POSTHOG_KEY is present.
 * In production without the key, or in local/test environments, does nothing.
 */
export function initPostHog(): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (isInitialized) {
    return;
  }

  const { apiKey, apiHost } = getPostHogConfig();

  if (!apiKey) {
    return;
  }

  posthog.init(apiKey, {
    api_host: apiHost,
    request_batching: false,
    // Explicitly disable all automatic tracking and session recording
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    advanced_disable_decide: true,
    advanced_disable_feature_flags_on_first_load: true,
    disable_surveys: true,
    save_referrer: false,
    disable_capture_url_hashes: true,
    before_send: sanitizePostHogEventBeforeSend,
    // Store anonymous ID securely
    persistence: 'localStorage',
    loaded: () => {
      isInitialized = true;
    },
  });

  isInitialized = true;
}

/**
 * Reset module initialization flag for unit tests.
 */
export function __resetPostHogStateForTesting(): void {
  isInitialized = false;
}

/**
 * Identifies an authenticated user by their Supabase UUID.
 * Strictly asserts that the identifier is not an email address.
 */
export function identifyUser(userId: string | null | undefined): void {
  if (!isPostHogEnabled() || typeof window === 'undefined') {
    return;
  }

  if (!userId || typeof userId !== 'string') {
    return;
  }

  const trimmedId = userId.trim();
  if (!trimmedId || trimmedId.includes('@')) {
    // Defense-in-depth: Never use an email as a PostHog distinct_id
    console.warn('identifyUser rejected: userId appears to contain an email or invalid format.');
    return;
  }

  try {
    posthog.identify(trimmedId);
  } catch {
    // Fail-safe: analytics must never throw or disrupt application flow
  }
}

/**
 * Resets user identity on logout.
 */
export function resetUser(): void {
  if (!isPostHogEnabled() || typeof window === 'undefined') {
    return;
  }

  try {
    posthog.reset();
  } catch {
    // Fail-safe
  }
}

/**
 * Type-safe, sanitized event capture.
 * If PostHog is disabled, silently acts as a no-op.
 */
export function captureEvent<T extends EventName>(
  eventName: T,
  properties?: EventPropertiesMap[T]
): void {
  if (!isPostHogEnabled() || typeof window === 'undefined') {
    return;
  }

  try {
    const sanitizedProps = sanitizeEventProperties(eventName, properties);
    posthog.capture(eventName, sanitizedProps);
  } catch {
    // Fail-safe: analytics failures never crash UI or background jobs
  }
}

/**
 * Manually captures a pageview with normalized route template.
 * Strips all dynamic parameters, tokens, and query strings.
 */
export function capturePageView(rawRoute: string): void {
  if (!isPostHogEnabled() || typeof window === 'undefined') {
    return;
  }

  try {
    const route: AllowedRoute = normalizeRoute(rawRoute);
    const sanitizedProps = sanitizeEventProperties('$pageview', { route });
    posthog.capture('$pageview', sanitizedProps);
  } catch {
    // Fail-safe
  }
}

/**
 * Export underlying posthog instance for testing or advanced safe inspection.
 */
export { posthog };
