import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStartSpan, mockSetHttpStatus, capturedSpans, mockClient } = vi.hoisted(() => {
  const capturedSpans: any[] = [];
  const mockClient = {
    flush: vi.fn().mockResolvedValue(true),
  };
  const mockStartSpan = vi.fn((options: any, callback: any) => {
    const spanObj: any = {
      name: options.name,
      op: options.op,
      parentSpan: options.parentSpan,
      attributes: { ...options.attributes },
      status: undefined as any,
      setAttribute(k: string, v: any) {
        this.attributes[k] = v;
        return this;
      },
      setAttributes(attrs: any) {
        Object.assign(this.attributes, attrs);
        return this;
      },
      setStatus(s: any) {
        this.status = s;
        return this;
      },
      end() {},
    };
    capturedSpans.push(spanObj);
    return callback(spanObj);
  });
  const mockSetHttpStatus = vi.fn((span: any, status: number) => {
    if (span && span.setAttribute) {
      span.setAttribute('http.response.status_code', status);
    }
  });
  return { mockStartSpan, mockSetHttpStatus, capturedSpans, mockClient };
});

vi.mock('@sentry/nextjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/nextjs')>();
  return {
    ...actual,
    startSpan: mockStartSpan,
    setHttpStatus: mockSetHttpStatus,
    getClient: vi.fn(() => mockClient),
  };
});

vi.mock('youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
  fetchTranscript: vi.fn(),
}));

import {
  isAllowedSpanAttribute,
  filterSafeAttributes,
  createSafeSentrySpan,
  serverTracesSampler,
  extractRoutePath,
  sanitizeSpan,
  TARGET_INSTRUMENTED_ROUTES,
  EXCLUDED_TRACING_ROUTES,
} from '@/lib/sentry-tracing';
import { GET as getNotes } from '@/app/api/notes/route';
import { GET as getNoteById, DELETE as deleteNoteById } from '@/app/api/notes/[id]/route';
import { POST as postGenerate } from '@/app/api/generate/route';
import * as db from '@/lib/db';
import * as auth from '@/lib/auth';
import * as rateLimit from '@/lib/rate-limit';
import * as inngestClient from '@/inngest/client';

