/**
 * CodeNotes AI — Database Data Access Layer (Quota Client)
 * Strictly typed TypeScript wrappers for the 11 SECURITY DEFINER PL/pgSQL database routines
 * governing rate limiting, token quota reservations, chunk persistence, and administrative reconciliation.
 */

import { query } from '@/lib/db';
import { logger } from '@/lib/logger';

// -----------------------------------------------------------------------------
// TYPES & DOMAIN MODELS
// -----------------------------------------------------------------------------

export type ReservationStatus =
  | 'active'
  | 'dispatching'
  | 'dispatched'
  | 'committed'
  | 'released'
  | 'aborted'
  | 'uncertain'
  | 'reconciled_zero_usage';

export type TicketStatus = 'ACTIVE' | 'CONSUMED' | 'REVOKED' | 'EXPIRED';

export class QuotaError extends Error {
  readonly statusCode: string;
  readonly isRetryable: boolean;

  constructor(statusCode: string, message?: string, isRetryable = false) {
    super(message ? `Quota Error [${statusCode}]: ${message}` : `Quota Error [${statusCode}]`);
    this.name = 'QuotaError';
    this.statusCode = statusCode;
    this.isRetryable = isRetryable;
  }
}

/** Check if a quota status code indicates a transient rate-limit rejection */
export function isRateLimitExceeded(statusCode: string): boolean {
  return [
    'RATE_LIMIT_RPM_EXCEEDED',
    'RATE_LIMIT_TPM_EXCEEDED',
    'RATE_LIMIT_RPD_EXCEEDED',
    'MAX_ACTIVE_DISPATCHES_EXCEEDED',
  ].includes(statusCode);
}

// -----------------------------------------------------------------------------
// 1. RESERVE QUOTA
// -----------------------------------------------------------------------------

export interface ReserveQuotaParams {
  userId: string;
  parentKey: string;
  chunkIndex: number;
  projectId: string;
  quotaScope: string;
  modelName: string;
  workerId: string;
  estimatedTokens: number;
  leaseDurationInterval?: string; // e.g. '120 seconds'
}

export interface ReserveQuotaResult {
  allowed: boolean;
  statusCode: string;
  reservationToken: string | null;
  leaseToken: string | null;
  generation: number | null;
  leaseUntil: Date | null;
}

export async function reserveQuota(params: ReserveQuotaParams): Promise<ReserveQuotaResult> {
  const leaseDuration = params.leaseDurationInterval || '120 seconds';
  const res = await query(
    `SELECT reservation_token, lease_token, generation, lease_until, allowed, status_code
     FROM public.reserve_quota($1, $2, $3, $4, $5, $6, $7, $8, $9::interval)`,
    [
      params.userId,
      params.parentKey,
      params.chunkIndex,
      params.projectId,
      params.quotaScope,
      params.modelName,
      params.workerId,
      params.estimatedTokens,
      leaseDuration,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'reserve_quota returned no rows');
  }

  return {
    allowed: Boolean(row.allowed),
    statusCode: row.status_code,
    reservationToken: row.reservation_token || null,
    leaseToken: row.lease_token || null,
    generation: row.generation != null ? Number(row.generation) : null,
    leaseUntil: row.lease_until ? new Date(row.lease_until) : null,
  };
}

// -----------------------------------------------------------------------------
// 2. MARK RESERVATION DISPATCHING
// -----------------------------------------------------------------------------

export interface MarkDispatchingParams {
  reservationToken: string;
  leaseToken: string;
  workerId: string;
  generation: number;
  leaseDurationInterval?: string; // e.g. '120 seconds'
}

export interface MarkDispatchingResult {
  success: boolean;
  statusCode: string;
  newLeaseUntil: Date | null;
}

export async function markReservationDispatching(
  params: MarkDispatchingParams
): Promise<MarkDispatchingResult> {
  const leaseDuration = params.leaseDurationInterval || '120 seconds';
  const res = await query(
    `SELECT success, status_code, new_lease_until
     FROM public.mark_reservation_dispatching($1, $2, $3, $4, $5::interval)`,
    [
      params.reservationToken,
      params.leaseToken,
      params.workerId,
      params.generation,
      leaseDuration,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'mark_reservation_dispatching returned no rows');
  }

  return {
    success: Boolean(row.success),
    statusCode: row.status_code,
    newLeaseUntil: row.new_lease_until ? new Date(row.new_lease_until) : null,
  };
}

