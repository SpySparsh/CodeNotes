import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/proxy';

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Intercept unintended root or non-callback OAuth/email confirmation redirects
  // (e.g. if Supabase fallback redirects to Site URL '/' instead of '/auth/callback')
  if (
    pathname !== '/auth/callback' &&
    (request.nextUrl.searchParams.has('code') || request.nextUrl.searchParams.has('token_hash'))
  ) {
    const callbackUrl = new URL('/auth/callback', request.url);
    callbackUrl.search = request.nextUrl.search;
    return NextResponse.redirect(callbackUrl);
  }

  const { supabaseResponse, user } = await updateSession(request);

  // Protected pages: redirect unauthenticated users to login
  const isProtectedRoute = pathname.startsWith('/library') || pathname.startsWith('/notes');
  if (isProtectedRoute && !user) {
    const redirectUrl = new URL('/login', request.url);
    redirectUrl.searchParams.set('next', pathname + search);
    return NextResponse.redirect(redirectUrl);
  }

  // Guest-only pages: redirect already authenticated users to library
  const isGuestRoute = pathname === '/login' || pathname === '/signup';
  if (isGuestRoute && user) {
    return NextResponse.redirect(new URL('/library', request.url));
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/health|api/metrics|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
