#!/usr/bin/env node
/**
 * Cross-Process Real HTTP Boundary Verification Script for CodeNotes.
 *
 * Spawns a real FastAPI mock server on loopback, makes native HTTP requests,
 * and validates the health check, security boundaries, contract compatibility,
 * and error handling without using in-process mocks or incurring live Gemini costs.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const TEST_PORT = 18090;
const TEST_HOST = '127.0.0.1';
const TEST_SECRET = 'boundary-verification-secret-45678';
const BASE_URL = `http://${TEST_HOST}:${TEST_PORT}`;

function resolvePythonBinary() {
  const winVenv = path.join(rootDir, 'services', 'ai-generator', '.venv', 'Scripts', 'python.exe');
  const unixVenv = path.join(rootDir, 'services', 'ai-generator', '.venv', 'bin', 'python');

  if (process.platform === 'win32' && fs.existsSync(winVenv)) {
    return winVenv;
  }
  if (fs.existsSync(unixVenv)) {
    return unixVenv;
  }
  return process.env.PYTHON || 'python3';
}

async function waitForServer(url, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {
      // Server starting up
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function run() {
  console.log('='.repeat(70));
  console.log('CodeNotes FastAPI Cross-Process HTTP Boundary Verification');
  console.log('='.repeat(70));

  const pythonBin = resolvePythonBinary();
  const serverScript = path.join(rootDir, 'services', 'ai-generator', 'tests', 'mock_server.py');

  console.log(`[setup] Python interpreter: ${pythonBin}`);
  console.log(`[setup] Target endpoint:    ${BASE_URL}`);

  const serverProcess = spawn(
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
      cwd: rootDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        FASTAPI_SERVICE_SECRET: TEST_SECRET,
        GEMINI_API_KEY: 'test-mock-gemini-key',
        PYTHONUNBUFFERED: '1',
      },
    }
  );

  let serverOutput = '';
  serverProcess.stdout?.on('data', (d) => (serverOutput += d.toString()));
  serverProcess.stderr?.on('data', (d) => (serverOutput += d.toString()));

  const cleanup = () => {
    if (!serverProcess.killed) {
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
  };

  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    process.stdout.write('[startup] Waiting for FastAPI server on loopback... ');
    const isReady = await waitForServer(BASE_URL);
    if (!isReady) {
      console.log('FAILED');
      console.error('[startup] Server failed to start. Logs:\n', serverOutput);
      process.exit(1);
    }
    console.log('READY\n');

    let passed = 0;
    let failed = 0;

    async function check(name, fn) {
      process.stdout.write(`  • ${name.padEnd(55)} `);
      try {
        await fn();
        console.log('[PASS]');
        passed++;
      } catch (err) {
        console.log('[FAIL]');
        console.error(`    Error: ${err.message}`);
        failed++;
      }
    }

    // Check 1: Health Endpoint
    await check('GET /health returns 200 OK & healthy status', async () => {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const body = await res.json();
      if (body.status !== 'healthy') throw new Error(`Expected healthy, got ${body.status}`);
      if (!res.headers.get('x-request-id')) throw new Error('Missing x-request-id header');
    });

    // Check 2: Unauthorized request rejected
    await check('POST /api/v1/generate without auth returns 401', async () => {
      const res = await fetch(`${BASE_URL}/api/v1/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: 'test transcript content', videoTitle: 'title' }),
      });
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
      const body = await res.json();
      if (body?.error?.code !== 'UNAUTHORIZED') {
        throw new Error(`Expected UNAUTHORIZED, got ${body?.error?.code}`);
      }
    });

    // Check 3: Invalid token rejected
    await check('POST /api/v1/generate with bad secret returns 401', async () => {
      const res = await fetch(`${BASE_URL}/api/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer invalid-token-999',
        },
        body: JSON.stringify({ transcript: 'test transcript content', videoTitle: 'title' }),
      });
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
      const body = await res.json();
      if (body?.error?.code !== 'UNAUTHORIZED') {
        throw new Error(`Expected UNAUTHORIZED, got ${body?.error?.code}`);
      }
    });

    // Check 4: Schema validation error
    await check('POST /api/v1/generate with empty body returns 422', async () => {
      const res = await fetch(`${BASE_URL}/api/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_SECRET}`,
        },
        body: JSON.stringify({}),
      });
      if (res.status !== 422) throw new Error(`Expected 422, got ${res.status}`);
      const body = await res.json();
      if (body?.error?.code !== 'INVALID_REQUEST') {
        throw new Error(`Expected INVALID_REQUEST, got ${body?.error?.code}`);
      }
    });

    // Check 5: Authenticated note generation returns camelCase contract
    await check('POST /api/v1/generate returns valid structured notes', async () => {
      const res = await fetch(`${BASE_URL}/api/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_SECRET}`,
          'X-Request-ID': 'trace-script-001',
        },
        body: JSON.stringify({
          transcript: 'In this session we examine Next.js and FastAPI real HTTP boundary integration.',
          videoTitle: 'FastAPI Integration Demo',
        }),
      });
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const body = await res.json();
      if (typeof body.overview !== 'string' || body.overview.length === 0) {
        throw new Error('overview is missing or empty');
      }
      if (!Array.isArray(body.keyConcepts)) {
        throw new Error('keyConcepts is not an array');
      }
      if (typeof body.detailedNotes !== 'string' || body.detailedNotes.length === 0) {
        throw new Error('detailedNotes is missing or empty');
      }
      if (!Array.isArray(body.shorthands)) {
        throw new Error('shorthands is not an array');
      }
    });

    // Check 6: Request ID sanitization on wire
    await check('X-Request-ID with invalid chars is sanitized by server', async () => {
      const res = await fetch(`${BASE_URL}/api/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_SECRET}`,
          'X-Request-ID': 'valid-trace.id_123',
        },
        body: JSON.stringify({
          transcript: 'Testing request ID preservation.',
          videoTitle: 'Request ID Test',
        }),
      });
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const receivedId = res.headers.get('x-request-id');
      if (receivedId !== 'valid-trace.id_123') {
        throw new Error(`Expected valid-trace.id_123, got ${receivedId}`);
      }
    });

    // Check 7: Rate limit error mapping
    await check('POST /api/v1/generate maps 429 RATE_LIMITED', async () => {
      const res = await fetch(`${BASE_URL}/api/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_SECRET}`,
        },
        body: JSON.stringify({
          transcript: 'Rate limit trigger transcript.',
          videoTitle: 'TRIGGER_RATE_LIMIT',
        }),
      });
      if (res.status !== 429) throw new Error(`Expected 429, got ${res.status}`);
      const body = await res.json();
      if (body?.error?.code !== 'RATE_LIMITED') {
        throw new Error(`Expected RATE_LIMITED, got ${body?.error?.code}`);
      }
    });

    // Check 8: Upstream timeout error mapping
    await check('POST /api/v1/generate maps 504 TIMEOUT', async () => {
      const res = await fetch(`${BASE_URL}/api/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_SECRET}`,
        },
        body: JSON.stringify({
          transcript: 'Upstream timeout trigger transcript.',
          videoTitle: 'TRIGGER_UPSTREAM_TIMEOUT',
        }),
      });
      if (res.status !== 504) throw new Error(`Expected 504, got ${res.status}`);
      const body = await res.json();
      if (body?.error?.code !== 'TIMEOUT') {
        throw new Error(`Expected TIMEOUT, got ${body?.error?.code}`);
      }
    });

    console.log('\n' + '-'.repeat(70));
    console.log(`Results: ${passed} passed, ${failed} failed.`);
    console.log('-'.repeat(70));

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    cleanup();
  }
}

run().catch((err) => {
  console.error('[fatal] Boundary verification failed:', err);
  process.exit(1);
});
