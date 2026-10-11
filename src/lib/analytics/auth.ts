/**
 * src/lib/analytics/auth.ts
 *
 * Accurate, privacy-first authentication lifecycle tracking for CodeNotes.
 * Handles both Email/Password and Google OAuth authentication flows.
 *
 * Guarantees:
 * - Never counts button clicks as successful authentication.
 * - Stores initiating OAuth flow intent ('signup' | 'login') before redirect.
 * - Recovers and clears stored intent after redirect, preventing stale or double counts.
 * - When OAuth intent is missing or stale, does NOT guess whether the user signed up
 *   or logged in (no created_at/last_sign_in_at heuristics). Safely omits the classified
 *   event while still identifying the user and preserving session deduplication.
 * - Identifies users exclusively by their opaque Supabase UUID (rejects emails/PII).
 * - Deduplicates events across multiple handlers, rerenders, and page reloads via sessionStorage.
 */

import { identifyUser, captureEvent } from './posthog';

export const OAUTH_INTENT_STORAGE_KEY = 'codenotes_oauth_flow_intent';
const OAUTH_INTENT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export type OAuthFlowIntent = 'signup' | 'login';

interface StoredOAuthIntent {
  intent: OAuthFlowIntent;
  timestamp: number;
}

/**
 * Stores the initiating OAuth flow intent ('signup' or 'login') in sessionStorage
 * before redirecting to Google OAuth.
 */
export function setOAuthFlowIntent(intent: OAuthFlowIntent): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: StoredOAuthIntent = {
      intent,
      timestamp: Date.now(),
    };
    sessionStorage.setItem(OAUTH_INTENT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

/**
 * Recovers and clears the stored OAuth flow intent from sessionStorage.
 * Returns null if the intent is missing or older than 10 minutes (stale).
 */
export function getAndClearOAuthFlowIntent(): OAuthFlowIntent | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(OAUTH_INTENT_STORAGE_KEY);
    if (!raw) return null;

    // Immediately clear to prevent reuse across subsequent emissions
    sessionStorage.removeItem(OAUTH_INTENT_STORAGE_KEY);

    const parsed: StoredOAuthIntent = JSON.parse(raw);
    if (!parsed || !parsed.intent || !parsed.timestamp) return null;

    // Check staleness (10 minutes)
    if (Date.now() - parsed.timestamp > OAUTH_INTENT_MAX_AGE_MS) {
      return null;
    }

    if (parsed.intent === 'signup' || parsed.intent === 'login') {
      return parsed.intent;
    }
    return null;
  } catch {
    try {
      sessionStorage.removeItem(OAUTH_INTENT_STORAGE_KEY);
    } catch {}
    return null;
  }
}

export interface TrackableAuthUser {
  id: string;
  created_at?: string;
  last_sign_in_at?: string;
  app_metadata?: {
    provider?: string;
    providers?: string[];
  };
}

/**
 * Tracks successful authentication (login or signup) for a verified user session.
 * Deduplicates per user and sign-in timestamp using sessionStorage.
 *
 * Authoritative Classification Rules:
 * - For email: uses the known originating flow passed via flowOverride ('signup' | 'login').
 * - For Google OAuth: uses the recovered non-stale flow intent from sessionStorage.
 * - When OAuth intent is missing or stale: does NOT guess based on timestamps; safely
 *   omits the classified event while still calling identifyUser and maintaining session deduplication.
 */
export function trackAuthSuccess(
  user: TrackableAuthUser | null | undefined,
  methodOverride?: 'email' | 'google',
  flowOverride?: 'signup' | 'login'
): { event: 'user_signed_up' | 'user_logged_in'; method: 'email' | 'google' } | null {
  if (!user || !user.id || typeof window === 'undefined') {
    return null;
  }

  // Always identify user with opaque UUID (defense-in-depth rejects emails)
  identifyUser(user.id);

  const lastSignIn = user.last_sign_in_at || user.created_at || 'initial';
  const dedupeKey = `codenotes_auth_tracked_${user.id}_${lastSignIn}`;

  // Check if this specific sign-in session was already tracked
  try {
    if (sessionStorage.getItem(dedupeKey)) {
      return null;
    }
  } catch {
    // Graceful fallback if storage is restricted
  }

  // Mark as tracked in sessionStorage to preserve session-level deduplication
  try {
    sessionStorage.setItem(dedupeKey, 'true');
  } catch {
    // Ignore storage errors
  }

  // Determine auth method:
  let method: 'email' | 'google' = methodOverride || 'email';
  if (!methodOverride) {
    const isGoogle =
      user.app_metadata?.provider === 'google' ||
      user.app_metadata?.providers?.includes('google');
    if (isGoogle) {
      method = 'google';
    }
  }

  // Determine authoritative flow intent:
  // For email flows, flowOverride is explicit and authoritative.
  // For Google OAuth, getAndClearOAuthFlowIntent() is authoritative.
  let flowIntent: 'signup' | 'login' | null = flowOverride || null;
  if (!flowIntent && method === 'google') {
    flowIntent = getAndClearOAuthFlowIntent();
  }

  // When OAuth intent is missing or stale, do NOT guess based on timestamps.
  // Safely omit the classified lifecycle event. User identification and deduplication remain intact.
  if (!flowIntent) {
    return null;
  }

  const eventName = flowIntent === 'signup' ? 'user_signed_up' : 'user_logged_in';
  captureEvent(eventName, { method });

  return { event: eventName, method };
}
