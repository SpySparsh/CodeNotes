import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
      '[E2E Adaptive Chunking Test] FATAL: STAGING_DATABASE_URL is not set.\n' +
        'Set STAGING_DATABASE_URL to an explicit local staging database connection string (e.g. postgresql://<user>:<password>@127.0.0.1:5433/codenotes_staging).'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch (err: any) {
    throw new Error(`[E2E Adaptive Chunking Test] FATAL: STAGING_DATABASE_URL is not a valid URL: ${err?.message}`);
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`[E2E Adaptive Chunking Test] FATAL: STAGING_DATABASE_URL must use postgresql: protocol, got: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new Error(`[E2E Adaptive Chunking Test] SAFETY VIOLATION: Host "${hostname}" is not an allowed local staging host.`);
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (database !== 'codenotes_staging') {
    throw new Error(`[E2E Adaptive Chunking Test] SAFETY VIOLATION: Database "${database}" is not codenotes_staging.`);
  }

  const port = parseInt(parsed.port || '5432', 10);
  if (port !== 5433) {
    throw new Error(`[E2E Adaptive Chunking Test] SAFETY VIOLATION: Port "${port}" is not 5433 (staging port).`);
  }

  return { url: urlStr, hostname, database, port };
}

describe('End-to-End Adaptive Long-Video Chunking on Staging (127.0.0.1:5433 / codenotes_staging)', () => {
  let query: any;
  let generateNotesFunction: any;
  let getCodePointLength: any;
  let sliceByCodePoints: any;
  let verifyChunkManifest: any;

  let mockServer: http.Server;
  let mockServerPort: number;

  let activeChunkRequests = 0;
  let maxObservedChunkConcurrency = 0;
  const chunkRequestsReceived: any[] = [];
  const synthesizeRequestsReceived: any[] = [];

  const runId = `e2e-adaptive-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const testUserId = '33333333-3333-3333-3333-333333333333';
  const trackedParentKeys = new Set<string>();
  // YouTube video ID must be exactly 11 characters (base64url)
  const testVideoId = `e2e${crypto.randomBytes(4).toString('hex')}`;

  const MOCK_SECRET = 'mock_secret_for_e2e_adaptive_testing_min_32_chars!';

  // Deterministic multi-section transcript > 8,500 Unicode code points with emojis
  const section1Text =
    'Section 1: Distributed Systems Fundamentals 🚀.\n\n' +
    'In distributed computing, achieving consensus across asynchronous networks requires careful protocol design. '.repeat(55) +
    '\n\n';
  const section2Text =
    'Section 2: Quota and Rate Limiting Architecture 💻.\n\n' +
    'Rate limiting systems protect shared resources against sudden spikes and adversarial surges. Token bucket algorithms enforce limits. '.repeat(50) +
    '\n\n';
  const section3Text =
    'Section 3: Idempotent Dispatch and Failure Recovery 🛡️.\n\n' +
    'Fencing tokens and deterministic status tracking prevent race conditions in background processing queues. State machines ensure safety. '.repeat(45);

  const longTranscript = section1Text + section2Text + section3Text;

  beforeAll(async () => {
    const { url: validatedDbUrl } = validateStagingDatabaseUrl(process.env.STAGING_DATABASE_URL);
    process.env.DATABASE_URL = validatedDbUrl;
    process.env.TEST_DATABASE_URL = validatedDbUrl;

    const dbMod = await import('@/lib/db');
    const fnMod = await import('@/inngest/functions/generate-notes');
    const cpMod = await import('@/lib/chunk-planner');

    query = dbMod.query;
    generateNotesFunction = fnMod.generateNotesFunction;
    getCodePointLength = cpMod.getCodePointLength;
    sliceByCodePoints = cpMod.sliceByCodePoints;
    verifyChunkManifest = cpMod.verifyChunkManifest;

    // 1. Verify Staging DB coordinates
    const res = await query(
      'SELECT current_database(), inet_server_addr()::text as addr, inet_server_port() as port, current_user'
    );
    const dbInfo = res.rows[0];
    console.log('[E2E Adaptive Setup] Verified Staging Database:', dbInfo);

    if (dbInfo.current_database !== 'codenotes_staging') {
      throw new Error(`ABORT: Target DB is ${dbInfo.current_database}, expected codenotes_staging`);
    }
    if (dbInfo.port !== 5433) {
      throw new Error(`ABORT: Target Port is ${dbInfo.port}, expected 5433`);
    }

    // 2. Start local deterministic mock AI server
    mockServer = http.createServer(async (req, res) => {
      let bodyStr = '';
      req.on('data', (chunk) => {
        bodyStr += chunk;
      });
      req.on('end', async () => {
        const authHeader = req.headers['authorization'];
        const parsedBody = bodyStr ? JSON.parse(bodyStr) : null;

        if (authHeader !== `Bearer ${MOCK_SECRET}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Bad secret' } }));
          return;
        }

        if (req.url === '/api/v1/generate-chunk' && req.method === 'POST') {
          activeChunkRequests++;
          if (activeChunkRequests > maxObservedChunkConcurrency) {
            maxObservedChunkConcurrency = activeChunkRequests;
          }

          chunkRequestsReceived.push({
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: parsedBody,
          });

          // Simulate concurrent processing delay so parallel requests overlap
          await new Promise((resolve) => setTimeout(resolve, 40));
          activeChunkRequests--;

          const chunkIndex = parsedBody.chunkIndex;
          const chunkResponse = {
            overview: `Technical overview for chunk index ${chunkIndex} covering section topics.`,
            keyConcepts: [`Concept ${chunkIndex}.1: Core Primitives`, `Concept ${chunkIndex}.2: Boundary Safety`],
            detailedNotes: `Comprehensive technical notes for chunk ${chunkIndex}:\n- Protocol analysis\n- Boundary correctness\n- Token budget constraints`,
            shorthands: [`Tip ${chunkIndex}: Always maintain contiguous indices`],
            usage: {
              totalTokens: 1000 + chunkIndex * 100,
              promptTokens: 800 + chunkIndex * 80,
              candidateTokens: 180 + chunkIndex * 18,
              thoughtsTokens: 20 + chunkIndex * 2,
            },
            totalTokens: 1000 + chunkIndex * 100,
            promptTokens: 800 + chunkIndex * 80,
            candidateTokens: 180 + chunkIndex * 18,
            thoughtsTokens: 20 + chunkIndex * 2,
          };

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'x-request-id': req.headers['x-request-id'] || 'mock-chunk-req-id',
          });
          res.end(JSON.stringify(chunkResponse));
          return;
        }

        if (req.url === '/api/v1/synthesize' && req.method === 'POST') {
          synthesizeRequestsReceived.push({
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: parsedBody,
          });

          const synthesizeResponse = {
            overview: 'Master executive synthesis of all video sections in coherent technical structure.',
            keyConcepts: [
              'Unified Principle 1: Distributed Systems Fundamentals',
              'Unified Principle 2: Quota and Rate Limiting Architecture',
              'Unified Principle 3: Idempotent Dispatch and Failure Recovery',
            ],
            tableOfContents: [
              'Part 1: Distributed Systems Fundamentals',
              'Part 2: Quota & Rate Limiting Architecture',
              'Part 3: Idempotent Dispatch & Failure Recovery',
            ],
            shorthands: [
              'Invariant 1: Strictly contiguous source offsets without gaps or overlaps',
              'Invariant 2: Always verify database persistence before synthesis',
            ],
            detailedNotes: null,
            usage: {
              totalTokens: 1500,
              promptTokens: 1200,
              candidateTokens: 270,
              thoughtsTokens: 30,
            },
            totalTokens: 1500,
            promptTokens: 1200,
            candidateTokens: 270,
            thoughtsTokens: 30,
          };

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'x-request-id': req.headers['x-request-id'] || 'mock-synth-req-id',
          });
          res.end(JSON.stringify(synthesizeResponse));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not handled in mock' } }));
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as any;
        mockServerPort = addr.port;
        console.log(`[E2E Adaptive Setup] Deterministic Mock AI Server listening on 127.0.0.1:${mockServerPort}`);
        resolve();
      });
    });

    process.env.FASTAPI_SERVICE_URL = `http://127.0.0.1:${mockServerPort}`;
    process.env.FASTAPI_SERVICE_SECRET = MOCK_SECRET;
  });

  afterAll(async () => {
    // 1. Shutdown mock server
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }

    // 2. Clean up test fixtures from staging in strict foreign key order
    if (trackedParentKeys.size > 0 && query) {
      const keys = Array.from(trackedParentKeys);
      await query(`DELETE FROM public.notes WHERE parent_key = ANY($1::text[])`, [keys]);
      await query(`DELETE FROM public.chunk_generations WHERE parent_key = ANY($1::text[])`, [keys]);
      await query(
        `DELETE FROM public.rate_limit_dispatch_attempts
         WHERE reservation_token IN (
           SELECT reservation_token FROM public.rate_limit_reservations WHERE parent_key = ANY($1::text[])
         )`,
        [keys]
      );
      await query(`DELETE FROM public.rate_limit_events WHERE parent_key = ANY($1::text[])`, [keys]);
      await query(`DELETE FROM public.rate_limit_reservations WHERE parent_key = ANY($1::text[])`, [keys]);
      await query(`DELETE FROM public.generation_idempotency WHERE key = ANY($1::text[])`, [keys]);
      await query(`DELETE FROM public.youtube_transcripts WHERE video_id = $1`, [testVideoId]);
    }
  });

  function createTestKey(name: string): string {
    const key = `idem-${runId}-${name}`;
    trackedParentKeys.add(key);
    return key;
  }

  it('correctly executes full adaptive chunking pipeline for a transcript > 8,500 code points', async () => {
    activeChunkRequests = 0;
    maxObservedChunkConcurrency = 0;
    chunkRequestsReceived.length = 0;
    synthesizeRequestsReceived.length = 0;

    const parentKey = createTestKey('multi-chunk-pipeline');
    const videoUrl = `https://www.youtube.com/watch?v=${testVideoId}`;

    // Verify transcript length constraint
    const totalCodePoints = getCodePointLength(longTranscript);
    expect(totalCodePoints).toBeGreaterThan(8500);
    console.log(`[E2E Adaptive] Long transcript code point count: ${totalCodePoints}`);

    // 1. Seed cached transcript in public.youtube_transcripts to bypass external video fetch
    await query(
      `INSERT INTO public.youtube_transcripts (video_id, transcript_text, language, provider, created_at, updated_at)
       VALUES ($1, $2, 'en', 'cache_seed', clock_timestamp(), clock_timestamp())
       ON CONFLICT (video_id) DO UPDATE SET transcript_text = EXCLUDED.transcript_text, updated_at = clock_timestamp()`,
      [testVideoId, longTranscript]
    );

    // 2. Seed initial generation_idempotency row
    await query(
      `INSERT INTO public.generation_idempotency (user_id, key, status, video_id, video_url, created_at, updated_at)
       VALUES ($1, $2, 'processing', $3, $4, clock_timestamp(), clock_timestamp())`,
      [testUserId, parentKey, testVideoId, videoUrl]
    );

    // 3. Construct live Inngest execution context
    const executedStepNames: string[] = [];
    const step = {
      run: async (stepName: string, fn: () => Promise<any>) => {
        executedStepNames.push(stepName);
        return await fn();
      },
      sleep: async () => {},
    };

    const event = {
      data: {
        userId: testUserId,
        idempotencyKey: parentKey,
        videoId: testVideoId,
        videoUrl,
      },
    };

    // 4. Execute the real Inngest workflow handler
    const fnHandler = (generateNotesFunction as any).fn;
    const result = await fnHandler({ event, step });

    console.log('[E2E Adaptive] Execution Result:', result);
    console.log('[E2E Adaptive] Executed Steps:', executedStepNames);
    console.log('[E2E Adaptive] Max Observed Chunk Concurrency:', maxObservedChunkConcurrency);

    // -------------------------------------------------------------------------
    // REQUIRED ASSERTION 1: Result and Parent Generation State
    // -------------------------------------------------------------------------
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(typeof result.noteId).toBe('string');

    const parentRes = await query(
      `SELECT status, note_id, total_chunks, manifest_hash, error_message, error_code, lease_until
       FROM public.generation_idempotency
       WHERE user_id = $1 AND key = $2`,
      [testUserId, parentKey]
    );
    expect(parentRes.rows).toHaveLength(1);
    const parentRow = parentRes.rows[0];
    expect(parentRow.status).toBe('completed');
    expect(parentRow.note_id).toBe(result.noteId);
    expect(parentRow.total_chunks).toBe(3);
    expect(typeof parentRow.manifest_hash).toBe('string');
    expect(parentRow.manifest_hash).toHaveLength(64);
    expect(parentRow.error_message).toBeNull();
    expect(parentRow.error_code).toBeNull();
    expect(parentRow.lease_until).toBeNull();

    // -------------------------------------------------------------------------
    // REQUIRED ASSERTION 2: Source Offsets Cover Transcript Contiguously Without Gaps/Overlaps
    // -------------------------------------------------------------------------
    expect(executedStepNames).toContain('plan-chunk-manifest');
    expect(chunkRequestsReceived).toHaveLength(3);

    // Inspect chunk offsets passed to the mock server
    const chunk0 = chunkRequestsReceived.find((r) => r.body.chunkIndex === 0)?.body;
    const chunk1 = chunkRequestsReceived.find((r) => r.body.chunkIndex === 1)?.body;
    const chunk2 = chunkRequestsReceived.find((r) => r.body.chunkIndex === 2)?.body;

    expect(chunk0).toBeDefined();
    expect(chunk1).toBeDefined();
    expect(chunk2).toBeDefined();

    // Reconstruct full text from slices and verify exact match
    const stitchedSlices = chunk0.chunkText + chunk1.chunkText + chunk2.chunkText;
    expect(stitchedSlices).toBe(longTranscript);
    expect(getCodePointLength(stitchedSlices)).toBe(totalCodePoints);

    // -------------------------------------------------------------------------
    // REQUIRED ASSERTION 3: Bounded Concurrency (Never Exceeds 2)
    // -------------------------------------------------------------------------
    expect(maxObservedChunkConcurrency).toBeGreaterThanOrEqual(1);
    expect(maxObservedChunkConcurrency).toBeLessThanOrEqual(2);

    // -------------------------------------------------------------------------
    // REQUIRED ASSERTION 4: Every Chunk is Independently Dispatched, Persisted, and Accounted
    // -------------------------------------------------------------------------
    const chunkGenRows = await query(
      `SELECT chunk_id, chunk_index, reservation_token, status, model_name, total_tokens,
              prompt_tokens, candidate_tokens, thoughts_tokens, chunk_notes
       FROM public.chunk_generations
       WHERE user_id = $1 AND parent_key = $2
       ORDER BY chunk_index ASC`,
      [testUserId, parentKey]
    );

    expect(chunkGenRows.rows).toHaveLength(3);
    for (let idx = 0; idx < 3; idx++) {
      const row = chunkGenRows.rows[idx];
      expect(row.chunk_index).toBe(idx);
      expect(row.status).toBe('completed');
      expect(row.total_tokens).toBe(1000 + idx * 100);
      expect(row.prompt_tokens).toBe(800 + idx * 80);
      expect(row.candidate_tokens).toBe(180 + idx * 18);
      expect(row.thoughts_tokens).toBe(20 + idx * 2);
      expect(row.chunk_notes.overview).toContain(`chunk index ${idx}`);
      expect(row.chunk_notes.detailedNotes).toContain(`Comprehensive technical notes for chunk ${idx}`);
    }

    // Verify rate limit reservations for each chunk (operation_type = 'chunk')
    const chunkResRows = await query(
      `SELECT reservation_token, chunk_index, operation_type, status, estimated_tokens,
              actual_total_tokens, lease_until, committed_at
       FROM public.rate_limit_reservations
       WHERE user_id = $1 AND parent_key = $2 AND operation_type = 'chunk'
       ORDER BY chunk_index ASC`,
      [testUserId, parentKey]
    );
    expect(chunkResRows.rows).toHaveLength(3);
    for (let idx = 0; idx < 3; idx++) {
      const resRow = chunkResRows.rows[idx];
      expect(resRow.chunk_index).toBe(idx);
      expect(resRow.operation_type).toBe('chunk');
      expect(resRow.status).toBe('committed');
      expect(Number(resRow.actual_total_tokens)).toBe(1000 + idx * 100);
      expect(resRow.committed_at).not.toBeNull();
    }

    // Verify rate limit dispatch attempts for each chunk
    const chunkAttempts = await query(
      `SELECT a.attempt_id, a.operation_type, a.status, a.actual_total_tokens, a.actual_prompt_tokens, a.actual_candidate_tokens, a.actual_thoughts_tokens
       FROM public.rate_limit_dispatch_attempts a
       JOIN public.rate_limit_reservations r ON r.reservation_token = a.reservation_token
       WHERE r.user_id = $1 AND r.parent_key = $2 AND a.operation_type = 'chunk'
       ORDER BY r.chunk_index ASC`,
      [testUserId, parentKey]
    );
    expect(chunkAttempts.rows).toHaveLength(3);
    for (let idx = 0; idx < 3; idx++) {
      const att = chunkAttempts.rows[idx];
      expect(att.status).toBe('completed');
      expect(Number(att.actual_total_tokens)).toBe(1000 + idx * 100);
    }

    // -------------------------------------------------------------------------
    // REQUIRED ASSERTION 5: Synthesis Uses chunk_index = -1 and Receives All Chunks in Order
    // -------------------------------------------------------------------------
    expect(synthesizeRequestsReceived).toHaveLength(1);
    const synthReq = synthesizeRequestsReceived[0];
    expect(typeof synthReq.body.videoTitle).toBe('string');
    expect(synthReq.body.videoTitle.length).toBeGreaterThan(0);
    expect(synthReq.body.chunkSummaries).toHaveLength(3);

    expect(synthReq.body.chunkSummaries[0].chunkIndex).toBe(0);
    expect(synthReq.body.chunkSummaries[1].chunkIndex).toBe(1);
    expect(synthReq.body.chunkSummaries[2].chunkIndex).toBe(2);

    // Verify synthesis reservation record in database
    const synthResRows = await query(
      `SELECT reservation_token, chunk_index, operation_type, status, actual_total_tokens, lease_until, committed_at
       FROM public.rate_limit_reservations
       WHERE user_id = $1 AND parent_key = $2 AND operation_type = 'synthesis'`,
      [testUserId, parentKey]
    );
    expect(synthResRows.rows).toHaveLength(1);
    const synthRes = synthResRows.rows[0];
    expect(synthRes.chunk_index).toBe(-1);
    expect(synthRes.operation_type).toBe('synthesis');
    expect(synthRes.status).toBe('committed');
    expect(Number(synthRes.actual_total_tokens)).toBe(1500);

    // Verify synthesis dispatch attempt in database
    const synthAttempts = await query(
      `SELECT attempt_id, operation_type, status, actual_total_tokens
       FROM public.rate_limit_dispatch_attempts
       WHERE reservation_token = $1`,
      [synthRes.reservation_token]
    );
    expect(synthAttempts.rows).toHaveLength(1);
    expect(synthAttempts.rows[0].operation_type).toBe('synthesis');
    expect(synthAttempts.rows[0].status).toBe('completed');
    expect(Number(synthAttempts.rows[0].actual_total_tokens)).toBe(1500);

    // -------------------------------------------------------------------------
    // REQUIRED ASSERTION 6: Master Note Persistence with Stitched Sections
    // -------------------------------------------------------------------------
    const noteRows = await query(
      `SELECT id, user_id, parent_key, attempt_id, video_id, overview, key_concepts, detailed_notes, shorthands
       FROM public.notes
       WHERE id = $1`,
      [result.noteId]
    );
    expect(noteRows.rows).toHaveLength(1);
    const note = noteRows.rows[0];
    expect(note.user_id).toBe(testUserId);
    expect(note.parent_key).toBe(parentKey);
    expect(note.attempt_id).toBe(synthAttempts.rows[0].attempt_id);
    expect(note.overview).toContain('Master executive synthesis');

    // Key concepts & shorthands from synthesis
    expect(note.key_concepts).toEqual([
      'Unified Principle 1: Distributed Systems Fundamentals',
      'Unified Principle 2: Quota and Rate Limiting Architecture',
      'Unified Principle 3: Idempotent Dispatch and Failure Recovery',
    ]);
    expect(note.shorthands).toHaveLength(2);

    // Detailed notes must contain all 3 section headers and chunk notes stitched
    expect(note.detailed_notes).toContain('## Part 1: Distributed Systems Fundamentals\n\nComprehensive technical notes for chunk 0');
    expect(note.detailed_notes).toContain('## Part 2: Quota & Rate Limiting Architecture\n\nComprehensive technical notes for chunk 1');
    expect(note.detailed_notes).toContain('## Part 3: Idempotent Dispatch & Failure Recovery\n\nComprehensive technical notes for chunk 2');
    expect(note.detailed_notes).toContain('\n\n---\n\n');

    // -------------------------------------------------------------------------
    // REQUIRED ASSERTION 7: Quota Usage Committed Exactly Once
    // -------------------------------------------------------------------------
    // Verify reservations table: all 4 reservations (3 chunks + 1 synth) are committed
    const committedReservations = await query(
      `SELECT reservation_token, chunk_index, operation_type, status, actual_total_tokens, committed_at
       FROM public.rate_limit_reservations
       WHERE user_id = $1 AND parent_key = $2
       ORDER BY chunk_index ASC`,
      [testUserId, parentKey]
    );

    expect(committedReservations.rows).toHaveLength(4);
    for (const res of committedReservations.rows) {
      expect(res.status).toBe('committed');
      expect(res.committed_at).not.toBeNull();
    }

    // Verify exact token sum: 1000 + 1100 + 1200 + 1500 = 4800
    const totalCommittedTokens = committedReservations.rows.reduce(
      (sum: number, r: any) => sum + Number(r.actual_total_tokens),
      0
    );
    expect(totalCommittedTokens).toBe(4800);

    // Verify all 4 dispatch attempts are completed with matching tokens
    const allAttempts = await query(
      `SELECT a.attempt_id, a.operation_type, a.status, a.actual_total_tokens, r.chunk_index
       FROM public.rate_limit_dispatch_attempts a
       JOIN public.rate_limit_reservations r ON r.reservation_token = a.reservation_token
       WHERE r.user_id = $1 AND r.parent_key = $2
       ORDER BY r.chunk_index ASC`,
      [testUserId, parentKey]
    );
    expect(allAttempts.rows).toHaveLength(4);
    for (const att of allAttempts.rows) {
      expect(att.status).toBe('completed');
    }
    const totalAttemptTokens = allAttempts.rows.reduce(
      (sum: number, a: any) => sum + Number(a.actual_total_tokens),
      0
    );
    expect(totalAttemptTokens).toBe(4800);

    // Zero anomaly/settlement events logged on clean successful run
    const auditEvents = await query(
      `SELECT event_id, event_type, chunk_index, total_tokens
       FROM public.rate_limit_events
       WHERE user_id = $1 AND parent_key = $2
       ORDER BY event_id ASC`,
      [testUserId, parentKey]
    );
    expect(auditEvents.rows).toHaveLength(0);

    // -------------------------------------------------------------------------
    // REQUIRED ASSERTION 8: Workflow Replay Idempotency
    // -------------------------------------------------------------------------
    const preReplayChunkCount = chunkRequestsReceived.length;
    const preReplaySynthCount = synthesizeRequestsReceived.length;

    // Execute the exact same Inngest event a second time
    const replayResult = await fnHandler({ event, step });

    console.log('[E2E Adaptive] Replay Result:', replayResult);
    expect(replayResult).toBeDefined();
    expect(replayResult.skipped).toBe(true);
    expect(replayResult.noteId).toBe(result.noteId);

    // Proves zero new AI calls were made
    expect(chunkRequestsReceived.length).toBe(preReplayChunkCount);
    expect(synthesizeRequestsReceived.length).toBe(preReplaySynthCount);

    // Proves zero duplicate notes in database
    const postReplayNotes = await query(`SELECT COUNT(*) FROM public.notes WHERE parent_key = $1`, [parentKey]);
    expect(Number(postReplayNotes.rows[0].count)).toBe(1);

    // Proves zero duplicate chunks in database
    const postReplayChunks = await query(`SELECT COUNT(*) FROM public.chunk_generations WHERE parent_key = $1`, [parentKey]);
    expect(Number(postReplayChunks.rows[0].count)).toBe(3);

    // Proves zero duplicate reservations in database
    const postReplayReservations = await query(`SELECT COUNT(*) FROM public.rate_limit_reservations WHERE parent_key = $1`, [parentKey]);
    expect(Number(postReplayReservations.rows[0].count)).toBe(4); // 3 chunks + 1 synth

    // Proves zero duplicate attempts in database
    const postReplayAttempts = await query(
      `SELECT COUNT(*) FROM public.rate_limit_dispatch_attempts a
       JOIN public.rate_limit_reservations r ON r.reservation_token = a.reservation_token
       WHERE r.parent_key = $1`,
      [parentKey]
    );
    expect(Number(postReplayAttempts.rows[0].count)).toBe(4);

    // Proves zero duplicate audit events in database
    const postReplayEvents = await query(`SELECT COUNT(*) FROM public.rate_limit_events WHERE parent_key = $1`, [parentKey]);
    expect(Number(postReplayEvents.rows[0].count)).toBe(0);
  });
});
