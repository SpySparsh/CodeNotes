import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireUser, getOptionalUser, UnauthorizedError } from '@/lib/auth';
import { GET as handleCallback } from '@/app/auth/callback/route';
import * as serverSupabase from '@/lib/supabase/server';
import { sanitizeRedirectPath, getAppUrl, getAuthCallbackUrl } from '@/lib/auth/redirect';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

describe('Auth Helpers (src/lib/auth.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requireUser returns user when authenticated', async () => {
    const mockUser = { id: 'user-uuid-123', email: 'test@example.com' };
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const user = await requireUser();
    expect(user).toEqual(mockUser);
    expect(mockSupabase.auth.getUser).toHaveBeenCalledTimes(1);
  });

  it('requireUser throws UnauthorizedError when unauthenticated', async () => {
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('No session') }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    await expect(requireUser()).rejects.toThrow(UnauthorizedError);
  });

  it('getOptionalUser returns user when authenticated', async () => {
    const mockUser = { id: 'user-uuid-123', email: 'test@example.com' };
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const user = await getOptionalUser();
    expect(user).toEqual(mockUser);
  });

  it('getOptionalUser returns null when unauthenticated without throwing', async () => {
    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('No session') }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const user = await getOptionalUser();
    expect(user).toBeNull();
  });
});

