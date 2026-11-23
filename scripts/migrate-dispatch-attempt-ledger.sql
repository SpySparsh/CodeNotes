-- =============================================================================
-- Migration: scripts/migrate-dispatch-attempt-ledger.sql
-- Architecture: CodeNotes AI — Dispatch Attempt Ledger & Quota Hardening
-- Phase: 1 — Local Implementation
-- Engine: PostgreSQL 15+ (Supabase / AWS RDS / Self-Hosted Postgres)
-- Safety: Fully transactional (BEGIN ... COMMIT); Transaction-scoped advisory lock;
--         Idempotent DDL/DML; Strict 6-level universal lock hierarchy; Acyclic.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- SECTION 1: TRANSACTION-SCOPED ADVISORY MIGRATION LOCK
-- -----------------------------------------------------------------------------
SELECT pg_advisory_xact_lock(849204859284729105);

-- -----------------------------------------------------------------------------
-- SECTION 2: SCHEMA EXTENSIONS — RESERVATIONS & NOTES
-- -----------------------------------------------------------------------------

-- 1. Add operation_type to public.rate_limit_reservations if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'operation_type'
    ) THEN
        ALTER TABLE public.rate_limit_reservations
            ADD COLUMN operation_type VARCHAR(20) NOT NULL DEFAULT 'chunk';
    END IF;
END $$;

-- Update check constraint on chunk_index and operation_type
ALTER TABLE public.rate_limit_reservations
    DROP CONSTRAINT IF EXISTS chk_reservation_chunk_index;

ALTER TABLE public.rate_limit_reservations
    DROP CONSTRAINT IF EXISTS rate_limit_reservations_chunk_index_check;

ALTER TABLE public.rate_limit_reservations
    DROP CONSTRAINT IF EXISTS chk_reservation_operation_type;

ALTER TABLE public.rate_limit_reservations
    DROP CONSTRAINT IF EXISTS rate_limit_reservations_operation_type_check;

ALTER TABLE public.rate_limit_reservations
    ADD CONSTRAINT chk_reservation_operation_type
    CHECK (operation_type IN ('chunk', 'monolithic', 'synthesis'));

ALTER TABLE public.rate_limit_reservations
    ADD CONSTRAINT chk_reservation_chunk_index
    CHECK (
        (operation_type = 'chunk' AND chunk_index >= 0 AND chunk_index < 100)
        OR (operation_type IN ('monolithic', 'synthesis') AND chunk_index = -1)
    );

-- Replace partial unique index to include operation_type (resolves synthesis collision)
DROP INDEX IF EXISTS public.idx_reservations_active_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_active_unique
    ON public.rate_limit_reservations (user_id, parent_key, operation_type, chunk_index)
    WHERE status IN ('active', 'dispatching', 'dispatched', 'uncertain', 'committed');

-- 2. Add durable manifest fields to generation_idempotency if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'generation_idempotency' AND column_name = 'total_chunks'
    ) THEN
        ALTER TABLE public.generation_idempotency
            ADD COLUMN total_chunks INTEGER CHECK (total_chunks IS NULL OR total_chunks > 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'generation_idempotency' AND column_name = 'manifest_hash'
    ) THEN
        ALTER TABLE public.generation_idempotency
            ADD COLUMN manifest_hash VARCHAR(64);
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- SECTION 3: TABLE DDL — RATE LIMIT DISPATCH ATTEMPTS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rate_limit_dispatch_attempts (
    attempt_id                 UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_token          UUID                     NOT NULL REFERENCES public.rate_limit_reservations(reservation_token) ON DELETE RESTRICT,
    attempt_number             INTEGER                  NOT NULL CHECK (attempt_number >= 1),
    generation                 INTEGER                  NOT NULL CHECK (generation >= 1),
    worker_id                  VARCHAR(255)             NOT NULL,
    project_id                 VARCHAR(64)              NOT NULL,
    quota_scope                VARCHAR(64)              NOT NULL,
    operation_type             VARCHAR(20)              NOT NULL CHECK (operation_type IN ('chunk', 'monolithic', 'synthesis')),
    status                     VARCHAR(30)              NOT NULL DEFAULT 'dispatch_claimed'
        CHECK (status IN (
            'dispatch_claimed',
            'dispatched',
            'completed',
            'adopted',
            'rejected_quota',
            'failed_transient',
            'ambiguous',
            'superseded'
        )),
    estimated_tokens           INTEGER                  NOT NULL CHECK (estimated_tokens > 0),
    actual_total_tokens        INTEGER                  CHECK (actual_total_tokens IS NULL OR actual_total_tokens >= 0),
    actual_prompt_tokens       INTEGER                  CHECK (actual_prompt_tokens IS NULL OR actual_prompt_tokens >= 0),
    actual_candidate_tokens    INTEGER                  CHECK (actual_candidate_tokens IS NULL OR actual_candidate_tokens >= 0),
    actual_thoughts_tokens     INTEGER                  CHECK (actual_thoughts_tokens IS NULL OR actual_thoughts_tokens >= 0),
    response_payload           JSONB,
    error_code                 VARCHAR(100),
    error_message              TEXT,
    lease_until                TIMESTAMP WITH TIME ZONE NOT NULL,
    dispatched_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at               TIMESTAMP WITH TIME ZONE,
    quota_date_pacific         DATE                     NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date),
    created_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_dispatch_attempt_number UNIQUE (reservation_token, attempt_number)
);

-- Supporting indices for high-throughput quota checks
CREATE INDEX IF NOT EXISTS idx_attempts_rpm
    ON public.rate_limit_dispatch_attempts (project_id, quota_scope, dispatched_at, status);

CREATE INDEX IF NOT EXISTS idx_attempts_rpd
    ON public.rate_limit_dispatch_attempts (project_id, quota_scope, quota_date_pacific, status);

CREATE INDEX IF NOT EXISTS idx_attempts_tpm
    ON public.rate_limit_dispatch_attempts (project_id, quota_scope, dispatched_at, status);

