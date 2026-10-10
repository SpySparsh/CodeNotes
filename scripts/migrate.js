'use strict';
/**
 * scripts/migrate.js
 *
 * Authoritative schema migration for CodeNotes.
 * Creates all required tables, constraints, indexes, RLS policies, and grants
 * inside a single atomic transaction. Safe to run multiple times.
 *
 * Usage:
 *   npm run db:migrate          (reads DATABASE_URL from environment or .env.local)
 *   DATABASE_URL=... node scripts/migrate.js
 *
 * SSL policy mirrors src/lib/db.ts:
 *   production  (NODE_ENV=production) — full TLS certificate verification
 *   development (all other values)    — no SSL (local PostgreSQL)
 */

const { Pool } = require('pg');
const path = require('path');

async function migrateDatabase(connectionString, customSsl) {
  if (!connectionString) {
    throw new Error('[migrate] ERROR: Database connection string is required.');
  }

  const ssl =
    customSsl !== undefined
      ? customSsl
      : process.env.NODE_ENV === 'production'
        ? {
            ca: process.env.DATABASE_CA_CERT,
            rejectUnauthorized: true,
          }
        : false;

  const pool = new Pool({
    connectionString,
    ssl,
    connectionTimeoutMillis: 10000,
  });

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    await pool.end();
    throw new Error(`[migrate] ERROR: Could not connect to database: ${err.message}`);
  }

  try {
    console.log('[migrate] Starting schema migration...');
    await client.query('BEGIN');

    // Step 1 — notes table
    console.log('[migrate] Ensuring table: notes');
    await client.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id              UUID                     PRIMARY KEY,
        user_id         UUID                     NOT NULL,
        video_id        VARCHAR(255)             NOT NULL,
        video_title     TEXT                     NOT NULL,
        video_url       TEXT                     NOT NULL,
        thumbnail_url   TEXT,
        overview        TEXT,
        key_concepts    TEXT[],
        detailed_notes  TEXT,
        shorthands      TEXT[],
        created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Ensure user_id column exists if table was created previously without it
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'notes' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE notes ADD COLUMN user_id UUID;
          -- Purge unowned legacy notes in dev/portfolio before enforcing NOT NULL
          DELETE FROM notes WHERE user_id IS NULL;
          ALTER TABLE notes ALTER COLUMN user_id SET NOT NULL;
        END IF;
      END $$;
    `);

    // Add foreign key to auth.users if auth schema exists
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'auth' AND table_name = 'users'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'notes_user_id_fkey' AND table_name = 'notes'
          ) THEN
            ALTER TABLE notes
              ADD CONSTRAINT notes_user_id_fkey
              FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
          END IF;
        END IF;
      END $$;
    `);

    // Step 2 — generation_idempotency table
    console.log('[migrate] Ensuring table: generation_idempotency');
    await client.query(`
      CREATE TABLE IF NOT EXISTS generation_idempotency (
        user_id       UUID                     NOT NULL,
        key           VARCHAR(64)              NOT NULL,
        status        VARCHAR(20)              NOT NULL,
        video_id      VARCHAR(255),
        video_url     TEXT,
        note_id       UUID                     REFERENCES notes(id) ON DELETE SET NULL,
        error_message TEXT,
        error_code    VARCHAR(100),
        attempts      INTEGER                  DEFAULT 0,
        lease_until   TIMESTAMP WITH TIME ZONE,
        processing_owner VARCHAR(255),
        created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, key)
      )
    `);

    // Ensure columns exist if table was created previously without them
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'generation_idempotency' AND column_name = 'user_id'
        ) THEN
          ALTER TABLE generation_idempotency ADD COLUMN user_id UUID;
          DELETE FROM generation_idempotency WHERE user_id IS NULL;
          ALTER TABLE generation_idempotency ALTER COLUMN user_id SET NOT NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'generation_idempotency' AND column_name = 'video_id'
        ) THEN
          ALTER TABLE generation_idempotency ADD COLUMN video_id VARCHAR(255);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'generation_idempotency' AND column_name = 'video_url'
        ) THEN
          ALTER TABLE generation_idempotency ADD COLUMN video_url TEXT;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'generation_idempotency' AND column_name = 'error_message'
        ) THEN
          ALTER TABLE generation_idempotency ADD COLUMN error_message TEXT;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'generation_idempotency' AND column_name = 'error_code'
        ) THEN
          ALTER TABLE generation_idempotency ADD COLUMN error_code VARCHAR(100);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'generation_idempotency' AND column_name = 'attempts'
        ) THEN
          ALTER TABLE generation_idempotency ADD COLUMN attempts INTEGER DEFAULT 0;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'generation_idempotency' AND column_name = 'lease_until'
        ) THEN
          ALTER TABLE generation_idempotency ADD COLUMN lease_until TIMESTAMP WITH TIME ZONE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'generation_idempotency' AND column_name = 'processing_owner'
        ) THEN
          ALTER TABLE generation_idempotency ADD COLUMN processing_owner VARCHAR(255);
        END IF;

        -- Ensure compound primary key (user_id, key)
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'generation_idempotency_pkey'
          AND conrelid = 'generation_idempotency'::regclass
        ) THEN
          IF (
            SELECT count(*) FROM pg_attribute a
            JOIN pg_constraint c ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
            WHERE c.conname = 'generation_idempotency_pkey'
            AND c.conrelid = 'generation_idempotency'::regclass
          ) = 1 THEN
            ALTER TABLE generation_idempotency DROP CONSTRAINT generation_idempotency_pkey;
            ALTER TABLE generation_idempotency ADD CONSTRAINT generation_idempotency_pkey PRIMARY KEY (user_id, key);
          END IF;
        END IF;
      END $$;
    `);

    // Add foreign key to auth.users for generation_idempotency if auth schema exists
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'auth' AND table_name = 'users'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'generation_idempotency_user_id_fkey' AND table_name = 'generation_idempotency'
          ) THEN
            ALTER TABLE generation_idempotency
              ADD CONSTRAINT generation_idempotency_user_id_fkey
              FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
          END IF;
        END IF;
      END $$;
    `);

    // Step 3 — youtube_transcripts table (Shared/Global Transcript Cache)
    console.log('[migrate] Ensuring table: youtube_transcripts');
    await client.query(`
      CREATE TABLE IF NOT EXISTS youtube_transcripts (
        video_id        VARCHAR(32)              PRIMARY KEY,
        transcript_text TEXT                     NOT NULL,
        language        VARCHAR(16),
        provider        VARCHAR(32)              NOT NULL,
        created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Step 4 — rate_limit_buckets table (Infrastructure Rate-Limiting)
    console.log('[migrate] Ensuring table: rate_limit_buckets');
    await client.query(`
      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        key             VARCHAR(255)             NOT NULL,
        window_start    TIMESTAMP WITH TIME ZONE NOT NULL,
        count           INTEGER                  NOT NULL DEFAULT 1,
        expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
        PRIMARY KEY (key, window_start)
      )
    `);

    // Step 5 — indexes
    console.log('[migrate] Creating indexes');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notes_user_id_created_at
        ON notes(user_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_notes_user_created_at_id
        ON notes(user_id, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_notes_user_title_id
        ON notes(user_id, video_title ASC, id ASC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_generation_idempotency_user_created
        ON generation_idempotency(user_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires_at
        ON rate_limit_buckets(expires_at);
    `);

    // Step 4 — Enable and Force RLS
    console.log('[migrate] Enabling and forcing Row Level Security');
    await client.query(`
      ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE notes FORCE ROW LEVEL SECURITY;

      ALTER TABLE generation_idempotency ENABLE ROW LEVEL SECURITY;
      ALTER TABLE generation_idempotency FORCE ROW LEVEL SECURITY;
    `);

    // Step 5 — Grant permissions to authenticated role if role exists
    console.log('[migrate] Configuring role permissions and RLS policies');
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notes TO authenticated;
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE generation_idempotency TO authenticated;
        END IF;
      END $$;
    `);

    // Step 6 — RLS Policies for notes
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          DROP POLICY IF EXISTS "notes_select_policy" ON notes;
          CREATE POLICY "notes_select_policy" ON notes
            FOR SELECT TO authenticated
            USING (auth.uid() = user_id);

          DROP POLICY IF EXISTS "notes_insert_policy" ON notes;
          CREATE POLICY "notes_insert_policy" ON notes
            FOR INSERT TO authenticated
            WITH CHECK (auth.uid() = user_id);

          DROP POLICY IF EXISTS "notes_update_policy" ON notes;
          CREATE POLICY "notes_update_policy" ON notes
            FOR UPDATE TO authenticated
            USING (auth.uid() = user_id)
            WITH CHECK (auth.uid() = user_id);

          DROP POLICY IF EXISTS "notes_delete_policy" ON notes;
          CREATE POLICY "notes_delete_policy" ON notes
            FOR DELETE TO authenticated
            USING (auth.uid() = user_id);
        END IF;
      END $$;
    `);

    // Step 7 — RLS Policies for generation_idempotency
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          DROP POLICY IF EXISTS "idempotency_select_policy" ON generation_idempotency;
          CREATE POLICY "idempotency_select_policy" ON generation_idempotency
            FOR SELECT TO authenticated
            USING (auth.uid() = user_id);

          DROP POLICY IF EXISTS "idempotency_insert_policy" ON generation_idempotency;
          CREATE POLICY "idempotency_insert_policy" ON generation_idempotency
            FOR INSERT TO authenticated
            WITH CHECK (auth.uid() = user_id);

          DROP POLICY IF EXISTS "idempotency_update_policy" ON generation_idempotency;
          CREATE POLICY "idempotency_update_policy" ON generation_idempotency
            FOR UPDATE TO authenticated
            USING (auth.uid() = user_id)
            WITH CHECK (auth.uid() = user_id);

          DROP POLICY IF EXISTS "idempotency_delete_policy" ON generation_idempotency;
          CREATE POLICY "idempotency_delete_policy" ON generation_idempotency
            FOR DELETE TO authenticated
            USING (auth.uid() = user_id);
        END IF;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('[migrate] Schema migration complete.');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Ignore rollback error
    }
    console.error('[migrate] ERROR: Migration failed, transaction rolled back:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  migrateDatabase(process.env.DATABASE_URL)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { migrateDatabase };