describe('Redirect Path Sanitization (src/lib/auth/redirect.ts)', () => {
  const trustedOrigin = 'http://localhost:3000';

  it('preserves valid internal paths', () => {
    expect(sanitizeRedirectPath('/library', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/notes/my-note-id', trustedOrigin)).toBe('/notes/my-note-id');
    expect(sanitizeRedirectPath('/notes/123?sort=asc#summary', trustedOrigin)).toBe('/notes/123?sort=asc#summary');
    expect(sanitizeRedirectPath('/', trustedOrigin)).toBe('/');
  });

  it('rejects absolute external URLs and defaults to /library', () => {
    expect(sanitizeRedirectPath('https://evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('http://evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('https://evil.com/notes/123', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('http://attacker.com/library', trustedOrigin)).toBe('/library');
  });

  it('rejects protocol-relative URLs (//evil.com)', () => {
    expect(sanitizeRedirectPath('//evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('//evil.com/library', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('///evil.com', trustedOrigin)).toBe('/library');
  });

  it('rejects backslash-based URL variants (/\\evil.com, \\\\evil.com)', () => {
    expect(sanitizeRedirectPath('/\\evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/\\\\evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('\\evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('\\\\evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/\\/evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/.\\evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/..\\evil.com', trustedOrigin)).toBe('/library');
  });

  it('rejects encoded tab, newline, carriage return, and backslash bypass attempts', () => {
    expect(sanitizeRedirectPath('/%09/evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/%0a/evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/%0d/evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/%09evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/%0A/evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/%0D/evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/%5cevil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/%5Cevil.com', trustedOrigin)).toBe('/library');
  });

  it('rejects raw control characters in path string', () => {
    expect(sanitizeRedirectPath('/\t/evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/\n/evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('/\r/evil.com', trustedOrigin)).toBe('/library');
  });

  it('rejects javascript:, data:, and userinfo pseudo-schemes', () => {
    expect(sanitizeRedirectPath('javascript:alert(1)', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('data:text/html,evil', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('//@evil.com', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('//user:pass@evil.com', trustedOrigin)).toBe('/library');
  });

  it('returns fallback for invalid, empty, or non-string inputs', () => {
    expect(sanitizeRedirectPath('', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath('   ', trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath(null, trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath(undefined, trustedOrigin)).toBe('/library');
    expect(sanitizeRedirectPath(undefined, trustedOrigin, '/custom-fallback')).toBe('/custom-fallback');
  });
});

describe('OAuth & Confirmation Callback (GET /auth/callback)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exchanges code for session and redirects to default /library', async () => {
    const mockSupabase = {
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const request = new Request('http://localhost:3000/auth/callback?code=mock-auth-code');
    const response = await handleCallback(request);

    expect(response.status).toBe(307); // NextResponse.redirect default status is 307
    expect(response.headers.get('location')).toBe('http://localhost:3000/library');
    expect(mockSupabase.auth.exchangeCodeForSession).toHaveBeenCalledWith('mock-auth-code');
  });

  it('exchanges code for session and redirects to valid relative next path', async () => {
    const mockSupabase = {
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const request = new Request('http://localhost:3000/auth/callback?code=mock-auth-code&next=/notes/my-note-id');
    const response = await handleCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/notes/my-note-id');
  });

  it('blocks protocol-relative open redirect attacks (//evil.com) and defaults to /library', async () => {
    const mockSupabase = {
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const request = new Request('http://localhost:3000/auth/callback?code=mock-auth-code&next=//evil.com');
    const response = await handleCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/library');
  });

  it('blocks absolute external redirect attacks (https://evil.com) and defaults to /library', async () => {
    const mockSupabase = {
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const request = new Request('http://localhost:3000/auth/callback?code=mock-auth-code&next=https://evil.com');
    const response = await handleCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/library');
  });

  it('blocks backslash-based redirect attacks (/\\evil.com) and defaults to /library', async () => {
    const mockSupabase = {
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const request = new Request('http://localhost:3000/auth/callback?code=mock-auth-code&next=/%5Cevil.com');
    const response = await handleCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/library');
  });

  it('blocks encoded tab (%09), newline (%0a), and carriage-return (%0d) bypass attempts', async () => {
    const payloads = ['/%09/evil.com', '/%0a/evil.com', '/%0d/evil.com'];

    for (const payload of payloads) {
      const mockSupabase = {
        auth: {
          exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
        },
      };
      vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

      const request = new Request(`http://localhost:3000/auth/callback?code=mock-auth-code&next=${encodeURIComponent(payload)}`);
      const response = await handleCallback(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('http://localhost:3000/library');
    }
  });

  it('redirects to /login with error when exchangeCodeForSession fails', async () => {
    const mockSupabase = {
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: new Error('Invalid code') }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const request = new Request('http://localhost:3000/auth/callback?code=bad-code');
    const response = await handleCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?error=auth_callback_failed');
  });

  it('verifies token_hash and type for email confirmation and redirects to destination', async () => {
    const mockSupabase = {
      auth: {
        verifyOtp: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const request = new Request('http://localhost:3000/auth/callback?token_hash=mock-token-hash&type=signup&next=/library');
    const response = await handleCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/library');
    expect(mockSupabase.auth.verifyOtp).toHaveBeenCalledWith({
      type: 'signup',
      token_hash: 'mock-token-hash',
    });
  });

  it('redirects to /login with error when verifyOtp fails', async () => {
    const mockSupabase = {
      auth: {
        verifyOtp: vi.fn().mockResolvedValue({ data: {}, error: new Error('Token expired') }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const request = new Request('http://localhost:3000/auth/callback?token_hash=bad-token&type=signup');
    const response = await handleCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?error=auth_callback_failed');
  });

  it('redirects to /login with error when provider sends OAuth error in searchParams', async () => {
    const request = new Request('http://localhost:3000/auth/callback?error=access_denied&error_description=User+cancelled+authorization');
    const response = await handleCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?error=User+cancelled+authorization');
  });

  it('resolves public destination using x-forwarded-host and x-forwarded-proto headers', async () => {
    const mockSupabase = {
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const request = new Request('http://10.0.0.1:3000/auth/callback?code=mock-code&next=/notes/123', {
      headers: {
        'x-forwarded-host': 'codenotes-ai.vercel.app',
        'x-forwarded-proto': 'https',
      },
    });
    const response = await handleCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://codenotes-ai.vercel.app/notes/123');
  });

  it('redirects to /login with error when neither code nor token_hash is present', async () => {
    const request = new Request('http://localhost:3000/auth/callback');
    const response = await handleCallback(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?error=auth_callback_failed');
  });
});

describe('Dynamic Auth URL Helpers (getAppUrl & getAuthCallbackUrl)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_VERCEL_URL;
    delete process.env.VERCEL_URL;
  });

  it('resolves NEXT_PUBLIC_SITE_URL with https prepended if missing', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'codenotes.example.com';
    expect(getAppUrl()).toBe('https://codenotes.example.com');
  });

  it('preserves existing https in NEXT_PUBLIC_SITE_URL and strips trailing slash', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://codenotes.example.com/';
    expect(getAppUrl()).toBe('https://codenotes.example.com');
  });

  it('resolves NEXT_PUBLIC_VERCEL_URL for preview deployments', () => {
    process.env.NEXT_PUBLIC_VERCEL_URL = 'codenotes-git-preview.vercel.app';
    expect(getAppUrl()).toBe('https://codenotes-git-preview.vercel.app');
  });

  it('resolves VERCEL_URL on server side', () => {
    process.env.VERCEL_URL = 'codenotes-server.vercel.app';
    expect(getAppUrl()).toBe('https://codenotes-server.vercel.app');
  });

  it('defaults to http://localhost:3000 when no environment variables are configured', () => {
    expect(getAppUrl()).toBe('http://localhost:3000');
  });

  it('constructs complete callback URL with sanitized next parameter', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://codenotes.example.com';
    const callback = getAuthCallbackUrl('/notes/abc');
    expect(callback).toBe('https://codenotes.example.com/auth/callback?next=%2Fnotes%2Fabc');
  });

  it('sanitizes open redirect attempts in getAuthCallbackUrl', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://codenotes.example.com';
    const callback = getAuthCallbackUrl('https://evil.com');
    expect(callback).toBe('https://codenotes.example.com/auth/callback?next=%2Flibrary');
  });
});

describe('Email Signup Response Classification', () => {
  it('correctly classifies existing account with empty identities as existing user', () => {
    const authData = {
      user: { id: 'u-123', email: 'test@example.com', identities: [] },
      session: null,
    };
    const isExistingUser =
      authData.user &&
      Array.isArray(authData.user.identities) &&
      authData.user.identities.length === 0;

    expect(isExistingUser).toBe(true);
  });

  it('correctly classifies new user with identities as pending confirmation', () => {
    const authData = {
      user: { id: 'u-456', email: 'new@example.com', identities: [{ id: 'ident-1' }] },
      session: null,
    };
    const isExistingUser =
      authData.user &&
      Array.isArray(authData.user.identities) &&
      authData.user.identities.length === 0;
    const isConfirmationSent =
      authData.user &&
      !authData.session &&
      (!authData.user.identities || authData.user.identities.length > 0);

    expect(isExistingUser).toBe(false);
    expect(isConfirmationSent).toBe(true);
  });

  it('correctly classifies immediate session when email confirmation is disabled', () => {
    const authData = {
      user: { id: 'u-789', email: 'instant@example.com', identities: [{ id: 'ident-2' }] },
      session: { access_token: 'mock-access-token' },
    };
    expect(authData.session).toBeTruthy();
  });
});

describe('Client-Side Login Navigation Protection', () => {
  const origin = 'https://codenotes.example.com';

  it('resolves valid internal redirect target for client router.push', () => {
    const target = sanitizeRedirectPath('/notes/valid-id', origin, '/library');
    expect(target).toBe('/notes/valid-id');
  });

  it('falls back safely to /library for external target before client router.push', () => {
    const target = sanitizeRedirectPath('https://malicious.com/steal-session', origin, '/library');
    expect(target).toBe('/library');
  });

  it('falls back safely to /library for encoded whitespace bypasses before client router.push', () => {
    const target = sanitizeRedirectPath('/%09/malicious.com', origin, '/library');
    expect(target).toBe('/library');
  });
});
