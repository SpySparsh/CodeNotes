import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireUser, getOptionalUser, UnauthorizedError } from '@/lib/auth';
import { GET as handleCallback } from '@/app/auth/callback/route';
import * as serverSupabase from '@/lib/supabase/server';
import { sanitizeRedirectPath } from '@/lib/auth/redirect';

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
