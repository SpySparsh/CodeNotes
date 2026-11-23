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
      '[Real Short Video Test] FATAL: STAGING_DATABASE_URL is not set.\n' +
        'Set STAGING_DATABASE_URL to an explicit local staging database connection string (e.g. postgresql://<user>:<password>@127.0.0.1:5433/codenotes_staging).'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch (err: any) {
    throw new Error(`[Real Short Video Test] FATAL: STAGING_DATABASE_URL is not a valid URL: ${err?.message}`);
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`[Real Short Video Test] FATAL: STAGING_DATABASE_URL must use postgresql: protocol, got: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new Error(`[Real Short Video Test] SAFETY VIOLATION: Host "${hostname}" is not an allowed local staging host.`);
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (database !== 'codenotes_staging') {
    throw new Error(`[Real Short Video Test] SAFETY VIOLATION: Database "${database}" is not codenotes_staging.`);
  }

  const port = parseInt(parsed.port || '5432', 10);
  if (port !== 5433) {
    throw new Error(`[Real Short Video Test] SAFETY VIOLATION: Port "${port}" is not 5433 (staging port).`);
  }

  return { url: urlStr, hostname, database, port };
}

describe('Gemini 3.5 Flash-Lite Real Provider Validation — Short Video (Branch A)', () => {
  let query: any;
  let generateNotesFunction: any;

  const runId = `real-short-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const testUserId = '55555555-5555-5555-5555-555555555555';
  const parentKey = `idem-${runId}`;
  const testVideoId = `e2e${crypto.randomBytes(4).toString('hex')}`; // exactly 11 chars
  const videoUrl = `https://www.youtube.com/watch?v=${testVideoId}`;

  const shortTranscript = `
In this presentation, we explore the core principles of distributed transaction isolation and consensus algorithms.
First, we analyze two-phase commit (2PC) and how coordinator failures can lead to blocking states across participant nodes.
Second, we review the Raft consensus protocol, focusing on leader election, log replication invariants, and safety mechanisms.
Finally, we contrast pessimistic two-phase locking with optimistic concurrency control in high-throughput database systems.
`.trim();

  beforeAll(async () => {
    const rawUrl = process.env.STAGING_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    const validated = validateStagingDatabaseUrl(rawUrl);
    process.env.DATABASE_URL = validated.url;
    process.env.TEST_DATABASE_URL = validated.url;
    process.env.STAGING_DATABASE_URL = validated.url;

    process.env.FASTAPI_SERVICE_URL = 'http://127.0.0.1:8000';

    const dbMod = await import('@/lib/db');
    const fnMod = await import('@/inngest/functions/generate-notes');
    query = dbMod.query;
    generateNotesFunction = fnMod.generateNotesFunction;

    const res = await query('SELECT current_database(), inet_server_port() as port');
    console.log('[Real Short Video Setup] Staging Database:', res.rows[0]);
    if (res.rows[0].current_database !== 'codenotes_staging' || res.rows[0].port !== 5433) {
      throw new Error('Database is not codenotes_staging on port 5433');
    }
  });

  afterAll(async () => {
    if (query) {
      console.log('[Real Short Video Teardown] Cleaning staging fixtures...');
      await query(`DELETE FROM public.notes WHERE parent_key = $1`, [parentKey]);
      await query(
        `DELETE FROM public.rate_limit_dispatch_attempts
         WHERE reservation_token IN (SELECT reservation_token FROM public.rate_limit_reservations WHERE parent_key = $1)`,
        [parentKey]
      );
      await query(`DELETE FROM public.rate_limit_events WHERE parent_key = $1`, [parentKey]);
      await query(`DELETE FROM public.rate_limit_reservations WHERE parent_key = $1`, [parentKey]);
      await query(`DELETE FROM public.generation_idempotency WHERE key = $1`, [parentKey]);
      await query(`DELETE FROM public.youtube_transcripts WHERE video_id = $1`, [testVideoId]);
      console.log('[Real Short Video Teardown] Done.');
    }
  });

  it('completes real monolithic short-video note generation using Gemini 3.5 Flash-Lite', async () => {
    // 1. Seed cached transcript
    await query(
      `INSERT INTO public.youtube_transcripts (video_id, transcript_text, language, provider, created_at, updated_at)
       VALUES ($1, $2, 'en', 'cache_seed', clock_timestamp(), clock_timestamp())
       ON CONFLICT (video_id) DO UPDATE SET transcript_text = EXCLUDED.transcript_text, updated_at = clock_timestamp()`,
      [testVideoId, shortTranscript]
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
        console.log(`[Real Short Video Step] -> ${stepName}`);
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

    console.log(`[Real Short Video Completed] Latency: ${latencySec.toFixed(2)}s, Note ID: ${result?.noteId}`);
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(typeof result.noteId).toBe('string');
    expect(executedSteps).toContain('generate-ai-notes');

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

    console.log('\n--- Real Provider Content Generated ---');
    console.log(`Overview: ${note.overview}`);
    console.log(`Key Concepts (${note.key_concepts.length}):`, note.key_concepts);
    console.log(`Shorthands (${note.shorthands.length}):`, note.shorthands);
    console.log(`Detailed Notes Length: ${note.detailed_notes.length} chars`);

    expect(note.overview.length).toBeGreaterThan(20);
    expect(note.key_concepts.length).toBeGreaterThanOrEqual(2);
    expect(note.shorthands.length).toBeGreaterThanOrEqual(1);
    expect(note.detailed_notes.length).toBeGreaterThan(100);

    // 6. Query attempt ledger and reservation
    const attRes = await query(
      `SELECT a.attempt_id, a.operation_type, a.status, a.actual_total_tokens, a.actual_prompt_tokens, a.actual_candidate_tokens,
              r.status as res_status, r.actual_total_tokens as res_total_tokens, r.model_name
       FROM public.rate_limit_dispatch_attempts a
       JOIN public.rate_limit_reservations r ON r.reservation_token = a.reservation_token
       WHERE a.attempt_id = $1`,
      [note.attempt_id]
    );
    expect(attRes.rows).toHaveLength(1);
    const att = attRes.rows[0];
    console.log('\n--- Real Provider Token Accounting ---');
    console.log(`Model Name: ${att.model_name}`);
    console.log(`Attempt Status: ${att.status}`);
    console.log(`Reservation Status: ${att.res_status}`);
    console.log(`Prompt Tokens: ${att.actual_prompt_tokens}`);
    console.log(`Candidate Tokens: ${att.actual_candidate_tokens}`);
    console.log(`Total Tokens: ${att.actual_total_tokens}`);

    expect(att.model_name).toBe('gemini-3.5-flash-lite');
    expect(att.status).toBe('completed');
    expect(att.res_status).toBe('committed');
    expect(Number(att.actual_prompt_tokens)).toBeGreaterThan(0);
    expect(Number(att.actual_candidate_tokens)).toBeGreaterThan(0);
    expect(Number(att.actual_total_tokens)).toBe(
      Number(att.actual_prompt_tokens) + Number(att.actual_candidate_tokens)
    );
    expect(Number(att.res_total_tokens)).toBe(Number(att.actual_total_tokens));

    // 7. Verify generation_idempotency state
    const parentRes = await query(
      `SELECT status, note_id, error_message, error_code FROM public.generation_idempotency WHERE key = $1`,
      [parentKey]
    );
    expect(parentRes.rows[0].status).toBe('completed');
    expect(parentRes.rows[0].note_id).toBe(result.noteId);
    expect(parentRes.rows[0].error_message).toBeNull();
  }, 90000); // 90s timeout for live external LLM call
});
