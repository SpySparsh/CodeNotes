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

export type OperationType = 'chunk' | 'monolithic' | 'synthesis';

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

const TICKET_SECRET = Symbol('TICKET_SECRET');
const VALID_TICKETS = new WeakSet<DispatchAuthorizationTicket>();

/**
 * Single-use, cryptographically unforgeable dispatch authorization ticket.
 * Required by ai-client before executing any outbound Gemini API request.
 */
export class DispatchAuthorizationTicket {
  private readonly _attemptId: string;
  private readonly _reservationToken: string;
  private readonly _generation: number;
  private readonly _attemptNumber: number;
  private readonly _operationType: OperationType;
  private _consumed = false;

  constructor(
    secret: symbol,
    attemptId: string,
    reservationToken: string,
    generation: number,
    attemptNumber: number,
    operationType: OperationType
  ) {
    if (secret !== TICKET_SECRET) {
      throw new QuotaError(
        'UNAUTHORIZED_CONSTRUCTION',
        'DispatchAuthorizationTicket cannot be manually instantiated; acquire via claimOrAdoptDispatchSlot'
      );
    }
    this._attemptId = attemptId;
    this._reservationToken = reservationToken;
    this._generation = generation;
    this._attemptNumber = attemptNumber;
    this._operationType = operationType;
    VALID_TICKETS.add(this);
  }

  get attemptId(): string {
    return this._attemptId;
  }
  get reservationToken(): string {
    return this._reservationToken;
  }
  get generation(): number {
    return this._generation;
  }
  get attemptNumber(): number {
    return this._attemptNumber;
  }
  get operationType(): OperationType {
    return this._operationType;
  }
  get isConsumed(): boolean {
    return this._consumed;
  }

  /**
   * Consumes ticket atomically immediately before HTTP transmission.
   * Throws if ticket is forged, reused, or mismatched.
   */
  public consume(expectedOperation: OperationType, expectedAttemptId: string): void {
    if (this._consumed) {
      throw new QuotaError(
        'ILLEGAL_TICKET_REUSE',
        `Ticket for attempt ${this._attemptId} has already been consumed`
      );
    }
    if (!VALID_TICKETS.has(this)) {
      throw new QuotaError('ILLEGAL_TICKET', 'Forged or untrusted dispatch authorization ticket');
    }
    if (this._operationType !== expectedOperation) {
      throw new QuotaError(
        'TICKET_OPERATION_MISMATCH',
        `Ticket operation "${this._operationType}" does not match expected "${expectedOperation}"`
      );
    }
    if (this._attemptId !== expectedAttemptId) {
      throw new QuotaError(
        'TICKET_ATTEMPT_MISMATCH',
        `Ticket attempt "${this._attemptId}" does not match expected "${expectedAttemptId}"`
      );
    }

    this._consumed = true;
    VALID_TICKETS.delete(this);
  }
}

/** Factory function internal to quota-client and test suite */
export function createDispatchTicket(
  attemptId: string,
  reservationToken: string,
  generation: number,
  attemptNumber: number,
  operationType: OperationType
): DispatchAuthorizationTicket {
  return new DispatchAuthorizationTicket(
    TICKET_SECRET,
    attemptId,
    reservationToken,
    generation,
    attemptNumber,
    operationType
  );
}

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

/**
 * Classifies an attempt outcome following strict provider accounting rules:
 * - Definitive provider rate limit (429) -> 'rejected_quota'
 * - Definitive non-timeout provider service rejection (503) -> 'failed_transient'
 * - Uncertain post-dispatch outcomes (timeout, connection reset, 504, abort during fetch) -> 'ambiguous'
 * Ambiguous outcomes MUST be counted in RPM, RPD, and TPM accounting to prevent quota leakage.
 */
