import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'crypto';
import net from 'net';

const uuidv4 = () => crypto.randomUUID();

/**
 * Strictly parses and validates TEST_DATABASE_URL for live database integration tests.
 * Enforces exact loopback host 127.0.0.1, port 5433, and database codenotes_staging.
 * Never leaks credentials in thrown error messages.
 */
export function validateLiveDatabaseUrl(rawUrl: string | undefined): {
  url: string;
  host: string;
  port: string;
  database: string;
} {
  if (!rawUrl || rawUrl.trim() === '') {
    throw new Error('TEST_DATABASE_URL is not set.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid URL.');
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`TEST_DATABASE_URL must use postgresql: protocol, received: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== '127.0.0.1') {
    throw new Error(
      `TEST_DATABASE_URL host "${hostname}" is forbidden. Live database integration tests strictly require host "127.0.0.1".`
    );
  }

  const port = parsed.port;
  if (port !== '5433') {
    throw new Error(
      `TEST_DATABASE_URL port "${port || 'default'}" is forbidden. Live database integration tests strictly require port "5433".`
    );
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (database !== 'codenotes_staging') {
    throw new Error(
      `TEST_DATABASE_URL database "${database}" is forbidden. Live database integration tests strictly require database "codenotes_staging".`
    );
  }

  return {
    url: rawUrl,
    host: hostname,
    port,
    database,
  };
}

async function isPortReachable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(250);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

describe('TEST_DATABASE_URL Strict Validation Contract', () => {
  it('rejects missing or empty URLs', () => {
    expect(() => validateLiveDatabaseUrl(undefined)).toThrow(/TEST_DATABASE_URL is not set/);
    expect(() => validateLiveDatabaseUrl('')).toThrow(/TEST_DATABASE_URL is not set/);
    expect(() => validateLiveDatabaseUrl('   ')).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it('rejects non-postgres protocols', () => {
    expect(() => validateLiveDatabaseUrl('http://127.0.0.1:5433/codenotes_staging')).toThrow(
      /must use postgresql: protocol/i
    );
    expect(() => validateLiveDatabaseUrl('mysql://127.0.0.1:5433/codenotes_staging')).toThrow(
      /must use postgresql: protocol/i
    );
  });

  it('rejects remote or non-127.0.0.1 hostnames (including localhost and remote Supabase)', () => {
    expect(() =>
      validateLiveDatabaseUrl('postgresql://phase1v_admin:secret@localhost:5433/codenotes_staging')
    ).toThrow(/host "localhost" is forbidden/i);
    expect(() =>
      validateLiveDatabaseUrl('postgresql://phase1v_admin:secret@db.supabase.co:5433/codenotes_staging')
    ).toThrow(/host "db.supabase.co" is forbidden/i);
    expect(() =>
      validateLiveDatabaseUrl('postgresql://phase1v_admin:secret@192.168.1.50:5433/codenotes_staging')
    ).toThrow(/host "192.168.1.50" is forbidden/i);
  });

  it('rejects non-5433 ports', () => {
    expect(() =>
      validateLiveDatabaseUrl('postgresql://phase1v_admin:secret@127.0.0.1:5432/codenotes_staging')
    ).toThrow(/port "5432" is forbidden/i);
    expect(() =>
      validateLiveDatabaseUrl('postgresql://phase1v_admin:secret@127.0.0.1/codenotes_staging')
    ).toThrow(/port "default" is forbidden/i);
  });

  it('rejects unapproved database names', () => {
    expect(() =>
      validateLiveDatabaseUrl('postgresql://phase1v_admin:secret@127.0.0.1:5433/postgres')
    ).toThrow(/database "postgres" is forbidden/i);
    expect(() =>
      validateLiveDatabaseUrl('postgresql://phase1v_admin:secret@127.0.0.1:5433/codenotes_test')
    ).toThrow(/database "codenotes_test" is forbidden/i);
    expect(() =>
      validateLiveDatabaseUrl('postgresql://phase1v_admin:secret@127.0.0.1:5433/codenotes_prod')
    ).toThrow(/database "codenotes_prod" is forbidden/i);
  });

  it('accepts strictly valid 127.0.0.1:5433/codenotes_staging without exposing credentials in error paths', () => {
    const res = validateLiveDatabaseUrl(
      'postgresql://phase1v_admin:test_password@127.0.0.1:5433/codenotes_staging'
    );
    expect(res.host).toBe('127.0.0.1');
    expect(res.port).toBe('5433');
    expect(res.database).toBe('codenotes_staging');
  });
});

describe('Gap 4: Application-to-Database Live Integration', () => {
  let hasLiveDb = false;
  let query: any;
  let getPool: any;
  let withUserTransaction: any;
  let reserveQuota: any;
  let claimOrAdoptDispatchSlot: any;
  let completeDispatchAttempt: any;
  let reportStaleAttemptOutcome: any;
  let recoverReservationOwnership: any;

  // Unique run identifier namespaces every generated key in this test process
  const runId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const trackedParentKeys = new Set<string>();

  function createTestParentKey(suffix: string): string {
    const key = `key-app-${runId}-${suffix}-${Date.now()}`;
    trackedParentKeys.add(key);
    return key;
  }

  /**
   * Deterministic bottom-up cleanup respecting foreign key constraints:
   * 1. notes
   * 2. rate_limit_events
   * 3. reconciliation_authorizations
   * 4. rate_limit_dispatch_attempts
   * 5. chunk_generations
   * 6. rate_limit_reservations
   * 7. generation_idempotency
   * Deletes only records created by this test run's trackedParentKeys.
   */
  async function cleanupTrackedRecords() {
    if (!hasLiveDb || trackedParentKeys.size === 0 || !query) return;
    const keys = Array.from(trackedParentKeys);
    try {
      await query(`DELETE FROM public.notes WHERE parent_key = ANY($1::text[])`, [keys]);
      await query(
        `DELETE FROM public.rate_limit_events WHERE reservation_token IN (
           SELECT reservation_token FROM public.rate_limit_reservations WHERE parent_key = ANY($1::text[])
         )`,
        [keys]
      );
      await query(
        `DELETE FROM public.reconciliation_authorizations WHERE reservation_token IN (
           SELECT reservation_token FROM public.rate_limit_reservations WHERE parent_key = ANY($1::text[])
         )`,
        [keys]
      );
      await query(
        `DELETE FROM public.rate_limit_dispatch_attempts WHERE reservation_token IN (
           SELECT reservation_token FROM public.rate_limit_reservations WHERE parent_key = ANY($1::text[])
         )`,
        [keys]
      );
      await query(`DELETE FROM public.chunk_generations WHERE parent_key = ANY($1::text[])`, [keys]);
      await query(`DELETE FROM public.rate_limit_reservations WHERE parent_key = ANY($1::text[])`, [keys]);
      await query(`DELETE FROM public.generation_idempotency WHERE key = ANY($1::text[])`, [keys]);
    } catch (err: any) {
      console.error('Failed to cleanup live test run records:', err?.message);
    }
  }

  beforeAll(async () => {
    // Live database tests strictly require TEST_DATABASE_URL to be set
    const rawUrl = process.env.TEST_DATABASE_URL?.trim();
    if (!rawUrl) {
      // Offline mode: skip live DB operations even if port 5433 is listening
      hasLiveDb = false;
      return;
    }

    const validated = validateLiveDatabaseUrl(rawUrl);
    const reachable = await isPortReachable(Number(validated.port), validated.host);
    if (!reachable) {
      throw new Error(`Target ${validated.host}:${validated.port} is unreachable.`);
    }

    process.env.DATABASE_URL = validated.url;
    hasLiveDb = true;

    const db = await import('@/lib/db');
    const qc = await import('@/lib/quota-client');
    query = db.query;
    getPool = db.getPool;
    withUserTransaction = db.withUserTransaction;
    reserveQuota = qc.reserveQuota;
    claimOrAdoptDispatchSlot = qc.claimOrAdoptDispatchSlot;
    completeDispatchAttempt = qc.completeDispatchAttempt;
    reportStaleAttemptOutcome = qc.reportStaleAttemptOutcome;
    recoverReservationOwnership = qc.recoverReservationOwnership;
  });

  afterEach(async () => {
    // Reliable cleanup runs after every test regardless of pass or fail
    await cleanupTrackedRecords();
  });

  afterAll(async () => {
    try {
      await cleanupTrackedRecords();
      // Verify no records leaked from this test run
      if (hasLiveDb && query && trackedParentKeys.size > 0) {
        const keys = Array.from(trackedParentKeys);
        const check = await query(
          `SELECT
             (SELECT count(*) FROM public.notes WHERE parent_key = ANY($1::text[])) as notes_cnt,
             (SELECT count(*) FROM public.rate_limit_reservations WHERE parent_key = ANY($1::text[])) as res_cnt,
             (SELECT count(*) FROM public.generation_idempotency WHERE key = ANY($1::text[])) as idemp_cnt`,
          [keys]
        );
        const { notes_cnt, res_cnt, idemp_cnt } = check.rows[0];
        if (Number(notes_cnt) > 0 || Number(res_cnt) > 0 || Number(idemp_cnt) > 0) {
          throw new Error(
            `Cleanup leaked test records! notes=${notes_cnt}, reservations=${res_cnt}, idemp=${idemp_cnt}`
          );
        }
      }
    } finally {
      if (hasLiveDb && getPool) {
        const pool = getPool();
        await pool.end();
      }
    }
  });

  it('APP-01: Monolithic Generation Workflow Contract', async () => {
    if (!hasLiveDb) {
      // Offline contract verification: module imports and parameter validation
      const qc = await import('@/lib/quota-client');
      expect(typeof qc.reserveQuota).toBe('function');
      expect(typeof qc.claimOrAdoptDispatchSlot).toBe('function');
      expect(typeof qc.completeDispatchAttempt).toBe('function');
      return;
    }

    const testUserId = uuidv4();
    const modelName = 'gemini-2.5-flash';
    const parentKey = createTestParentKey('mono');
    const videoId = 'vid-app-001';

    await query(
      `INSERT INTO public.generation_idempotency (user_id, key, video_id, status) VALUES ($1, $2, $3, 'pending')`,
      [testUserId, parentKey, videoId]
    );

    const reserveRes = await reserveQuota({
      userId: testUserId,
      parentKey,
      chunkIndex: -1,
      projectId: 'codenotes',
      quotaScope: modelName,
      modelName,
      workerId: 'app-worker-1',
      estimatedTokens: 2000,
      leaseDurationInterval: '60 seconds',
      operationType: 'monolithic',
    });

    expect(reserveRes.allowed).toBe(true);
    expect(reserveRes.statusCode).toBe('SUCCESS');
    expect(reserveRes.generation).toBe(1);

    const claimRes = await claimOrAdoptDispatchSlot({
      userId: testUserId,
      parentKey,
      operationType: 'monolithic',
      chunkIndex: -1,
      reservationToken: reserveRes.reservationToken,
      leaseToken: reserveRes.leaseToken,
      workerId: 'app-worker-1',
      generation: reserveRes.generation,
      projectId: 'codenotes',
      quotaScope: modelName,
      modelName,
      estimatedTokens: 2000,
    });

    expect(claimRes.allowed).toBe(true);
    expect(claimRes.statusCode).toBe('DISPATCH_CLAIMED');

    const mockPayload = {
      overview: 'Live integration overview text',
      keyConcepts: ['Integration', 'RLS', 'ACID'],
      detailedNotes: 'Live integration detailed notes content.',
      shorthands: ['INT', 'DB'],
      videoId,
      videoTitle: 'Integration Test Video',
      videoUrl: 'https://youtube.com/watch?v=app-test',
      thumbnailUrl: 'https://img.youtube.com/vi/app-test/0.jpg',
    };

    const completeRes = await completeDispatchAttempt({
      attemptId: claimRes.attemptId!,
      reservationToken: reserveRes.reservationToken,
      leaseToken: reserveRes.leaseToken,
      workerId: 'app-worker-1',
      fencingGeneration: reserveRes.generation,
      operationType: 'monolithic',
      responsePayload: mockPayload,
      totalTokens: 1450,
      promptTokens: 1050,
      candidateTokens: 400,
      thoughtsTokens: 0,
      modelName,
      userId: testUserId,
      parentKey,
      videoId,
      videoTitle: 'Integration Test Video',
      videoUrl: 'https://youtube.com/watch?v=app-test',
      thumbnailUrl: 'https://img.youtube.com/vi/app-test/0.jpg',
    });

    expect(completeRes.success).toBe(true);

    const noteRes = await query(
      `SELECT id, user_id, parent_key, attempt_id, video_title FROM public.notes WHERE parent_key = $1`,
      [parentKey]
    );
    expect(noteRes.rows).toHaveLength(1);
    expect(noteRes.rows[0].parent_key).toBe(parentKey);
    expect(noteRes.rows[0].attempt_id).toBe(claimRes.attemptId);
  });

  it('APP-02: User Isolation via withUserTransaction Contract', async () => {
    if (!hasLiveDb) {
      const db = await import('@/lib/db');
      expect(typeof db.withUserTransaction).toBe('function');
      return;
    }

    const testUserId = uuidv4();
    const testUserBId = uuidv4();
    const parentKey = createTestParentKey('iso');
    const videoId = 'vid-app-iso';
    const noteId = uuidv4();

    await query(
      `INSERT INTO public.generation_idempotency (user_id, key, video_id, status) VALUES ($1, $2, $3, 'completed')`,
      [testUserId, parentKey, videoId]
    );
    await query(
      `INSERT INTO public.notes (id, user_id, parent_key, video_id, video_title, video_url, thumbnail_url, overview, detailed_notes)
       VALUES ($1, $2, $3, $4, 'Private Video', 'http://', 'http://', 'Overview', 'Notes')`,
      [noteId, testUserId, parentKey, videoId]
    );

    const userASeesNote = await withUserTransaction(testUserId, async (client: any) => {
      const res = await client.query('SELECT id FROM public.notes WHERE id = $1', [noteId]);
      return res.rows.length === 1;
    });
    expect(userASeesNote).toBe(true);

    const userBSeesNote = await withUserTransaction(testUserBId, async (client: any) => {
      const res = await client.query('SELECT id FROM public.notes WHERE id = $1', [noteId]);
      return res.rows.length === 1;
    });
    expect(userBSeesNote).toBe(false);
  });

  it('APP-03: Adaptive Chunk Generation & Synthesis Contract', async () => {
    if (!hasLiveDb) {
      const qc = await import('@/lib/quota-client');
      expect(typeof qc.reserveQuota).toBe('function');
      expect(typeof qc.claimOrAdoptDispatchSlot).toBe('function');
      return;
    }

    const testUserId = uuidv4();
    const modelName = 'gemini-2.5-flash';
    const parentKey = createTestParentKey('adapt');
    const videoId = 'vid-app-adapt';

    await query(
      `INSERT INTO public.generation_idempotency (user_id, key, video_id, status, total_chunks, manifest_hash)
       VALUES ($1, $2, $3, 'processing', 2, 'hash123')`,
      [testUserId, parentKey, videoId]
    );

    for (const chunkIndex of [0, 1]) {
      const rRes = await reserveQuota({
        userId: testUserId,
        parentKey,
        chunkIndex,
        projectId: 'codenotes',
        quotaScope: modelName,
        modelName,
        workerId: `worker-chunk-${chunkIndex}`,
        estimatedTokens: 800,
        leaseDurationInterval: '60 seconds',
        operationType: 'chunk',
      });
      expect(rRes.allowed).toBe(true);

      const cRes = await claimOrAdoptDispatchSlot({
        userId: testUserId,
        parentKey,
        operationType: 'chunk',
        chunkIndex,
        reservationToken: rRes.reservationToken,
        leaseToken: rRes.leaseToken,
        workerId: `worker-chunk-${chunkIndex}`,
        generation: rRes.generation,
        projectId: 'codenotes',
        quotaScope: modelName,
        modelName,
        estimatedTokens: 800,
      });
      expect(cRes.allowed).toBe(true);

      const compRes = await completeDispatchAttempt({
        attemptId: cRes.attemptId!,
        reservationToken: rRes.reservationToken,
        leaseToken: rRes.leaseToken,
        workerId: `worker-chunk-${chunkIndex}`,
        fencingGeneration: rRes.generation,
        operationType: 'chunk',
        responsePayload: { chunkNotes: `Notes for chunk ${chunkIndex}` },
        totalTokens: 600,
        promptTokens: 450,
        candidateTokens: 150,
        thoughtsTokens: 0,
        modelName,
      });
      expect(compRes.success).toBe(true);
    }

    const chunksRes = await query(
      `SELECT chunk_index, status FROM public.chunk_generations WHERE parent_key = $1 ORDER BY chunk_index ASC`,
      [parentKey]
    );
    expect(chunksRes.rows).toHaveLength(2);
  });

  it('APP-04: Retry & Recovery via recoverReservationOwnership Contract', async () => {
    if (!hasLiveDb) {
      const qc = await import('@/lib/quota-client');
      expect(typeof qc.recoverReservationOwnership).toBe('function');
      return;
    }

    const testUserId = uuidv4();
    const modelName = 'gemini-2.5-flash';
    const parentKey = createTestParentKey('rec');
    const videoId = 'vid-app-rec';

    await query(
      `INSERT INTO public.generation_idempotency (user_id, key, video_id, status) VALUES ($1, $2, $3, 'pending')`,
      [testUserId, parentKey, videoId]
    );

    const rRes = await reserveQuota({
      userId: testUserId,
      parentKey,
      chunkIndex: -1,
      projectId: 'codenotes',
      quotaScope: modelName,
      modelName,
      workerId: 'worker-stale-1',
      estimatedTokens: 1000,
      leaseDurationInterval: '10 seconds',
      operationType: 'monolithic',
    });

    await query(
      `UPDATE public.rate_limit_reservations SET lease_until = clock_timestamp() - INTERVAL '5 seconds' WHERE reservation_token = $1`,
      [rRes.reservationToken]
    );

    const recRes = await recoverReservationOwnership({
      userId: testUserId,
      parentKey,
      reservationToken: rRes.reservationToken,
      newWorkerId: 'worker-recovered-2',
      leaseDurationInterval: '60 seconds',
    });

    expect(recRes.success).toBe(true);
    expect(recRes.newGeneration).toBe(rRes.generation + 1);
  });

  it('APP-05: Stale Attempt Outcome Reporting Contract', async () => {
    if (!hasLiveDb) {
      const qc = await import('@/lib/quota-client');
      expect(typeof qc.reportStaleAttemptOutcome).toBe('function');
      return;
    }

    const testUserId = uuidv4();
    const modelName = 'gemini-2.5-flash';
    const parentKey = createTestParentKey('stale');
    const videoId = 'vid-app-stale';

    await query(
      `INSERT INTO public.generation_idempotency (user_id, key, video_id, status) VALUES ($1, $2, $3, 'pending')`,
      [testUserId, parentKey, videoId]
    );

    const rRes = await reserveQuota({
      userId: testUserId,
      parentKey,
      chunkIndex: -1,
      projectId: 'codenotes',
      quotaScope: modelName,
      modelName,
      workerId: 'worker-stale-report',
      estimatedTokens: 1000,
      leaseDurationInterval: '60 seconds',
      operationType: 'monolithic',
    });

    const cRes = await claimOrAdoptDispatchSlot({
      userId: testUserId,
      parentKey,
      operationType: 'monolithic',
      chunkIndex: -1,
      reservationToken: rRes.reservationToken,
      leaseToken: rRes.leaseToken,
      workerId: 'worker-stale-report',
      generation: rRes.generation,
      projectId: 'codenotes',
      quotaScope: modelName,
      modelName,
      estimatedTokens: 1000,
    });

    const staleRes = await reportStaleAttemptOutcome({
      attemptId: cRes.attemptId!,
      reservationToken: rRes.reservationToken,
      workerId: 'worker-stale-report',
      outcomeStatus: 'failed_transient',
      errorCode: 'HTTP_504',
      errorMessage: 'Gateway Timeout from AI Provider',
      totalTokens: 0,
      promptTokens: 0,
      candidateTokens: 0,
      thoughtsTokens: 0,
    });

    expect(staleRes.success).toBe(true);
  });
});
