'use strict';
/**
 * scripts/seed-from-json.js
 *
 * LOCAL DEVELOPMENT ONLY — imports notes from data/codenotes.json into
 * the local PostgreSQL database.
 *
 * This script DOES NOT create or modify the database schema.
 * Always run `npm run db:migrate` first to ensure the schema exists.
 *
 * Usage:
 *   npm run db:seed          (reads DATABASE_URL from environment or .env.local)
 *   DATABASE_URL=... node scripts/seed-from-json.js
 *
 * DO NOT run this script in production. Production databases have no
 * data/codenotes.json file and should never receive locally generated seed data.
 *
 * SSL policy mirrors src/lib/db.ts:
 *   production  (NODE_ENV=production) — full TLS certificate verification
 *   development (all other values)    — no SSL (local PostgreSQL)
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Load .env.local for local development. No-ops silently when the file is
// absent (platform-managed environments inject vars directly).
require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });

if (!process.env.DATABASE_URL) {
  console.error('[seed] ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

// Mirror the SSL policy in src/lib/db.ts exactly.
const ssl = process.env.NODE_ENV === 'production' ? true : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  connectionTimeoutMillis: 10000,
});

async function seed() {
  // Check for source data before touching the database
  const dataPath = path.join(process.cwd(), 'data', 'codenotes.json');
  if (!fs.existsSync(dataPath)) {
    console.log('[seed] No data/codenotes.json found. Nothing to import.');
    await pool.end();
    return;
  }

  let db;
  try {
    const fileContent = fs.readFileSync(dataPath, 'utf-8');
    db = JSON.parse(fileContent);
  } catch (err) {
    console.error('[seed] ERROR: Failed to read or parse data/codenotes.json:', err.message);
    process.exit(1);
  }

  if (!db.notes || db.notes.length === 0) {
    console.log('[seed] No notes found in data/codenotes.json. Nothing to import.');
    await pool.end();
    return;
  }

  console.log(`[seed] Found ${db.notes.length} note(s) to import.`);

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error('[seed] ERROR: Could not connect to database:', err.message);
    process.exit(1);
  }

  let imported = 0;
  let skipped = 0;

  try {
    for (const note of db.notes) {
      // Skip notes that already exist to make re-runs safe
      const existing = await client.query(
        'SELECT id FROM notes WHERE id = $1',
        [note.id]
      );

      if (existing.rows.length > 0) {
        console.log(`[seed] Skipping existing note: ${note.id}`);
        skipped++;
        continue;
      }

      await client.query(
        `INSERT INTO notes
           (id, video_id, video_title, video_url, thumbnail_url, overview,
            key_concepts, detailed_notes, shorthands, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          note.id,
          note.videoId,
          note.videoTitle,
          note.videoUrl,
          note.thumbnailUrl,
          note.overview,
          note.keyConcepts,
          note.detailedNotes,
          note.shorthands,
          note.createdAt || new Date().toISOString(),
        ]
      );

      console.log(`[seed] Imported note: ${note.id}`);
      imported++;
    }

    console.log(`[seed] Done. Imported: ${imported}, Skipped: ${skipped}.`);
  } catch (err) {
    console.error('[seed] ERROR: Import failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