export function classifyAttemptOutcome(
  err: any
): 'completed' | 'rejected_quota' | 'failed_transient' | 'ambiguous' | 'superseded' {
  if (!err) return 'completed';

  const code = err?.code || '';
  const status = Number(err?.statusCode || err?.status || 0);

  // Uncertain post-dispatch states:
  // Timeouts, gateway timeouts (504), network resets while awaiting provider
  if (
    code === 'TIMEOUT' ||
    code === 'NETWORK_ERROR' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    status === 504 ||
    err?.name === 'AbortError' ||
    (typeof err?.message === 'string' && err.message.toLowerCase().includes('timed out'))
  ) {
    return 'ambiguous';
  }

  // Definitive provider rate limit:
  if (code === 'RATE_LIMITED' || status === 429) {
    return 'rejected_quota';
  }

  // Definitive server unavailable where no generation could have executed:
  if (status === 503 || (err?.isRetryable && !code.includes('TIMEOUT'))) {
    return 'failed_transient';
  }

  return 'ambiguous';
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
  operationType?: OperationType;
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
  const operationType = params.operationType || 'chunk';
  const res = await query(
    `SELECT reservation_token, lease_token, generation, lease_until, allowed, status_code
     FROM public.reserve_quota($1, $2, $3, $4, $5, $6, $7, $8, $9::interval, $10)`,
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
      operationType,
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

// -----------------------------------------------------------------------------
// 12. CLAIM OR ADOPT DISPATCH SLOT (DISPATCH LEDGER)
// -----------------------------------------------------------------------------

export interface ClaimOrAdoptDispatchSlotParams {
  userId: string;
  parentKey: string;
  operationType: OperationType;
  chunkIndex: number; // 0..99 for chunk, -1 for monolithic/synthesis
  reservationToken: string;
  leaseToken: string;
  workerId: string;
  generation: number;
  projectId: string;
  quotaScope: string;
  modelName: string;
  estimatedTokens: number;
  leaseDurationInterval?: string; // e.g. '120 seconds'
}

export interface ClaimOrAdoptDispatchSlotResult {
  allowed: boolean;
  adopted: boolean;
  statusCode: string;
  ticket: DispatchAuthorizationTicket | null;
  adoptedPayload: any | null;
  attemptId: string | null;
  attemptNumber: number | null;
  generation: number | null;
  leaseUntil: Date | null;
}

export async function claimOrAdoptDispatchSlot(
  params: ClaimOrAdoptDispatchSlotParams
): Promise<ClaimOrAdoptDispatchSlotResult> {
  const leaseDuration = params.leaseDurationInterval || '120 seconds';
  const res = await query(
    `SELECT allowed, adopted, status_code, attempt_id, attempt_number, generation, lease_until, adopted_payload
     FROM public.claim_or_adopt_dispatch_slot($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::interval)`,
    [
      params.userId,
      params.parentKey,
      params.operationType,
      params.chunkIndex,
      params.reservationToken,
      params.leaseToken,
      params.workerId,
      params.generation,
      params.projectId,
      params.quotaScope,
      params.modelName,
      params.estimatedTokens,
      leaseDuration,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'claim_or_adopt_dispatch_slot returned no rows');
  }

  const allowed = Boolean(row.allowed);
  const adopted = Boolean(row.adopted);
  const attemptId = row.attempt_id ? String(row.attempt_id) : null;
  const attemptNumber = row.attempt_number != null ? Number(row.attempt_number) : null;
  const generation = row.generation != null ? Number(row.generation) : null;
  const leaseUntil = row.lease_until ? new Date(row.lease_until) : null;

  let ticket: DispatchAuthorizationTicket | null = null;
  if (allowed && !adopted && attemptId && attemptNumber && generation) {
    ticket = createDispatchTicket(
      attemptId,
      params.reservationToken,
      generation,
      attemptNumber,
      params.operationType
    );
  }

  return {
    allowed,
    adopted,
    statusCode: row.status_code,
    ticket,
    adoptedPayload: row.adopted_payload || null,
    attemptId,
    attemptNumber,
    generation,
    leaseUntil,
  };
}

// -----------------------------------------------------------------------------
// 13. COMPLETE DISPATCH ATTEMPT (DISPATCH LEDGER)
// -----------------------------------------------------------------------------

export interface CompleteDispatchAttemptParams {
  attemptId: string;
  reservationToken: string;
  leaseToken: string;
  workerId: string;
  fencingGeneration: number;
  operationType: OperationType;
  responsePayload: any;
  totalTokens: number;
  promptTokens: number;
  candidateTokens: number;
  thoughtsTokens: number;
  modelName: string;
  // Monolithic note attributes
  userId?: string;
  parentKey?: string;
  videoId?: string;
  videoTitle?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
}

export interface CompleteDispatchAttemptResult {
  success: boolean;
  statusCode: string;
  completedAt: Date | null;
}

export async function completeDispatchAttempt(
  params: CompleteDispatchAttemptParams
): Promise<CompleteDispatchAttemptResult> {
  const res = await query(
    `SELECT success, status_code, completed_at
     FROM public.complete_dispatch_attempt(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18
     )`,
    [
      params.attemptId,
      params.reservationToken,
      params.leaseToken,
      params.workerId,
      params.fencingGeneration,
      params.operationType,
      JSON.stringify(params.responsePayload),
      params.totalTokens,
      params.promptTokens,
      params.candidateTokens,
      params.thoughtsTokens,
      params.modelName,
      params.userId || null,
      params.parentKey || null,
      params.videoId || null,
      params.videoTitle || null,
      params.videoUrl || null,
      params.thumbnailUrl || null,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'complete_dispatch_attempt returned no rows');
  }

  return {
    success: Boolean(row.success),
    statusCode: row.status_code,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
  };
}

// -----------------------------------------------------------------------------
// 14. REPORT STALE ATTEMPT OUTCOME
// -----------------------------------------------------------------------------

export interface ReportStaleAttemptOutcomeParams {
  attemptId: string;
  reservationToken: string;
  workerId: string;
  outcomeStatus: 'completed' | 'rejected_quota' | 'failed_transient' | 'ambiguous' | 'superseded';
  responsePayload?: any;
  totalTokens?: number;
  promptTokens?: number;
  candidateTokens?: number;
  thoughtsTokens?: number;
  errorCode?: string;
  errorMessage?: string;
}

export async function reportStaleAttemptOutcome(
  params: ReportStaleAttemptOutcomeParams
): Promise<SimpleRoutineResult> {
  const res = await query(
    `SELECT success, status_code
     FROM public.report_stale_attempt_outcome($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      params.attemptId,
      params.reservationToken,
      params.workerId,
      params.outcomeStatus,
      params.responsePayload ? JSON.stringify(params.responsePayload) : null,
      params.totalTokens ?? null,
      params.promptTokens ?? null,
      params.candidateTokens ?? null,
      params.thoughtsTokens ?? null,
      params.errorCode ?? null,
      params.errorMessage ?? null,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'report_stale_attempt_outcome returned no rows');
  }

  return {
    success: Boolean(row.success),
    statusCode: row.status_code,
  };
}

// -----------------------------------------------------------------------------
// 15. RECOVER RESERVATION OWNERSHIP
// -----------------------------------------------------------------------------

export interface RecoverReservationOwnershipParams {
  userId: string;
  parentKey: string;
  reservationToken: string;
  newWorkerId: string;
  leaseDurationInterval?: string;
}

export interface RecoverReservationOwnershipResult {
  success: boolean;
  statusCode: string;
  newLeaseToken: string | null;
  newGeneration: number | null;
  newLeaseUntil: Date | null;
}

export async function recoverReservationOwnership(
  params: RecoverReservationOwnershipParams
): Promise<RecoverReservationOwnershipResult> {
  const leaseDuration = params.leaseDurationInterval || '120 seconds';
  const res = await query(
    `SELECT success, status_code, new_lease_token, new_generation, new_lease_until
     FROM public.recover_reservation_ownership($1, $2, $3, $4, $5::interval)`,
    [
      params.userId,
      params.parentKey,
      params.reservationToken,
      params.newWorkerId,
      leaseDuration,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'recover_reservation_ownership returned no rows');
  }

  return {
    success: Boolean(row.success),
    statusCode: row.status_code,
    newLeaseToken: row.new_lease_token || null,
    newGeneration: row.new_generation != null ? Number(row.new_generation) : null,
    newLeaseUntil: row.new_lease_until ? new Date(row.new_lease_until) : null,
  };
}

export interface SettleFailedDispatchUsageParams {
  attemptId: string;
  reservationToken: string;
  leaseToken: string;
  workerId: string;
  fencingGeneration: number;
  totalTokens: number;
  promptTokens?: number | null;
  candidateTokens?: number | null;
  thoughtsTokens?: number | null;
  errorCode?: string;
  errorMessage?: string | null;
  evidencePayload?: Record<string, any> | null;
}

export interface SettleFailedDispatchUsageResult {
  success: boolean;
  statusCode: string;
  settledAt: Date | null;
}

export async function settleFailedDispatchUsage(
  params: SettleFailedDispatchUsageParams
): Promise<SettleFailedDispatchUsageResult> {
  const res = await query(
    `SELECT success, status_code, settled_at
     FROM public.settle_failed_dispatch_usage(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
     )`,
    [
      params.attemptId,
      params.reservationToken,
      params.leaseToken,
      params.workerId,
      params.fencingGeneration,
      params.totalTokens,
      params.promptTokens ?? null,
      params.candidateTokens ?? null,
      params.thoughtsTokens ?? null,
      params.errorCode ?? 'MALFORMED_OUTPUT',
      params.errorMessage ?? null,
      params.evidencePayload ? JSON.stringify(params.evidencePayload) : null,
    ]
  );

  const row = res.rows[0];
  if (!row) {
    throw new QuotaError('NO_ROW_RETURNED', 'settle_failed_dispatch_usage returned no rows');
  }

  return {
    success: Boolean(row.success),
    statusCode: row.status_code,
    settledAt: row.settled_at ? new Date(row.settled_at) : null,
  };
}
