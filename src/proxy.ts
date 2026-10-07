import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/proxy';

export async function proxy(request: NextRequest) {
  const { supabaseResponse, user } = await updateSession(request);
  const { pathname, search } = request.nextUrl;

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
