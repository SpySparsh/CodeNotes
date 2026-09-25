'use strict';
/**
 * scripts/migrate.js
 *
 * Authoritative schema migration for CodeNotes.
 * Creates all required tables and indexes using IF NOT EXISTS — safe to run
 * any number of times on any database state.
 *
 * Usage:
 *   npm run db:migrate          (reads DATABASE_URL from environment or .env.local)
 *   DATABASE_URL=... node scripts/migrate.js
 *
 * SSL policy mirrors src/lib/db.ts:
 *   production  (NODE_ENV=production) — full TLS certificate verification
 *   development (all other values)    — no SSL (local PostgreSQL)
 *
 * DO NOT add data-import logic to this file.
 * For local JSON seeding use: npm run db:seed
 */

const { Pool } = require('pg');
const path = require('path');

// Load .env.local for local development. No-ops silently when the file is
// absent (platform-managed environments inject vars directly).
require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });

if (!process.env.DATABASE_URL) {
  console.error('[migrate] ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

// Mirror the SSL policy in src/lib/db.ts exactly.
// production  → ssl: { ca: DATABASE_CA_CERT, rejectUnauthorized: true }
// development → ssl: false (local PostgreSQL requires no TLS)
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
  connectionTimeoutMillis: 10000,
});

async function migrate() {
  let client;

  try {
    client = await pool.connect();
  } catch (err) {
    console.error('[migrate] ERROR: Could not connect to database:', err.message);
    process.exit(1);
  }

  try {
    console.log('[migrate] Starting schema migration...');
    await client.query('BEGIN');

    // Step 1 — notes (must be created before generation_idempotency due to FK)
    console.log('[migrate] Creating table: notes');
    await client.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id              UUID                     PRIMARY KEY,
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

    // Step 2 — generation_idempotency (FK → notes)
    console.log('[migrate] Creating table: generation_idempotency');
    await client.query(`
      CREATE TABLE IF NOT EXISTS generation_idempotency (
        key        VARCHAR(64)              PRIMARY KEY,
        status     VARCHAR(20)              NOT NULL,
        note_id    UUID                     REFERENCES notes(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Step 3 — indexes
    console.log('[migrate] Creating index: idx_notes_created_at');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notes_created_at
        ON notes(created_at DESC)
    `);

    console.log('[migrate] Creating index: idx_generation_idempotency_created_at');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_generation_idempotency_created_at
        ON generation_idempotency(created_at)
    `);

    await client.query('COMMIT');
    console.log('[migrate] Schema migration complete.');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Ignore rollback errors — original error is more important
    }
    console.error('[migrate] ERROR: Migration failed, transaction rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
