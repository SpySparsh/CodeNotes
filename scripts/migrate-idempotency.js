const { Pool } = require('pg');
const path = require('path');

require('dotenv').config({ path: path.join(process.cwd(), '.env.local'), override: true });

if (!process.env.DATABASE_URL) {
  console.error("Please set DATABASE_URL in your environment.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrateIdempotency() {
  const client = await pool.connect();

  try {
    console.log("Creating table 'generation_idempotency' if it does not exist...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS generation_idempotency (
        key VARCHAR(64) PRIMARY KEY,
        status VARCHAR(20) NOT NULL,
        note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_generation_idempotency_created_at
        ON generation_idempotency(created_at);
    `);
    console.log("Table 'generation_idempotency' is ready.");
  } catch (err) {
    console.error("Error during idempotency migration:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrateIdempotency();
