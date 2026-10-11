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
