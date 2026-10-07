'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });
const { Inngest } = require('inngest');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

async function main() {
  console.log('--- Testing Live Inngest Dev Server Round Trip ---');

  const inngest = new Inngest({
    id: 'codenotes',
    isDev: true,
  });

  const userRes = await pool.query('SELECT id FROM auth.users LIMIT 1');
  if (userRes.rows.length === 0) {
    console.error('❌ No users found in auth.users');
    process.exit(1);
  }
  const testUserId = userRes.rows[0].id;
  const testKey = 'live-inngest-test-' + Date.now();
  const testVideoId = 'dQw4w9WgXcQ';
  const testVideoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const eventId = `gen-${testUserId}-${testKey}`;

  // 1. Insert pending DB record as required by Phase 3 contract
  console.log(`1. Inserting pending row in PostgreSQL generation_idempotency (user ${testUserId})...`);
  await pool.query(
    `INSERT INTO generation_idempotency (user_id, key, status, video_id, video_url, created_at, updated_at)
     VALUES ($1, $2, 'pending', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [testUserId, testKey, testVideoId, testVideoUrl]
  );
  console.log('   ✅ Pending row inserted successfully.');

  // 2. Dispatch event to live Inngest Dev Server
  console.log('2. Sending event notes/generate.requested to Inngest Dev Server (http://127.0.0.1:8288)...');
  const sendRes = await inngest.send({
    name: 'notes/generate.requested',
    id: eventId,
    data: {
      userId: testUserId,
      idempotencyKey: testKey,
      videoId: testVideoId,
      videoUrl: testVideoUrl,
    },
  });
  console.log('   ✅ Event sent to Inngest Dev Server. Result:', sendRes);

  // 3. Poll PostgreSQL generation_idempotency to watch real execution progress
  console.log('3. Polling generation_idempotency table for real execution progress...');
  let completed = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const res = await pool.query(
      `SELECT status, note_id, error_message, error_code, attempts, lease_until
       FROM generation_idempotency
       WHERE user_id = $1 AND key = $2`,
      [testUserId, testKey]
    );

    if (res.rows.length > 0) {
      const row = res.rows[0];
      console.log(`   [Poll ${i + 1}s] Status: ${row.status}, Attempts: ${row.attempts}, NoteId: ${row.note_id || 'null'}, Error: ${row.error_code || 'none'}`);

      if (row.status === 'completed' || row.status === 'failed') {
        completed = true;
        console.log(`\n🎉 Inngest Function Completed with Status: ${row.status}`);
        if (row.status === 'completed') {
          console.log(`   Note UUID: ${row.note_id}`);
          const noteRes = await pool.query(`SELECT id, video_title, overview FROM notes WHERE id = $1`, [row.note_id]);
          console.log(`   Persisted Note Title: "${noteRes.rows[0]?.video_title}"`);
        } else {
          console.log(`   Failure reason: [${row.error_code}] ${row.error_message}`);
        }
        break;
      }
    }
  }

  if (!completed) {
    console.error('❌ Inngest execution timed out while waiting for DB status transition.');
    process.exit(1);
  }

  // Cleanup test record
  await pool.query('DELETE FROM notes WHERE user_id = $1 AND video_id = $2', [testUserId, testVideoId]);
  await pool.query('DELETE FROM generation_idempotency WHERE user_id = $1 AND key = $2', [testUserId, testKey]);
  await pool.end();
  console.log('--- Live Inngest Verification Succeeded ---');
}

main().catch(async (err) => {
  console.error('Live Inngest verification failed:', err);
  await pool.end();
  process.exit(1);
});
