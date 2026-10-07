import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireUser, getOptionalUser, UnauthorizedError } from '@/lib/auth';
import { GET as handleCallback } from '@/app/auth/callback/route';
import * as serverSupabase from '@/lib/supabase/server';

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

  it('blocks open redirect attacks (//evil.com) and defaults to /library', async () => {
    const mockSupabase = {
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
    };
    vi.mocked(serverSupabase.createClient).mockResolvedValueOnce(mockSupabase as any);

    const request = new Request('http://localhost:3000/auth/callback?code=mock-auth-code&next=//evil.com');
    const response = await handleCallback(request);

    expect(response.headers.get('location')).toBe('http://localhost:3000/library');
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

    expect(response.headers.get('location')).toBe('http://localhost:3000/login?error=auth_callback_failed');
  });
});