// -----------------------------------------------------------------------------
// 3. COMPLETE CHUNK AND COMMIT QUOTA
// -----------------------------------------------------------------------------

export interface CompleteChunkParams {
  userId: string;
  parentKey: string;
  chunkIndex: number;
  reservationToken: string;
  leaseToken: string;
  workerId: string;
  fencingGeneration: number;
  chunkNotes: Record<string, any>;
  totalTokens: number;
  promptTokens: number;
  candidateTokens: number;
  thoughtsTokens: number;
  modelName: string;
}

export interface CompleteChunkResult {
  success: boolean;
  statusCode: string;
  committedAt: Date | null;
}

export async function completeChunkAndCommitQuota(
  params: CompleteChunkParams
): Promise<CompleteChunkResult> {
  const res = await query(
    `SELECT success, status_code, committed_at
     FROM public.complete_chunk_and_commit_quota(
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13
     )`,
    [
      params.userId,
      params.parentKey,
      params.chunkIndex,
      params.reservationToken,
      params.leaseToken,
      params.workerId,
      params.fencingGeneration,
      JSON.stringify(params.chunkNotes),
      params.totalTokens,
      params.promptTokens,
      params.candidateTokens,
      params.thoughtsTokens,
      params.modelName,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'complete_chunk_and_commit_quota returned no rows');
  }

  return {
    success: Boolean(row.success),
    statusCode: row.status_code,
    committedAt: row.committed_at ? new Date(row.committed_at) : null,
  };
}

// -----------------------------------------------------------------------------
// 4. RENEW UNCERTAIN LEASE
// -----------------------------------------------------------------------------

export interface RenewUncertainLeaseParams {
  userId: string;
  parentKey: string;
  chunkIndex: number;
  reservationToken: string;
  leaseToken: string;
  workerId: string;
  fencingGeneration: number;
  leaseDurationInterval?: string;
}

export interface RenewUncertainLeaseResult {
  success: boolean;
  statusCode: string;
  newLeaseToken: string | null;
  newGeneration: number | null;
  newLeaseUntil: Date | null;
}

export async function renewUncertainLease(
  params: RenewUncertainLeaseParams
): Promise<RenewUncertainLeaseResult> {
  const leaseDuration = params.leaseDurationInterval || '120 seconds';
  const res = await query(
    `SELECT success, status_code, new_lease_token, new_generation, new_lease_until
     FROM public.renew_uncertain_lease($1, $2, $3, $4, $5, $6, $7, $8::interval)`,
    [
      params.userId,
      params.parentKey,
      params.chunkIndex,
      params.reservationToken,
      params.leaseToken,
      params.workerId,
      params.fencingGeneration,
      leaseDuration,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'renew_uncertain_lease returned no rows');
  }

  return {
    success: Boolean(row.success),
    statusCode: row.status_code,
    newLeaseToken: row.new_lease_token || null,
    newGeneration: row.new_generation != null ? Number(row.new_generation) : null,
    newLeaseUntil: row.new_lease_until ? new Date(row.new_lease_until) : null,
  };
}

// -----------------------------------------------------------------------------
// 5. RELEASE QUOTA RESERVATION
// -----------------------------------------------------------------------------

export interface ReleaseQuotaParams {
  reservationToken: string;
  leaseToken: string;
  workerId: string;
  generation: number;
}

export interface SimpleRoutineResult {
  success: boolean;
  statusCode: string;
}

export async function releaseQuotaReservation(
  params: ReleaseQuotaParams
): Promise<SimpleRoutineResult> {
  const res = await query(
    `SELECT success, status_code
     FROM public.release_quota_reservation($1, $2, $3, $4)`,
    [params.reservationToken, params.leaseToken, params.workerId, params.generation]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'release_quota_reservation returned no rows');
  }

  return {
    success: Boolean(row.success),
    statusCode: row.status_code,
  };
}

// -----------------------------------------------------------------------------
// 6. RELEASE ABORTED DISPATCH
// -----------------------------------------------------------------------------

