import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Internal Tables Hardening & Security Configuration', () => {
  const migrateScriptPath = path.resolve('scripts/migrate.js');
  const standaloneSqlPath = path.resolve('scripts/harden-internal-tables.sql');

  it('scripts/migrate.js includes statements to ENABLE and FORCE RLS on youtube_transcripts and rate_limit_buckets', () => {
    const content = fs.readFileSync(migrateScriptPath, 'utf8');

    expect(content).toContain('ALTER TABLE youtube_transcripts ENABLE ROW LEVEL SECURITY;');
    expect(content).toContain('ALTER TABLE youtube_transcripts FORCE ROW LEVEL SECURITY;');
    expect(content).toContain('ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;');
    expect(content).toContain('ALTER TABLE rate_limit_buckets FORCE ROW LEVEL SECURITY;');
  });

  it('scripts/migrate.js revokes all privileges on internal tables and application tables from PUBLIC and anon roles', () => {
    const content = fs.readFileSync(migrateScriptPath, 'utf8');

    expect(content).toContain('REVOKE ALL ON TABLE notes FROM PUBLIC;');
    expect(content).toContain('REVOKE ALL ON TABLE generation_idempotency FROM PUBLIC;');
    expect(content).toContain('REVOKE ALL ON TABLE youtube_transcripts FROM PUBLIC;');
    expect(content).toContain('REVOKE ALL ON TABLE rate_limit_buckets FROM PUBLIC;');

    expect(content).toContain('REVOKE ALL ON TABLE notes FROM anon;');
    expect(content).toContain('REVOKE ALL ON TABLE generation_idempotency FROM anon;');
    expect(content).toContain('REVOKE ALL ON TABLE youtube_transcripts FROM anon;');
    expect(content).toContain('REVOKE ALL ON TABLE rate_limit_buckets FROM anon;');

    expect(content).toContain('REVOKE ALL ON TABLE youtube_transcripts FROM authenticated;');
    expect(content).toContain('REVOKE ALL ON TABLE rate_limit_buckets FROM authenticated;');
  });

  it('scripts/migrate.js does NOT grant permissions or create permissive RLS policies on internal tables for client roles', () => {
    const content = fs.readFileSync(migrateScriptPath, 'utf8');

    // Ensure no policies are created on youtube_transcripts or rate_limit_buckets
    expect(content).not.toMatch(/CREATE\s+POLICY[^\n]+ON\s+youtube_transcripts/i);
    expect(content).not.toMatch(/CREATE\s+POLICY[^\n]+ON\s+rate_limit_buckets/i);

    // Ensure no grants are given to anon or authenticated on internal tables
    expect(content).not.toMatch(/GRANT[^\n]+ON\s+TABLE\s+youtube_transcripts\s+TO\s+(?:anon|authenticated)/i);
    expect(content).not.toMatch(/GRANT[^\n]+ON\s+TABLE\s+rate_limit_buckets\s+TO\s+(?:anon|authenticated)/i);
  });

  it('scripts/harden-internal-tables.sql exists and contains valid idempotent SQL statements', () => {
    expect(fs.existsSync(standaloneSqlPath)).toBe(true);
    const sql = fs.readFileSync(standaloneSqlPath, 'utf8');

    expect(sql).toContain('ALTER TABLE public.youtube_transcripts ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE public.youtube_transcripts FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE public.rate_limit_buckets FORCE ROW LEVEL SECURITY;');

    expect(sql).toContain('REVOKE ALL ON TABLE public.notes FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.generation_idempotency FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.youtube_transcripts FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.rate_limit_buckets FROM PUBLIC;');

    expect(sql).toContain('REVOKE ALL ON TABLE public.notes FROM anon;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.generation_idempotency FROM anon;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.youtube_transcripts FROM anon;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.rate_limit_buckets FROM anon;');

    expect(sql).toContain('REVOKE ALL ON TABLE public.youtube_transcripts FROM authenticated;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.rate_limit_buckets FROM authenticated;');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notes TO authenticated;');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.generation_idempotency TO authenticated;');

    expect(sql).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;');
  });

  it('scripts/migrate.js hardens default privileges in schema public for future tables', () => {
    const content = fs.readFileSync(migrateScriptPath, 'utf8');

    expect(content).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;');
    expect(content).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;');
  });

  it('application code queries internal tables strictly through the direct server-side connection pool', () => {
    const transcriptServicePath = path.resolve('src/lib/transcript/service.ts');
    const rateLimitPath = path.resolve('src/lib/rate-limit.ts');

    const transcriptContent = fs.readFileSync(transcriptServicePath, 'utf8');
    const rateLimitContent = fs.readFileSync(rateLimitPath, 'utf8');

    // Both must import query from '@/lib/db'
    expect(transcriptContent).toContain("import { query } from '@/lib/db'");
    expect(rateLimitContent).toContain("import { query } from '@/lib/db'");

    // Neither must import @supabase/supabase-js or createClient
    expect(transcriptContent).not.toContain('@supabase/supabase-js');
    expect(transcriptContent).not.toContain('@supabase/ssr');
    expect(rateLimitContent).not.toContain('@supabase/supabase-js');
    expect(rateLimitContent).not.toContain('@supabase/ssr');
  });
});
