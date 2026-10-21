import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger';
import { GET as getNotes } from '@/app/api/notes/route';
import { GET as getHealth } from '@/app/api/health/route';
import { GET as getMetrics } from '@/app/api/metrics/route';
import * as db from '@/lib/db';
import * as auth from '@/lib/auth';

const { generateContentMock, getGenerativeModelMock } = vi.hoisted(() => {
  const generateContentMock = vi.fn();
  const getGenerativeModelMock = vi.fn(() => ({
    generateContent: generateContentMock,
  }));
  return { generateContentMock, getGenerativeModelMock };
});

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel = getGenerativeModelMock;
    },
    SchemaType: {
      OBJECT: 'OBJECT',
      STRING: 'STRING',
      ARRAY: 'ARRAY',
    },
  };
});

vi.mock('@/lib/db', () => ({
  query: vi.fn(),
  withUserTransaction: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {
    constructor(msg = 'Unauthorized') {
      super(msg);
      this.name = 'UnauthorizedError';
    }
  },
}));

vi.mock('youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
  fetchTranscript: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  withScope: vi.fn((cb: any) => cb({ setTag: vi.fn() })),
  captureException: vi.fn(),
  captureRequestError: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  getClient: vi.fn(() => null),
  init: vi.fn(),
  startSpan: vi.fn((_opts: any, cb: any) =>
    cb({
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    })
  ),
  setHttpStatus: vi.fn(),
}));

import { generateNotes, GEMINI_MODEL } from '@/lib/gemini';
import { generateNotesFunction } from '@/inngest/functions/generate-notes';

