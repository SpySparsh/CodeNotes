import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Database Lock Ordering Hierarchy Verification', () => {
  const sqlPath = path.resolve(__dirname, '../scripts/migrate-dispatch-attempt-ledger.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Hierarchy levels
  // L1: generation_idempotency
  // L2: project_quota_configs (global)
  // L3: project_quota_configs (scope)
  // L4: rate_limit_reservations
  // L5: rate_limit_dispatch_attempts
  // L6: chunk_generations / notes

  it('verifies claim_or_adopt_dispatch_slot acquires locks strictly in order L1 -> L2 -> L3 -> L4', () => {
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_or_adopt_dispatch_slot');
    const fnEnd = sql.indexOf('$$;', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = sql.slice(fnStart, fnEnd);

    const l1Pos = fnBody.indexOf('FROM public.generation_idempotency');
    const l2Pos = fnBody.indexOf("FROM public.project_quota_configs\n    WHERE project_id = p_project_id AND quota_scope = 'global'");
    const l3Pos = fnBody.indexOf('FROM public.project_quota_configs\n        WHERE project_id = p_project_id AND quota_scope = p_quota_scope');
    const l4Pos = fnBody.indexOf('FROM public.rate_limit_reservations\n    WHERE reservation_token = p_reservation_token');
    const l5Pos = fnBody.indexOf('INSERT INTO public.rate_limit_dispatch_attempts');

    expect(l1Pos).toBeGreaterThan(-1);
    expect(l2Pos).toBeGreaterThan(-1);
    expect(l3Pos).toBeGreaterThan(-1);
    expect(l4Pos).toBeGreaterThan(-1);
    expect(l5Pos).toBeGreaterThan(-1);

    // Verify strict monotonic ordering: L1 < L2 < L3 < L4 < L5
    expect(l1Pos).toBeLessThan(l2Pos);
    expect(l2Pos).toBeLessThan(l3Pos);
    expect(l3Pos).toBeLessThan(l4Pos);
    expect(l4Pos).toBeLessThan(l5Pos);
  });

  it('verifies complete_dispatch_attempt acquires locks strictly in order L1 -> L4 -> L5', () => {
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
    const fnEnd = sql.indexOf('$$;', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = sql.slice(fnStart, fnEnd);

    const l1Pos = fnBody.indexOf('FROM public.generation_idempotency');
    const l4Pos = fnBody.indexOf('FROM public.rate_limit_reservations\n    WHERE reservation_token = p_reservation_token');
    const l5Pos = fnBody.indexOf('FROM public.rate_limit_dispatch_attempts\n    WHERE attempt_id = p_attempt_id');

    expect(l1Pos).toBeGreaterThan(-1);
    expect(l4Pos).toBeGreaterThan(-1);
    expect(l5Pos).toBeGreaterThan(-1);

    // Verify strict monotonic ordering: L1 < L4 < L5
    expect(l1Pos).toBeLessThan(l4Pos);
    expect(l4Pos).toBeLessThan(l5Pos);
  });

  it('verifies recover_reservation_ownership acquires locks strictly in order L1 -> L4', () => {
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.recover_reservation_ownership');
    const fnEnd = sql.indexOf('$$;', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = sql.slice(fnStart, fnEnd);

    const l1Pos = fnBody.indexOf('FROM public.generation_idempotency');
    const l4Pos = fnBody.indexOf('FROM public.rate_limit_reservations');

    expect(l1Pos).toBeGreaterThan(-1);
    expect(l4Pos).toBeGreaterThan(-1);

    // Verify strict monotonic ordering: L1 < L4
    expect(l1Pos).toBeLessThan(l4Pos);
  });

  it('verifies reserve_quota acquires locks strictly in order L1 -> L2 -> L3 -> L4', () => {
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.reserve_quota(');
    const fnEnd = sql.indexOf('$$;', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = sql.slice(fnStart, fnEnd);

    const l1Pos = fnBody.indexOf('FROM public.generation_idempotency');
    const l2Pos = fnBody.indexOf("FROM public.project_quota_configs\n    WHERE project_id = p_project_id AND quota_scope = 'global'");
    const l3Pos = fnBody.indexOf('FROM public.project_quota_configs\n    WHERE project_id = p_project_id AND quota_scope = p_quota_scope');
    const l4Pos = fnBody.indexOf('INSERT INTO public.rate_limit_reservations');

    expect(l1Pos).toBeGreaterThan(-1);
    expect(l2Pos).toBeGreaterThan(-1);
    expect(l3Pos).toBeGreaterThan(-1);
    expect(l4Pos).toBeGreaterThan(-1);

    // Verify strict monotonic ordering: L1 < L2 < L3 < L4
    expect(l1Pos).toBeLessThan(l2Pos);
    expect(l2Pos).toBeLessThan(l3Pos);
    expect(l3Pos).toBeLessThan(l4Pos);
  });

  it('verifies report_stale_attempt_outcome locks only L5', () => {
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.report_stale_attempt_outcome');
    const fnEnd = sql.indexOf('$$;', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = sql.slice(fnStart, fnEnd);

    expect(fnBody).toContain('FROM public.rate_limit_dispatch_attempts');
    expect(fnBody).not.toContain('FROM public.generation_idempotency');
    expect(fnBody).not.toContain('FROM public.project_quota_configs');
    expect(fnBody).not.toContain('FROM public.rate_limit_reservations');
  });
});
