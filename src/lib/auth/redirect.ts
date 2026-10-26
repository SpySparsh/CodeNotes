/**
 * src/lib/auth/redirect.ts
 *
 * Robust redirect path validation and sanitization for post-authentication navigation.
 * Defends against open redirect attacks across both server-side OAuth callback redirects
 * and client-side post-login routing.
 */

/**
 * Validates and sanitizes a post-auth redirect target (`next` parameter) to prevent open redirects.
 *
 * Guarantees:
 * 1. Only relative, internal paths on the current application origin are allowed.
 * 2. Absolute external URLs, protocol-relative URLs (`//`), backslashes (`\`),
 *    and whitespace/control-character bypasses (`/%09/`, `/%0a/`, `/%0d/`, etc.)
 *    are strictly rejected.
 * 3. When validation fails or input is invalid/missing, safely returns `fallback` (default: `/library`).
 * 4. The returned value is guaranteed to be a relative path string starting with a single `/`.
 *
 * @param nextParam - Untrusted input from URL query string or route parameter
 * @param baseOrigin - Optional trusted origin (e.g. `request.url` origin or `window.location.origin`)
 * @param fallback - Safe internal path returned if validation fails (default: `/library`)
 * @returns Sanitized relative path starting with `/`
 */
export function sanitizeRedirectPath(
  nextParam: string | null | undefined,
  baseOrigin?: string,
  fallback = '/library'
): string {
  if (!nextParam || typeof nextParam !== 'string') {
    return fallback;
  }

  const trimmed = nextParam.trim();
  if (!trimmed) {
    return fallback;
  }

  // Must begin with exactly one leading slash; reject protocol-relative URLs ('//')
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return fallback;
  }

  // Reject backslashes or percent-encoded backslashes (%5c / %5C)
  if (trimmed.includes('\\') || /%5c/i.test(trimmed)) {
    return fallback;
  }

  // Reject unprintable ASCII control characters (0x00-0x1F, 0x7F) and common control-char encodings
  // such as tab (%09), newline (%0A), carriage return (%0D)
  if (/[\u0000-\u001F\u007F]/.test(trimmed) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(trimmed)) {
    return fallback;
  }

  try {
    // Resolve against trusted baseOrigin if valid, otherwise fallback to local reference origin
    let referenceOrigin = 'http://127.0.0.1';
    if (baseOrigin) {
      try {
        referenceOrigin = new URL(baseOrigin).origin;
      } catch {
        // Keep fallback reference origin
      }
    }

    const parsed = new URL(trimmed, referenceOrigin);

    // Origin must strictly match the trusted reference origin
    if (parsed.origin !== referenceOrigin) {
      return fallback;
    }

    // Must not contain userinfo (username / password)
    if (parsed.username || parsed.password) {
      return fallback;
    }

    // Pathname must start with a single slash and not double slash
    if (!parsed.pathname.startsWith('/') || parsed.pathname.startsWith('//')) {
      return fallback;
    }

    // Construct sanitized relative path preserving query parameters and hash fragment
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return fallback;
  }
}

/**
 * Resolves the canonical/runtime base origin across client and server environments.
 * Priority:
 * 1. Client-side browser: window.location.origin (reflects the exact host/port where the user is active)
 * 2. NEXT_PUBLIC_SITE_URL: configured production canonical domain
 * 3. NEXT_PUBLIC_VERCEL_URL: automatic Vercel preview domain
 * 4. VERCEL_URL: server-side Vercel deployment URL
 * 5. Fallback: http://localhost:3000
 */
export function getAppUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  const rawSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (rawSiteUrl) {
    const formatted = rawSiteUrl.startsWith('http://') || rawSiteUrl.startsWith('https://')
      ? rawSiteUrl
      : `https://${rawSiteUrl}`;
    return formatted.replace(/\/+$/, '');
  }

  const rawVercelPublic = process.env.NEXT_PUBLIC_VERCEL_URL?.trim();
  if (rawVercelPublic) {
    const formatted = rawVercelPublic.startsWith('http://') || rawVercelPublic.startsWith('https://')
      ? rawVercelPublic
      : `https://${rawVercelPublic}`;
    return formatted.replace(/\/+$/, '');
  }

  const rawVercelServer = process.env.VERCEL_URL?.trim();
  if (rawVercelServer) {
    const formatted = rawVercelServer.startsWith('http://') || rawVercelServer.startsWith('https://')
      ? rawVercelServer
      : `https://${rawVercelServer}`;
    return formatted.replace(/\/+$/, '');
  }

  return 'http://localhost:3000';
}

/**
 * Constructs an absolute authentication callback URL (/auth/callback) suitable for
 * Supabase OAuth redirectTo and email confirmation emailRedirectTo options.
 *
 * @param next - Optional post-authentication destination path (sanitized against open redirects)
 * @returns Fully-qualified callback URL string (e.g. 'https://my-app.vercel.app/auth/callback?next=%2Flibrary')
 */
export function getAuthCallbackUrl(next?: string | null): string {
  const base = getAppUrl();
  const callbackUrl = new URL('/auth/callback', base);
  if (next) {
    const sanitizedNext = sanitizeRedirectPath(next, base, '/library');
    callbackUrl.searchParams.set('next', sanitizedNext);
  }
  return callbackUrl.toString();
}