describe('Log Privacy Remediation & Leakage Prevention', () => {
  let loggedEntries: any[] = [];
  let consoleLogSpy: any;
  let consoleWarnSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    loggedEntries = [];

    const intercept = (rawJson: string) => {
      try {
        loggedEntries.push(JSON.parse(rawJson));
      } catch {
        loggedEntries.push(rawJson);
      }
    };

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(intercept);
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(intercept);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(intercept);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('A. Inngest generation function start logging', () => {
    it('does NOT log the raw submitted YouTube URL or query/token fragments', async () => {
      const sensitiveUrl =
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&secret_token=TOP_SECRET_AUTH_PARAM_XYZ&list=PL12345';
      const mockUserId = 'usr-123e4567-e89b-12d3-a456-426614174000';
      const mockIdempotencyKey = 'idemp-secret-key-123';
      const mockVideoId = 'dQw4w9WgXcQ';

      const mockEvent = {
        data: {
          userId: mockUserId,
          idempotencyKey: mockIdempotencyKey,
          videoId: mockVideoId,
          videoUrl: sensitiveUrl,
        },
      };

      const mockStep = {
        run: vi.fn(async () => {
          // Short-circuit step 1 claim to stop further downstream execution
          return { claimed: false, skipped: true, noteId: 'existing-note-id' };
        }),
      };

      const fnHandler = (generateNotesFunction as any).fn;
      await fnHandler({ event: mockEvent, step: mockStep });

      const startLog = loggedEntries.find(
        (e) => e.event === 'inngest_generation_function_started'
      );

      expect(startLog).toBeDefined();
      expect(startLog.userId).toBe(mockUserId);
      expect(startLog.idempotencyKey).toBe(mockIdempotencyKey);
      expect(startLog.videoId).toBe(mockVideoId);

      // Verify videoUrl is completely absent and raw sensitive tokens never appear
      expect(startLog.videoUrl).toBeUndefined();
      const serialized = JSON.stringify(startLog);
      expect(serialized).not.toContain('TOP_SECRET_AUTH_PARAM_XYZ');
      expect(serialized).not.toContain(sensitiveUrl);
      expect(serialized).not.toContain('watch?v=');
    });
  });

  describe('B. Notes list completion logging', () => {
    it('does NOT log the raw search query and replaces it with hasSearch boolean flag', async () => {
      const sensitiveSearchQuery = 'CONFIDENTIAL_FINANCIAL_RESEARCH_TOPIC_2026';
      const mockUserId = 'usr-123e4567-e89b-12d3-a456-426614174000';

      vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as any);

      const request = new Request(
        `http://localhost/api/notes?search=${encodeURIComponent(sensitiveSearchQuery)}&limit=10`
      );

      const response = await getNotes(request);
      expect(response.status).toBe(200);

      const completedLog = loggedEntries.find(
        (e) => e.event === 'get_notes_completed'
      );

      expect(completedLog).toBeDefined();
      expect(completedLog.userId).toBe(mockUserId);
      expect(completedLog.method).toBe('GET');
      expect(completedLog.path).toBe('/api/notes');
      expect(completedLog.hasSearch).toBe(true);

      // Verify raw search text is completely absent
      expect(completedLog.search).toBeUndefined();
      const serialized = JSON.stringify(completedLog);
      expect(serialized).not.toContain(sensitiveSearchQuery);
    });

    it('sets hasSearch to false when search parameter is omitted', async () => {
      const mockUserId = 'usr-123e4567-e89b-12d3-a456-426614174000';

      vi.mocked(auth.requireUser).mockResolvedValueOnce({ id: mockUserId } as any);
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      const request = new Request('http://localhost/api/notes');
      const response = await getNotes(request);
      expect(response.status).toBe(200);

      const completedLog = loggedEntries.find(
        (e) => e.event === 'get_notes_completed'
      );

      expect(completedLog).toBeDefined();
      expect(completedLog.hasSearch).toBe(false);
      expect(completedLog.search).toBeUndefined();
    });
  });

  describe('C. Gemini AI inference error logging', () => {
    it('does NOT log rawOutputPreview or model response fragments on JSON parse errors', async () => {
      const sensitiveModelOutput =
        'MALFORMED_OUTPUT_CONTAINING_PRIVATE_DATA_AND_STUDY_SECRETS_XYZ_12345';

      generateContentMock.mockResolvedValueOnce({
        response: {
          text: () => sensitiveModelOutput,
        },
      });

      await expect(
        generateNotes('Mock Transcript Content', 'Mock Video Title')
      ).rejects.toThrow('AI returned malformed data.');

      const parseErrorLog = loggedEntries.find(
        (e) => e.event === 'gemini_json_parse_failed'
      );

      expect(parseErrorLog).toBeDefined();
      expect(parseErrorLog.level).toBe('error');
      expect(parseErrorLog.errorMessage).toBeDefined();
      expect(parseErrorLog.outputLength).toBe(sensitiveModelOutput.length);

      // Verify rawOutputPreview is completely absent and raw model output is not leaked
      expect(parseErrorLog.rawOutputPreview).toBeUndefined();
      const serialized = JSON.stringify(parseErrorLog);
      expect(serialized).not.toContain(sensitiveModelOutput);
      expect(serialized).not.toContain('PRIVATE_DATA');
    });
  });

  describe('D. Health and Metrics endpoint integrity', () => {
    it('health endpoint returns 200 with minimal status without credentials or internal details', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] } as any);

      const response = await getHealth();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual({
        status: 'healthy',
        timestamp: expect.any(String),
        database: 'connected',
      });

      const healthLog = loggedEntries.find((e) => e.event === 'health_check_passed');
      expect(healthLog).toBeDefined();
      expect(healthLog.database).toBe('healthy');
    });

    it('metrics endpoint remains protected and returns 401/503 without authorized Bearer token', async () => {
      const envRecord = process.env as Record<string, string | undefined>;
      const prevEnv = process.env.NODE_ENV;
      const prevSecret = process.env.METRICS_SECRET;
      try {
        envRecord.NODE_ENV = 'production';
        envRecord.METRICS_SECRET = 'test-secret-value-123';

        // Missing Authorization header
        const resNoAuth = await getMetrics();
        expect(resNoAuth.status).toBe(401);

        // Invalid token
        const reqBadAuth = new Request('http://localhost/api/metrics', {
          headers: { Authorization: 'Bearer wrong-secret' },
        });
        const resBadAuth = await getMetrics(reqBadAuth);
        expect(resBadAuth.status).toBe(401);

        // Valid token
        const reqGoodAuth = new Request('http://localhost/api/metrics', {
          headers: { Authorization: 'Bearer test-secret-value-123' },
        });
        const resGoodAuth = await getMetrics(reqGoodAuth);
        expect(resGoodAuth.status).toBe(200);
      } finally {
        envRecord.NODE_ENV = prevEnv;
        envRecord.METRICS_SECRET = prevSecret;
      }
    });
  });
});