CREATE INDEX IF NOT EXISTS idx_attempts_lease
    ON public.rate_limit_dispatch_attempts (status, lease_until);

-- 3. Add parent_key and attempt_id to public.notes
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'parent_key'
    ) THEN
        ALTER TABLE public.notes
            ADD COLUMN parent_key VARCHAR(64);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notes' AND column_name = 'attempt_id'
    ) THEN
        ALTER TABLE public.notes
            ADD COLUMN attempt_id UUID REFERENCES public.rate_limit_dispatch_attempts(attempt_id) ON DELETE SET NULL;
    END IF;
END $$;

-- 4. Enforce 1:1 note uniqueness per parent while supporting NULL parent_key for legacy rows
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_parent_key_unique
    ON public.notes (user_id, parent_key)
    WHERE parent_key IS NOT NULL;

-- -----------------------------------------------------------------------------
-- SECTION 4: SECURITY & LEAST-PRIVILEGE RLS POLICIES
-- -----------------------------------------------------------------------------
ALTER TABLE public.rate_limit_dispatch_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_dispatch_attempts FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO codenotes_definer;
GRANT SELECT, INSERT, UPDATE ON TABLE public.rate_limit_dispatch_attempts TO codenotes_definer;
GRANT SELECT, INSERT, UPDATE ON TABLE public.notes TO codenotes_definer;
-- Column-level update grants on generation_idempotency required for atomic completion & manifest persistence
GRANT SELECT, UPDATE (updated_at, status, note_id, lease_until, total_chunks, manifest_hash, error_message, error_code)
    ON TABLE public.generation_idempotency TO codenotes_definer;

-- Restrictive definer policy on rate_limit_dispatch_attempts
DROP POLICY IF EXISTS p_codenotes_definer_attempts ON public.rate_limit_dispatch_attempts;
CREATE POLICY p_codenotes_definer_attempts ON public.rate_limit_dispatch_attempts
    FOR ALL TO codenotes_definer
    USING (true)
    WITH CHECK (true);

-- Scoped definer policy on notes
DROP POLICY IF EXISTS p_codenotes_definer_notes ON public.notes;
CREATE POLICY p_codenotes_definer_notes ON public.notes
    FOR ALL TO codenotes_definer
    USING (
        user_id IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM public.generation_idempotency gi
            WHERE gi.user_id = notes.user_id
        )
    )
    WITH CHECK (
        user_id IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM public.generation_idempotency gi
            WHERE gi.user_id = notes.user_id
        )
    );

