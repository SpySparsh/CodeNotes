import { Pool } from 'pg';
import { logger } from '@/lib/logger';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: 10000,
});

export interface Note {
  id: string;
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  thumbnailUrl?: string;
  overview: string;
  keyConcepts: string[];
  detailedNotes: string;
  shorthands: string[];
  createdAt?: string;
}

export async function query(text: string, params?: any[]) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  logger.info('db_query_executed', { durationMs: duration, rowCount: res.rowCount ?? 0 });
  return res;
}

export async function withTransaction<T>(callback: (client: { query: (text: string, params?: any[]) => Promise<any> }) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error('db_rollback_failed', { errorMessage: (rollbackError as any)?.message });
    }
    throw error;
  } finally {
    client.release();
  }
}
