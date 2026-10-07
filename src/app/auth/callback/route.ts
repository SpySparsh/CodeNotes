import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const nextParam = requestUrl.searchParams.get('next');

  // Sanitize next parameter: must be an internal relative path starting with '/' and not '//'
  let next = '/library';
  if (nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') && !nextParam.startsWith('/\\')) {
    next = nextParam;
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  }

  // Return to login with error if code exchange fails or code is missing
  return NextResponse.redirect(new URL('/login?error=auth_callback_failed', request.url));
}