export interface ReleaseAbortedDispatchParams {
  reservationToken: string;
  leaseToken: string;
  workerId: string;
  generation: number;
  reason: string;
}

export async function releaseAbortedDispatch(
  params: ReleaseAbortedDispatchParams
): Promise<SimpleRoutineResult> {
  const res = await query(
    `SELECT success, status_code
     FROM public.release_aborted_dispatch($1, $2, $3, $4, $5)`,
    [
      params.reservationToken,
      params.leaseToken,
      params.workerId,
      params.generation,
      params.reason,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'release_aborted_dispatch returned no rows');
  }

  return {
    success: Boolean(row.success),
    statusCode: row.status_code,
  };
}

// -----------------------------------------------------------------------------
// 7. RECONCILE STALE RESERVATIONS
// -----------------------------------------------------------------------------

export async function reconcileStaleReservations(batchSize = 50): Promise<number> {
  const res = await query(
    `SELECT reconciled_count FROM public.reconcile_stale_reservations($1)`,
    [batchSize]
  );
  return res.rows[0]?.reconciled_count != null ? Number(res.rows[0].reconciled_count) : 0;
}

// -----------------------------------------------------------------------------
// 8. RECONCILE DAY BOUNDARY ROLLOVER
// -----------------------------------------------------------------------------

export async function reconcileDayBoundaryRollover(batchSize = 100): Promise<number> {
  const res = await query(
    `SELECT reconciled_count FROM public.reconcile_day_boundary_rollover($1)`,
    [batchSize]
  );
  return res.rows[0]?.reconciled_count != null ? Number(res.rows[0].reconciled_count) : 0;
}

// -----------------------------------------------------------------------------
// 9. RECONCILE UNCERTAIN ZERO USAGE
// -----------------------------------------------------------------------------

export interface ReconcileUncertainZeroUsageParams {
  ticketId: string;
  reservationToken: string;
  adminWorkerId: string;
  adminReason: string;
}

export async function reconcileUncertainZeroUsage(
  params: ReconcileUncertainZeroUsageParams
): Promise<SimpleRoutineResult> {
  const res = await query(
    `SELECT success, status_code
     FROM public.reconcile_uncertain_zero_usage($1, $2, $3, $4)`,
    [
      params.ticketId,
      params.reservationToken,
      params.adminWorkerId,
      params.adminReason,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'reconcile_uncertain_zero_usage returned no rows');
  }

  return {
    success: Boolean(row.success),
    statusCode: row.status_code,
  };
}

// -----------------------------------------------------------------------------
// 10. CREATE RECONCILIATION AUTHORIZATION
// -----------------------------------------------------------------------------

export interface CreateReconciliationAuthorizationParams {
  reservationToken: string;
  authorizedBy: string;
  justification: string;
  externalAuditRef: string;
}

export interface CreateReconciliationAuthorizationResult {
  ticketId: string | null;
  success: boolean;
  statusCode: string;
}

export async function createReconciliationAuthorization(
  params: CreateReconciliationAuthorizationParams
): Promise<CreateReconciliationAuthorizationResult> {
  const res = await query(
    `SELECT ticket_id, success, status_code
     FROM public.create_reconciliation_authorization($1, $2, $3, $4)`,
    [
      params.reservationToken,
      params.authorizedBy,
      params.justification,
      params.externalAuditRef,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'create_reconciliation_authorization returned no rows');
  }

  return {
    ticketId: row.ticket_id || null,
    success: Boolean(row.success),
    statusCode: row.status_code,
  };
}

// -----------------------------------------------------------------------------
// 11. REVOKE RECONCILIATION AUTHORIZATION
// -----------------------------------------------------------------------------

export interface RevokeReconciliationAuthorizationParams {
  ticketId: string;
  revokeReason: string;
}

export async function revokeReconciliationAuthorization(
  params: RevokeReconciliationAuthorizationParams
): Promise<SimpleRoutineResult> {
  const res = await query(
    `SELECT success, status_code
     FROM public.revoke_reconciliation_authorization($1, $2)`,
    [params.ticketId, params.revokeReason]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'revoke_reconciliation_authorization returned no rows');
  }

  return {
    success: Boolean(row.success),
    statusCode: row.status_code,
  };
}
