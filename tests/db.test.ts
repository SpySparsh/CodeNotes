import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDbSslConfig, withTransaction, withUserTransaction, getPool } from '@/lib/db';

describe('Database SSL Configuration (getDbSslConfig)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('disables SSL in development environment', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    expect(getDbSslConfig()).toBe(false);
  });

  it('disables SSL in test environment', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    expect(getDbSslConfig()).toBe(false);
  });

  it('enforces certificate verification with custom CA in production when DATABASE_CA_CERT is provided', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    process.env.DATABASE_CA_CERT = '-----BEGIN CERTIFICATE-----\nMOCK_CA_CERT\n-----END CERTIFICATE-----';

    const sslConfig = getDbSslConfig();
    expect(sslConfig).toEqual({
      ca: '-----BEGIN CERTIFICATE-----\nMOCK_CA_CERT\n-----END CERTIFICATE-----',
      rejectUnauthorized: true,
    });
    expect((sslConfig as any).rejectUnauthorized).toBe(true);
  });

  it('throws a configuration error in production when DATABASE_CA_CERT is missing or empty', () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    delete process.env.DATABASE_CA_CERT;

    expect(() => getDbSslConfig()).toThrow(
      'DATABASE_CA_CERT must be set in production to securely verify PostgreSQL TLS certificates.'
    );

    process.env.DATABASE_CA_CERT = '   ';
    expect(() => getDbSslConfig()).toThrow(
      'DATABASE_CA_CERT must be set in production to securely verify PostgreSQL TLS certificates.'
    );
  });

  it('configures pg.Pool with query_timeout instead of statement_timeout', async () => {
    const pool = getPool();
    expect((pool.options as any).query_timeout).toBe(10000);
    expect((pool.options as any).statement_timeout).toBeUndefined();
  });
});

describe('Database User Transactions (withUserTransaction & RLS Context)', () => {
  const targetUserId = 'user-123e4567-e89b-12d3-a456-426614174000';

  it('sets transaction-local claims and switches to authenticated role before executing callback', async () => {
    const executedQueries: Array<{ text: string; params?: any[] }> = [];
    const mockClient = {
      query: vi.fn().mockImplementation(async (text: string, params?: any[]) => {
        executedQueries.push({ text, params });
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    const pool = getPool();
    const connectSpy = vi.spyOn(pool, 'connect').mockResolvedValueOnce(mockClient as any);

    const result = await withUserTransaction(targetUserId, async (client) => {
      await client.query('INSERT INTO notes (id, user_id) VALUES ($1, $2)', ['note-1', targetUserId]);
      return 'created-successfully';
    });

    expect(result).toBe('created-successfully');
    expect(connectSpy).toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalledTimes(1);

    // Verify correct sequence of RLS context commands
    expect(executedQueries[0]).toEqual({ text: 'BEGIN', params: undefined });
    expect(executedQueries[1]).toEqual({
      text: 'SELECT set_config($1, $2, true)',
      params: ['request.jwt.claim.sub', targetUserId],
    });
    expect(executedQueries[2]).toEqual({
      text: 'SELECT set_config($1, $2, true)',
      params: ['request.jwt.claims', JSON.stringify({ sub: targetUserId, role: 'authenticated' })],
    });
    expect(executedQueries[3]).toEqual({ text: 'SET LOCAL ROLE authenticated', params: undefined });
    expect(executedQueries[4]).toEqual({
      text: 'INSERT INTO notes (id, user_id) VALUES ($1, $2)',
      params: ['note-1', targetUserId],
    });
    expect(executedQueries[5]).toEqual({ text: 'COMMIT', params: undefined });
  });

  it('rolls back user transaction and releases client when callback throws', async () => {
    const executedQueries: Array<{ text: string; params?: any[] }> = [];
    const mockClient = {
      query: vi.fn().mockImplementation(async (text: string, params?: any[]) => {
        executedQueries.push({ text, params });
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    const pool = getPool();
    vi.spyOn(pool, 'connect').mockResolvedValueOnce(mockClient as any);

    await expect(
      withUserTransaction(targetUserId, async () => {
        throw new Error('Transaction execution failure');
      })
    ).rejects.toThrow('Transaction execution failure');

    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(executedQueries.some((q) => q.text === 'ROLLBACK')).toBe(true);
    expect(executedQueries.some((q) => q.text === 'COMMIT')).toBe(false);
  });
});

describe('Database Generic Transactions (withTransaction)', () => {
  it('executes BEGIN, callback queries, COMMIT, and releases client', async () => {
    const executedQueries: Array<{ text: string }> = [];
    const mockClient = {
      query: vi.fn().mockImplementation(async (text: string) => {
        executedQueries.push({ text });
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    const pool = getPool();
    vi.spyOn(pool, 'connect').mockResolvedValueOnce(mockClient as any);

    const result = await withTransaction(async (client) => {
      await client.query('SELECT 1');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(executedQueries.map((q) => q.text)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});