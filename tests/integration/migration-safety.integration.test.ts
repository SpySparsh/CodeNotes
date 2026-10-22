import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { migrateDatabase, MIGRATION_LOCK_KEY } from '../../scripts/migrate';

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ALLOWED_DATABASES = new Set(['codenotes_test']);

function validateTestDatabaseUrl(urlStr: string | undefined): { url: string; hostname: string; database: string } {
  if (!urlStr || urlStr.trim() === '') {
    throw new Error('TEST_DATABASE_URL is not set.');
  }
  const parsed = new URL(urlStr);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`TEST_DATABASE_URL must use postgresql: protocol, got: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(`Host "${hostname}" is not an allowed local test host.`);
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (!ALLOWED_DATABASES.has(database)) {
    throw new Error(`Database "${database}" is not an approved test database.`);
  }
  return { url: urlStr, hostname, database };
}

describe('Database Migration Safety & Hardening (Phase 1)', () => {
  let testPool: Pool;
  let testDbUrl: string;

  beforeAll(async () => {
    const validated = validateTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    testDbUrl = validated.url;

    testPool = new Pool({
      connectionString: testDbUrl,
      ssl: false,
      connectionTimeoutMillis: 5000,
    });

    const client = await testPool.connect();
    try {
      const dbIdentity = await client.query('SELECT current_database()');
      if (dbIdentity.rows[0].current_database !== 'codenotes_test') {
        throw new Error(
          `Safety violation: Connected to "${dbIdentity.rows[0].current_database}", expected "codenotes_test".`
        );
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (testPool) {
      await testPool.end();
    }
  });

  it('successfully migrates a clean database from scratch', async () => {
    const client = await testPool.connect();
    try {
      // Drop application tables to simulate a fresh database
      await client.query(`
        DROP TABLE IF EXISTS notes CASCADE;
        DROP TABLE IF EXISTS generation_idempotency CASCADE;
        DROP TABLE IF EXISTS youtube_transcripts CASCADE;
        DROP TABLE IF EXISTS rate_limit_buckets CASCADE;
      `);
    } finally {
      client.release();
    }

    // Run authoritative migration
    await expect(migrateDatabase(testDbUrl, false)).resolves.not.toThrow();

    // Verify tables and primary keys were created
    const client2 = await testPool.connect();
    try {
      const tablesRes = await client2.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('notes', 'generation_idempotency', 'youtube_transcripts', 'rate_limit_buckets')
        ORDER BY table_name;
      `);
      const tableNames = tablesRes.rows.map((r) => r.table_name);
      expect(tableNames).toEqual([
        'generation_idempotency',
        'notes',
        'rate_limit_buckets',
        'youtube_transcripts',
      ]);

      // Verify user_id in notes is NOT NULL
      const notesUserIdCol = await client2.query(`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'notes' AND column_name = 'user_id'
      `);
      expect(notesUserIdCol.rows[0].is_nullable).toBe('NO');
    } finally {
      client2.release();
    }
  });

  it('repeated migration execution is idempotent and safe', async () => {
    // Run second time
    await expect(migrateDatabase(testDbUrl, false)).resolves.not.toThrow();
    // Run third time
    await expect(migrateDatabase(testDbUrl, false)).resolves.not.toThrow();
  });

  it('serializes concurrent migration invocations via transaction-scoped advisory lock', async () => {
    const lockAcquiredOrder: string[] = [];

    // Client 1 holds the advisory lock inside an open transaction
    const client1 = await testPool.connect();
    await client1.query('BEGIN');
    await client1.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    lockAcquiredOrder.push('client1_locked');

    let client2Finished = false;

    // Launch migrateDatabase concurrently (client 2)
    // It should block waiting for client 1 to release the lock
    const client2Promise = migrateDatabase(testDbUrl, false).then(() => {
      client2Finished = true;
      lockAcquiredOrder.push('client2_completed');
    });

    // Give client 2 time to start and block on the advisory lock
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client2Finished).toBe(false);
    expect(lockAcquiredOrder).toEqual(['client1_locked']);

    // Release Client 1's lock by committing transaction
    await client1.query('COMMIT');
    client1.release();

    // Client 2 should now acquire the lock, complete migration, and finish
    await client2Promise;
    expect(client2Finished).toBe(true);
    expect(lockAcquiredOrder).toEqual(['client1_locked', 'client2_completed']);

    // Also verify parallel Promise.all runs of migrateDatabase serialize without deadlock
    await expect(
      Promise.all([migrateDatabase(testDbUrl, false), migrateDatabase(testDbUrl, false)])
    ).resolves.not.toThrow();
  });

  it('preserves unowned legacy records and aborts migration when notes table lacks user_id and contains rows', async () => {
    const client = await testPool.connect();
    try {
      // Recreate notes without user_id to simulate legacy pre-user table with rows
      await client.query('DROP TABLE IF EXISTS notes CASCADE;');
      await client.query(`
        CREATE TABLE notes (
          id UUID PRIMARY KEY,
          video_id VARCHAR(255) NOT NULL,
          video_title TEXT NOT NULL,
          video_url TEXT NOT NULL,
          thumbnail_url TEXT,
          overview TEXT,
          key_concepts TEXT[],
          detailed_notes TEXT,
          shorthands TEXT[],
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Insert 2 legacy unowned rows
      await client.query(`
        INSERT INTO notes (id, video_id, video_title, video_url) VALUES
          ('11111111-1111-1111-1111-111111111111', 'vid1', 'Legacy Note 1', 'https://yt.com/1'),
          ('22222222-2222-2222-2222-222222222222', 'vid2', 'Legacy Note 2', 'https://yt.com/2');
      `);

      // Attempt migration — must fail with descriptive error, not delete rows!
      await expect(migrateDatabase(testDbUrl, false)).rejects.toThrow(
        /Migration safety check failed: Table "notes" contains 2 unowned legacy record\(s\) but lacks a user_id column/i
      );

      // Verify that NO DATA was deleted
      const countRes = await client.query('SELECT count(*) FROM notes;');
      expect(Number(countRes.rows[0].count)).toBe(2);

      // Verify the records themselves still exist intact
      const rowsRes = await client.query('SELECT id, video_title FROM notes ORDER BY video_title;');
      expect(rowsRes.rows).toEqual([
        { id: '11111111-1111-1111-1111-111111111111', video_title: 'Legacy Note 1' },
        { id: '22222222-2222-2222-2222-222222222222', video_title: 'Legacy Note 2' },
      ]);
    } finally {
      // Clean up legacy test table and restore valid schema for subsequent tests
      try {
        await client.query('DROP TABLE IF EXISTS notes CASCADE;');
      } catch (_) {}
      client.release();
      await migrateDatabase(testDbUrl, false);
    }
  });

  it('preserves unowned records and aborts migration when notes contains NULL user_id rows', async () => {
    const client = await testPool.connect();
    try {
      // Allow nullable user_id temporarily to test safety guard on existing column
      await client.query('ALTER TABLE notes ALTER COLUMN user_id DROP NOT NULL;');
      await client.query(`
        INSERT INTO notes (id, user_id, video_id, video_title, video_url) VALUES
          ('33333333-3333-3333-3333-333333333333', NULL, 'vid3', 'Unowned Note 3', 'https://yt.com/3');
      `);

      // Attempt migration — must fail cleanly without deleting the row
      await expect(migrateDatabase(testDbUrl, false)).rejects.toThrow(
        /Migration safety check failed: Table "notes" contains 1 unowned record\(s\) with NULL user_id/i
      );

      // Verify the unowned row was preserved and NOT deleted
      const checkRes = await client.query(
        "SELECT count(*) FROM notes WHERE id = '33333333-3333-3333-3333-333333333333';"
      );
      expect(Number(checkRes.rows[0].count)).toBe(1);
    } finally {
      try {
        await client.query("DELETE FROM notes WHERE id = '33333333-3333-3333-3333-333333333333';");
        await client.query('ALTER TABLE notes ALTER COLUMN user_id SET NOT NULL;');
      } catch (_) {}
      client.release();
      await migrateDatabase(testDbUrl, false);
    }
  });

  it('preserves unowned records and aborts migration when generation_idempotency contains NULL user_id rows', async () => {
    const client = await testPool.connect();
    try {
      // Cleanly reset generation_idempotency table with nullable user_id
      await client.query('DROP TABLE IF EXISTS generation_idempotency CASCADE;');
      await client.query(`
        CREATE TABLE generation_idempotency (
          user_id UUID,
          key VARCHAR(64) NOT NULL,
          status VARCHAR(20) NOT NULL
        );
      `);

      // Insert unowned row
      await client.query(`
        INSERT INTO generation_idempotency (user_id, key, status) VALUES
          (NULL, 'orphaned-key-1', 'pending');
      `);

      // Attempt migration — must fail without deleting the row
      await expect(migrateDatabase(testDbUrl, false)).rejects.toThrow(
        /Migration safety check failed: Table "generation_idempotency" contains 1 unowned record\(s\) with NULL user_id/i
      );

      // Verify the row was preserved
      const checkRes = await client.query('SELECT count(*) FROM generation_idempotency;');
      expect(Number(checkRes.rows[0].count)).toBe(1);
    } finally {
      try {
        await client.query('DROP TABLE IF EXISTS generation_idempotency CASCADE;');
      } catch (_) {}
      client.release();
      await migrateDatabase(testDbUrl, false);
    }
  });

  it('verifies transaction rollback on failure leaves database in pre-migration state', async () => {
    const client = await testPool.connect();
    try {
      // Clean notes table and insert a row with NULL user_id (temporarily dropping NOT NULL)
      await client.query('ALTER TABLE notes ALTER COLUMN user_id DROP NOT NULL;');
      await client.query(`
        INSERT INTO notes (id, user_id, video_id, video_title, video_url) VALUES
          ('44444444-4444-4444-4444-444444444444', NULL, 'vid4', 'Rollback Test Note', 'https://yt.com/4');
      `);

      // Run migration, expecting failure
      await expect(migrateDatabase(testDbUrl, false)).rejects.toThrow(
        /Migration safety check failed: Table "notes" contains 1 unowned record\(s\) with NULL user_id/i
      );

      // Verify user_id is still nullable (the transaction's attempted ALTER TABLE did not commit!)
      const colRes = await client.query(`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'notes' AND column_name = 'user_id';
      `);
      expect(colRes.rows[0].is_nullable).toBe('YES');

      // Verify the unowned test note was not deleted
      const noteRes = await client.query(
        "SELECT count(*) FROM notes WHERE id = '44444444-4444-4444-4444-444444444444';"
      );
      expect(Number(noteRes.rows[0].count)).toBe(1);
    } finally {
      try {
        await client.query("DELETE FROM notes WHERE id = '44444444-4444-4444-4444-444444444444';");
        await client.query('ALTER TABLE notes ALTER COLUMN user_id SET NOT NULL;');
      } catch (_) {}
      client.release();
      await migrateDatabase(testDbUrl, false);
    }
  });
});
