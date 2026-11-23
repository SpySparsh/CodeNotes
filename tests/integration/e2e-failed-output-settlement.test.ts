import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';

vi.mock('youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
  fetchTranscript: vi.fn(),
}));

export function validateStagingDatabaseUrl(urlStr: string | undefined): {
  url: string;
  hostname: string;
  database: string;
  port: number;
} {
  if (!urlStr || urlStr.trim() === '') {
    throw new Error(
      '[E2E Settlement Test] FATAL: STAGING_DATABASE_URL is not set.\n' +
        'Set STAGING_DATABASE_URL to an explicit local staging database connection string (e.g. postgresql://<user>:<password>@127.0.0.1:5433/codenotes_staging).'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch (err: any) {
    throw new Error(`[E2E Settlement Test] FATAL: STAGING_DATABASE_URL is not a valid URL: ${err?.message}`);
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`[E2E Settlement Test] FATAL: STAGING_DATABASE_URL must use postgresql: protocol, got: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new Error(`[E2E Settlement Test] SAFETY VIOLATION: Host "${hostname}" is not an allowed local staging host.`);
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (database !== 'codenotes_staging') {
    throw new Error(`[E2E Settlement Test] SAFETY VIOLATION: Database "${database}" is not codenotes_staging.`);
  }

  const port = parseInt(parsed.port || '5432', 10);
  if (port !== 5433) {
    throw new Error(`[E2E Settlement Test] SAFETY VIOLATION: Port "${port}" is not 5433 (staging port).`);
  }

  return { url: urlStr, hostname, database, port };
}

describe('End-to-End Failed-Output Settlement on Staging (127.0.0.1:5433 / codenotes_staging)', () => {
  let query: any;
  let generateNotesFunction: any;
  let settleFailedDispatchUsage: any;

  let mockServer: http.Server;
  let mockServerPort: number;
  let mockServerMode: 'malformed_502' | 'schema_invalid_200' | 'success' = 'malformed_502';
  let mockServerRequests: any[] = [];

  const runId = `e2e-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const testUserId = '22222222-2222-2222-2222-222222222222';
  const trackedParentKeys = new Set<string>();

  const MOCK_SECRET = 'mock_secret_for_e2e_testing_min_32_chars_long!';

  beforeAll(async () => {
    const { url: validatedDbUrl } = validateStagingDatabaseUrl(process.env.STAGING_DATABASE_URL);
    process.env.DATABASE_URL = validatedDbUrl;
    process.env.TEST_DATABASE_URL = validatedDbUrl;

    const dbMod = await import('@/lib/db');
    const fnMod = await import('@/inngest/functions/generate-notes');
    const qcMod = await import('@/lib/quota-client');

    query = dbMod.query;
    generateNotesFunction = fnMod.generateNotesFunction;
    settleFailedDispatchUsage = qcMod.settleFailedDispatchUsage;

    // 1. Verify Staging DB coordinates
    const res = await query(
      'SELECT current_database(), inet_server_addr()::text as addr, inet_server_port() as port, current_user'
    );
    const dbInfo = res.rows[0];
    console.log('[E2E Setup] Verified Staging Database:', dbInfo);

    if (dbInfo.current_database !== 'codenotes_staging') {
      throw new Error(`ABORT: Target DB is ${dbInfo.current_database}, expected codenotes_staging`);
    }
    if (dbInfo.port !== 5433) {
      throw new Error(`ABORT: Target Port is ${dbInfo.port}, expected 5433`);
    }

    // 2. Start local deterministic mock AI server
    mockServer = http.createServer((req, res) => {
      let bodyStr = '';
      req.on('data', (chunk) => {
        bodyStr += chunk;
      });
      req.on('end', () => {
        const authHeader = req.headers['authorization'];
        mockServerRequests.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: bodyStr ? JSON.parse(bodyStr) : null,
        });

        if (authHeader !== `Bearer ${MOCK_SECRET}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Bad secret' } }));
          return;
        }

        if (mockServerMode === 'malformed_502') {
          // Provider returns HTTP 502 MALFORMED_OUTPUT with verified usage
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'x-request-id': req.headers['x-request-id'] || 'mock-req-id',
          });
          res.end(
            JSON.stringify({
              error: {
                code: 'MALFORMED_OUTPUT',
                message: 'Gemini model generated invalid markdown JSON output',
                usage: {
                  totalTokens: 1420,
                  promptTokens: 1200,
                  candidateTokens: 200,
                  thoughtsTokens: 20,
                },
              },
            })
          );
          return;
        }

        if (mockServerMode === 'schema_invalid_200') {
          // Provider returns HTTP 200 with invalid schema and verified usage
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'x-request-id': req.headers['x-request-id'] || 'mock-req-id',
          });
          res.end(
            JSON.stringify({
              invalidField: 'Not a note format',
              usage: {
                totalTokens: 1000,
                promptTokens: 800,
                candidateTokens: 150,
                thoughtsTokens: 50,
              },
            })
          );
          return;
        }

        if (mockServerMode === 'success') {
          // Provider returns HTTP 200 with valid note format
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'x-request-id': req.headers['x-request-id'] || 'mock-req-id',
          });
          res.end(
            JSON.stringify({
              overview: 'Complete end-to-end overview of testing and database invariants.',
              keyConcepts: ['Quota admission', 'Fenced settlement', 'Audit logging'],
              detailedNotes: 'Comprehensive notes demonstrating full generation pipeline.',
              shorthands: ['QA: Quota Admission', 'E2E: End to End'],
              usage: {
                totalTokens: 1200,
                promptTokens: 900,
                candidateTokens: 250,
                thoughtsTokens: 50,
              },
            })
          );
          return;
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as any;
        mockServerPort = addr.port;
        console.log(`[E2E Setup] Deterministic Mock AI Server listening on 127.0.0.1:${mockServerPort}`);
        resolve();
      });
    });

    // Point application AI client configuration to mock server
    process.env.FASTAPI_SERVICE_URL = `http://127.0.0.1:${mockServerPort}`;
    process.env.FASTAPI_SERVICE_SECRET = MOCK_SECRET;
  });

  afterAll(async () => {
    // Shutdown mock server
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }

    // Cleanup published notes and seeded transcripts
    if (trackedParentKeys.size > 0 && query) {
      const keys = Array.from(trackedParentKeys);
      await query(`DELETE FROM public.notes WHERE parent_key = ANY($1::text[])`, [keys]);
      await query(`DELETE FROM public.youtube_transcripts WHERE video_id = 'dQw4w9WgXcQ'`);
    }
  });

  function createTestKey(name: string): string {
    const key = `idem-${runId}-${name}`;
    trackedParentKeys.add(key);
    return key;
  }

  it('exercises full workflow when provider succeeds but output is malformed (HTTP 502 MALFORMED_OUTPUT)', async () => {
    mockServerMode = 'malformed_502';
    mockServerRequests = [];

    const parentKey = createTestKey('malformed-502');
    const videoId = 'dQw4w9WgXcQ';
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // 1. Seed cached transcript in youtube_transcripts so external transcript fetch is bypassed
    await query(
      `INSERT INTO public.youtube_transcripts (video_id, transcript_text, language, provider, created_at, updated_at)
       VALUES ($1, $2, 'en', 'cache_seed', clock_timestamp(), clock_timestamp())
       ON CONFLICT (video_id) DO UPDATE SET transcript_text = EXCLUDED.transcript_text, updated_at = clock_timestamp()`,
      [videoId, 'This is a deterministic test transcript text representing a 5 minute presentation.']
    );

    // 2. Seed initial generation_idempotency row
    await query(
      `INSERT INTO public.generation_idempotency (user_id, key, status, video_id, video_url, created_at, updated_at)
       VALUES ($1, $2, 'processing', $3, $4, clock_timestamp(), clock_timestamp())`,
      [testUserId, parentKey, videoId, videoUrl]
    );

    // 3. Capture baseline database state before running workflow
    const beforeResCheck = await query(
      `SELECT COUNT(*) FROM public.rate_limit_reservations WHERE parent_key = $1`,
      [parentKey]
    );
    expect(Number(beforeResCheck.rows[0].count)).toBe(0);

    // 4. Construct live Inngest execution context
    const executedSteps: string[] = [];
    const step = {
      run: async (stepName: string, fn: () => Promise<any>) => {
        executedSteps.push(stepName);
        return await fn();
      },
      sleep: async () => {},
    };

    const event = {
      data: {
        userId: testUserId,
        idempotencyKey: parentKey,
        videoId,
        videoUrl,
      },
    };

    // 5. Invoke the real Inngest workflow handler
    const fnHandler = (generateNotesFunction as any).fn;
    let thrownError: any = null;
    try {
      await fnHandler({ event, step });
    } catch (err) {
      thrownError = err;
    }

    console.log('[E2E Workflow] Executed Steps:', executedSteps);
    console.log('[E2E Workflow] Caught Error:', thrownError?.name, thrownError?.message);

    // The workflow must throw NonRetriableError to halt Inngest retries
    expect(thrownError).toBeDefined();
    expect(thrownError?.name).toBe('NonRetriableError');

    // 6. Query staging database and perform mandatory assertions
    // Assertion A: Parent generation is terminal and failed
    const parentRow = await query(
      `SELECT status, note_id, error_code, error_message FROM public.generation_idempotency WHERE user_id = $1 AND key = $2`,
      [testUserId, parentKey]
    );
    expect(parentRow.rows).toHaveLength(1);
    expect(parentRow.rows[0].status).toBe('failed');
    expect(parentRow.rows[0].note_id).toBeNull();
    expect(parentRow.rows[0].error_code).toBe('MALFORMED_OUTPUT');

    // Assertion B: No note or chunk from the malformed output was published
    const noteCount = await query(`SELECT COUNT(*) FROM public.notes WHERE parent_key = $1`, [parentKey]);
    expect(Number(noteCount.rows[0].count)).toBe(0);

    const chunkCount = await query(`SELECT COUNT(*) FROM public.chunk_generations WHERE parent_key = $1`, [parentKey]);
    expect(Number(chunkCount.rows[0].count)).toBe(0);

    // Assertion C: Reservation is settled_failure with verified usage and terminated lease
    const resRows = await query(
      `SELECT reservation_token, lease_token, worker_id, generation, status,
              estimated_tokens, actual_total_tokens, actual_prompt_tokens, actual_candidate_tokens, actual_thoughts_tokens,
              lease_until, committed_at
       FROM public.rate_limit_reservations
       WHERE user_id = $1 AND parent_key = $2`,
      [testUserId, parentKey]
    );
    expect(resRows.rows).toHaveLength(1);
    const resRecord = resRows.rows[0];
    expect(resRecord.status).toBe('settled_failure');
    expect(resRecord.actual_total_tokens).toBe(1420);
    expect(resRecord.actual_prompt_tokens).toBe(1200);
    expect(resRecord.actual_candidate_tokens).toBe(200);
    expect(resRecord.actual_thoughts_tokens).toBe(20);
    expect(new Date(resRecord.lease_until).getTime()).toBeLessThanOrEqual(new Date(resRecord.committed_at).getTime() + 100);

    // Assertion D: Dispatch attempt is failed_output with verified usage
    const attemptRows = await query(
      `SELECT attempt_id, attempt_number, status, actual_total_tokens, actual_prompt_tokens,
              actual_candidate_tokens, actual_thoughts_tokens, error_code
       FROM public.rate_limit_dispatch_attempts
       WHERE reservation_token = $1`,
      [resRecord.reservation_token]
    );
    expect(attemptRows.rows).toHaveLength(1);
    const attemptRecord = attemptRows.rows[0];
    expect(attemptRecord.status).toBe('failed_output');
    expect(attemptRecord.actual_total_tokens).toBe(1420);
    expect(attemptRecord.actual_prompt_tokens).toBe(1200);
    expect(attemptRecord.actual_candidate_tokens).toBe(200);
    expect(attemptRecord.actual_thoughts_tokens).toBe(20);
    expect(attemptRecord.error_code).toBe('MALFORMED_OUTPUT');

    // Assertion E: Exactly one SETTLE_FAILURE event exists for the attempt
    const eventRows = await query(
      `SELECT event_type, total_tokens, prompt_tokens, candidate_tokens, thoughts_tokens, payload
       FROM public.rate_limit_events
       WHERE reservation_token = $1`,
      [resRecord.reservation_token]
    );
    expect(eventRows.rows).toHaveLength(1);
    expect(eventRows.rows[0].event_type).toBe('SETTLE_FAILURE');
    expect(eventRows.rows[0].total_tokens).toBe(1420);
    expect(eventRows.rows[0].prompt_tokens).toBe(1200);
    expect(eventRows.rows[0].candidate_tokens).toBe(200);
    expect(eventRows.rows[0].thoughts_tokens).toBe(20);

    // Assertion F: Quota/TPM accounting includes the settled usage in committed tokens
    const committedTpmRes = await query(
      `SELECT COALESCE(SUM(COALESCE(actual_total_tokens, estimated_tokens)), 0) as committed_tpm
       FROM public.rate_limit_reservations
       WHERE project_id = 'codenotes'
         AND status IN ('committed', 'settled_failure')
         AND reservation_token = $1`,
      [resRecord.reservation_token]
    );
    expect(Number(committedTpmRes.rows[0].committed_tpm)).toBe(1420);

    const inFlightTpmRes = await query(
      `SELECT COALESCE(SUM(estimated_tokens), 0) as in_flight_tpm
       FROM public.rate_limit_reservations
       WHERE project_id = 'codenotes'
         AND status IN ('active', 'dispatching', 'dispatched')
         AND reservation_token = $1`,
      [resRecord.reservation_token]
    );
    expect(Number(inFlightTpmRes.rows[0].in_flight_tpm)).toBe(0);

    // Assertion G: Replaying identical settlement returns ALREADY_SETTLED without duplicate events
    const replayResult = await settleFailedDispatchUsage({
      attemptId: attemptRecord.attempt_id,
      reservationToken: resRecord.reservation_token,
      leaseToken: resRecord.lease_token,
      workerId: resRecord.worker_id,
      fencingGeneration: resRecord.generation,
      totalTokens: 1420,
      promptTokens: 1200,
      candidateTokens: 200,
      thoughtsTokens: 20,
      errorCode: 'MALFORMED_OUTPUT',
      errorMessage: 'Replay test',
      evidencePayload: eventRows.rows[0].payload,
    });
    expect(replayResult.success).toBe(true);
    expect(replayResult.statusCode).toBe('ALREADY_SETTLED');

    const eventCountAfter = await query(
      `SELECT COUNT(*) FROM public.rate_limit_events WHERE reservation_token = $1 AND event_type = 'SETTLE_FAILURE'`,
      [resRecord.reservation_token]
    );
    expect(Number(eventCountAfter.rows[0].count)).toBe(1);
  });

  it('exercises full workflow when provider returns HTTP 200 but body violates schema (schema-invalid output)', async () => {
    mockServerMode = 'schema_invalid_200';
    mockServerRequests = [];

    const parentKey = createTestKey('schema-invalid-200');
    const videoId = 'dQw4w9WgXcQ';
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Seed parent idempotency row
    await query(
      `INSERT INTO public.generation_idempotency (user_id, key, status, video_id, video_url, created_at, updated_at)
       VALUES ($1, $2, 'processing', $3, $4, clock_timestamp(), clock_timestamp())`,
      [testUserId, parentKey, videoId, videoUrl]
    );

    const executedSteps: string[] = [];
    const step = {
      run: async (stepName: string, fn: () => Promise<any>) => {
        executedSteps.push(stepName);
        return await fn();
      },
      sleep: async () => {},
    };

    const event = {
      data: {
        userId: testUserId,
        idempotencyKey: parentKey,
        videoId,
        videoUrl,
      },
    };

    const fnHandler = (generateNotesFunction as any).fn;
    let thrownError: any = null;
    try {
      await fnHandler({ event, step });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError?.name).toBe('NonRetriableError');

    // Verify parent is failed with no note
    const parentRow = await query(
      `SELECT status, note_id, error_code FROM public.generation_idempotency WHERE user_id = $1 AND key = $2`,
      [testUserId, parentKey]
    );
    expect(parentRow.rows[0].status).toBe('failed');
    expect(parentRow.rows[0].note_id).toBeNull();
    expect(parentRow.rows[0].error_code).toBe('MALFORMED_OUTPUT');

    // No note or chunk published
    const noteCount = await query(`SELECT COUNT(*) FROM public.notes WHERE parent_key = $1`, [parentKey]);
    expect(Number(noteCount.rows[0].count)).toBe(0);

    const chunkCount = await query(`SELECT COUNT(*) FROM public.chunk_generations WHERE parent_key = $1`, [parentKey]);
    expect(Number(chunkCount.rows[0].count)).toBe(0);

    // Reservation is settled_failure with 1000 tokens
    const resRow = await query(
      `SELECT status, actual_total_tokens, actual_prompt_tokens, actual_candidate_tokens, actual_thoughts_tokens
       FROM public.rate_limit_reservations
       WHERE user_id = $1 AND parent_key = $2`,
      [testUserId, parentKey]
    );
    expect(resRow.rows[0].status).toBe('settled_failure');
    expect(resRow.rows[0].actual_total_tokens).toBe(1000);
    expect(resRow.rows[0].actual_prompt_tokens).toBe(800);
    expect(resRow.rows[0].actual_candidate_tokens).toBe(150);
    expect(resRow.rows[0].actual_thoughts_tokens).toBe(50);

    // Dispatch attempt is failed_output with 1000 tokens
    const attemptRow = await query(
      `SELECT status, actual_total_tokens FROM public.rate_limit_dispatch_attempts WHERE reservation_token IN (
         SELECT reservation_token FROM public.rate_limit_reservations WHERE parent_key = $1
       )`,
      [parentKey]
    );
    expect(attemptRow.rows[0].status).toBe('failed_output');
    expect(attemptRow.rows[0].actual_total_tokens).toBe(1000);

    // SETTLE_FAILURE event created
    const eventRow = await query(
      `SELECT event_type, total_tokens FROM public.rate_limit_events WHERE reservation_token IN (
         SELECT reservation_token FROM public.rate_limit_reservations WHERE parent_key = $1
       )`,
      [parentKey]
    );
    expect(eventRow.rows).toHaveLength(1);
    expect(eventRow.rows[0].event_type).toBe('SETTLE_FAILURE');
    expect(eventRow.rows[0].total_tokens).toBe(1000);
  });

  it('normal successful generation path remains completely unaffected and commits notes', async () => {
    mockServerMode = 'success';
    mockServerRequests = [];

    const parentKey = createTestKey('success-path');
    const videoId = 'dQw4w9WgXcQ';
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Seed parent idempotency row
    await query(
      `INSERT INTO public.generation_idempotency (user_id, key, status, video_id, video_url, created_at, updated_at)
       VALUES ($1, $2, 'processing', $3, $4, clock_timestamp(), clock_timestamp())`,
      [testUserId, parentKey, videoId, videoUrl]
    );

    const executedSteps: string[] = [];
    const step = {
      run: async (stepName: string, fn: () => Promise<any>) => {
        executedSteps.push(stepName);
        return await fn();
      },
      sleep: async () => {},
    };

    const event = {
      data: {
        userId: testUserId,
        idempotencyKey: parentKey,
        videoId,
        videoUrl,
      },
    };

    const fnHandler = (generateNotesFunction as any).fn;
    const result = await fnHandler({ event, step });

    console.log('[E2E Success Workflow] Result:', result);
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.noteId).toBeDefined();

    // Verify parent status is completed and noteId is populated
    const parentRow = await query(
      `SELECT status, note_id FROM public.generation_idempotency WHERE user_id = $1 AND key = $2`,
      [testUserId, parentKey]
    );
    expect(parentRow.rows[0].status).toBe('completed');
    expect(parentRow.rows[0].note_id).toBe(result.noteId);

    // Verify note is actually published in public.notes
    const noteRow = await query(
      `SELECT id, overview, key_concepts, detailed_notes, shorthands FROM public.notes WHERE id = $1`,
      [result.noteId]
    );
    expect(noteRow.rows).toHaveLength(1);
    expect(noteRow.rows[0].overview).toContain('Complete end-to-end overview');

    // Verify reservation is committed
    const resRow = await query(
      `SELECT status, actual_total_tokens FROM public.rate_limit_reservations WHERE parent_key = $1`,
      [parentKey]
    );
    expect(resRow.rows[0].status).toBe('committed');
    expect(resRow.rows[0].actual_total_tokens).toBe(1200);

    // Verify attempt is completed
    const attemptRow = await query(
      `SELECT status, actual_total_tokens FROM public.rate_limit_dispatch_attempts WHERE reservation_token IN (
         SELECT reservation_token FROM public.rate_limit_reservations WHERE parent_key = $1
       )`,
      [parentKey]
    );
    expect(attemptRow.rows[0].status).toBe('completed');
    expect(attemptRow.rows[0].actual_total_tokens).toBe(1200);
  });
});
