const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(process.cwd(), '.env.local'),override: true });

// Ensure the connection URL is available
if (!process.env.DATABASE_URL) {
  console.error("Please set DATABASE_URL in your environment.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  const client = await pool.connect();

  try {
    // 1. Create the schema
    console.log("Creating table 'notes' if it does not exist...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS notes (
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
    console.log("Table 'notes' is ready.");

    // 2. Read the local JSON file
    const dataPath = path.join(process.cwd(), 'data', 'codenotes.json');
    if (!fs.existsSync(dataPath)) {
      console.log("No local codenotes.json found. Skipping data import.");
      return;
    }

    const fileContent = fs.readFileSync(dataPath, 'utf-8');
    const db = JSON.parse(fileContent);

    if (!db.notes || db.notes.length === 0) {
      console.log("No notes found in local JSON.");
      return;
    }

    console.log(`Found ${db.notes.length} notes to migrate. Starting import...`);

    // 3. Insert each note
    for (const note of db.notes) {
      // Check if note already exists to prevent duplicate key errors during reruns
      const checkParams = [note.id];
      const checkRes = await client.query('SELECT id FROM notes WHERE id = $1', checkParams);
      
      if (checkRes.rows.length > 0) {
        console.log(`Note ${note.id} already exists in Postgres. Skipping.`);
        continue;
      }

      const insertQuery = `
        INSERT INTO notes (id, video_id, video_title, video_url, thumbnail_url, overview, key_concepts, detailed_notes, shorthands, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `;
      
      const insertParams = [
        note.id,
        note.videoId,
        note.videoTitle,
        note.videoUrl,
        note.thumbnailUrl,
        note.overview,
        note.keyConcepts, // pg pool handles JavaScript array mapping to PostgreSQL array naturally
        note.detailedNotes,
        note.shorthands,
        note.createdAt || new Date().toISOString()
      ];

      await client.query(insertQuery, insertParams);
      console.log(`Inserted note: ${note.id}`);
    }

    console.log("Migration completed successfully!");

  } catch (err) {
    console.error("Error during migration:", err);
  } finally {
    client.release();
    pool.end();
  }
}

migrate();