-- -----------------------------------------------------------------------------
-- SECTION 5: PL/pgSQL ROUTINE — claim_or_adopt_dispatch_slot
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_or_adopt_dispatch_slot(
    p_user_id              UUID,
    p_parent_key           VARCHAR,
    p_operation_type       VARCHAR,
    p_chunk_index          INTEGER,
    p_reservation_token    UUID,
    p_lease_token          UUID,
    p_worker_id            VARCHAR,
    p_generation           INTEGER,
    p_project_id           VARCHAR,
    p_quota_scope          VARCHAR,
    p_model_name           VARCHAR,
    p_estimated_tokens     INTEGER,
    p_lease_duration       INTERVAL DEFAULT '120 seconds'
)
RETURNS TABLE (
    allowed                BOOLEAN,
    adopted                BOOLEAN,
    status_code            VARCHAR,
    attempt_id             UUID,
    attempt_number         INTEGER,
    generation             INTEGER,
    lease_until            TIMESTAMP WITH TIME ZONE,
    adopted_payload        JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_now                  TIMESTAMPTZ;
    v_pacific_today        DATE;
    v_parent_status        VARCHAR(20);
    v_res                  RECORD;
    v_existing_attempt     RECORD;
    v_existing_chunk       RECORD;
    v_next_attempt_number  INTEGER;
    v_new_attempt_id       UUID;
    v_new_lease_until      TIMESTAMPTZ;
    v_global_cfg           RECORD;
    v_scope_cfg            RECORD;
    v_global_active        INTEGER;
    v_scope_active         INTEGER;
    v_global_rpm           INTEGER;
    v_scope_rpm            INTEGER;
    v_global_rpd           INTEGER;
    v_scope_rpd            INTEGER;
    v_global_active_holds  BIGINT;
    v_scope_active_holds   BIGINT;
    v_global_dispatched    BIGINT;
    v_scope_dispatched     BIGINT;
    v_new_note_id          UUID;
BEGIN
    IF current_setting('role', true) IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an authenticated user role context'
            USING ERRCODE = '42501';
    END IF;

    v_now := clock_timestamp();
    v_pacific_today := (v_now AT TIME ZONE 'America/Los_Angeles')::date;

    -- Validate Operation Type and Chunk Index Coordinate
    IF p_operation_type NOT IN ('chunk', 'monolithic', 'synthesis') THEN
        RETURN QUERY SELECT false, false, 'INVALID_OPERATION_TYPE'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    IF p_operation_type = 'chunk' AND (p_chunk_index < 0 OR p_chunk_index >= 100) THEN
        RETURN QUERY SELECT false, false, 'INVALID_CHUNK_INDEX'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    IF p_operation_type IN ('monolithic', 'synthesis') AND p_chunk_index <> -1 THEN
        RETURN QUERY SELECT false, false, 'INVALID_NON_CHUNK_COORDINATE'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    -- =========================================================================
    -- LOCK LEVEL 1: Parent Generation Row
    -- =========================================================================
    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = p_user_id AND key = p_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, false, 'PARENT_GENERATION_NOT_FOUND'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    IF v_parent_status NOT IN ('processing', 'pending') THEN
        RETURN QUERY SELECT false, false, 'PARENT_GENERATION_NOT_ACTIVE'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    -- =========================================================================
    -- LOCK LEVEL 2 & 3: Acquire Quota Configuration Row Locks
    -- =========================================================================
    SELECT max_active_dispatches, max_rpm, max_tpm, max_rpd INTO v_global_cfg
    FROM public.project_quota_configs
    WHERE project_id = p_project_id AND quota_scope = 'global'
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, false, 'CONFIG_NOT_FOUND_GLOBAL'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    IF p_quota_scope <> 'global' THEN
        SELECT max_active_dispatches, max_rpm, max_tpm, max_rpd INTO v_scope_cfg
        FROM public.project_quota_configs
        WHERE project_id = p_project_id AND quota_scope = p_quota_scope
        FOR UPDATE;

        IF NOT FOUND THEN
            RETURN QUERY SELECT false, false, 'CONFIG_NOT_FOUND_SCOPE'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
            RETURN;
        END IF;
    ELSE
        v_scope_cfg := v_global_cfg;
    END IF;

    -- =========================================================================
    -- LOCK LEVEL 4: Rate Limit Reservation Row
    -- =========================================================================
    SELECT * INTO v_res
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, false, 'RESERVATION_NOT_FOUND'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    -- Validate Fencing & Lease Ownership
    IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN
        RETURN QUERY SELECT false, false, 'STALE_LEASE_OWNERSHIP'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    IF v_res.generation IS DISTINCT FROM p_generation THEN
        RETURN QUERY SELECT false, false, 'FENCING_GENERATION_MISMATCH'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    IF v_now > v_res.lease_until THEN
        RETURN QUERY SELECT false, false, 'LEASE_EXPIRED_DURING_EXECUTION'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    -- =========================================================================
    -- ADOPTION CHECK: Inspect Existing Attempts for Completed/Adopted Results
    -- =========================================================================
    SELECT * INTO v_existing_attempt
    FROM public.rate_limit_dispatch_attempts
    WHERE reservation_token = p_reservation_token
      AND status IN ('completed', 'adopted')
    ORDER BY attempt_number DESC
    LIMIT 1;

    IF FOUND THEN
        -- Case A: Chunk Generation Adoption
        IF p_operation_type = 'chunk' THEN
            SELECT chunk_id, reservation_token, chunk_notes INTO v_existing_chunk
            FROM public.chunk_generations
            WHERE user_id = p_user_id AND parent_key = p_parent_key AND chunk_index = p_chunk_index;

            IF FOUND THEN
                IF v_existing_chunk.reservation_token = p_reservation_token THEN
                    RETURN QUERY SELECT true, true, 'ADOPTED_EXISTING_CHUNK'::VARCHAR, v_existing_attempt.attempt_id, v_existing_attempt.attempt_number, v_existing_attempt.generation, v_existing_attempt.lease_until, v_existing_attempt.response_payload;
                    RETURN;
                ELSE
                    RAISE EXCEPTION 'CONFLICTING_CHUNK_PAYLOAD: Chunk exists with conflicting reservation %', v_existing_chunk.reservation_token
                        USING ERRCODE = '23505';
                END IF;
            ELSE
                -- Atomically restore missing chunk from stored payload
                INSERT INTO public.chunk_generations (
                    chunk_id, user_id, parent_key, chunk_index, reservation_token,
                    status, chunk_notes, completed_at, total_tokens, prompt_tokens,
                    candidate_tokens, thoughts_tokens, model_name
                ) VALUES (
                    gen_random_uuid(), p_user_id, p_parent_key, p_chunk_index, p_reservation_token,
                    'completed', v_existing_attempt.response_payload, v_now,
                    v_existing_attempt.actual_total_tokens, v_existing_attempt.actual_prompt_tokens,
                    v_existing_attempt.actual_candidate_tokens, v_existing_attempt.actual_thoughts_tokens,
                    p_model_name
                );

                RETURN QUERY SELECT true, true, 'ADOPTED_AND_RESTORED_CHUNK'::VARCHAR, v_existing_attempt.attempt_id, v_existing_attempt.attempt_number, v_existing_attempt.generation, v_existing_attempt.lease_until, v_existing_attempt.response_payload;
                RETURN;
            END IF;
        END IF;

        -- Case B: Monolithic Generation Adoption
        IF p_operation_type = 'monolithic' THEN
            v_new_note_id := gen_random_uuid();
            INSERT INTO public.notes (
                id, user_id, parent_key, attempt_id, video_id, video_title, video_url,
                thumbnail_url, overview, key_concepts, detailed_notes, shorthands
            ) VALUES (
                v_new_note_id, p_user_id, p_parent_key, v_existing_attempt.attempt_id,
                v_existing_attempt.response_payload->>'videoId',
                v_existing_attempt.response_payload->>'videoTitle',
                v_existing_attempt.response_payload->>'videoUrl',
                v_existing_attempt.response_payload->>'thumbnailUrl',
                v_existing_attempt.response_payload->>'overview',
                ARRAY(SELECT jsonb_array_elements_text(v_existing_attempt.response_payload->'keyConcepts')),
                v_existing_attempt.response_payload->>'detailedNotes',
                ARRAY(SELECT jsonb_array_elements_text(v_existing_attempt.response_payload->'shorthands'))
            );

            UPDATE public.generation_idempotency
            SET status = 'completed', note_id = v_new_note_id, lease_until = NULL, updated_at = v_now
            WHERE user_id = p_user_id AND key = p_parent_key;

            UPDATE public.rate_limit_reservations
            SET status = 'committed', committed_at = v_now, updated_at = v_now
            WHERE reservation_token = p_reservation_token;

            RETURN QUERY SELECT true, true, 'ADOPTED_MONOLITHIC_NOTE'::VARCHAR, v_existing_attempt.attempt_id, v_existing_attempt.attempt_number, v_existing_attempt.generation, v_existing_attempt.lease_until, v_existing_attempt.response_payload;
            RETURN;
        END IF;

        -- Case C: Synthesis Adoption
        IF p_operation_type = 'synthesis' THEN
            RETURN QUERY SELECT true, true, 'ADOPTED_SYNTHESIS'::VARCHAR, v_existing_attempt.attempt_id, v_existing_attempt.attempt_number, v_existing_attempt.generation, v_existing_attempt.lease_until, v_existing_attempt.response_payload;
            RETURN;
        END IF;
    END IF;

    -- =========================================================================
    -- SIX QUOTA ADMISSION CHECKS (RPM, RPD, TPM Global & Scope)
    -- =========================================================================
    -- Check 1 & 2: RPM
    SELECT COUNT(*) INTO v_global_rpm
    FROM public.rate_limit_dispatch_attempts a
    WHERE a.project_id = p_project_id
      AND a.dispatched_at >= v_now - INTERVAL '60 seconds'
      AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted');

    IF (v_global_rpm + 1) > v_global_cfg.max_rpm THEN
        RETURN QUERY SELECT false, false, 'RATE_LIMIT_GLOBAL_RPM_EXCEEDED'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    IF p_quota_scope <> 'global' THEN
        SELECT COUNT(*) INTO v_scope_rpm
        FROM public.rate_limit_dispatch_attempts a
        WHERE a.project_id = p_project_id
          AND a.quota_scope = p_quota_scope
          AND a.dispatched_at >= v_now - INTERVAL '60 seconds'
          AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted');

        IF (v_scope_rpm + 1) > v_scope_cfg.max_rpm THEN
            RETURN QUERY SELECT false, false, 'RATE_LIMIT_SCOPE_RPM_EXCEEDED'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
            RETURN;
        END IF;
    END IF;

    -- Check 3 & 4: RPD (Pacific Calendar Day)
    SELECT COUNT(*) INTO v_global_rpd
    FROM public.rate_limit_dispatch_attempts a
    WHERE a.project_id = p_project_id
      AND a.quota_date_pacific = v_pacific_today
      AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted');

    IF (v_global_rpd + 1) > v_global_cfg.max_rpd THEN
        RETURN QUERY SELECT false, false, 'RATE_LIMIT_GLOBAL_RPD_EXCEEDED'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    IF p_quota_scope <> 'global' THEN
        SELECT COUNT(*) INTO v_scope_rpd
        FROM public.rate_limit_dispatch_attempts a
        WHERE a.project_id = p_project_id
          AND a.quota_scope = p_quota_scope
          AND a.quota_date_pacific = v_pacific_today
          AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted');

        IF (v_scope_rpd + 1) > v_scope_cfg.max_rpd THEN
            RETURN QUERY SELECT false, false, 'RATE_LIMIT_SCOPE_RPD_EXCEEDED'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
            RETURN;
        END IF;
    END IF;

    -- Check 5 & 6: TPM (Complete 3-Term Formula)
    SELECT COALESCE(SUM(r.estimated_tokens), 0) INTO v_global_active_holds
    FROM public.rate_limit_reservations r
    WHERE r.project_id = p_project_id
      AND r.status = 'active'
      AND r.lease_until > v_now
      AND r.reservation_token <> p_reservation_token;

    SELECT COALESCE(SUM(
        CASE WHEN a.status = 'completed' THEN COALESCE(a.actual_total_tokens, a.estimated_tokens) ELSE a.estimated_tokens END
    ), 0) INTO v_global_dispatched
    FROM public.rate_limit_dispatch_attempts a
    WHERE a.project_id = p_project_id
      AND a.dispatched_at >= v_now - INTERVAL '60 seconds'
      AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted');

    IF (v_global_active_holds + v_global_dispatched + p_estimated_tokens) > v_global_cfg.max_tpm THEN
        RETURN QUERY SELECT false, false, 'RATE_LIMIT_GLOBAL_TPM_EXCEEDED'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    IF p_quota_scope <> 'global' THEN
        SELECT COALESCE(SUM(r.estimated_tokens), 0) INTO v_scope_active_holds
        FROM public.rate_limit_reservations r
        WHERE r.project_id = p_project_id
          AND r.quota_scope = p_quota_scope
          AND r.status = 'active'
          AND r.lease_until > v_now
          AND r.reservation_token <> p_reservation_token;

        SELECT COALESCE(SUM(
            CASE WHEN a.status = 'completed' THEN COALESCE(a.actual_total_tokens, a.estimated_tokens) ELSE a.estimated_tokens END
        ), 0) INTO v_scope_dispatched
        FROM public.rate_limit_dispatch_attempts a
        WHERE a.project_id = p_project_id
          AND a.quota_scope = p_quota_scope
          AND a.dispatched_at >= v_now - INTERVAL '60 seconds'
          AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted');

        IF (v_scope_active_holds + v_scope_dispatched + p_estimated_tokens) > v_scope_cfg.max_tpm THEN
            RETURN QUERY SELECT false, false, 'RATE_LIMIT_SCOPE_TPM_EXCEEDED'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
            RETURN;
        END IF;
    END IF;

    -- =========================================================================
    -- MUTATION: Claim Dispatch Slot
    -- =========================================================================
    SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_next_attempt_number
    FROM public.rate_limit_dispatch_attempts
    WHERE reservation_token = p_reservation_token;

    v_new_attempt_id := gen_random_uuid();
    v_new_lease_until := v_now + p_lease_duration;

    INSERT INTO public.rate_limit_dispatch_attempts (
        attempt_id, reservation_token, attempt_number, generation, worker_id,
        project_id, quota_scope, operation_type, status, estimated_tokens,
        lease_until, dispatched_at, quota_date_pacific, created_at, updated_at
    ) VALUES (
        v_new_attempt_id, p_reservation_token, v_next_attempt_number, p_generation, p_worker_id,
        p_project_id, p_quota_scope, p_operation_type, 'dispatch_claimed', p_estimated_tokens,
        v_new_lease_until, v_now, v_pacific_today, v_now, v_now
    );

    UPDATE public.rate_limit_reservations
    SET status = 'dispatching',
        lease_until = v_new_lease_until,
        dispatching_at = v_now,
        updated_at = v_now
    WHERE reservation_token = p_reservation_token;

    RETURN QUERY SELECT
        true,
        false,
        'DISPATCH_CLAIMED'::VARCHAR,
        v_new_attempt_id,
        v_next_attempt_number,
        p_generation,
        v_new_lease_until,
        NULL::JSONB;
    RETURN;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 6: PL/pgSQL ROUTINE — complete_dispatch_attempt
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_dispatch_attempt(
    p_attempt_id               UUID,
    p_reservation_token        UUID,
    p_lease_token              UUID,
    p_worker_id                VARCHAR,
    p_fencing_generation       INTEGER,
    p_operation_type           VARCHAR,
    p_response_payload         JSONB,
    p_total_tokens             INTEGER,
    p_prompt_tokens            INTEGER,
    p_candidate_tokens         INTEGER,
    p_thoughts_tokens          INTEGER,
    p_model_name               VARCHAR,
    -- Optional monolithic parameters:
    p_user_id                  UUID DEFAULT NULL,
    p_parent_key               VARCHAR DEFAULT NULL,
    p_video_id                 VARCHAR DEFAULT NULL,
    p_video_title              TEXT DEFAULT NULL,
    p_video_url                TEXT DEFAULT NULL,
    p_thumbnail_url            TEXT DEFAULT NULL
)
RETURNS TABLE (
    success                    BOOLEAN,
    status_code                VARCHAR,
    completed_at               TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_now                      TIMESTAMPTZ;
    v_attempt                  RECORD;
    v_res                      RECORD;
    v_parent_status            VARCHAR(20);
    v_new_note_id              UUID;
BEGIN
    IF current_setting('role', true) IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an authenticated user role context'
            USING ERRCODE = '42501';
    END IF;

    v_now := clock_timestamp();

    -- Lock L1: Parent Idempotency Row (Preserving Universal Lock Hierarchy L1 -> L4 -> L5 -> L6)
    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = COALESCE(p_user_id, (SELECT user_id FROM public.rate_limit_reservations WHERE reservation_token = p_reservation_token))
      AND key = COALESCE(p_parent_key, (SELECT parent_key FROM public.rate_limit_reservations WHERE reservation_token = p_reservation_token))
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'PARENT_GENERATION_NOT_FOUND'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Lock L4: Reservation
    SELECT * INTO v_res
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'RESERVATION_NOT_FOUND'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Validate Fencing
    IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN
        RETURN QUERY SELECT false, 'STALE_LEASE_OWNERSHIP'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.generation IS DISTINCT FROM p_fencing_generation THEN
        RETURN QUERY SELECT false, 'FENCING_GENERATION_MISMATCH'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Lock L5: Attempt
    SELECT * INTO v_attempt
    FROM public.rate_limit_dispatch_attempts
    WHERE attempt_id = p_attempt_id AND reservation_token = p_reservation_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'ATTEMPT_NOT_FOUND'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_attempt.status = 'completed' THEN
        RETURN QUERY SELECT true, 'ALREADY_COMPLETED'::VARCHAR, v_attempt.completed_at;
        RETURN;
    END IF;

    -- Update Attempt Row
    UPDATE public.rate_limit_dispatch_attempts
    SET status = 'completed',
        response_payload = p_response_payload,
        actual_total_tokens = p_total_tokens,
        actual_prompt_tokens = p_prompt_tokens,
        actual_candidate_tokens = p_candidate_tokens,
        actual_thoughts_tokens = p_thoughts_tokens,
        completed_at = v_now,
        updated_at = v_now
    WHERE attempt_id = p_attempt_id;

    -- Update Reservation Row
    UPDATE public.rate_limit_reservations
    SET status = 'committed',
        actual_total_tokens = p_total_tokens,
        actual_prompt_tokens = p_prompt_tokens,
        actual_candidate_tokens = p_candidate_tokens,
        actual_thoughts_tokens = p_thoughts_tokens,
        committed_at = v_now,
        updated_at = v_now
    WHERE reservation_token = p_reservation_token;

    -- Operation-Specific Persistence
    IF p_operation_type = 'chunk' THEN
        -- Insert into chunk_generations
        INSERT INTO public.chunk_generations (
            chunk_id, user_id, parent_key, chunk_index, reservation_token,
            status, chunk_notes, completed_at, total_tokens, prompt_tokens,
            candidate_tokens, thoughts_tokens, model_name
        ) VALUES (
            gen_random_uuid(), v_res.user_id, v_res.parent_key, v_res.chunk_index, p_reservation_token,
            'completed', p_response_payload, v_now,
            p_total_tokens, p_prompt_tokens, p_candidate_tokens, p_thoughts_tokens, p_model_name
        )
        ON CONFLICT (user_id, parent_key, chunk_index) DO NOTHING;
    ELSIF p_operation_type = 'monolithic' THEN
        v_new_note_id := gen_random_uuid();
        INSERT INTO public.notes (
            id, user_id, parent_key, attempt_id, video_id, video_title, video_url,
            thumbnail_url, overview, key_concepts, detailed_notes, shorthands
        ) VALUES (
            v_new_note_id, v_res.user_id, v_res.parent_key, p_attempt_id,
            COALESCE(p_video_id, p_response_payload->>'videoId'),
            COALESCE(p_video_title, p_response_payload->>'videoTitle'),
            COALESCE(p_video_url, p_response_payload->>'videoUrl'),
            COALESCE(p_thumbnail_url, p_response_payload->>'thumbnailUrl'),
            p_response_payload->>'overview',
            ARRAY(SELECT jsonb_array_elements_text(p_response_payload->'keyConcepts')),
            p_response_payload->>'detailedNotes',
            ARRAY(SELECT jsonb_array_elements_text(p_response_payload->'shorthands'))
        );

        UPDATE public.generation_idempotency
        SET status = 'completed',
            note_id = v_new_note_id,
            lease_until = NULL,
            updated_at = v_now
        WHERE user_id = v_res.user_id AND key = v_res.parent_key;
    END IF;

    RETURN QUERY SELECT true, 'SUCCESS'::VARCHAR, v_now;
    RETURN;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 7: PL/pgSQL ROUTINE — report_stale_attempt_outcome
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_stale_attempt_outcome(
    p_attempt_id               UUID,
    p_reservation_token        UUID,
    p_worker_id                VARCHAR,
    p_outcome_status           VARCHAR,
    p_response_payload         JSONB DEFAULT NULL,
    p_total_tokens             INTEGER DEFAULT NULL,
    p_prompt_tokens            INTEGER DEFAULT NULL,
    p_candidate_tokens         INTEGER DEFAULT NULL,
    p_thoughts_tokens          INTEGER DEFAULT NULL,
    p_error_code               VARCHAR DEFAULT NULL,
    p_error_message            TEXT DEFAULT NULL
)
RETURNS TABLE (
    success                    BOOLEAN,
    status_code                VARCHAR
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_now                      TIMESTAMPTZ;
    v_attempt                  RECORD;
BEGIN
    IF current_setting('role', true) IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an authenticated user role context'
            USING ERRCODE = '42501';
    END IF;

    v_now := clock_timestamp();

    SELECT * INTO v_attempt
    FROM public.rate_limit_dispatch_attempts
    WHERE attempt_id = p_attempt_id AND reservation_token = p_reservation_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'ATTEMPT_NOT_FOUND'::VARCHAR;
        RETURN;
    END IF;

    IF v_attempt.status IN ('completed', 'adopted') THEN
        RETURN QUERY SELECT true, 'ALREADY_TERMINAL'::VARCHAR;
        RETURN;
    END IF;

    UPDATE public.rate_limit_dispatch_attempts
    SET status = p_outcome_status,
        response_payload = COALESCE(p_response_payload, response_payload),
        actual_total_tokens = COALESCE(p_total_tokens, actual_total_tokens),
        actual_prompt_tokens = COALESCE(p_prompt_tokens, actual_prompt_tokens),
        actual_candidate_tokens = COALESCE(p_candidate_tokens, actual_candidate_tokens),
        actual_thoughts_tokens = COALESCE(p_thoughts_tokens, actual_thoughts_tokens),
        error_code = COALESCE(p_error_code, error_code),
        error_message = COALESCE(p_error_message, error_message),
        updated_at = v_now
    WHERE attempt_id = p_attempt_id;

    RETURN QUERY SELECT true, 'SUCCESS'::VARCHAR;
    RETURN;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 8: PL/pgSQL ROUTINE — recover_reservation_ownership
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recover_reservation_ownership(
    p_user_id                  UUID,
    p_parent_key               VARCHAR,
    p_reservation_token        UUID,
    p_new_worker_id            VARCHAR,
    p_lease_duration           INTERVAL DEFAULT '120 seconds'
)
RETURNS TABLE (
    success                    BOOLEAN,
    status_code                VARCHAR,
    new_lease_token            UUID,
    new_generation             INTEGER,
    new_lease_until            TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_now                      TIMESTAMPTZ;
    v_parent_status            VARCHAR(20);
    v_res                      RECORD;
    v_new_token                UUID;
    v_new_gen                  INTEGER;
    v_new_until                TIMESTAMPTZ;
BEGIN
    IF current_setting('role', true) IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an authenticated user role context'
            USING ERRCODE = '42501';
    END IF;

    v_now := clock_timestamp();

    -- Lock L1: Parent Idempotency Row (Preserving Universal Lock Hierarchy L1 -> L4)
    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = p_user_id AND key = p_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'PARENT_GENERATION_NOT_FOUND'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Lock L4: Reservation Row
    SELECT * INTO v_res
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token
      AND user_id = p_user_id
      AND parent_key = p_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'RESERVATION_NOT_FOUND'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.status IN ('committed', 'released', 'reconciled_zero_usage') THEN
        RETURN QUERY SELECT false, 'RESERVATION_ALREADY_TERMINAL'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.lease_until > v_now THEN
        RETURN QUERY SELECT false, 'LEASE_STILL_ACTIVE'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    v_new_token := gen_random_uuid();
    v_new_gen := v_res.generation + 1;
    v_new_until := v_now + p_lease_duration;

    UPDATE public.rate_limit_reservations
    SET lease_token = v_new_token,
        generation = v_new_gen,
        worker_id = p_new_worker_id,
        lease_until = v_new_until,
        updated_at = v_now
    WHERE reservation_token = p_reservation_token;

    RETURN QUERY SELECT true, 'SUCCESS'::VARCHAR, v_new_token, v_new_gen, v_new_until;
    RETURN;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 9: PL/pgSQL ROUTINE — reserve_quota (OPERATION-AWARE OVERLOAD)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_quota(
    p_user_id              UUID,
    p_parent_key           VARCHAR,
    p_chunk_index          INTEGER,
    p_project_id           VARCHAR,
    p_quota_scope          VARCHAR,
    p_model_name           VARCHAR,
    p_worker_id            VARCHAR,
    p_estimated_tokens     INTEGER,
    p_lease_duration       INTERVAL,
    p_operation_type       VARCHAR DEFAULT 'chunk'
)
RETURNS TABLE (
    reservation_token      UUID,
    lease_token            UUID,
    generation             INTEGER,
    lease_until            TIMESTAMP WITH TIME ZONE,
    allowed                BOOLEAN,
    status_code            TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_global_config        RECORD;
    v_scope_config         RECORD;
    v_parent_status        VARCHAR(20);
    v_existing_res         RECORD;
    v_existing_chunk       RECORD;
    v_existing_event       RECORD;
    v_now                  TIMESTAMPTZ;
    v_current_pacific_date DATE;
    v_global_active        INTEGER;
    v_global_rpm           INTEGER;
    v_global_committed_tpm BIGINT;
    v_global_in_flight_tpm BIGINT;
    v_global_rolling_tpm   BIGINT;
    v_global_rpd           INTEGER;
    v_scope_active         INTEGER;
    v_scope_rpm            INTEGER;
    v_scope_committed_tpm  BIGINT;
    v_scope_in_flight_tpm  BIGINT;
    v_scope_rolling_tpm    BIGINT;
    v_scope_rpd            INTEGER;
    v_res_token            UUID;
    v_lease_token          UUID;
    v_lease_until          TIMESTAMPTZ;
BEGIN
    -- Authorization & Role-Switching Protection
    IF NOT (
        session_user = 'service_role'
        OR pg_has_role(session_user, 'service_role', 'MEMBER')
        OR (SELECT COALESCE(rolsuper, false) FROM pg_roles WHERE rolname = session_user)
    ) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Caller "%" is not authorized to execute backend routine', session_user
            USING ERRCODE = '42501';
    END IF;

    IF current_setting('role', true) IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an authenticated user role context'
            USING ERRCODE = '42501';
    END IF;

    -- Input Parameter Validation
    IF p_operation_type NOT IN ('chunk', 'monolithic', 'synthesis') THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'INVALID_OPERATION_TYPE'::TEXT;
        RETURN;
    END IF;
    IF p_project_id IS NULL OR trim(p_project_id) = '' THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'INVALID_PROJECT_ID'::TEXT;
        RETURN;
    END IF;
    IF p_quota_scope IS NULL OR trim(p_quota_scope) = '' THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'INVALID_QUOTA_SCOPE'::TEXT;
        RETURN;
    END IF;
    IF p_model_name IS NULL OR trim(p_model_name) = '' THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'INVALID_MODEL_NAME'::TEXT;
        RETURN;
    END IF;
    IF p_quota_scope <> p_model_name THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'MODEL_SCOPE_MISMATCH'::TEXT;
        RETURN;
    END IF;
    IF p_worker_id IS NULL OR trim(p_worker_id) = '' THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'INVALID_WORKER_ID'::TEXT;
        RETURN;
    END IF;
    IF p_estimated_tokens IS NULL OR p_estimated_tokens <= 0 THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'INVALID_ESTIMATED_TOKENS'::TEXT;
        RETURN;
    END IF;
    IF p_lease_duration IS NULL OR p_lease_duration <= '0 seconds'::interval OR p_lease_duration > '300 seconds'::interval THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'INVALID_LEASE_DURATION'::TEXT;
        RETURN;
    END IF;
    IF p_operation_type = 'chunk' AND (p_chunk_index IS NULL OR p_chunk_index < 0 OR p_chunk_index >= 100) THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'INVALID_CHUNK_INDEX'::TEXT;
        RETURN;
    END IF;
    IF p_operation_type IN ('monolithic', 'synthesis') AND p_chunk_index <> -1 THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'INVALID_NON_CHUNK_COORDINATE'::TEXT;
        RETURN;
    END IF;

    -- Lock Order: Parent -> Project Quota -> Scope Quota
    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = p_user_id AND key = p_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'PARENT_GENERATION_NOT_FOUND'::TEXT;
        RETURN;
    END IF;
    IF v_parent_status NOT IN ('processing', 'pending') THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'PARENT_GENERATION_NOT_ACTIVE'::TEXT;
        RETURN;
    END IF;

    -- Idempotency Check on Existing Reservation for this (parent_key, operation_type, chunk_index)
    SELECT * INTO v_existing_res
    FROM public.rate_limit_reservations
    WHERE user_id = p_user_id AND parent_key = p_parent_key AND operation_type = p_operation_type AND chunk_index = p_chunk_index
      AND status IN ('active', 'dispatching', 'dispatched', 'uncertain', 'committed');

    IF FOUND THEN
        IF v_existing_res.status = 'committed' THEN
            RETURN QUERY SELECT v_existing_res.reservation_token, v_existing_res.lease_token, v_existing_res.generation, v_existing_res.lease_until, TRUE, 'ALREADY_COMMITTED'::TEXT;
            RETURN;
        END IF;

        IF v_existing_res.status = 'dispatching' THEN
            RETURN QUERY SELECT v_existing_res.reservation_token, v_existing_res.lease_token, v_existing_res.generation, v_existing_res.lease_until, FALSE, 'ALREADY_DISPATCHING'::TEXT;
            RETURN;
        END IF;

        IF v_existing_res.status = 'uncertain' THEN
            RETURN QUERY SELECT v_existing_res.reservation_token, v_existing_res.lease_token, v_existing_res.generation, v_existing_res.lease_until, FALSE, 'RESERVATION_UNCERTAIN'::TEXT;
            RETURN;
        END IF;

        IF v_existing_res.worker_id = p_worker_id AND v_existing_res.lease_until > clock_timestamp() THEN
            RETURN QUERY SELECT v_existing_res.reservation_token, v_existing_res.lease_token, v_existing_res.generation, v_existing_res.lease_until, TRUE, 'ALREADY_RESERVED'::TEXT;
            RETURN;
        END IF;

        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'CHUNK_RESERVATION_CONFLICT'::TEXT;
        RETURN;
    END IF;

    -- Exclusive Admission Locks (Global -> Scope FOR UPDATE)
    SELECT * INTO v_global_config
    FROM public.project_quota_configs
    WHERE project_id = p_project_id AND quota_scope = 'global'
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'CONFIG_NOT_FOUND_GLOBAL'::TEXT;
        RETURN;
    END IF;

    SELECT * INTO v_scope_config
    FROM public.project_quota_configs
    WHERE project_id = p_project_id AND quota_scope = p_quota_scope
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'CONFIG_NOT_FOUND_SCOPE'::TEXT;
        RETURN;
    END IF;

    v_now := clock_timestamp();
    v_current_pacific_date := (v_now AT TIME ZONE 'America/Los_Angeles')::date;

    -- Concurrency Check
    SELECT COALESCE(COUNT(*), 0) INTO v_global_active
    FROM public.rate_limit_reservations
    WHERE project_id = p_project_id
      AND (
          (status = 'active' AND lease_until > v_now)
          OR (status IN ('dispatching', 'dispatched', 'uncertain'))
      );

    IF v_global_active >= v_global_config.max_active_dispatches THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_ACTIVE_DISPATCHES_GLOBAL'::TEXT;
        RETURN;
    END IF;

    -- RPM Check
    SELECT COALESCE(COUNT(*), 0) INTO v_global_rpm
    FROM public.rate_limit_reservations
    WHERE project_id = p_project_id
      AND dispatching_at IS NOT NULL
      AND dispatching_at >= v_now - INTERVAL '60 seconds';

    IF v_global_rpm >= v_global_config.max_rpm THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_RPM_GLOBAL'::TEXT;
        RETURN;
    END IF;

    -- TPM Check (3-term formula with active hold validity)
    SELECT COALESCE(SUM(r.estimated_tokens), 0) INTO v_global_in_flight_tpm
    FROM public.rate_limit_reservations r
    WHERE r.project_id = p_project_id
      AND (
          (r.status = 'active' AND r.lease_until > v_now)
          OR (r.status IN ('dispatching', 'dispatched', 'uncertain'))
      );

    SELECT COALESCE(SUM(COALESCE(r.actual_total_tokens, r.estimated_tokens)), 0) INTO v_global_committed_tpm
    FROM public.rate_limit_reservations r
    WHERE r.project_id = p_project_id
      AND r.status = 'committed'
      AND r.committed_at >= v_now - INTERVAL '60 seconds';

    v_global_rolling_tpm := v_global_in_flight_tpm + v_global_committed_tpm;

    IF (v_global_rolling_tpm + p_estimated_tokens) > v_global_config.max_tpm THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_TPM_GLOBAL'::TEXT;
        RETURN;
    END IF;

    -- Scope Checks
    SELECT COALESCE(COUNT(*), 0) INTO v_scope_active
    FROM public.rate_limit_reservations
    WHERE project_id = p_project_id AND quota_scope = p_quota_scope
      AND (
          (status = 'active' AND lease_until > v_now)
          OR (status IN ('dispatching', 'dispatched', 'uncertain'))
      );

    IF v_scope_active >= v_scope_config.max_active_dispatches THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_ACTIVE_DISPATCHES_SCOPE'::TEXT;
        RETURN;
    END IF;

    -- RPD Check
    SELECT COALESCE(COUNT(*), 0) INTO v_global_rpd
    FROM public.rate_limit_reservations
    WHERE project_id = p_project_id
      AND quota_date_pacific = v_current_pacific_date
      AND dispatching_at IS NOT NULL;

    IF v_global_rpd >= v_global_config.max_rpd THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_RPD_GLOBAL'::TEXT;
        RETURN;
    END IF;

    -- Success: Mint Reservation
    v_res_token := gen_random_uuid();
    v_lease_token := gen_random_uuid();
    v_lease_until := v_now + p_lease_duration;

    INSERT INTO public.rate_limit_reservations (
        reservation_token,
        project_id,
        quota_scope,
        operation_type,
        user_id,
        parent_key,
        chunk_index,
        model_name,
        lease_token,
        worker_id,
        generation,
        status,
        estimated_tokens,
        lease_until,
        quota_date_pacific,
        created_at,
        updated_at
    ) VALUES (
        v_res_token,
        p_project_id,
        p_quota_scope,
        p_operation_type,
        p_user_id,
        p_parent_key,
        p_chunk_index,
        p_model_name,
        v_lease_token,
        p_worker_id,
        1,
        'active',
        p_estimated_tokens,
        v_lease_until,
        v_current_pacific_date,
        v_now,
        v_now
    );

    RETURN QUERY SELECT v_res_token, v_lease_token, 1, v_lease_until, TRUE, 'SUCCESS'::TEXT;
    RETURN;
END;
$$;

-- Revoke default public execution privileges on all backend routines
REVOKE EXECUTE ON FUNCTION public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL, VARCHAR) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_or_adopt_dispatch_slot(UUID, VARCHAR, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_dispatch_attempt(UUID, UUID, UUID, VARCHAR, INTEGER, VARCHAR, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, UUID, VARCHAR, VARCHAR, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.report_stale_attempt_outcome(UUID, UUID, VARCHAR, VARCHAR, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.recover_reservation_ownership(UUID, VARCHAR, UUID, VARCHAR, INTERVAL) FROM PUBLIC;

-- Grant execution privileges to backend application roles
GRANT EXECUTE ON FUNCTION public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL, VARCHAR) TO service_role;
ALTER FUNCTION public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL, VARCHAR) OWNER TO codenotes_definer;

-- Grant execute on new routines
GRANT EXECUTE ON FUNCTION public.claim_or_adopt_dispatch_slot(UUID, VARCHAR, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_dispatch_attempt(UUID, UUID, UUID, VARCHAR, INTEGER, VARCHAR, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, UUID, VARCHAR, VARCHAR, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.report_stale_attempt_outcome(UUID, UUID, VARCHAR, VARCHAR, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_reservation_ownership(UUID, VARCHAR, UUID, VARCHAR, INTERVAL) TO service_role;

ALTER FUNCTION public.claim_or_adopt_dispatch_slot OWNER TO codenotes_definer;
ALTER FUNCTION public.complete_dispatch_attempt OWNER TO codenotes_definer;
ALTER FUNCTION public.report_stale_attempt_outcome OWNER TO codenotes_definer;
ALTER FUNCTION public.recover_reservation_ownership OWNER TO codenotes_definer;

COMMIT;
