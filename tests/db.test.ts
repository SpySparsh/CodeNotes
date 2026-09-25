import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDbSslConfig } from '@/lib/db';

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
});