import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import dotenv from 'dotenv';

vi.mock('youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn(),
  },
  fetchTranscript: vi.fn(),
}));

dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });
dotenv.config({ path: path.resolve(process.cwd(), 'services/ai-generator/.env'), override: true });

export function validateStagingDatabaseUrl(urlStr: string | undefined): {
  url: string;
  hostname: string;
  database: string;
  port: number;
} {
  if (!urlStr || urlStr.trim() === '') {
    throw new Error(
      '[Real Adaptive Chunking Test] FATAL: STAGING_DATABASE_URL is not set.\n' +
        'Set STAGING_DATABASE_URL to an explicit local staging database connection string (e.g. postgresql://<user>:<password>@127.0.0.1:5433/codenotes_staging).'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch (err: any) {
    throw new Error(`[Real Adaptive Chunking Test] FATAL: STAGING_DATABASE_URL is not a valid URL: ${err?.message}`);
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`[Real Adaptive Chunking Test] FATAL: STAGING_DATABASE_URL must use postgresql: protocol, got: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new Error(`[Real Adaptive Chunking Test] SAFETY VIOLATION: Host "${hostname}" is not an allowed local staging host.`);
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (database !== 'codenotes_staging') {
    throw new Error(`[Real Adaptive Chunking Test] SAFETY VIOLATION: Database "${database}" is not codenotes_staging.`);
  }

  const port = parseInt(parsed.port || '5432', 10);
  if (port !== 5433) {
    throw new Error(`[Real Adaptive Chunking Test] SAFETY VIOLATION: Port "${port}" is not 5433 (staging port).`);
  }

  return { url: urlStr, hostname, database, port };
}

describe('Gemini 3.5 Flash-Lite Real Provider Validation — Adaptive Chunking (Branch B)', () => {
  let query: any;
  let generateNotesFunction: any;
  let getCodePointLength: any;

  const runId = `real-adapt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const testUserId = '66666666-6666-6666-6666-666666666666';
  const parentKey = `idem-${runId}`;
  const testVideoId = `e2e${crypto.randomBytes(4).toString('hex')}`; // exactly 11 chars
  const videoUrl = `https://www.youtube.com/watch?v=${testVideoId}`;

  // Deterministic realistic transcript > 8,500 Unicode code points (2 chunks: ~5,200 chars each = ~10,400 chars)
  const part1Paragraph =
    'In this comprehensive lecture on modern distributed systems, we begin with consensus foundations. ' +
    'Distributed systems must balance consistency, availability, and partition tolerance according to the CAP theorem. ' +
    'The Paxos and Raft algorithms ensure that distributed state machines agree on identical sequences of state transitions. ' +
    'Raft achieves consensus through a single elected leader that manages an append-only replicated log. ' +
    'When network partitions isolate a leader from a majority quorum, the isolated leader cannot commit new log entries. ';

  const part2Paragraph =
    'In the second half of our analysis, we transition to transactional concurrency control and multi-version storage. ' +
    'Multi-Version Concurrency Control (MVCC) enables readers to proceed without blocking concurrent writers by maintaining historical row versions. ' +
    'Serializability guarantees that concurrent transactions produce outcomes equivalent to some serial execution order. ' +
    'Two-Phase Locking (2PL) enforces serializability by acquiring shared locks for reads and exclusive locks for writes, held until commit. ' +
    'Optimistic Concurrency Control (OCC) validates transaction read sets at commit time, optimal for low-contention analytical workloads. ';

  const part1Text = 'Part 1: Consensus and Distributed State Machines.\n\n' + part1Paragraph.repeat(10) + '\n\n';
  const part2Text = 'Part 2: Concurrency Control and Multi-Version Database Engines.\n\n' + part2Paragraph.repeat(10);
  const longTranscript = part1Text + part2Text;

  beforeAll(async () => {
    const rawUrl = process.env.STAGING_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    const validated = validateStagingDatabaseUrl(rawUrl);
    process.env.DATABASE_URL = validated.url;
    process.env.TEST_DATABASE_URL = validated.url;
    process.env.STAGING_DATABASE_URL = validated.url;

    process.env.FASTAPI_SERVICE_URL = 'http://127.0.0.1:8000';

    const dbMod = await import('@/lib/db');
    const fnMod = await import('@/inngest/functions/generate-notes');
    const cpMod = await import('@/lib/chunk-planner');

    query = dbMod.query;
    generateNotesFunction = fnMod.generateNotesFunction;
    getCodePointLength = cpMod.getCodePointLength;

    const res = await query('SELECT current_database(), inet_server_port() as port');
    console.log('[Real Adaptive Setup] Staging Database:', res.rows[0]);
    if (res.rows[0].current_database !== 'codenotes_staging' || res.rows[0].port !== 5433) {
      throw new Error('Database is not codenotes_staging on port 5433');
    }
  });

  afterAll(async () => {
    if (query) {
      console.log('[Real Adaptive Teardown] Cleaning staging fixtures...');
      await query(`DELETE FROM public.notes WHERE parent_key = $1`, [parentKey]);
      await query(`DELETE FROM public.chunk_generations WHERE parent_key = $1`, [parentKey]);
      await query(
        `DELETE FROM public.rate_limit_dispatch_attempts
         WHERE reservation_token IN (SELECT reservation_token FROM public.rate_limit_reservations WHERE parent_key = $1)`,
        [parentKey]
      );
      await query(`DELETE FROM public.rate_limit_events WHERE parent_key = $1`, [parentKey]);
      await query(`DELETE FROM public.rate_limit_reservations WHERE parent_key = $1`, [parentKey]);
      await query(`DELETE FROM public.generation_idempotency WHERE key = $1`, [parentKey]);
      await query(`DELETE FROM public.youtube_transcripts WHERE video_id = $1`, [testVideoId]);
      console.log('[Real Adaptive Teardown] Done.');
    }
  });

  it('completes real adaptive multi-chunk note generation and synthesis using Gemini 3.5 Flash-Lite', async () => {
    const totalCodePoints = getCodePointLength(longTranscript);
    expect(totalCodePoints).toBeGreaterThan(8500);
    console.log(`[Real Adaptive] Transcript Length: ${totalCodePoints} code points (> 8,500 Branch B threshold)`);

    // 1. Seed cached transcript
    await query(
      `INSERT INTO public.youtube_transcripts (video_id, transcript_text, language, provider, created_at, updated_at)
       VALUES ($1, $2, 'en', 'cache_seed', clock_timestamp(), clock_timestamp())
       ON CONFLICT (video_id) DO UPDATE SET transcript_text = EXCLUDED.transcript_text, updated_at = clock_timestamp()`,
      [testVideoId, longTranscript]
    );

    // 2. Seed generation_idempotency
    await query(
      `INSERT INTO public.generation_idempotency (user_id, key, status, video_id, video_url, created_at, updated_at)
       VALUES ($1, $2, 'processing', $3, $4, clock_timestamp(), clock_timestamp())`,
      [testUserId, parentKey, testVideoId, videoUrl]
    );

    // 3. Execution Context
    const executedSteps: string[] = [];
    const step = {
      run: async (stepName: string, fn: () => Promise<any>) => {
        executedSteps.push(stepName);
        console.log(`[Real Adaptive Step] -> ${stepName}`);
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

    // 4. Run the real Inngest workflow handler against live FastAPI & Gemini 3.5 Flash-Lite
    const fnHandler = (generateNotesFunction as any).fn;
    const start = performance.now();
    const result = await fnHandler({ event, step });
    const latencySec = (performance.now() - start) / 1000;

    console.log(`\n[Real Adaptive Completed] Total Duration: ${latencySec.toFixed(2)}s, Note ID: ${result?.noteId}`);
    console.log(`Executed Steps: ${executedSteps.join(' -> ')}`);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(typeof result.noteId).toBe('string');
    expect(executedSteps).toContain('plan-chunk-manifest');
    expect(executedSteps).toContain('generate-chunk-0');
    expect(executedSteps).toContain('generate-chunk-1');
    expect(executedSteps).toContain('hierarchical-synthesis');
    expect(executedSteps).toContain('persist-adaptive-notes');

    // 5. Query and verify persisted note in public.notes
    const noteRes = await query(
      `SELECT id, user_id, parent_key, attempt_id, video_id, overview, key_concepts, detailed_notes, shorthands
       FROM public.notes
       WHERE id = $1`,
      [result.noteId]
    );
    expect(noteRes.rows).toHaveLength(1);
    const note = noteRes.rows[0];
    expect(note.user_id).toBe(testUserId);
    expect(note.parent_key).toBe(parentKey);
    expect(note.attempt_id).toBeDefined();

    console.log('\n--- Real Synthesized Master Note ---');
    console.log(`Overview: ${note.overview}`);
    console.log(`Key Concepts (${note.key_concepts.length}):`, note.key_concepts);
    console.log(`Shorthands (${note.shorthands.length}):`, note.shorthands);
    console.log(`Detailed Notes Length: ${note.detailed_notes.length} chars`);

    expect(note.overview.length).toBeGreaterThan(30);
    expect(note.key_concepts.length).toBeGreaterThanOrEqual(2);
    expect(note.shorthands.length).toBeGreaterThanOrEqual(1);
    expect(note.detailed_notes.length).toBeGreaterThan(500);
    expect(note.detailed_notes).toMatch(/## (Section|Part)/i);

    // 6. Query chunk_generations
    const chunksRes = await query(
      `SELECT chunk_index, status, model_name, total_tokens, prompt_tokens, candidate_tokens, chunk_notes
       FROM public.chunk_generations
       WHERE parent_key = $1
       ORDER BY chunk_index ASC`,
      [parentKey]
    );
    expect(chunksRes.rows).toHaveLength(2);
    console.log('\n--- Real Provider Chunk Generations ---');
    for (const chunk of chunksRes.rows) {
      console.log(`Chunk ${chunk.chunk_index}: model=${chunk.model_name}, prompt=${chunk.prompt_tokens}, candidate=${chunk.candidate_tokens}, total=${chunk.total_tokens}`);
      expect(chunk.status).toBe('completed');
      expect(chunk.model_name).toBe('gemini-3.5-flash-lite');
      expect(Number(chunk.total_tokens)).toBeGreaterThan(0);
      expect(chunk.chunk_notes.overview.length).toBeGreaterThan(10);
    }

    // 7. Query rate limit reservations and dispatch attempts
    const resRows = await query(
      `SELECT chunk_index, operation_type, status, model_name, actual_total_tokens, actual_prompt_tokens, actual_candidate_tokens
       FROM public.rate_limit_reservations
       WHERE parent_key = $1
       ORDER BY chunk_index ASC`,
      [parentKey]
    );
    expect(resRows.rows).toHaveLength(3); // 2 chunks + 1 synthesis

    console.log('\n--- Real Provider Token Accounting Across Pipeline ---');
    let grandTotalTokens = 0;
    for (const r of resRows.rows) {
      const tokens = Number(r.actual_total_tokens);
      grandTotalTokens += tokens;
      console.log(`Reservation (${r.operation_type}, chunk_index=${r.chunk_index}): status=${r.status}, model=${r.model_name}, prompt=${r.actual_prompt_tokens}, candidate=${r.actual_candidate_tokens}, total=${tokens}`);
      expect(r.status).toBe('committed');
      expect(r.model_name).toBe('gemini-3.5-flash-lite');
      expect(tokens).toBeGreaterThan(0);
    }
    console.log(`Grand Total Provider Tokens Committed: ${grandTotalTokens}`);

    // Verify all 3 attempts completed
    const attemptsRes = await query(
      `SELECT a.attempt_id, a.operation_type, a.status, a.actual_total_tokens
       FROM public.rate_limit_dispatch_attempts a
       JOIN public.rate_limit_reservations r ON r.reservation_token = a.reservation_token
       WHERE r.parent_key = $1
       ORDER BY r.chunk_index ASC`,
      [parentKey]
    );
    expect(attemptsRes.rows).toHaveLength(3);
    for (const a of attemptsRes.rows) {
      expect(a.status).toBe('completed');
      expect(Number(a.actual_total_tokens)).toBeGreaterThan(0);
    }

    // 8. Verify generation_idempotency
    const parentRes = await query(
      `SELECT status, note_id, total_chunks, manifest_hash, error_message
       FROM public.generation_idempotency
       WHERE key = $1`,
      [parentKey]
    );
    expect(parentRes.rows[0].status).toBe('completed');
    expect(parentRes.rows[0].note_id).toBe(result.noteId);
    expect(parentRes.rows[0].total_chunks).toBe(2);
    expect(parentRes.rows[0].manifest_hash).toBeDefined();
    expect(parentRes.rows[0].error_message).toBeNull();
  }, 180000); // 180s timeout for multi-step LLM calls (2 chunks + synthesis)
});
