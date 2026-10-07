'use strict';
/**
 * scripts/verify-rls.js
 *
 * Standalone verification script for PostgreSQL Row Level Security (RLS).
 * Directly tests multi-user isolation, IDOR read prevention, and IDOR delete
 * prevention using withUserTransaction() against a real PostgreSQL instance.
 *
 * Usage:
 *   node scripts/verify-rls.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });

if (!process.env.DATABASE_URL) {
  console.error('[verify-rls] DATABASE_URL is not set. Please configure .env.local.');
  process.exit(1);
}

const { Pool } = require('pg');
const crypto = require('crypto');

const ssl =
  process.env.NODE_ENV === 'production'
    ? {
        ca: process.env.DATABASE_CA_CERT,
        rejectUnauthorized: true,
      }
    : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  connectionTimeoutMillis: 5000,
});

async function withUserTx(userId, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', userId]);
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);

    try {
      await client.query('SET LOCAL ROLE authenticated');
    } catch (roleErr) {
      console.warn('[verify-rls] NOTE: SET LOCAL ROLE authenticated skipped (local environment without Supabase roles):', roleErr.message);
    }

    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function createTestUser(client, userId, email) {
  const checkAuthUsers = await client.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  `);

  if (checkAuthUsers.rows.length > 0) {
    await client.query(
      `INSERT INTO auth.users (
        id,
        instance_id,
        aud,
        role,
        email,
        encrypted_password,
        email_confirmed_at,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
      ) VALUES (
        $1,
        '00000000-0000-0000-0000-000000000000',
        'authenticated',
        'authenticated',
        $2,
        'test-password-hash',
        NOW(),
        '{"provider":"email","providers":["email"]}',
        '{}',
        NOW(),
        NOW()
      ) ON CONFLICT (id) DO NOTHING`,
      [userId, email]
    );
  }
}

async function verifyRls() {
  console.log('[verify-rls] Starting database-level RLS verification...');

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const emailA = `test-user-a-${userA.substring(0, 8)}@codenotes.test`;
  const emailB = `test-user-b-${userB.substring(0, 8)}@codenotes.test`;
  const noteIdA = crypto.randomUUID();
  const noteIdB = crypto.randomUUID();
  const sharedIdempotencyKey = `idemp-${crypto.randomBytes(8).toString('hex')}`;

  let adminClient;

  try {
    adminClient = await pool.connect();

    // Establish genuine test users in auth.users to satisfy foreign key constraints
    console.log('[verify-rls] Establishing temporary test users in auth.users...');
    await createTestUser(adminClient, userA, emailA);
    await createTestUser(adminClient, userB, emailB);
    console.log('[verify-rls] Test users established: User A and User B.');

    // 1. User A creates and reads own note
    console.log('[verify-rls] Step 1: User A creating Note A...');
    await withUserTx(userA, async (client) => {
      await client.query(
        `INSERT INTO notes (id, user_id, video_id, video_title, video_url, overview, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [noteIdA, userA, 'vidA1234567', 'User A Note', 'https://youtube.com/watch?v=vidA1234567', 'Overview A']
      );
    });

    const readNoteA = await withUserTx(userA, async (client) => {
      const res = await client.query('SELECT id, video_title FROM notes WHERE id = $1', [noteIdA]);
      return res.rows;
    });

    if (readNoteA.length !== 1 || readNoteA[0].id !== noteIdA) {
      throw new Error('RLS ERROR: User A was unable to read own note!');
    }
    console.log('[verify-rls] PASS (1/7): User A can create and read own note.');

    // 2. User B cannot read User A note
    console.log('[verify-rls] Step 2: User B attempting IDOR read on Note A...');
    const userBReadNoteA = await withUserTx(userB, async (client) => {
      const res = await client.query('SELECT * FROM notes WHERE id = $1', [noteIdA]);
      return res.rows;
    });

    if (userBReadNoteA.length !== 0) {
      throw new Error('RLS VIOLATION: User B was able to read User A note!');
    }
    console.log('[verify-rls] PASS (2/7): User B cannot read User A note (0 rows returned).');

    // 3. User B cannot delete User A note
    console.log('[verify-rls] Step 3: User B attempting IDOR delete on Note A...');
    const userBDeleteNoteA = await withUserTx(userB, async (client) => {
      const res = await client.query('DELETE FROM notes WHERE id = $1', [noteIdA]);
      return res.rowCount;
    });

    if (userBDeleteNoteA !== 0) {
      throw new Error('RLS VIOLATION: User B was able to delete User A note!');
    }
    console.log('[verify-rls] PASS (3/7): User B cannot delete User A note (0 rows deleted).');

    // 4. User B cannot update User A note
    console.log('[verify-rls] Step 4: User B attempting IDOR update on Note A...');
    const userBUpdateNoteA = await withUserTx(userB, async (client) => {
      const res = await client.query('UPDATE notes SET overview = $1 WHERE id = $2', ['Tampered Overview', noteIdA]);
      return res.rowCount;
    });

    if (userBUpdateNoteA !== 0) {
      throw new Error('RLS VIOLATION: User B was able to update User A note!');
    }
    console.log('[verify-rls] PASS (4/7): User B cannot update User A note (0 rows updated).');

    // 5. User B creates and reads own note
    console.log('[verify-rls] Step 5: User B creating Note B...');
    await withUserTx(userB, async (client) => {
      await client.query(
        `INSERT INTO notes (id, user_id, video_id, video_title, video_url, overview, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [noteIdB, userB, 'vidB1234567', 'User B Note', 'https://youtube.com/watch?v=vidB1234567', 'Overview B']
      );
    });

    const readNoteB = await withUserTx(userB, async (client) => {
      const res = await client.query('SELECT id, video_title FROM notes WHERE id = $1', [noteIdB]);
      return res.rows;
    });

    if (readNoteB.length !== 1 || readNoteB[0].id !== noteIdB) {
      throw new Error('RLS ERROR: User B was unable to read own note!');
    }
    console.log('[verify-rls] PASS (5/7): User B can create and read own note.');

    // 6. Compound idempotency key isolation (User A and User B can generate with the same key concurrently)
    console.log('[verify-rls] Step 6: Testing compound idempotency key isolation with shared key...');
    await withUserTx(userA, async (client) => {
      await client.query(
        `INSERT INTO generation_idempotency (user_id, key, status, note_id)
         VALUES ($1, $2, 'completed', $3)`,
        [userA, sharedIdempotencyKey, noteIdA]
      );
    });

    await withUserTx(userB, async (client) => {
      await client.query(
        `INSERT INTO generation_idempotency (user_id, key, status, note_id)
         VALUES ($1, $2, 'completed', $3)`,
        [userB, sharedIdempotencyKey, noteIdB]
      );
    });
    console.log('[verify-rls] PASS (6/7): User A and User B inserted records with identical idempotency key without primary key conflict.');

    // 7. User A cannot read User B idempotency records
    console.log('[verify-rls] Step 7: User A querying idempotency records...');
    const userAIdempRecords = await withUserTx(userA, async (client) => {
      const res = await client.query('SELECT user_id, key, note_id FROM generation_idempotency WHERE key = $1', [sharedIdempotencyKey]);
      return res.rows;
    });

    if (userAIdempRecords.some((r) => r.user_id === userB || r.note_id === noteIdB)) {
      throw new Error('RLS VIOLATION: User A was able to read User B idempotency record!');
    }
    if (!userAIdempRecords.some((r) => r.user_id === userA && r.note_id === noteIdA)) {
      throw new Error('RLS ERROR: User A was unable to read own idempotency record!');
    }
    console.log('[verify-rls] PASS (7/7): User A cannot read User B idempotency records.');

    console.log('\n[verify-rls] ALL 7 DATABASE RLS AND ISOLATION CHECKS PASSED SUCCESSFULLY.');
  } catch (err) {
    console.error('[verify-rls] FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    // Cleanup test records and test users
    try {
      if (adminClient) {
        console.log('[verify-rls] Cleaning up test records and test users...');
        await adminClient.query('DELETE FROM generation_idempotency WHERE key = $1', [sharedIdempotencyKey]).catch(() => {});
        await adminClient.query('DELETE FROM notes WHERE id IN ($1, $2)', [noteIdA, noteIdB]).catch(() => {});
        const checkAuthUsers = await adminClient.query(`
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'auth' AND table_name = 'users'
        `);
        if (checkAuthUsers.rows.length > 0) {
          await adminClient.query('DELETE FROM auth.users WHERE id IN ($1, $2)', [userA, userB]).catch(() => {});
        }
        console.log('[verify-rls] Cleanup completed.');
      }
    } catch (_) {}

    if (adminClient) {
      adminClient.release();
    }
    await pool.end();
  }
}

verifyRls();