describe('Sentry Tracing & API Observability (Step 10B)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    capturedSpans.length = 0;
  });

  describe('1. Attribute Allowlist & Privacy Validation', () => {
    it('approves legitimate operational and query attributes', () => {
      expect(isAllowedSpanAttribute('http.method', 'GET')).toBe(true);
      expect(isAllowedSpanAttribute('http.method', 'POST')).toBe(true);
      expect(isAllowedSpanAttribute('http.method', 'DELETE')).toBe(true);
      expect(isAllowedSpanAttribute('http.route', '/api/notes')).toBe(true);
      expect(isAllowedSpanAttribute('http.route', '/api/notes/[id]')).toBe(true);
      expect(isAllowedSpanAttribute('http.route', '/api/generate')).toBe(true);
      expect(isAllowedSpanAttribute('http.status_code', 200)).toBe(true);
      expect(isAllowedSpanAttribute('http.status_code', 404)).toBe(true);
      expect(isAllowedSpanAttribute('http.status_code', 500)).toBe(true);
      expect(isAllowedSpanAttribute('notes.sort_field', 'created_at')).toBe(true);
      expect(isAllowedSpanAttribute('notes.sort_field', 'video_title')).toBe(true);
      expect(isAllowedSpanAttribute('notes.sort_order', 'asc')).toBe(true);
      expect(isAllowedSpanAttribute('notes.sort_order', 'desc')).toBe(true);
      expect(isAllowedSpanAttribute('notes.is_search_applied', true)).toBe(true);
      expect(isAllowedSpanAttribute('notes.has_cursor', false)).toBe(true);
      expect(isAllowedSpanAttribute('notes.returned_count', 25)).toBe(true);
      expect(isAllowedSpanAttribute('rate_limit.allowed', true)).toBe(true);
      expect(isAllowedSpanAttribute('operation.status', 'replayed')).toBe(true);
      expect(isAllowedSpanAttribute('error.type', 'UnauthorizedError')).toBe(true);
    });

    it('strictly rejects prohibited identifiers, credentials, and sensitive payload keys', () => {
      const prohibitedKeys = [
        'user_id',
        'userId',
        'user',
        'email',
        'note_id',
        'noteId',
        'notes',
        'video_id',
        'videoId',
        'video_url',
        'url',
        'token',
        'apiKey',
        'api_key',
        'secret',
        'password',
        'cookie',
        'authorization',
        'prompt',
        'transcript',
        'transcript_text',
        'detailed_notes',
        'key_concepts',
        'overview',
        'search',
        'cursor',
        'idempotency_key',
        'idempotencyKey',
      ];

      for (const key of prohibitedKeys) {
        expect(isAllowedSpanAttribute(key, 'val')).toBe(false);
        expect(isAllowedSpanAttribute(key, 123)).toBe(false);
        expect(isAllowedSpanAttribute(key, true)).toBe(false);
      }
    });

    it('rejects invalid or malformed values for allowed keys', () => {
      // Invalid HTTP method
      expect(isAllowedSpanAttribute('http.method', 'INVALID')).toBe(false);
      expect(isAllowedSpanAttribute('http.method', 123)).toBe(false);

      // Route containing query string or fragments
      expect(isAllowedSpanAttribute('http.route', '/api/notes?user_id=123')).toBe(false);

      // Status code out of range
      expect(isAllowedSpanAttribute('http.status_code', 99)).toBe(false);
      expect(isAllowedSpanAttribute('http.status_code', 600)).toBe(false);
      expect(isAllowedSpanAttribute('http.status_code', '200')).toBe(false);

      // Sort field out of range
      expect(isAllowedSpanAttribute('notes.sort_field', 'password')).toBe(false);
      expect(isAllowedSpanAttribute('notes.sort_order', 'random')).toBe(false);

      // Negative returned count
      expect(isAllowedSpanAttribute('notes.returned_count', -1)).toBe(false);

      // Non-boolean flags
      expect(isAllowedSpanAttribute('notes.is_search_applied', 'yes')).toBe(false);
      expect(isAllowedSpanAttribute('rate_limit.allowed', 1)).toBe(false);
    });

    it('filterSafeAttributes filters out prohibited fields', () => {
      const dirty = {
        'http.method': 'GET',
        'http.route': '/api/notes',
        'user_id': 'secret-uuid',
        'notes.returned_count': 10,
        'search': 'react hooks tutorial',
        'cursor': 'encoded_cursor_value',
        'apiKey': 'AIzaSy1234567890',
      };

      const clean = filterSafeAttributes(dirty);
      expect(clean).toEqual({
        'http.method': 'GET',
        'http.route': '/api/notes',
        'notes.returned_count': 10,
      });
      expect(clean).not.toHaveProperty('user_id');
      expect(clean).not.toHaveProperty('search');
      expect(clean).not.toHaveProperty('cursor');
      expect(clean).not.toHaveProperty('apiKey');
    });

    it('createSafeSentrySpan drops prohibited setAttribute calls', () => {
      const rawSpan: any = {
        attributes: {} as Record<string, any>,
        setAttribute(k: string, v: any) {
          this.attributes[k] = v;
          return this;
        },
        setAttributes(attrs: Record<string, any>) {
          Object.assign(this.attributes, attrs);
          return this;
        },
      };

      const safe = createSafeSentrySpan(rawSpan);
      safe.setAttribute('http.status_code', 200);
      safe.setAttribute('user_id', 'user_123');
      safe.setAttribute('videoId', 'dQw4w9WgXcQ');
      safe.setAttribute('notes.returned_count', 5);

      expect(rawSpan.attributes).toEqual({
        'http.status_code': 200,
        'notes.returned_count': 5,
      });
      expect(rawSpan.attributes).not.toHaveProperty('user_id');
      expect(rawSpan.attributes).not.toHaveProperty('videoId');
    });
  });

  describe('2. Sampling Policy (serverTracesSampler)', () => {
    it('extractRoutePath correctly parses HTTP method and path while stripping query and hash', () => {
      expect(extractRoutePath('GET /api/health')).toBe('/api/health');
      expect(extractRoutePath('POST /api/inngest')).toBe('/api/inngest');
      expect(extractRoutePath('/auth/callback')).toBe('/auth/callback');
      expect(extractRoutePath('GET /api/health?probe=1#fragment')).toBe('/api/health');
      expect(extractRoutePath('DELETE /api/notes/[id]')).toBe('/api/notes/[id]');
      expect(extractRoutePath('db.query_notes_keyset')).toBeNull();
      expect(extractRoutePath('')).toBeNull();
      expect(extractRoutePath(undefined)).toBeNull();
    });

    it('samples high-value instrumented routes at approximately 10% (0.1) when parentSampled is undefined', () => {
      for (const routeName of TARGET_INSTRUMENTED_ROUTES) {
        const rate = serverTracesSampler({ name: routeName });
        expect(rate).toBe(0.1);
      }

      // Explicit verification for targeted routes and methods
      expect(serverTracesSampler({ name: 'GET /api/notes' })).toBe(0.1);
      expect(serverTracesSampler({ name: 'GET /api/notes/[id]' })).toBe(0.1);
      expect(serverTracesSampler({ name: 'DELETE /api/notes/[id]' })).toBe(0.1);
      expect(serverTracesSampler({ name: 'POST /api/generate' })).toBe(0.1);

      // Attribute-based route matching
      expect(
        serverTracesSampler({
          name: 'handler',
          attributes: { 'http.route': '/api/notes', 'http.method': 'GET' },
        })
      ).toBe(0.1);
      expect(
        serverTracesSampler({
          name: 'POST /api/notes',
          attributes: { 'http.route': '/api/notes', 'http.method': 'POST' },
        })
      ).toBe(0.1);
    });

    it('samples when route attribute is present in sampling context without parent decision', () => {
      const rate = serverTracesSampler({
        name: 'handler',
        attributes: { 'http.route': '/api/notes' },
      });
      expect(rate).toBe(0.1);

      const genRate = serverTracesSampler({
        name: 'handler',
        attributes: { 'http.route': '/api/generate' },
      });
      expect(genRate).toBe(0.1);
    });

    it('returns 0 for excluded routes (/api/health, /api/metrics, /api/inngest, /auth/callback) without parent decision', () => {
      for (const excluded of EXCLUDED_TRACING_ROUTES) {
        expect(serverTracesSampler({ name: `GET ${excluded}` })).toBe(0);
        expect(
          serverTracesSampler({
            name: 'generic',
            attributes: { 'http.route': excluded },
          })
        ).toBe(0);
      }
    });

    it('unconditionally returns 0 for exact excluded routes even when parentSampled is true (regression check)', () => {
      for (const excluded of EXCLUDED_TRACING_ROUTES) {
        expect(serverTracesSampler({ name: `GET ${excluded}`, parentSampled: true })).toBe(0);
        expect(serverTracesSampler({ name: `POST ${excluded}`, parentSampled: true })).toBe(0);
        expect(serverTracesSampler({ name: `GET ${excluded}?probe=true#1`, parentSampled: true })).toBe(0);
        expect(
          serverTracesSampler({
            name: 'probe',
            attributes: { 'http.route': excluded },
            parentSampled: true,
          })
        ).toBe(0);
        expect(
          serverTracesSampler({
            name: 'probe',
            attributes: { 'http.route': `${excluded}?check=1` },
            parentSampled: true,
          })
        ).toBe(0);
      }
    });

    it('does NOT mistake similar route names such as /api/healthcheck or /api/metrics-exporter for excluded routes', () => {
      // Non-excluded similar route honors parentSampled: true
      expect(serverTracesSampler({ name: 'GET /api/healthcheck', parentSampled: true })).toBe(true);
      expect(serverTracesSampler({ name: 'GET /api/healthcheck', parentSampled: false })).toBe(false);
      // Non-excluded similar route without parent decision defaults to 0 (since it's not a target instrumented route)
      expect(serverTracesSampler({ name: 'GET /api/healthcheck' })).toBe(0);

      // Attribute matching precision
      expect(
        serverTracesSampler({
          name: 'probe',
          attributes: { 'http.route': '/api/healthcheck' },
          parentSampled: true,
        })
      ).toBe(true);
      expect(
        serverTracesSampler({
          name: 'probe',
          attributes: { 'http.route': '/api/metrics-exporter' },
          parentSampled: true,
        })
      ).toBe(true);
      expect(
        serverTracesSampler({
          name: 'probe',
          attributes: { 'http.route': '/api/inngest-worker' },
          parentSampled: true,
        })
      ).toBe(true);
    });

    it('returns 0 for excluded routes when parentSampled is false', () => {
      for (const excluded of EXCLUDED_TRACING_ROUTES) {
        expect(serverTracesSampler({ name: `GET ${excluded}`, parentSampled: false })).toBe(0);
        expect(
          serverTracesSampler({
            name: 'probe',
            attributes: { 'http.route': excluded },
            parentSampled: false,
          })
        ).toBe(0);
      }
    });

    it('honors explicit inherited sampling decision for non-excluded routes', () => {
      // GET /api/notes honors parentSampled
      expect(serverTracesSampler({ name: 'GET /api/notes', parentSampled: true })).toBe(true);
      expect(serverTracesSampler({ name: 'GET /api/notes', parentSampled: false })).toBe(false);
      expect(serverTracesSampler({ name: 'GET /api/notes?cursor=abc#top', parentSampled: false })).toBe(false);
      expect(
        serverTracesSampler({
          name: 'handler',
          attributes: { 'http.route': '/api/notes', 'http.method': 'GET' },
          parentSampled: true,
        })
      ).toBe(true);
      expect(
        serverTracesSampler({
          name: 'handler',
          attributes: { 'http.route': '/api/notes', 'http.method': 'GET' },
          parentSampled: false,
        })
      ).toBe(false);

      // GET /api/notes/[id] with parentSampled: false remains unsampled
      expect(serverTracesSampler({ name: 'GET /api/notes/[id]', parentSampled: false })).toBe(false);
      expect(
        serverTracesSampler({
          name: 'handler',
          attributes: { 'http.route': '/api/notes/[id]', 'http.method': 'GET' },
          parentSampled: false,
        })
      ).toBe(false);
      expect(serverTracesSampler({ name: 'GET /api/notes/[id]', parentSampled: true })).toBe(true);

      // DELETE /api/notes/[id] with parentSampled: false remains unsampled
      expect(serverTracesSampler({ name: 'DELETE /api/notes/[id]', parentSampled: false })).toBe(false);
      expect(serverTracesSampler({ name: 'DELETE /api/notes/[id]', parentSampled: true })).toBe(true);

      // POST /api/generate preserves inherited sampling
      expect(
        serverTracesSampler({
          name: 'handler',
          attributes: { 'http.route': '/api/generate' },
          parentSampled: true,
        })
      ).toBe(true);
      expect(
        serverTracesSampler({
          name: 'handler',
          attributes: { 'http.route': '/api/generate' },
          parentSampled: false,
        })
      ).toBe(false);

      // Non-GET method on /api/notes preserves inherited sampling
      expect(
        serverTracesSampler({
          name: 'POST /api/notes',
          attributes: { 'http.route': '/api/notes', 'http.method': 'POST' },
          parentSampled: false,
        })
      ).toBe(false);
      expect(
        serverTracesSampler({
          name: 'POST /api/notes',
          attributes: { 'http.route': '/api/notes', 'http.method': 'POST' },
          parentSampled: true,
        })
      ).toBe(true);
    });

    it('returns 0 for un-instrumented or unknown routes', () => {
      expect(serverTracesSampler({ name: 'GET /api/unknown' })).toBe(0);
      expect(serverTracesSampler({ name: 'GET /random-page' })).toBe(0);
      expect(
        serverTracesSampler({
          name: 'POST /unknown',
          attributes: { 'http.route': '/unknown' },
        })
      ).toBe(0);
    });
  });

  describe('3. Outgoing Span Sanitization (sanitizeSpan)', () => {
    it('redacts dynamic UUIDs from span name to maintain low cardinality', () => {
      const span = {
        name: 'GET /api/notes/550e8400-e29b-41d4-a716-446655440000',
        attributes: {
          'http.route': '/api/notes/[id]',
          'http.status_code': 200,
        },
      };

      const sanitized = sanitizeSpan(span);
      expect(sanitized.name).toBe('GET /api/notes/[id]');
    });

    it('strips non-allowlisted and prohibited attributes from outgoing spans', () => {
      const span = {
        name: 'GET /api/notes',
        attributes: {
          'sentry.op': 'http.server',
          'sentry.origin': 'manual',
          'http.method': 'GET',
          'http.route': '/api/notes',
          'http.status_code': 200,
          'user_id': 'secret_123',
          'videoId': 'dQw4w9WgXcQ',
          'random_unapproved': 'drop_me',
          'device.memory': 1024,
        },
      };

      const sanitized = sanitizeSpan(span);
      expect(sanitized.attributes).toEqual({
        'sentry.op': 'http.server',
        'sentry.origin': 'manual',
        'http.method': 'GET',
        'http.route': '/api/notes',
        'http.status_code': 200,
        'device.memory': 1024,
      });
      expect(sanitized.attributes).not.toHaveProperty('user_id');
      expect(sanitized.attributes).not.toHaveProperty('videoId');
      expect(sanitized.attributes).not.toHaveProperty('random_unapproved');
    });
  });

  describe('4. Route Handler Instrumentation & Span Generation', () => {
    it('GET /api/notes executes with root span, auth child span, and db child span', async () => {
      vi.spyOn(auth, 'requireUser').mockResolvedValue({ id: 'user-uuid-123' } as any);
      vi.spyOn(db, 'query').mockResolvedValue({
        rows: [
          {
            id: 'note-1',
            video_id: 'vid-1',
            video_title: 'TypeScript Crash Course',
            thumbnail_url: null,
            overview: 'Overview content',
            created_at: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      } as any);

      const request = new Request('http://localhost/api/notes?limit=10&sort=created_at&order=desc');
      const response = await getNotes(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.notes).toHaveLength(1);

      // Verify created spans
      const spanNames = capturedSpans.map((s) => s.name);
      expect(spanNames).toContain('GET /api/notes');
      expect(spanNames).toContain('auth.require_user');
      expect(spanNames).toContain('db.query_notes_keyset');

      // Verify root span metadata
      const rootSpan = capturedSpans.find((s) => s.name === 'GET /api/notes');
      expect(rootSpan).toBeDefined();
      expect(rootSpan.attributes['http.method']).toBe('GET');
      expect(rootSpan.attributes['http.route']).toBe('/api/notes');
      expect(rootSpan.attributes['http.status_code']).toBe(200);
      expect(rootSpan.attributes['notes.sort_field']).toBe('created_at');
      expect(rootSpan.attributes['notes.sort_order']).toBe('desc');
      expect(rootSpan.attributes['notes.has_cursor']).toBe(false);
      expect(rootSpan.attributes['notes.returned_count']).toBe(1);

      // Verify explicit parent linking
      const authChild = capturedSpans.find((s) => s.name === 'auth.require_user');
      const dbChild = capturedSpans.find((s) => s.name === 'db.query_notes_keyset');
      expect(authChild.parentSpan).toBe(rootSpan);
      expect(dbChild.parentSpan).toBe(rootSpan);

      // Verify privacy: no user IDs, cursors, or raw payloads in span attributes
      expect(rootSpan.attributes).not.toHaveProperty('user_id');
      expect(rootSpan.attributes).not.toHaveProperty('cursor');
    });

    it('GET /api/notes/[id] creates root span and db.query_note_by_id without leaking note ID', async () => {
      vi.spyOn(auth, 'requireUser').mockResolvedValue({ id: 'user-uuid-123' } as any);
      vi.spyOn(db, 'query').mockResolvedValue({
        rows: [
          {
            id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            user_id: 'user-uuid-123',
            video_id: 'vid-99',
            video_title: 'Algorithms',
            video_url: 'https://youtube.com/watch?v=vid-99',
            thumbnail_url: null,
            overview: 'Summary',
            key_concepts: [],
            detailed_notes: 'Details',
            shorthands: [],
            created_at: new Date('2026-01-01'),
          },
        ],
      } as any);

      const request = new Request('http://localhost/api/notes/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      const response = await getNoteById(request, {
        params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
      });

      expect(response.status).toBe(200);

      const spanNames = capturedSpans.map((s) => s.name);
      expect(spanNames).toContain('GET /api/notes/[id]');
      expect(spanNames).toContain('auth.require_user');
      expect(spanNames).toContain('db.query_note_by_id');

      const rootSpan = capturedSpans.find((s) => s.name === 'GET /api/notes/[id]');
      expect(rootSpan.name).toBe('GET /api/notes/[id]');
      expect(rootSpan.attributes['http.method']).toBe('GET');
      expect(rootSpan.attributes['http.route']).toBe('/api/notes/[id]');
      expect(rootSpan.attributes['http.status_code']).toBe(200);

      // Verify explicit parent linking
      const authChild = capturedSpans.find((s) => s.name === 'auth.require_user');
      const dbChild = capturedSpans.find((s) => s.name === 'db.query_note_by_id');
      expect(authChild.parentSpan).toBe(rootSpan);
      expect(dbChild.parentSpan).toBe(rootSpan);

      // Verify that the note ID UUID is NOT in root span name or attributes
      expect(rootSpan.name).not.toContain('aaaaaaaa-aaaa');
      expect(rootSpan.attributes).not.toHaveProperty('note_id');
      expect(rootSpan.attributes).not.toHaveProperty('id');
    });

    it('DELETE /api/notes/[id] creates root span and db.delete_note', async () => {
      vi.spyOn(auth, 'requireUser').mockResolvedValue({ id: 'user-uuid-123' } as any);
      vi.spyOn(db, 'query').mockResolvedValue({ rowCount: 1 } as any);

      const request = new Request('http://localhost/api/notes/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', {
        method: 'DELETE',
      });
      const response = await deleteNoteById(request, {
        params: Promise.resolve({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
      });

      expect(response.status).toBe(200);

      const spanNames = capturedSpans.map((s) => s.name);
      expect(spanNames).toContain('DELETE /api/notes/[id]');
      expect(spanNames).toContain('auth.require_user');
      expect(spanNames).toContain('db.delete_note');

      const rootSpan = capturedSpans.find((s) => s.name === 'DELETE /api/notes/[id]');
      expect(rootSpan.attributes['http.status_code']).toBe(200);

      // Verify explicit parent linking
      const authChild = capturedSpans.find((s) => s.name === 'auth.require_user');
      const dbChild = capturedSpans.find((s) => s.name === 'db.delete_note');
      expect(authChild.parentSpan).toBe(rootSpan);
      expect(dbChild.parentSpan).toBe(rootSpan);
    });

    it('POST /api/generate instruments rate_limit, idempotency lookup, and inngest.send', async () => {
      vi.spyOn(auth, 'requireUser').mockResolvedValue({ id: 'user-123' } as any);
      vi.spyOn(rateLimit, 'checkRateLimit').mockResolvedValue({
        allowed: true,
        limit: 5,
        remaining: 4,
        resetSeconds: 60,
        currentCount: 1,
      });
      vi.spyOn(db, 'query').mockResolvedValue({ rows: [] } as any); // No existing job
      vi.spyOn(inngestClient.inngest, 'send').mockResolvedValue({} as any);

      const request = new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
      });

      const response = await postGenerate(request);
      expect(response.status).toBe(202);

      const spanNames = capturedSpans.map((s) => s.name);
      expect(spanNames).toContain('POST /api/generate');
      expect(spanNames).toContain('auth.require_user');
      expect(spanNames).toContain('rate_limit.check');
      expect(spanNames).toContain('db.idempotency_lookup');
      expect(spanNames).toContain('inngest.send_event');

      const rootSpan = capturedSpans.find((s) => s.name === 'POST /api/generate');
      expect(rootSpan.attributes['http.method']).toBe('POST');
      expect(rootSpan.attributes['http.route']).toBe('/api/generate');
      expect(rootSpan.attributes['http.status_code']).toBe(202);
      expect(rootSpan.attributes['operation.status']).toBe('job_queued');

      // Verify explicit parent linking across all child spans
      const authChild = capturedSpans.find((s) => s.name === 'auth.require_user');
      const rateLimitChild = capturedSpans.find((s) => s.name === 'rate_limit.check');
      const dbChild = capturedSpans.find((s) => s.name === 'db.idempotency_lookup');
      const inngestChild = capturedSpans.find((s) => s.name === 'inngest.send_event');
      expect(authChild.parentSpan).toBe(rootSpan);
      expect(rateLimitChild.parentSpan).toBe(rootSpan);
      expect(dbChild.parentSpan).toBe(rootSpan);
      expect(inngestChild.parentSpan).toBe(rootSpan);

      // Verify no sensitive fields in attributes
      expect(rootSpan.attributes).not.toHaveProperty('url');
      expect(rootSpan.attributes).not.toHaveProperty('videoId');
      expect(rootSpan.attributes).not.toHaveProperty('user_id');
    });

    it('early return (401 Unauthorized) marks root span status correctly and finishes span', async () => {
      vi.spyOn(auth, 'requireUser').mockRejectedValue(new auth.UnauthorizedError('No session token'));

      const request = new Request('http://localhost/api/notes');
      const response = await getNotes(request);
      expect(response.status).toBe(401);

      const rootSpan = capturedSpans.find((s) => s.name === 'GET /api/notes');
      expect(rootSpan).toBeDefined();
      expect(rootSpan.attributes['http.status_code']).toBe(401);
    });
  });
});
