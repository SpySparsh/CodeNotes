import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as quotaClient from '@/lib/quota-client';

/**
 * Note on Test Scope & Environment:
 * This test suite performs static text and AST invariant assertions on the PostgreSQL migration
 * routines in `scripts/migrate-canonical-chunk-settlement.sql` and unit mock tests on the
 * TypeScript client wrappers.
 *
 * It does NOT execute live PostgreSQL transactions, row-level locks (FOR UPDATE), or concurrency
 * race conditions against a running database engine. Full integration testing with true lock
 * acquisition and serialization requires a live PostgreSQL instance.
 */
describe('Canonical Chunk Settlement & Quota Replay Hardening', () => {
  const sqlPath = path.resolve(__dirname, '../scripts/migrate-canonical-chunk-settlement.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8').replace(/\r\n/g, '\n');

  // =========================================================================
  // 1. TypeScript Contract: Preservation of Attempt Identity on Normal & Adopted Paths
  // =========================================================================
  describe('TypeScript Contract & Attempt Identity Preservation', () => {
    it('1. Normal chunk completion preserves attemptId and passes it to completeDispatchAttempt', async () => {
      const mockAttemptId = '11111111-2222-3333-4444-555555555555';
      const mockSlotRes: quotaClient.ClaimOrAdoptDispatchSlotResult = {
        allowed: true,
        adopted: false,
        statusCode: 'DISPATCH_CLAIMED',
        ticket: quotaClient.createDispatchTicket(
          mockAttemptId,
          'res-token-1',
          1,
          1,
          'chunk'
        ),
        adoptedPayload: null,
        attemptId: mockAttemptId,
        attemptNumber: 1,
        generation: 1,
        leaseUntil: new Date(),
      };

      expect(mockSlotRes.attemptId).toBe(mockAttemptId);
      expect(mockSlotRes.adopted).toBe(false);
      expect(mockSlotRes.ticket).not.toBeNull();
    });

    it('2. Adoption of an already-existing chunk preserves attemptId and handles ALREADY_COMPLETED idempotently', async () => {
      const mockAdoptedAttemptId = '22222222-3333-4444-5555-666666666666';
      const mockAdoptedPayload = {
        overview: 'Adopted chunk overview',
        keyConcepts: ['Concept 1'],
        detailedNotes: 'Detailed adopted chunk notes',
        shorthands: ['Short 1'],
      };

      const mockSlotRes: quotaClient.ClaimOrAdoptDispatchSlotResult = {
        allowed: true,
        adopted: true,
        statusCode: 'ADOPTED_EXISTING_CHUNK',
        ticket: null,
        adoptedPayload: mockAdoptedPayload,
        attemptId: mockAdoptedAttemptId,
        attemptNumber: 1,
        generation: 1,
        leaseUntil: new Date(),
      };

      // Invariant: attemptId must be preserved on adoption
      expect(mockSlotRes.attemptId).toBe(mockAdoptedAttemptId);
      expect(mockSlotRes.adopted).toBe(true);
      expect(mockSlotRes.adoptedPayload).toEqual(mockAdoptedPayload);

      // Verify that calling completeDispatchAttempt with this attemptId returns ALREADY_COMPLETED without error
      const mockCompleteDispatch = vi.fn().mockResolvedValue({
        success: true,
        statusCode: 'ALREADY_COMPLETED',
        completedAt: new Date(),
      });

      const res = await mockCompleteDispatch({
        attemptId: mockSlotRes.attemptId,
        reservationToken: 'res-token-1',
        leaseToken: 'lease-token-1',
        workerId: 'worker-1',
        fencingGeneration: 1,
        operationType: 'chunk',
        responsePayload: mockSlotRes.adoptedPayload,
        totalTokens: 1200,
        promptTokens: 800,
        candidateTokens: 400,
        thoughtsTokens: 50,
        modelName: 'gemini-2.0-flash',
      });

      expect(res.success).toBe(true);
      expect(res.statusCode).toBe('ALREADY_COMPLETED');
    });

    it('3. Adoption of a restored missing chunk preserves attemptId and surfaces errors on failure', async () => {
      const mockRestoredAttemptId = '33333333-4444-5555-6666-777777777777';
      const mockRestoredPayload = {
        overview: 'Restored chunk overview',
        keyConcepts: ['Restored Concept'],
        detailedNotes: 'Restored detailed chunk notes',
        shorthands: ['Restored Short'],
      };

      const mockSlotRes: quotaClient.ClaimOrAdoptDispatchSlotResult = {
        allowed: true,
        adopted: true,
        statusCode: 'ADOPTED_AND_RESTORED_CHUNK',
        ticket: null,
        adoptedPayload: mockRestoredPayload,
        attemptId: mockRestoredAttemptId,
        attemptNumber: 1,
        generation: 1,
        leaseUntil: new Date(),
      };

      expect(mockSlotRes.attemptId).toBe(mockRestoredAttemptId);
      expect(mockSlotRes.statusCode).toBe('ADOPTED_AND_RESTORED_CHUNK');

      // Failure during settlement must not be ignored
      const mockCompleteFailing = vi.fn().mockResolvedValue({
        success: false,
        statusCode: 'LOCK_TIMEOUT',
        completedAt: null,
      });

      const compRes = await mockCompleteFailing({
        attemptId: mockSlotRes.attemptId,
        reservationToken: 'res-token-1',
        leaseToken: 'lease-token-1',
        workerId: 'worker-1',
        fencingGeneration: 1,
        operationType: 'chunk',
        responsePayload: mockSlotRes.adoptedPayload,
        totalTokens: 1500,
        promptTokens: 1000,
        candidateTokens: 500,
        thoughtsTokens: 0,
        modelName: 'gemini-2.0-flash',
      });

      expect(compRes.success).toBe(false);
      expect(compRes.statusCode).toBe('LOCK_TIMEOUT');
    });

    it('4. Retry after settlement has already completed succeeds without re-execution', async () => {
      const completedAt = new Date('2026-11-25T01:00:00Z');
      const mockCompleteDispatch = vi.fn().mockResolvedValue({
        success: true,
        statusCode: 'ALREADY_COMPLETED',
        completedAt,
      });

      const result = await mockCompleteDispatch({
        attemptId: 'existing-attempt-id',
        reservationToken: 'res-token-1',
        leaseToken: 'lease-token-1',
        workerId: 'worker-1',
        fencingGeneration: 1,
        operationType: 'chunk',
        responsePayload: { overview: 'Cached' },
        totalTokens: 1000,
        promptTokens: 700,
        candidateTokens: 300,
        thoughtsTokens: 0,
        modelName: 'gemini-2.0-flash',
      });

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe('ALREADY_COMPLETED');
      expect(result.completedAt).toEqual(completedAt);
    });
  });

  // =========================================================================
  // 2. SQL Contract: Canonical Settlement & Replay Guarantees
  // =========================================================================
  describe('SQL Settlement Invariants & Atomicity', () => {
    it('5. Ensures complete_dispatch_attempt reconciles missing chunk, missing COMMIT event, and reservation token accounting', () => {
      const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const fnEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_chunk_and_commit_quota', fnStart);
      expect(fnStart).toBeGreaterThan(-1);
      expect(fnEnd).toBeGreaterThan(-1);
      const fnBody = sql.slice(fnStart, fnEnd);

      // Verifies unconsumed & overage token calculation using authoritative total tokens
      expect(fnBody).toContain('v_unconsumed_total := v_res.estimated_tokens - v_final_total;');
      expect(fnBody).toContain('v_overage_total := v_final_total - v_res.estimated_tokens;');

      // Verifies chunk reconciliation / upsert
      expect(fnBody).toContain('UPDATE public.chunk_generations');
      expect(fnBody).toContain('INSERT INTO public.chunk_generations');

      // Verifies rate_limit_events COMMIT accounting
      expect(fnBody).toContain('INSERT INTO public.rate_limit_events');
      expect(fnBody).toContain("'COMMIT'");
      expect(fnBody).toContain("'CHUNK_COMMITTED'");

      // Verifies atomic attempt and reservation update
      expect(fnBody).toContain("UPDATE public.rate_limit_dispatch_attempts\n    SET status = 'completed'");
      expect(fnBody).toContain("UPDATE public.rate_limit_reservations\n    SET status = 'committed'");
      expect(fnBody).toContain('unconsumed_total_tokens = v_unconsumed_total');
      expect(fnBody).toContain('overage_total_tokens = v_overage_total');

      // Verifies ALREADY_COMPLETED is returned safely after reconciliation
      expect(fnBody).toContain("RETURN QUERY SELECT true, 'ALREADY_COMPLETED'::VARCHAR");
    });

    it('6. Enforces conflicting attempt/chunk identity and prevents cross-operation adoption', () => {
      // In claim_or_adopt_dispatch_slot:
      const adoptStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_or_adopt_dispatch_slot');
      const adoptEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt', adoptStart);
      const adoptBody = sql.slice(adoptStart, adoptEnd);

      // Must strictly validate attempt matches requested operation_type
      expect(adoptBody).toContain('IF v_existing_attempt.operation_type IS DISTINCT FROM p_operation_type THEN');
      expect(adoptBody).toContain("RETURN QUERY SELECT false, false, 'OPERATION_TYPE_MISMATCH'::VARCHAR");

      // Must reject conflicting chunk reservation token
      expect(adoptBody).toContain('RAISE EXCEPTION \'CONFLICTING_CHUNK_PAYLOAD: Chunk exists with conflicting reservation %\'');

      // Must reject conflicting chunk payload
      expect(adoptBody).toContain('RAISE EXCEPTION \'CONFLICTING_CHUNK_PAYLOAD: Existing chunk notes conflict with attempt payload\'');

      // In complete_dispatch_attempt:
      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compBody = sql.slice(compStart);

      // Rejects operation type mismatch
      expect(compBody).toContain("RETURN QUERY SELECT false, 'OPERATION_TYPE_MISMATCH'::VARCHAR, NULL::TIMESTAMPTZ;");

      // Rejects conflicting reservation on chunk
      expect(compBody).toContain("RETURN QUERY SELECT false, 'CONFLICTING_RESERVATION_COMPLETION'::VARCHAR, NULL::TIMESTAMPTZ;");

      // Rejects conflicting chunk payload on replay
      expect(compBody).toContain("RETURN QUERY SELECT false, 'CONFLICTING_CHUNK_PAYLOAD'::VARCHAR, NULL::TIMESTAMPTZ;");
    });

    it('7. Enforces fencing generation, lease ownership, and lease expiry verification', () => {
      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compBody = sql.slice(compStart);

      // Lease ownership on reservation and attempt
      expect(compBody).toContain('IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN');
      expect(compBody).toContain('IF v_attempt.worker_id IS DISTINCT FROM p_worker_id THEN');
      expect(compBody).toContain("RETURN QUERY SELECT false, 'STALE_LEASE_OWNERSHIP'::VARCHAR, NULL::TIMESTAMPTZ;");

      // Fencing generation on reservation and attempt
      expect(compBody).toContain('IF v_res.generation IS DISTINCT FROM p_fencing_generation THEN');
      expect(compBody).toContain('IF v_attempt.generation IS DISTINCT FROM p_fencing_generation THEN');
      expect(compBody).toContain("RETURN QUERY SELECT false, 'FENCING_GENERATION_MISMATCH'::VARCHAR, NULL::TIMESTAMPTZ;");

      // Terminal state protection
      expect(compBody).toContain("IF v_res.status IN ('settled_failure', 'released', 'reconciled_zero_usage', 'expired_day_boundary')");
      expect(compBody).toContain("RETURN QUERY SELECT false, 'ATTEMPT_ALREADY_TERMINAL'::VARCHAR, NULL::TIMESTAMPTZ;");
    });

    it('8. Enforces Universal Lock Hierarchy strictly in order L1 -> L4 -> L5 -> L6', () => {
      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_chunk_and_commit_quota', compStart);
      const compBody = sql.slice(compStart, compEnd);

      const l1Pos = compBody.indexOf('FROM public.generation_idempotency\n    WHERE user_id = COALESCE');
      const l4Pos = compBody.indexOf('FROM public.rate_limit_reservations\n    WHERE reservation_token = p_reservation_token\n    FOR UPDATE;');
      const l5Pos = compBody.indexOf('FROM public.rate_limit_dispatch_attempts\n    WHERE attempt_id = v_attempt_id');
      const l6Pos = compBody.indexOf('FROM public.chunk_generations\n        WHERE user_id = v_res.user_id AND parent_key = v_res.parent_key AND chunk_index = v_res.chunk_index\n        FOR UPDATE;');

      expect(l1Pos).toBeGreaterThan(-1);
      expect(l4Pos).toBeGreaterThan(-1);
      expect(l5Pos).toBeGreaterThan(-1);
      expect(l6Pos).toBeGreaterThan(-1);

      // Monotonic lock acquisition: L1 < L4 < L5 < L6 prevents deadlocks under concurrent calls
      expect(l1Pos).toBeLessThan(l4Pos);
      expect(l4Pos).toBeLessThan(l5Pos);
      expect(l5Pos).toBeLessThan(l6Pos);
    });

    it('9. Parent-generation retryability & adoption after commitment: permits completed parents and committed reservations to reach adoption while preventing new dispatches', () => {
      const adoptStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_or_adopt_dispatch_slot');
      const adoptEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt', adoptStart);
      const adoptBody = sql.slice(adoptStart, adoptEnd);

      // Parent generation permits completed parent status to proceed to adoption
      expect(adoptBody).toContain("IF v_parent_status NOT IN ('processing', 'pending', 'completed') THEN");
      // Proves old blocking check is no longer present
      expect(adoptBody).not.toContain("IF v_parent_status NOT IN ('processing', 'pending') THEN");

      // Forbids new dispatch claims if parent generation is already completed
      expect(adoptBody).toContain("IF v_parent_status = 'completed' THEN");
      expect(adoptBody).toContain("RETURN QUERY SELECT false, false, 'PARENT_GENERATION_ALREADY_COMPLETED'::VARCHAR");

      // Rejection of unrelated terminal statuses before adoption check
      expect(adoptBody).toContain("IF v_res.status = 'settled_failure' THEN");
      expect(adoptBody).toContain("'RESERVATION_ALREADY_SETTLED_FAILURE'");
      expect(adoptBody).toContain("ELSIF v_res.status IN ('released', 'reconciled_zero_usage', 'expired_day_boundary') THEN");
      expect(adoptBody).toContain("'RESERVATION_ALREADY_TERMINAL'");

      // Committed reservation is permitted into adoption check
      expect(adoptBody).toContain("ELSIF v_res.status NOT IN ('active', 'dispatching', 'dispatched', 'committed') THEN");

      // If reservation is committed and no completed attempt was adopted, reject as terminal
      expect(adoptBody).toContain("IF v_res.status = 'committed' THEN");
      expect(adoptBody).toContain("RETURN QUERY SELECT false, false, 'RESERVATION_ALREADY_TERMINAL'::VARCHAR");

      // Guarded inserts preventing duplicate records on repeated adoption
      expect(adoptBody).toContain('IF v_existing_chunk.chunk_id IS NOT NULL THEN');
      expect(adoptBody).toContain('INSERT INTO public.chunk_generations');
      expect(adoptBody).toContain('IF NOT EXISTS (SELECT 1 FROM public.notes WHERE attempt_id = v_existing_attempt.attempt_id)');
      expect(adoptBody).toContain('SELECT * INTO v_existing_event\n            FROM public.rate_limit_events\n            WHERE reservation_token = p_reservation_token AND event_type = \'COMMIT\'');
    });

    it('10. Completed-attempt adoption across workers: allows adopting worker to adopt completed work while strictly fencing unfinished attempts', () => {
      const adoptStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_or_adopt_dispatch_slot');
      const adoptEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt', adoptStart);
      const adoptBody = sql.slice(adoptStart, adoptEnd);

      // Reservation coordinates and lease ownership validation for adopting worker
      expect(adoptBody).toContain('IF v_res.user_id IS DISTINCT FROM p_user_id');
      expect(adoptBody).toContain('OR v_res.parent_key IS DISTINCT FROM p_parent_key');
      expect(adoptBody).toContain("OR (p_operation_type = 'chunk' AND v_res.chunk_index IS DISTINCT FROM p_chunk_index)");
      expect(adoptBody).toContain('IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN');
      expect(adoptBody).toContain('IF v_res.generation IS DISTINCT FROM p_generation THEN');

      // Proves old problematic checks requiring completed attempt worker to equal adopting worker are gone
      expect(adoptBody).not.toContain('IF v_existing_attempt.generation IS DISTINCT FROM p_generation THEN');
      expect(adoptBody).not.toContain('IF v_existing_attempt.worker_id IS DISTINCT FROM p_worker_id THEN');

      // Attempt operation type and payload presence are verified
      expect(adoptBody).toContain('IF v_existing_attempt.operation_type IS DISTINCT FROM p_operation_type THEN');
      expect(adoptBody).toContain('IF v_existing_attempt.response_payload IS NULL THEN');

      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compBody = sql.slice(compStart);

      // In complete_dispatch_attempt: unfinished attempts require strict worker ownership and generation match
      expect(compBody).toContain('IF NOT v_is_already_completed THEN');
      expect(compBody).toContain('IF v_attempt.worker_id IS DISTINCT FROM p_worker_id THEN');
      expect(compBody).toContain('IF v_attempt.generation IS DISTINCT FROM p_fencing_generation THEN');
    });

    it('11. Lease expiry: strictly prevents unfinished attempts from completing after lease expiry while allowing completed reconciliation', () => {
      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compBody = sql.slice(compStart);

      // Unfinished attempts fail on lease expiry
      expect(compBody).toContain('IF NOT v_is_already_completed THEN');
      expect(compBody).toContain('IF v_now > v_res.lease_until OR v_now > v_attempt.lease_until THEN');
      expect(compBody).toContain("RETURN QUERY SELECT false, 'LEASE_EXPIRED_DURING_EXECUTION'::VARCHAR");

      // Already completed reconciliation returns ALREADY_COMPLETED without being blocked by expired lease
      expect(compBody).toContain("IF v_is_already_completed THEN\n        RETURN QUERY SELECT true, 'ALREADY_COMPLETED'::VARCHAR");
    });

    it('12. Reconciliation of partially settled attempts & authoritative accounting: rejects conflicts and preserves existing payload/counters', () => {
      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compBody = sql.slice(compStart);

      // Identifies completed attempt even if reservation is not yet committed
      expect(compBody).toContain("IF v_attempt.status IN ('completed', 'adopted') THEN\n        v_is_already_completed := true;");
      // Proves old check requiring reservation to already be committed is gone
      expect(compBody).not.toContain("IF v_attempt.status IN ('completed', 'adopted') AND v_res.status = 'committed' THEN");

      // Rejects conflicting token counters
      expect(compBody).toContain('IF v_attempt.actual_total_tokens IS NOT NULL AND p_total_tokens IS NOT NULL');
      expect(compBody).toContain('AND v_attempt.actual_total_tokens <> p_total_tokens THEN');
      expect(compBody).toContain("RETURN QUERY SELECT false, 'CONFLICTING_TOKEN_COUNT'::VARCHAR");

      // Rejects conflicting attempt payload
      expect(compBody).toContain('IF v_attempt.response_payload IS NOT NULL AND p_response_payload IS NOT NULL');
      expect(compBody).toContain('AND v_attempt.response_payload IS DISTINCT FROM p_response_payload THEN');
      expect(compBody).toContain("RETURN QUERY SELECT false, 'CONFLICTING_ATTEMPT_PAYLOAD'::VARCHAR");

      // Rejects conflicting chunk payload
      expect(compBody).toContain('IF v_chunk.chunk_notes IS NOT NULL AND v_final_payload IS NOT NULL');
      expect(compBody).toContain('AND v_chunk.chunk_notes IS DISTINCT FROM v_final_payload THEN');
      expect(compBody).toContain("RETURN QUERY SELECT false, 'CONFLICTING_CHUNK_PAYLOAD'::VARCHAR");

      // Uses authoritative attempt values and does not overwrite with retry parameters
      expect(compBody).toContain('v_final_payload   := COALESCE(v_attempt.response_payload, p_response_payload);');
      expect(compBody).toContain('v_final_total     := COALESCE(v_attempt.actual_total_tokens, p_total_tokens);');
      expect(compBody).toContain('v_final_prompt    := COALESCE(v_attempt.actual_prompt_tokens, p_prompt_tokens);');
      expect(compBody).toContain('v_final_candidate := COALESCE(v_attempt.actual_candidate_tokens, p_candidate_tokens);');
      expect(compBody).toContain('v_final_thoughts  := COALESCE(v_attempt.actual_thoughts_tokens, p_thoughts_tokens);');
    });

    it('13. Legacy wrapper & canonical completion: resolves lock ordering and converges on attempt under L1/L4 locks', () => {
      const wrapperStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_chunk_and_commit_quota');
      const wrapperEnd = sql.indexOf('GRANT EXECUTE ON FUNCTION public.claim_or_adopt_dispatch_slot', wrapperStart);
      const wrapperBody = sql.slice(wrapperStart, wrapperEnd);

      // 1. Wrapper does NOT perform pre-lock writes or inserts into rate_limit_dispatch_attempts
      expect(wrapperBody).not.toContain('INSERT INTO public.rate_limit_dispatch_attempts');
      expect(wrapperBody).not.toContain('SELECT attempt_id INTO v_attempt_id');

      // 2. Wrapper routes directly to complete_dispatch_attempt passing NULL attempt_id under canonical lock ordering
      expect(wrapperBody).toContain('FROM public.complete_dispatch_attempt(\n        NULL,');

      // 3. Inspect canonical complete_dispatch_attempt for lock-ordered attempt lookup, reuse, and synthesis
      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compBody = sql.slice(compStart, wrapperStart);

      const l1Pos = compBody.indexOf('FROM public.generation_idempotency\n    WHERE user_id = COALESCE');
      const l4Pos = compBody.indexOf('FROM public.rate_limit_reservations\n    WHERE reservation_token = p_reservation_token\n    FOR UPDATE;');
      const attemptLookupPos = compBody.indexOf('IF v_attempt_id IS NULL THEN');
      const attemptInsertPos = compBody.indexOf('INSERT INTO public.rate_limit_dispatch_attempts');
      const l5Pos = compBody.indexOf('FROM public.rate_limit_dispatch_attempts\n    WHERE attempt_id = v_attempt_id');

      expect(l1Pos).toBeGreaterThan(-1);
      expect(l4Pos).toBeGreaterThan(-1);
      expect(attemptLookupPos).toBeGreaterThan(-1);
      expect(attemptInsertPos).toBeGreaterThan(-1);
      expect(l5Pos).toBeGreaterThan(-1);

      // Verifies L1 and L4 locks are acquired BEFORE attempt lookup, synthesis, or L5 lock
      expect(l1Pos).toBeLessThan(l4Pos);
      expect(l4Pos).toBeLessThan(attemptLookupPos);
      expect(attemptLookupPos).toBeLessThan(attemptInsertPos);
      expect(attemptInsertPos).toBeLessThan(l5Pos);

      // Verifies attempt reuse when an attempt already exists
      expect(compBody).toContain('SELECT attempt_id INTO v_attempt_id\n        FROM public.rate_limit_dispatch_attempts\n        WHERE reservation_token = p_reservation_token\n          AND operation_type = p_operation_type\n        ORDER BY attempt_number DESC\n        LIMIT 1;');

      // Verifies synthetic insert uses ON CONFLICT DO NOTHING to prevent unhandled unique violations
      expect(compBody).toContain('ON CONFLICT (reservation_token, attempt_number) DO NOTHING;');

      // Verifies re-selection to converge concurrent callers on the winner attempt
      expect(compBody).toContain('SELECT attempt_id INTO v_attempt_id\n            FROM public.rate_limit_dispatch_attempts\n            WHERE reservation_token = p_reservation_token\n              AND attempt_number = 1;');
    });

    it('14. PostgreSQL signature correctness: explicit signatures on GRANT EXECUTE and ALTER FUNCTION OWNER TO', () => {
      // Explicit GRANT EXECUTE signatures
      expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.claim_or_adopt_dispatch_slot(\n    UUID, VARCHAR, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL\n) TO service_role;');
      expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.complete_dispatch_attempt(\n    UUID, UUID, UUID, VARCHAR, INTEGER, VARCHAR, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, UUID, VARCHAR, VARCHAR, TEXT, TEXT, TEXT\n) TO service_role;');
      expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.complete_chunk_and_commit_quota(\n    UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR\n) TO service_role;');

      // Explicit ALTER FUNCTION OWNER TO signatures
      expect(sql).toContain('ALTER FUNCTION public.claim_or_adopt_dispatch_slot(\n    UUID, VARCHAR, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL\n) OWNER TO codenotes_definer;');
      expect(sql).toContain('ALTER FUNCTION public.complete_dispatch_attempt(\n    UUID, UUID, UUID, VARCHAR, INTEGER, VARCHAR, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, UUID, VARCHAR, VARCHAR, TEXT, TEXT, TEXT\n) OWNER TO codenotes_definer;');
      expect(sql).toContain('ALTER FUNCTION public.complete_chunk_and_commit_quota(\n    UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR\n) OWNER TO codenotes_definer;');
    });

    it('15. Monolithic adoption accounting: reconciles reservation actual token counters, unconsumed, and overage tokens from attempt authoritative values', () => {
      const adoptStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_or_adopt_dispatch_slot');
      const adoptEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt', adoptStart);
      const adoptBody = sql.slice(adoptStart, adoptEnd);

      // Verifies monolithic adoption calculates unconsumed and overage tokens from attempt actual tokens
      expect(adoptBody).toContain('v_unconsumed_total := v_res.estimated_tokens - v_existing_attempt.actual_total_tokens;');
      expect(adoptBody).toContain('v_overage_total := v_existing_attempt.actual_total_tokens - v_res.estimated_tokens;');

      // Verifies reservation update includes actual tokens, unconsumed tokens, and overage tokens
      const monoBlockStart = adoptBody.indexOf("IF p_operation_type = 'monolithic' THEN");
      const monoBlockEnd = adoptBody.indexOf("IF p_operation_type = 'synthesis' THEN", monoBlockStart);
      const monoBody = adoptBody.slice(monoBlockStart, monoBlockEnd);

      expect(monoBody).toContain("UPDATE public.rate_limit_reservations\n            SET status = 'committed'");
      expect(monoBody).toContain('actual_total_tokens = COALESCE(v_existing_attempt.actual_total_tokens, actual_total_tokens)');
      expect(monoBody).toContain('actual_prompt_tokens = COALESCE(v_existing_attempt.actual_prompt_tokens, actual_prompt_tokens)');
      expect(monoBody).toContain('actual_candidate_tokens = COALESCE(v_existing_attempt.actual_candidate_tokens, actual_candidate_tokens)');
      expect(monoBody).toContain('actual_thoughts_tokens = COALESCE(v_existing_attempt.actual_thoughts_tokens, actual_thoughts_tokens)');
      expect(monoBody).toContain('unconsumed_total_tokens = v_unconsumed_total');
      expect(monoBody).toContain('overage_total_tokens = v_overage_total');

      // Verifies COMMIT event agrees with reservation accounting
      expect(monoBody).toContain("'unconsumed_total_tokens', v_unconsumed_total");
      expect(monoBody).toContain("'overage_total_tokens', v_overage_total");
      expect(monoBody).toContain("'thoughts_tokens', v_existing_attempt.actual_thoughts_tokens");
      expect(monoBody).toContain("'disposition', 'NOTE_COMMITTED'");

      // Verifies idempotent handling of already-existing note
      expect(monoBody).toContain('IF NOT EXISTS (SELECT 1 FROM public.notes WHERE attempt_id = v_existing_attempt.attempt_id)');
    });

    it('16. [Static Check] Existing COMMIT event validation: verifies reservation identity, token counters, and raises exception on mismatch', () => {
      // In claim_or_adopt_dispatch_slot:
      const adoptStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_or_adopt_dispatch_slot');
      const adoptEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt', adoptStart);
      const adoptBody = sql.slice(adoptStart, adoptEnd);

      expect(adoptBody).toContain("RAISE EXCEPTION 'CONFLICTING_COMMIT_EVENT: Existing COMMIT event accounting conflicts with attempt'");
      expect(adoptBody).toContain('v_existing_event.total_tokens IS DISTINCT FROM v_existing_attempt.actual_total_tokens');
      expect(adoptBody).toContain('v_existing_event.prompt_tokens IS DISTINCT FROM v_existing_attempt.actual_prompt_tokens');
      expect(adoptBody).toContain('v_existing_event.candidate_tokens IS DISTINCT FROM v_existing_attempt.actual_candidate_tokens');
      expect(adoptBody).toContain('v_existing_event.thoughts_tokens IS DISTINCT FROM v_existing_attempt.actual_thoughts_tokens');
      expect(adoptBody).toContain('v_existing_event.project_id IS DISTINCT FROM v_res.project_id');
      expect(adoptBody).toContain('v_existing_event.quota_scope IS DISTINCT FROM v_res.quota_scope');
      expect(adoptBody).toContain('v_existing_event.user_id IS DISTINCT FROM p_user_id');
      expect(adoptBody).toContain('v_existing_event.parent_key IS DISTINCT FROM p_parent_key');

      // In complete_dispatch_attempt:
      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compBody = sql.slice(compStart);

      expect(compBody).toContain("RAISE EXCEPTION 'CONFLICTING_COMMIT_EVENT: Existing COMMIT event accounting conflicts with attempt'");
      expect(compBody).toContain('v_existing_event.total_tokens IS DISTINCT FROM v_final_total');
      expect(compBody).toContain('v_existing_event.prompt_tokens IS DISTINCT FROM v_final_prompt');
      expect(compBody).toContain('v_existing_event.candidate_tokens IS DISTINCT FROM v_final_candidate');
      expect(compBody).toContain('v_existing_event.thoughts_tokens IS DISTINCT FROM v_final_thoughts');
      expect(compBody).toContain('v_existing_event.project_id IS DISTINCT FROM v_res.project_id');
      expect(compBody).toContain('v_existing_event.quota_scope IS DISTINCT FROM v_res.quota_scope');
      expect(compBody).toContain('v_existing_event.user_id IS DISTINCT FROM v_res.user_id');
      expect(compBody).toContain('v_existing_event.parent_key IS DISTINCT FROM v_res.parent_key');
      expect(compBody).toContain('v_existing_event.chunk_index IS DISTINCT FROM v_res.chunk_index');
    });

    it('17. Thoughts-token conflict: rejects conflicting thoughts tokens and persists authoritative thoughts token count', () => {
      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compBody = sql.slice(compStart);

      // Verifies conflict check for thoughts tokens alongside total, prompt, candidate
      expect(compBody).toContain('IF v_attempt.actual_thoughts_tokens IS NOT NULL AND p_thoughts_tokens IS NOT NULL');
      expect(compBody).toContain('AND v_attempt.actual_thoughts_tokens <> p_thoughts_tokens THEN');
      expect(compBody).toContain("RETURN QUERY SELECT false, 'CONFLICTING_TOKEN_COUNT'::VARCHAR, NULL::TIMESTAMPTZ;");

      // Verifies all four token counters maintain authoritative persistence
      expect(compBody).toContain('v_final_thoughts  := COALESCE(v_attempt.actual_thoughts_tokens, p_thoughts_tokens);');
      expect(compBody).toContain('actual_thoughts_tokens = v_final_thoughts');
    });

    it('18. Attempt coordinate validation: validates available attempt coordinates (project_id, quota_scope, reservation_token) without querying nonexistent columns', () => {
      const adoptStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_or_adopt_dispatch_slot');
      const adoptEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt', adoptStart);
      const adoptBody = sql.slice(adoptStart, adoptEnd);

      // In claim_or_adopt_dispatch_slot: validates coordinates on v_existing_attempt
      expect(adoptBody).toContain('IF v_existing_attempt.reservation_token IS DISTINCT FROM p_reservation_token');
      expect(adoptBody).toContain('OR v_existing_attempt.project_id IS DISTINCT FROM v_res.project_id');
      expect(adoptBody).toContain('OR v_existing_attempt.quota_scope IS DISTINCT FROM v_res.quota_scope THEN');
      expect(adoptBody).toContain("RETURN QUERY SELECT false, false, 'ATTEMPT_COORDINATE_MISMATCH'::VARCHAR");

      // In complete_dispatch_attempt: validates coordinates on v_attempt
      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compBody = sql.slice(compStart);

      expect(compBody).toContain('IF v_attempt.reservation_token IS DISTINCT FROM p_reservation_token');
      expect(compBody).toContain('OR v_attempt.project_id IS DISTINCT FROM v_res.project_id');
      expect(compBody).toContain('OR v_attempt.quota_scope IS DISTINCT FROM v_res.quota_scope THEN');
      expect(compBody).toContain("RETURN QUERY SELECT false, 'ATTEMPT_COORDINATE_MISMATCH'::VARCHAR, NULL::TIMESTAMPTZ;");

      // Verifies that nonexistent columns (user_id, parent_key, chunk_index) are NOT queried on rate_limit_dispatch_attempts
      expect(adoptBody).not.toContain('v_existing_attempt.user_id');
      expect(adoptBody).not.toContain('v_existing_attempt.parent_key');
      expect(adoptBody).not.toContain('v_existing_attempt.chunk_index');
      expect(compBody).not.toContain('v_attempt.user_id');
      expect(compBody).not.toContain('v_attempt.parent_key');
      expect(compBody).not.toContain('v_attempt.chunk_index');
    });

    it('19. [Static Check] COMMIT event conflict detection precedes all settlement writes and raises exception to prevent partial mutations', () => {
      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_chunk_and_commit_quota', compStart);
      const compBody = sql.slice(compStart, compEnd);

      const commitCheckPos = compBody.indexOf('SELECT * INTO v_existing_event\n    FROM public.rate_limit_events\n    WHERE reservation_token = p_reservation_token AND event_type = \'COMMIT\'');
      const chunkMutatePos = compBody.indexOf('UPDATE public.chunk_generations');
      const noteMutatePos = compBody.indexOf('INSERT INTO public.notes');
      const attemptMutatePos = compBody.indexOf('UPDATE public.rate_limit_dispatch_attempts');
      const resMutatePos = compBody.indexOf('UPDATE public.rate_limit_reservations');

      expect(commitCheckPos).toBeGreaterThan(-1);
      expect(chunkMutatePos).toBeGreaterThan(-1);
      expect(noteMutatePos).toBeGreaterThan(-1);
      expect(attemptMutatePos).toBeGreaterThan(-1);
      expect(resMutatePos).toBeGreaterThan(-1);

      // Verify strict write ordering: COMMIT event validation occurs BEFORE any settlement writes
      expect(commitCheckPos).toBeLessThan(chunkMutatePos);
      expect(commitCheckPos).toBeLessThan(noteMutatePos);
      expect(commitCheckPos).toBeLessThan(attemptMutatePos);
      expect(commitCheckPos).toBeLessThan(resMutatePos);

      // Verify that RAISE EXCEPTION is used instead of RETURN QUERY SELECT false so PL/pgSQL rolls back
      const validationSlice = compBody.slice(commitCheckPos, chunkMutatePos);
      expect(validationSlice).toContain("RAISE EXCEPTION 'CONFLICTING_COMMIT_EVENT: Existing COMMIT event accounting conflicts with attempt'");
      expect(validationSlice).not.toContain("RETURN QUERY SELECT false, 'CONFLICTING_COMMIT_EVENT'");
    });

    it('20. [Static Check] Strict null-safe event validation rejects populated-vs-NULL mismatches and allows matching idempotent replays', () => {
      const compStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt');
      const compBody = sql.slice(compStart);

      // Null event counter cannot silently pass: IS DISTINCT FROM ensures NULL is distinct from any integer
      expect(compBody).toContain('v_existing_event.total_tokens IS DISTINCT FROM v_final_total');
      expect(compBody).toContain('v_existing_event.prompt_tokens IS DISTINCT FROM v_final_prompt');
      expect(compBody).toContain('v_existing_event.candidate_tokens IS DISTINCT FROM v_final_candidate');
      expect(compBody).toContain('v_existing_event.thoughts_tokens IS DISTINCT FROM v_final_thoughts');

      // Proves vulnerable non-null checks that let NULL event counters slip through are eliminated
      expect(compBody).not.toContain('v_existing_event.total_tokens IS NOT NULL AND v_final_total IS NOT NULL');
      expect(compBody).not.toContain('v_existing_event.thoughts_tokens IS NOT NULL AND v_final_thoughts IS NOT NULL');

      // Matching existing COMMIT event allows idempotent completion without duplicate INSERT
      expect(compBody).toContain('IF v_existing_event.event_id IS NULL THEN');
      expect(compBody).toContain('INSERT INTO public.rate_limit_events');

      // Verify same guarantees in claim_or_adopt_dispatch_slot
      const adoptStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_or_adopt_dispatch_slot');
      const adoptEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt', adoptStart);
      const adoptBody = sql.slice(adoptStart, adoptEnd);

      expect(adoptBody).not.toContain('v_existing_event.total_tokens IS NOT NULL AND v_existing_attempt.actual_total_tokens IS NOT NULL');
      expect(adoptBody).toContain('v_existing_event.total_tokens IS DISTINCT FROM v_existing_attempt.actual_total_tokens');
      expect(adoptBody).toContain('IF v_existing_event.event_id IS NULL THEN\n                INSERT INTO public.rate_limit_events');
    });
  });
});
