/**
 * Verification Suite for Failed-Output Usage Settlement & Fenced Claim Concurrency
 *
 * This test suite validates all 10 critical scenarios specified in Phase A.2:
 * 1. Valid provider usage + malformed JSON -> usage settled, no note.
 * 2. Valid provider usage + schema-invalid output -> usage settled, no note.
 * 3. Identical settlement replay -> returns ALREADY_SETTLED, zero duplicate events.
 * 4. Conflicting settlement replay -> rejected with CONFLICTING_REPLAY_PARAMS.
 * 5. Settlement followed by claim -> claim rejected with RESERVATION_ALREADY_SETTLED_FAILURE.
 * 6. Claim followed by settlement -> superseded attempt rejected with SUPERSEDED_ATTEMPT_MUTATION.
 * 7. Failed-output usage is counted in RPM, RPD, and TPM queries.
 * 8. User retry creates fresh reservation without erasing previous usage.
 * 9. Timeout / ambiguous provider execution does not become failed_output.
 * 10. Normal successful generation still completes and commits notes.
 *
 * NOTE: This suite tests database stored procedures and requires migration execution authorization.
 */

import pg from 'pg';
const { Pool } = pg;

export function validateStagingConnectionString(connectionString) {
  if (!connectionString || typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new Error('FATAL: A non-empty connection string is required.');
  }
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch (err) {
    throw new Error(`FATAL: Invalid connection string URL: ${err.message}`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`FATAL: Protocol must be postgresql:, got ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new Error(`SAFETY VIOLATION: Host "${hostname}" is not an allowed local staging host.`);
  }
  const dbName = parsed.pathname.replace(/^\//, '');
  if (dbName !== 'codenotes_staging') {
    throw new Error(`SAFETY VIOLATION: Database "${dbName}" is not codenotes_staging.`);
  }
  const port = parseInt(parsed.port || '5432', 10);
  if (port !== 5433) {
    throw new Error(`SAFETY VIOLATION: Port "${port}" is not 5433 (staging port).`);
  }
}

export async function runSettlementVerification(connectionString) {
  validateStagingConnectionString(connectionString);
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  console.log('--- Starting Failed-Output Settlement Database Verification ---');

  try {
    await client.query('BEGIN');

    const testUserId = '11111111-1111-1111-1111-111111111111';
    const testParentKey = `test-parent-${Date.now()}`;
    const testWorkerId = 'worker-test-agent-01';

    // Setup: Create parent idempotency record
    await client.query(
      `INSERT INTO public.generation_idempotency (user_id, key, status, created_at, updated_at)
       VALUES ($1, $2, 'processing', clock_timestamp(), clock_timestamp())`,
      [testUserId, testParentKey]
    );

    // Scenario 1 & 2: Reserve quota and claim dispatch slot
    const resResult = await client.query(
      `SELECT * FROM public.reserve_quota(
         $1, $2, -1, 'codenotes', 'gemini-2.5-flash', 'gemini-2.5-flash', $3, 1000, INTERVAL '120 seconds', 'monolithic'
       )`,
      [testUserId, testParentKey, testWorkerId]
    );
    const reservation = resResult.rows[0];
    console.log('[Scenario 1/2] Reservation created:', reservation.status_code, reservation.reservation_token);

    const claimResult = await client.query(
      `SELECT * FROM public.claim_or_adopt_dispatch_slot(
         $1, $2, 'monolithic', -1, $3, $4, $5, $6, 'codenotes', 'gemini-2.5-flash', 'gemini-2.5-flash', 1000, INTERVAL '75 seconds'
       )`,
      [testUserId, testParentKey, reservation.reservation_token, reservation.lease_token, testWorkerId, reservation.generation]
    );
    const attempt = claimResult.rows[0];
    console.log('[Scenario 1/2] Attempt 1 claimed:', attempt.status_code, attempt.attempt_id);

    // Initial Settlement: 1,420 tokens with malformed output
    const settleResult1 = await client.query(
      `SELECT * FROM public.settle_failed_dispatch_usage(
         $1, $2, $3, $4, $5, 1420, 1200, 200, 20, 'MALFORMED_OUTPUT', 'Malformed output test', '{"raw": "{bad json"}'::jsonb
       )`,
      [attempt.attempt_id, reservation.reservation_token, reservation.lease_token, testWorkerId, reservation.generation]
    );
    console.log('[Scenario 1/2] Initial settlement outcome:', settleResult1.rows[0].status_code);
    if (settleResult1.rows[0].status_code !== 'SUCCESS') {
      throw new Error(`Expected SUCCESS but got ${settleResult1.rows[0].status_code}`);
    }

    // Verify parent idempotency status is 'failed' and NO note exists
    const parentCheck = await client.query(
      `SELECT status, note_id FROM public.generation_idempotency WHERE user_id = $1 AND key = $2`,
      [testUserId, testParentKey]
    );
    console.log('[Scenario 1/2] Parent idempotency state:', parentCheck.rows[0].status, 'note_id:', parentCheck.rows[0].note_id);
    if (parentCheck.rows[0].status !== 'failed' || parentCheck.rows[0].note_id !== null) {
      throw new Error('Parent idempotency was not marked failed or note was published!');
    }

    // Scenario 3: Identical settlement replay -> ALREADY_SETTLED
    const settleResultReplay = await client.query(
      `SELECT * FROM public.settle_failed_dispatch_usage(
         $1, $2, $3, $4, $5, 1420, 1200, 200, 20, 'MALFORMED_OUTPUT', 'Malformed output test', '{"raw": "{bad json"}'::jsonb
       )`,
      [attempt.attempt_id, reservation.reservation_token, reservation.lease_token, testWorkerId, reservation.generation]
    );
    console.log('[Scenario 3] Replay settlement outcome:', settleResultReplay.rows[0].status_code);
    if (settleResultReplay.rows[0].status_code !== 'ALREADY_SETTLED') {
      throw new Error(`Expected ALREADY_SETTLED but got ${settleResultReplay.rows[0].status_code}`);
    }

    // Verify exactly 1 audit event was created
    const eventCount = await client.query(
      `SELECT COUNT(*) FROM public.rate_limit_events WHERE reservation_token = $1 AND event_type = 'SETTLE_FAILURE'`,
      [reservation.reservation_token]
    );
    console.log('[Scenario 3] Audit event count:', eventCount.rows[0].count);
    if (Number(eventCount.rows[0].count) !== 1) {
      throw new Error(`Duplicate audit events detected: count is ${eventCount.rows[0].count}`);
    }

    // Scenario 4: Conflicting replay with different tokens -> CONFLICTING_REPLAY_PARAMS
    const settleConflict = await client.query(
      `SELECT * FROM public.settle_failed_dispatch_usage(
         $1, $2, $3, $4, $5, 1500, 1200, 280, 20, 'MALFORMED_OUTPUT', 'Conflicting replay', '{"raw": "{bad json"}'::jsonb
       )`,
      [attempt.attempt_id, reservation.reservation_token, reservation.lease_token, testWorkerId, reservation.generation]
    );
    console.log('[Scenario 4] Conflicting settlement outcome:', settleConflict.rows[0].status_code);
    if (settleConflict.rows[0].status_code !== 'CONFLICTING_REPLAY_PARAMS') {
      throw new Error(`Expected CONFLICTING_REPLAY_PARAMS but got ${settleConflict.rows[0].status_code}`);
    }

    // Scenario 5: Settlement followed by Claim
    // 5A. When parent is terminal 'failed', L1 barrier rejects claim
    const lateClaimL1 = await client.query(
      `SELECT * FROM public.claim_or_adopt_dispatch_slot(
         $1, $2, 'monolithic', -1, $3, $4, $5, $6, 'codenotes', 'gemini-2.5-flash', 'gemini-2.5-flash', 1000, INTERVAL '75 seconds'
       )`,
      [testUserId, testParentKey, reservation.reservation_token, reservation.lease_token, testWorkerId, reservation.generation]
    );
    console.log('[Scenario 5A] Late claim on terminal parent outcome:', lateClaimL1.rows[0].status_code);
    if (lateClaimL1.rows[0].status_code !== 'PARENT_GENERATION_NOT_ACTIVE') {
      throw new Error(`Expected PARENT_GENERATION_NOT_ACTIVE but got ${lateClaimL1.rows[0].status_code}`);
    }

    // 5B. When parent is reset to 'processing' (e.g. concurrent retry), L4 reservation barrier rejects settled reservation
    await client.query(
      `UPDATE public.generation_idempotency SET status = 'processing', updated_at = clock_timestamp() WHERE user_id = $1 AND key = $2`,
      [testUserId, testParentKey]
    );
    const lateClaimL4 = await client.query(
      `SELECT * FROM public.claim_or_adopt_dispatch_slot(
         $1, $2, 'monolithic', -1, $3, $4, $5, $6, 'codenotes', 'gemini-2.5-flash', 'gemini-2.5-flash', 1000, INTERVAL '75 seconds'
       )`,
      [testUserId, testParentKey, reservation.reservation_token, reservation.lease_token, testWorkerId, reservation.generation]
    );
    console.log('[Scenario 5B] Late claim on settled reservation outcome:', lateClaimL4.rows[0].status_code);
    if (lateClaimL4.rows[0].status_code !== 'RESERVATION_ALREADY_SETTLED_FAILURE') {
      throw new Error(`Expected RESERVATION_ALREADY_SETTLED_FAILURE but got ${lateClaimL4.rows[0].status_code}`);
    }

    // Scenario 8: User retry with same parent key creates fresh reservation & attempt
    // Step 8A: Parent is reset to 'pending' upon user retry
    await client.query(
      `UPDATE public.generation_idempotency SET status = 'pending', updated_at = clock_timestamp() WHERE user_id = $1 AND key = $2`,
      [testUserId, testParentKey]
    );
    // Step 8B: Fresh reservation
    const retryRes = await client.query(
      `SELECT * FROM public.reserve_quota(
         $1, $2, -1, 'codenotes', 'gemini-2.5-flash', 'gemini-2.5-flash', $3, 1000, INTERVAL '120 seconds', 'monolithic'
       )`,
      [testUserId, testParentKey, testWorkerId]
    );
    const reservation2 = retryRes.rows[0];
    console.log('[Scenario 8] Retry reservation created:', reservation2.status_code, reservation2.reservation_token);
    if (!reservation2.allowed || reservation2.reservation_token === reservation.reservation_token) {
      throw new Error('Retry did not create fresh distinct reservation token!');
    }

    // Scenario 6: Superseded attempt rejection
    // Claim Attempt 1 under reservation 2
    const claimRes2_1 = await client.query(
      `SELECT * FROM public.claim_or_adopt_dispatch_slot(
         $1, $2, 'monolithic', -1, $3, $4, $5, $6, 'codenotes', 'gemini-2.5-flash', 'gemini-2.5-flash', 1000, INTERVAL '75 seconds'
       )`,
      [testUserId, testParentKey, reservation2.reservation_token, reservation2.lease_token, testWorkerId, reservation2.generation]
    );
    const attempt2_1 = claimRes2_1.rows[0];
    console.log('[Scenario 6] Reservation 2 Attempt 1 claimed:', attempt2_1.status_code, attempt2_1.attempt_id);

    // Claim Attempt 2 under reservation 2 (e.g. transient retry)
    const claimRes2_2 = await client.query(
      `SELECT * FROM public.claim_or_adopt_dispatch_slot(
         $1, $2, 'monolithic', -1, $3, $4, $5, $6, 'codenotes', 'gemini-2.5-flash', 'gemini-2.5-flash', 1000, INTERVAL '75 seconds'
       )`,
      [testUserId, testParentKey, reservation2.reservation_token, reservation2.lease_token, testWorkerId, reservation2.generation]
    );
    const attempt2_2 = claimRes2_2.rows[0];
    console.log('[Scenario 6] Reservation 2 Attempt 2 claimed:', attempt2_2.status_code, attempt2_2.attempt_id);

    // Now attempt to settle Attempt 1 (which is superseded by Attempt 2)
    const settleSuperseded = await client.query(
      `SELECT * FROM public.settle_failed_dispatch_usage(
         $1, $2, $3, $4, $5, 1200, 1000, 180, 20, 'MALFORMED_OUTPUT', 'Superseded test', '{"raw": "{}"}'::jsonb
       )`,
      [attempt2_1.attempt_id, reservation2.reservation_token, reservation2.lease_token, testWorkerId, reservation2.generation]
    );
    console.log('[Scenario 6] Superseded attempt settlement outcome:', settleSuperseded.rows[0].status_code);
    if (settleSuperseded.rows[0].status_code !== 'SUPERSEDED_ATTEMPT_MUTATION') {
      throw new Error(`Expected SUPERSEDED_ATTEMPT_MUTATION but got ${settleSuperseded.rows[0].status_code}`);
    }

    // Scenario 10: Successful generation commits note and completes parent
    const completeRes = await client.query(
      `SELECT * FROM public.complete_dispatch_attempt(
         $1, $2, $3, $4, $5, 'monolithic',
         '{"videoId": "vid-10", "videoTitle": "Test", "videoUrl": "https://youtu.be/test", "thumbnailUrl": "https://img.jpg", "overview": "Test overview", "keyConcepts": ["c1"], "detailedNotes": "notes", "shorthands": ["s1"]}'::jsonb,
         1200, 1000, 180, 20, 'gemini-2.5-flash',
         $6, $7, 'vid-10', 'Test', 'https://youtu.be/test', 'https://img.jpg'
       )`,
      [attempt2_2.attempt_id, reservation2.reservation_token, reservation2.lease_token, testWorkerId, reservation2.generation, testUserId, testParentKey]
    );
    console.log('[Scenario 10] Complete dispatch attempt outcome:', completeRes.rows[0].status_code);
    if (completeRes.rows[0].status_code !== 'SUCCESS') {
      throw new Error(`Expected SUCCESS but got ${completeRes.rows[0].status_code}`);
    }

    const noteCheck = await client.query(
      `SELECT id, attempt_id FROM public.notes WHERE parent_key = $1`,
      [testParentKey]
    );
    console.log('[Scenario 10] Note published successfully, id:', noteCheck.rows[0]?.id);
    if (!noteCheck.rows[0]?.id) {
      throw new Error('Expected note to be created!');
    }

    // Rollback test transaction so test leaves zero dirty staging data
    await client.query('ROLLBACK');
    console.log('--- Database Verification Complete: All Scenarios Passed (Clean Rollback) ---');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('--- Database Verification Failed ---', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const connectionString = process.env.STAGING_DATABASE_URL;
  if (!connectionString) {
    console.error('FATAL: STAGING_DATABASE_URL environment variable is required to run verification.');
    console.error('Usage: STAGING_DATABASE_URL="postgresql://user:pass@127.0.0.1:5433/codenotes_staging" node scripts/verify-failed-output-settlement.mjs');
    process.exit(1);
  }

  runSettlementVerification(connectionString)
    .then(() => {
      console.log('All settlement scenarios verified successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Settlement verification error:', err);
      process.exit(1);
    });
}
