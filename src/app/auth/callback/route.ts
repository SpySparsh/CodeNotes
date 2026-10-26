import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sanitizeRedirectPath } from '@/lib/auth/redirect';
import type { EmailOtpType } from '@supabase/supabase-js';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const tokenHash = requestUrl.searchParams.get('token_hash');
  const type = requestUrl.searchParams.get('type') as EmailOtpType | null;
  const nextParam = requestUrl.searchParams.get('next');
  const error = requestUrl.searchParams.get('error');
  const errorDescription = requestUrl.searchParams.get('error_description');

  // Determine trusted public origin (support Vercel and reverse proxies)
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto') || 'https';
  const publicOrigin = forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : requestUrl.origin;

  // Sanitize next parameter against open redirects
  const next = sanitizeRedirectPath(nextParam, publicOrigin, '/library');
  const destinationUrl = new URL(next, publicOrigin);

  // If OAuth provider returned an error directly in the query parameters
  if (error) {
    const loginErrorUrl = new URL('/login', publicOrigin);
    loginErrorUrl.searchParams.set('error', errorDescription || error);
    return NextResponse.redirect(loginErrorUrl);
  }

  // 1. Verify token_hash for email confirmations / OTP verification
  if (tokenHash && type) {
    const supabase = await createClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });

    if (!verifyError) {
      return NextResponse.redirect(destinationUrl);
    }

    const loginErrorUrl = new URL('/login', publicOrigin);
    loginErrorUrl.searchParams.set('error', 'auth_callback_failed');
    return NextResponse.redirect(loginErrorUrl);
  }

  // 2. Exchange authorization code for session (OAuth & PKCE)
  if (code) {
    const supabase = await createClient();
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

    if (!exchangeError) {
      return NextResponse.redirect(destinationUrl);
    }

    const loginErrorUrl = new URL('/login', publicOrigin);
    loginErrorUrl.searchParams.set('error', 'auth_callback_failed');
    return NextResponse.redirect(loginErrorUrl);
  }

  // Return to login with error if neither code nor token_hash is present
  const loginErrorUrl = new URL('/login', publicOrigin);
  loginErrorUrl.searchParams.set('error', 'auth_callback_failed');
  return NextResponse.redirect(loginErrorUrl);
}
