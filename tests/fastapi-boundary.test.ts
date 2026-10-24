import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import {
  generateAiNotes,
  generatedNotesSchema,
  AiClientError,
} from '@/lib/ai-client';

const TEST_PORT = 18088;
const TEST_HOST = '127.0.0.1';
const TEST_SECRET = 'boundary-test-secret-98765';
const BASE_URL = `http://${TEST_HOST}:${TEST_PORT}`;

function resolvePythonBinary(): string {
  const root = path.resolve(__dirname, '..');
  const winVenv = path.join(root, 'services', 'ai-generator', '.venv', 'Scripts', 'python.exe');
  const unixVenv = path.join(root, 'services', 'ai-generator', '.venv', 'bin', 'python');

  if (process.platform === 'win32' && fs.existsSync(winVenv)) {
    return winVenv;
  }
  if (fs.existsSync(unixVenv)) {
    return unixVenv;
  }
  return process.env.PYTHON || 'python3';
}

async function waitForServer(url: string, timeoutMs = 12000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

describe('FastAPI Cross-Process HTTP Boundary Integration', () => {
  let serverProcess: ChildProcess | null = null;

  beforeAll(async () => {
    const pythonBin = resolvePythonBinary();
    const serverScript = path.resolve(
      __dirname,
      '..',
      'services',
      'ai-generator',
      'tests',
      'mock_server.py'
    );

    serverProcess = spawn(
      pythonBin,
      [
        serverScript,
        '--host',
        TEST_HOST,
        '--port',
        String(TEST_PORT),
        '--secret',
        TEST_SECRET,
      ],
      {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'inherit',
        env: {
          ...process.env,
          FASTAPI_SERVICE_SECRET: TEST_SECRET,
          GEMINI_API_KEY: 'test-mock-gemini-key',
          PYTHONUNBUFFERED: '1',
        },
      }
    );

    const ready = await waitForServer(BASE_URL);
    if (!ready) {
      if (serverProcess) {
        serverProcess.kill('SIGTERM');
      }
      throw new Error(`Failed to start mock FastAPI server on ${BASE_URL} within timeout.`);
    }
  }, 20000);

  afterAll(async () => {
    if (serverProcess && !serverProcess.killed) {
      if (process.platform === 'win32' && serverProcess.pid) {
        try {
          spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F']);
        } catch {
          serverProcess.kill('SIGKILL');
        }
      } else {
        serverProcess.kill('SIGTERM');
      }
    }
  });

  it('1. GET /health responds with 200 OK and healthy status without requiring auth', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'healthy' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('2. POST /api/v1/generate without Authorization header is rejected with 401 UNAUTHORIZED', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: 'Valid transcript content for unauthorized boundary test.',
        videoTitle: 'Test Video',
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('3. POST /api/v1/generate with invalid secret token is rejected with 401 UNAUTHORIZED', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-secret-token',
      },
      body: JSON.stringify({
        transcript: 'Valid transcript content for wrong secret test.',
        videoTitle: 'Test Video',
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('4. POST /api/v1/generate with empty payload fails Pydantic schema validation with 422', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_SECRET}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('5. generateAiNotes() communicates over real HTTP, receives camelCase response, and passes Zod validation', async () => {
    const transcript =
      'In this tutorial we explore full-stack TypeScript architecture, FastAPI integration, and durable workflows.';
    const videoTitle = 'Full-Stack Architecture Deep Dive';

    const result = await generateAiNotes(transcript, videoTitle, {
      serviceUrl: BASE_URL,
      serviceSecret: TEST_SECRET,
      requestId: 'boundary-trace-req-001',
    });

    // Validate using Zod schema directly
    const validated = generatedNotesSchema.parse(result);
    expect(validated.overview).toContain(videoTitle);
    expect(Array.isArray(validated.keyConcepts)).toBe(true);
    expect(validated.keyConcepts.length).toBeGreaterThan(0);
    expect(typeof validated.detailedNotes).toBe('string');
    expect(validated.detailedNotes.length).toBeGreaterThan(0);
    expect(Array.isArray(validated.shorthands)).toBe(true);
  });

  it('6. normalizes dirty request IDs across real loopback HTTP without breaking correlation', async () => {
    const dirtyRequestId = 'idem:boundary test#123@v1';

    const result = await generateAiNotes(
      'Short transcript text for correlation tracing test.',
      'Tracing Verification Video',
      {
        serviceUrl: BASE_URL,
        serviceSecret: TEST_SECRET,
        requestId: dirtyRequestId,
      }
    );

    expect(result.overview).toContain('Tracing Verification Video');
    // Detailed notes from mock server include the received request ID
    expect(result.detailedNotes).toContain('idem_boundary_test_123_v1');
  });

  it('7. maps upstream 429 rate limit to retryable AiClientError(RATE_LIMITED)', async () => {
    try {
      await generateAiNotes(
        'Valid transcript text for rate limit mapping verification.',
        'TRIGGER_RATE_LIMIT',
        {
          serviceUrl: BASE_URL,
          serviceSecret: TEST_SECRET,
        }
      );
      expect.unreachable('Should have thrown AiClientError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(AiClientError);
      expect(err.code).toBe('RATE_LIMITED');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(429);
    }
  });

  it('8. maps upstream 504 gateway timeout to retryable AiClientError(TIMEOUT)', async () => {
    try {
      await generateAiNotes(
        'Valid transcript text for upstream timeout mapping verification.',
        'TRIGGER_UPSTREAM_TIMEOUT',
        {
          serviceUrl: BASE_URL,
          serviceSecret: TEST_SECRET,
        }
      );
      expect.unreachable('Should have thrown AiClientError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(AiClientError);
      expect(err.code).toBe('TIMEOUT');
      expect(err.isRetryable).toBe(true);
      expect(err.statusCode).toBe(504);
    }
  });

  it('9. enforces client-side timeout and maps to retryable AiClientError(TIMEOUT)', async () => {
    try {
      await generateAiNotes(
        'Valid transcript text for client timeout verification.',
        'TRIGGER_TIMEOUT',
        {
          serviceUrl: BASE_URL,
          serviceSecret: TEST_SECRET,
          timeoutMs: 400,
        }
      );
      expect.unreachable('Should have thrown AiClientError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(AiClientError);
      expect(err.code).toBe('TIMEOUT');
      expect(err.isRetryable).toBe(true);
    }
  });
});
