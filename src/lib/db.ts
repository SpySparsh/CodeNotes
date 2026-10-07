import { Pool } from 'pg';
import { logger } from '@/lib/logger';

export function getDbSslConfig() {
  if (process.env.NODE_ENV !== 'production') {
    return false;
  }

  const caCert = process.env.DATABASE_CA_CERT?.trim();
  if (!caCert) {
    throw new Error(
      'DATABASE_CA_CERT must be set in production to securely verify PostgreSQL TLS certificates.'
    );
  }

  return {
    ca: caCert,
    rejectUnauthorized: true,
  };
}

let poolInstance: Pool | null = null;

export function getPool(): Pool {
  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Disable SSL for local development; enable full TLS certificate verification in production.
      // rejectUnauthorized:false is intentionally avoided — it silently disables cert validation.
      // For Supabase, the private root CA certificate is passed via DATABASE_CA_CERT.
      ssl: getDbSslConfig(),
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      query_timeout: 10000,
    });
  }
  return poolInstance;
}

export interface Note {
  id: string;
  userId?: string;
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
  const pool = getPool();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  logger.info('db_query_executed', { durationMs: duration, rowCount: res.rowCount ?? 0 });
  return res;
}

export async function withTransaction<T>(
  callback: (client: { query: (text: string, params?: any[]) => Promise<any> }) => Promise<T>
): Promise<T> {
  const pool = getPool();
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

export async function withUserTransaction<T>(
  userId: string,
  callback: (client: { query: (text: string, params?: any[]) => Promise<any> }) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Set transaction-local JWT claims so auth.uid() and auth.jwt() resolve to the authenticated user
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', userId]);
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);

    // Switch role transaction-locally when authenticated role exists
    try {
      await client.query('SET LOCAL ROLE authenticated');
    } catch (roleErr: any) {
      logger.warn('db_set_local_role_skipped', { errorMessage: roleErr?.message });
    }

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
