import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { migrateDatabase } from '../../scripts/migrate';

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ALLOWED_DATABASES = new Set(['codenotes_test']);

/**
 * Validates that TEST_DATABASE_URL is set and strictly points to an approved local test database.
 * Fails closed immediately if missing, invalid, pointing to cloud/production infrastructure,
 * or using an unapproved host/database name.
 */
export function validateTestDatabaseUrl(urlStr: string | undefined): {
  url: string;
  hostname: string;
  database: string;
  port: string;
} {
  if (!urlStr || urlStr.trim() === '') {
    throw new Error(
      '[RLS Security Test] FATAL: TEST_DATABASE_URL is not set. ' +
        'Set TEST_DATABASE_URL to an isolated test PostgreSQL database (e.g. postgresql://postgres:postgres@localhost:5432/codenotes_test) ' +
        'to run live RLS integration tests.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch (err: any) {
    throw new Error(`[RLS Security Test] FATAL: TEST_DATABASE_URL is not a valid URL: ${err?.message}`);
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      `[RLS Security Test] FATAL: TEST_DATABASE_URL must use postgresql: protocol, received: ${parsed.protocol}`
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(
      `[RLS Security Test] SAFETY VIOLATION: Host "${hostname}" is not an allowed local test host. ` +
        `Only explicitly approved local test hosts (${Array.from(ALLOWED_HOSTS).join(', ')}) are permitted.`
    );
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (!ALLOWED_DATABASES.has(database)) {
    throw new Error(
      `[RLS Security Test] SAFETY VIOLATION: Database "${database}" is not an approved test database. ` +
        `Only dedicated test databases (${Array.from(ALLOWED_DATABASES).join(', ')}) are permitted.`
    );
  }

  return {
    url: urlStr,
    hostname,
    database,
    port: parsed.port || '5432',
  };
}

describe('TEST_DATABASE_URL Safety & Destination Validation', () => {
  it('rejects undefined, empty, or whitespace-only URLs', () => {
    expect(() => validateTestDatabaseUrl(undefined)).toThrow(/TEST_DATABASE_URL is not set/i);
    expect(() => validateTestDatabaseUrl('')).toThrow(/TEST_DATABASE_URL is not set/i);
    expect(() => validateTestDatabaseUrl('   ')).toThrow(/TEST_DATABASE_URL is not set/i);
  });

  it('rejects invalid or non-postgres protocols', () => {
    expect(() => validateTestDatabaseUrl('not-a-valid-url')).toThrow(/not a valid URL/i);
    expect(() => validateTestDatabaseUrl('http://localhost:5432/codenotes_test')).toThrow(
      /must use postgresql: protocol/i
    );
    expect(() => validateTestDatabaseUrl('mysql://localhost:3306/codenotes_test')).toThrow(
      /must use postgresql: protocol/i
    );
  });

  it('rejects disallowed, remote, or cloud hostnames', () => {
    expect(() =>
      validateTestDatabaseUrl('postgresql://postgres:secret@db.supabase.co:5432/codenotes_test')
    ).toThrow(/SAFETY VIOLATION: Host "db.supabase.co" is not an allowed local test host/i);

    expect(() =>
      validateTestDatabaseUrl('postgresql://postgres:secret@aws.rds.amazonaws.com:5432/codenotes_test')
    ).toThrow(/SAFETY VIOLATION: Host "aws.rds.amazonaws.com" is not an allowed local test host/i);

    expect(() =>
      validateTestDatabaseUrl('postgresql://postgres:secret@192.168.1.100:5432/codenotes_test')
    ).toThrow(/SAFETY VIOLATION: Host "192.168.1.100" is not an allowed local test host/i);
  });

  it('rejects disallowed database names even on localhost', () => {
    expect(() =>
      validateTestDatabaseUrl('postgresql://postgres:postgres@localhost:5432/postgres')
    ).toThrow(/SAFETY VIOLATION: Database "postgres" is not an approved test database/i);

    expect(() =>
      validateTestDatabaseUrl('postgresql://postgres:postgres@localhost:5432/production')
    ).toThrow(/SAFETY VIOLATION: Database "production" is not an approved test database/i);

    expect(() =>
      validateTestDatabaseUrl('postgresql://postgres:postgres@localhost:5432/codenotes_prod')
    ).toThrow(/SAFETY VIOLATION: Database "codenotes_prod" is not an approved test database/i);
  });

  it('accepts explicitly approved hosts (localhost, 127.0.0.1, ::1) with database codenotes_test', () => {
    const res1 = validateTestDatabaseUrl('postgresql://postgres:postgres@localhost:54332/codenotes_test');
    expect(res1.hostname).toBe('localhost');
    expect(res1.database).toBe('codenotes_test');
    expect(res1.port).toBe('54332');

    const res2 = validateTestDatabaseUrl('postgresql://postgres:pw@127.0.0.1:5432/codenotes_test');
    expect(res2.hostname).toBe('127.0.0.1');
    expect(res2.database).toBe('codenotes_test');
    expect(res2.port).toBe('5432');
  });
});

describe('PostgreSQL Row Level Security (RLS) Engine Enforcement (Real Migration)', () => {
  let testPool: Pool;
  let testDbUrl: string;

  const USER_A_ID = '11111111-1111-4111-8111-111111111111';
  const USER_B_ID = '22222222-2222-4222-8222-222222222222';
  const NOTE_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const NOTE_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  /**
   * Helper to run queries inside a transaction configured with Supabase-compatible JWT claims
   * and switched to the 'authenticated' role.
   */
  async function executeAsUser<T>(
    userId: string,
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', userId]);
      await client.query('SELECT set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
      await client.query('SET LOCAL ROLE authenticated');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    const validated = validateTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    testDbUrl = validated.url;

    testPool = new Pool({
      connectionString: testDbUrl,
      ssl: false,
      connectionTimeoutMillis: 5000,
    });

    const adminClient = await testPool.connect();
    try {
      // 1. Verify connected database identity matches allowed test database
      const dbIdentity = await adminClient.query('SELECT current_database(), current_user');
      const currentDb = dbIdentity.rows[0].current_database;
      if (currentDb !== 'codenotes_test') {
        throw new Error(
          `[RLS Security Test] Safety check failed: Connected database name is "${currentDb}", expected "codenotes_test".`
        );
      }

      await adminClient.query('BEGIN');

      // 2. Setup Supabase-compatible roles, schemas, and auth functions in test DB
      await adminClient.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            CREATE ROLE authenticated;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            CREATE ROLE anon;
          END IF;
        END $$;

        CREATE SCHEMA IF NOT EXISTS auth;

        CREATE TABLE IF NOT EXISTS auth.users (
          id UUID PRIMARY KEY,
          email TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
          SELECT NULLIF(
            COALESCE(
              current_setting('request.jwt.claim.sub', true),
              (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
            ),
            ''
          )::uuid;
        $$ LANGUAGE sql STABLE;

        CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$
          SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
        $$ LANGUAGE sql STABLE;

        GRANT USAGE ON SCHEMA public TO authenticated;
        GRANT USAGE ON SCHEMA auth TO authenticated;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated;
        GRANT ALL ON ALL TABLES IN SCHEMA auth TO authenticated;
      `);

      await adminClient.query('COMMIT');

      // 3. Apply the authoritative production migration directly to the test database
      await migrateDatabase(testDbUrl, false);

      // 4. Seed test users into auth.users table
      await adminClient.query('BEGIN');
      await adminClient.query(`
        INSERT INTO auth.users (id, email) VALUES
          ('${USER_A_ID}', 'user-a@example.com'),
          ('${USER_B_ID}', 'user-b@example.com')
        ON CONFLICT (id) DO NOTHING;
      `);
      await adminClient.query('COMMIT');
    } catch (err) {
      try {
        await adminClient.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      adminClient.release();
    }
  });

  afterAll(async () => {
    if (testPool) {
      const adminClient = await testPool.connect();
      try {
        await adminClient.query('DELETE FROM notes WHERE id IN ($1, $2)', [NOTE_A_ID, NOTE_B_ID]);
        await adminClient.query('DELETE FROM auth.users WHERE id IN ($1, $2)', [USER_A_ID, USER_B_ID]);
      } catch {}
      adminClient.release();
      await testPool.end();
    }
  });

  it('1. Confirms the active transaction executes with role "authenticated" and matching auth.uid()', async () => {
    await executeAsUser(USER_A_ID, async (client) => {
      const res = await client.query(`
        SELECT
          current_user AS active_role,
          current_setting('request.jwt.claim.sub') AS claim_sub,
          auth.uid() AS resolved_uid
      `);
      expect(res.rows[0].active_role).toBe('authenticated');
      expect(res.rows[0].claim_sub).toBe(USER_A_ID);
      expect(res.rows[0].resolved_uid).toBe(USER_A_ID);
    });
  });

  it('2. User A successfully inserts and reads their own note under RLS', async () => {
    await executeAsUser(USER_A_ID, async (client) => {
      // Clean up if leftover
      await client.query('DELETE FROM notes WHERE id = $1', [NOTE_A_ID]);

      const insertRes = await client.query(
        `INSERT INTO notes (
          id, user_id, video_id, video_title, video_url, overview, key_concepts, detailed_notes, shorthands
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          NOTE_A_ID,
          USER_A_ID,
          'vid_abc_123',
          'User A Private Architecture Note',
          'https://youtube.com/watch?v=vid_abc_123',
          'Confidential overview of distributed systems.',
          ['Raft', 'Consensus'],
          '# Private Notes for User A',
          ['paxos'],
        ]
      );
      expect(insertRes.rowCount).toBe(1);

      const selectRes = await client.query('SELECT * FROM notes WHERE id = $1', [NOTE_A_ID]);
      expect(selectRes.rowCount).toBe(1);
      expect(selectRes.rows[0].id).toBe(NOTE_A_ID);
      expect(selectRes.rows[0].user_id).toBe(USER_A_ID);
      expect(selectRes.rows[0].video_title).toBe('User A Private Architecture Note');
    });
  });

  it('3. User B cannot SELECT User A note when deliberately omitting application user_id filter', async () => {
    await executeAsUser(USER_B_ID, async (client) => {
      // Note: We deliberately do NOT include "AND user_id = USER_B_ID"
      // RLS policy "notes_select_policy" from scripts/migrate.js must filter out the row at the engine level
      const res = await client.query('SELECT * FROM notes WHERE id = $1', [NOTE_A_ID]);
      expect(res.rowCount).toBe(0);
      expect(res.rows).toEqual([]);
    });
  });

  it('4. User B cannot DELETE User A note by ID alone, and the record remains intact', async () => {
    // User B attempts delete
    await executeAsUser(USER_B_ID, async (client) => {
      const deleteRes = await client.query('DELETE FROM notes WHERE id = $1', [NOTE_A_ID]);
      expect(deleteRes.rowCount).toBe(0);
    });

    // Verify as User A that the note was not deleted
    await executeAsUser(USER_A_ID, async (client) => {
      const selectRes = await client.query('SELECT * FROM notes WHERE id = $1', [NOTE_A_ID]);
      expect(selectRes.rowCount).toBe(1);
      expect(selectRes.rows[0].id).toBe(NOTE_A_ID);
    });
  });

  it('5. User B cannot UPDATE User A note, and contents remain unmodified', async () => {
    // User B attempts update
    await executeAsUser(USER_B_ID, async (client) => {
      const updateRes = await client.query(
        'UPDATE notes SET overview = $1 WHERE id = $2',
        ['Malicious overwrite by User B', NOTE_A_ID]
      );
      expect(updateRes.rowCount).toBe(0);
    });

    // Verify as User A that overview was not altered
    await executeAsUser(USER_A_ID, async (client) => {
      const selectRes = await client.query('SELECT overview FROM notes WHERE id = $1', [NOTE_A_ID]);
      expect(selectRes.rows[0].overview).toBe('Confidential overview of distributed systems.');
    });
  });

  it('6. User B cannot INSERT a note assigned to User A (INSERT WITH CHECK violation)', async () => {
    await executeAsUser(USER_B_ID, async (client) => {
      // User B attempts to insert a note with user_id = USER_A_ID
      const spoofedInsert = client.query(
        `INSERT INTO notes (
          id, user_id, video_id, video_title, video_url
        ) VALUES ($1, $2, $3, $4, $5)`,
        [
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          USER_A_ID,
          'vid_spoofed',
          'Spoofed Note',
          'https://youtube.com/watch?v=vid_spoofed',
        ]
      );

      // PostgreSQL must raise error code 42501 (insufficient_privilege / RLS policy violation)
      await expect(spoofedInsert).rejects.toThrow(
        /new row violates row-level security policy for table "notes"/i
      );
    });
  });

  it('7. User B can create their own note, which is strictly isolated from User A', async () => {
    // User B creates Note B
    await executeAsUser(USER_B_ID, async (client) => {
      const insertRes = await client.query(
        `INSERT INTO notes (
          id, user_id, video_id, video_title, video_url, overview
        ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          NOTE_B_ID,
          USER_B_ID,
          'vid_user_b',
          'User B Independent Note',
          'https://youtube.com/watch?v=vid_user_b',
          'User B study material.',
        ]
      );
      expect(insertRes.rowCount).toBe(1);

      const selectRes = await client.query('SELECT * FROM notes WHERE id = $1', [NOTE_B_ID]);
      expect(selectRes.rowCount).toBe(1);
    });

    // User A cannot SELECT Note B
    await executeAsUser(USER_A_ID, async (client) => {
      const selectRes = await client.query('SELECT * FROM notes WHERE id = $1', [NOTE_B_ID]);
      expect(selectRes.rowCount).toBe(0);
    });
  });
});
