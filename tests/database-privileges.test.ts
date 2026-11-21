import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Database Privileges & Security Posture Verification', () => {
  const sqlPath = path.resolve(__dirname, '../scripts/migrate-dispatch-attempt-ledger.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  it('grants specific column-level updates on generation_idempotency without broad table update', () => {
    expect(sql).toContain(
      'GRANT SELECT, UPDATE (updated_at, status, note_id, lease_until, total_chunks, manifest_hash, error_message, error_code)'
    );
    expect(sql).toContain('ON TABLE public.generation_idempotency TO codenotes_definer;');

    // Verify it does NOT grant broad UPDATE on generation_idempotency
    const broadUpdateMatches = sql.match(/GRANT\s+UPDATE\s+ON\s+TABLE\s+public\.generation_idempotency/i);
    expect(broadUpdateMatches).toBeNull();
  });

  it('enforces FORCE ROW LEVEL SECURITY on rate_limit_dispatch_attempts', () => {
    expect(sql).toContain('ALTER TABLE public.rate_limit_dispatch_attempts ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE public.rate_limit_dispatch_attempts FORCE ROW LEVEL SECURITY;');
  });

  it('sets fixed search_path = pg_catalog on all SECURITY DEFINER routines', () => {
    const routines = [
      'claim_or_adopt_dispatch_slot',
      'complete_dispatch_attempt',
      'report_stale_attempt_outcome',
      'recover_reservation_ownership',
      'reserve_quota',
    ];

    for (const routine of routines) {
      const idx = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${routine}`);
      expect(idx).toBeGreaterThan(-1);
      const slice = sql.slice(idx, idx + 2000);
      expect(slice).toContain('SECURITY DEFINER');
      expect(slice).toContain('SET search_path = pg_catalog');
    }
  });

  it('assigns ownership of all SECURITY DEFINER routines to codenotes_definer', () => {
    const routines = [
      'claim_or_adopt_dispatch_slot',
      'complete_dispatch_attempt',
      'report_stale_attempt_outcome',
      'recover_reservation_ownership',
    ];

    for (const routine of routines) {
      expect(sql).toContain(`ALTER FUNCTION public.${routine} OWNER TO codenotes_definer;`);
    }
  });

  it('creates partial unique index on public.notes for parent_key', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_parent_key_unique \n    ON public.notes (user_id, parent_key) \n    WHERE parent_key IS NOT NULL;'
    );
  });
});
