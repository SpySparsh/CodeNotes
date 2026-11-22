-- =============================================================================
-- Migration: Failed-Output Usage Settlement & Fenced Claim Concurrency Protection
-- Target Database: PostgreSQL 18.3 (codenotes_staging / production)
-- Universal Lock Hierarchy: L1 (generation_idempotency) -> L2/L3 (project_quota_configs) -> L4 (rate_limit_reservations) -> L5 (rate_limit_dispatch_attempts) -> L6 (chunk_generations / notes)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Step 1: Constraint Modifications (DDL)
-- -----------------------------------------------------------------------------

-- 1A. Add 'settled_failure' to rate_limit_reservations.status
ALTER TABLE public.rate_limit_reservations
    DROP CONSTRAINT IF EXISTS chk_reservation_status;

ALTER TABLE public.rate_limit_reservations
    ADD CONSTRAINT chk_reservation_status
    CHECK (status IN (
        'active',
        'dispatching',
        'dispatched',
        'uncertain',
        'committed',
        'released',
        'expired_day_boundary',
        'reconciled_zero_usage',
        'settled_failure'
    ));

-- 1B. Add 'failed_output' to rate_limit_dispatch_attempts.status
ALTER TABLE public.rate_limit_dispatch_attempts
    DROP CONSTRAINT IF EXISTS rate_limit_dispatch_attempts_status_check;

ALTER TABLE public.rate_limit_dispatch_attempts
    DROP CONSTRAINT IF EXISTS status_check;

ALTER TABLE public.rate_limit_dispatch_attempts
    ADD CONSTRAINT rate_limit_dispatch_attempts_status_check
    CHECK (status IN (
        'dispatch_claimed',
        'dispatched',
        'completed',
        'adopted',
        'rejected_quota',
        'failed_transient',
        'ambiguous',
        'superseded',
        'failed_output'
    ));

-- 1C. Add 'SETTLE_FAILURE' to rate_limit_events.event_type
ALTER TABLE public.rate_limit_events
    DROP CONSTRAINT IF EXISTS chk_event_type;

ALTER TABLE public.rate_limit_events
    ADD CONSTRAINT chk_event_type
    CHECK (event_type IN (
        'RESERVE',
        'COMMIT',
        'RELEASE',
        'RECONCILE_STALE',
        'RECONCILE_DAY_BOUNDARY',
        'RECONCILE_ZERO',
        'RECONCILE_ZERO_USAGE',
        'SETTLE_FAILURE'
    ));

-- 1D. Expand rate_limit_events.chunk_index check to support -1 (monolithic/synthesis events)
ALTER TABLE public.rate_limit_events
    DROP CONSTRAINT IF EXISTS rate_limit_events_chunk_index_check;

ALTER TABLE public.rate_limit_events
    ADD CONSTRAINT rate_limit_events_chunk_index_check
    CHECK (chunk_index >= -1 AND chunk_index < 100);

-- -----------------------------------------------------------------------------
-- Step 2: TPM Query Harmonization in reserve_quota()
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
    IF current_setting('role', true) IN ('authenticated', 'anon') OR SESSION_USER IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an authenticated user role context'
            USING ERRCODE = '42501';
    END IF;

    -- Strict Parameter Validation
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_user_id cannot be NULL' USING ERRCODE = '22023';
    END IF;
    IF p_parent_key IS NULL OR trim(p_parent_key) = '' THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_parent_key cannot be empty' USING ERRCODE = '22023';
    END IF;
    IF p_project_id IS NULL OR trim(p_project_id) = '' THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_project_id cannot be empty' USING ERRCODE = '22023';
    END IF;
    IF p_quota_scope IS NULL OR trim(p_quota_scope) = '' THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_quota_scope cannot be empty' USING ERRCODE = '22023';
    END IF;
    IF p_model_name IS NULL OR trim(p_model_name) = '' THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_model_name cannot be empty' USING ERRCODE = '22023';
    END IF;
    IF p_worker_id IS NULL OR trim(p_worker_id) = '' THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_worker_id cannot be empty' USING ERRCODE = '22023';
    END IF;
    IF p_quota_scope <> p_model_name THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_quota_scope (%) must match p_model_name (%)', p_quota_scope, p_model_name USING ERRCODE = '22023';
    END IF;
    IF p_operation_type NOT IN ('chunk', 'monolithic', 'synthesis') THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_operation_type must be chunk, monolithic, or synthesis' USING ERRCODE = '22023';
    END IF;
    IF p_operation_type = 'chunk' AND (p_chunk_index IS NULL OR p_chunk_index < 0 OR p_chunk_index >= 100) THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_chunk_index for chunk operation must be between 0 and 99' USING ERRCODE = '22023';
    END IF;
    IF p_operation_type IN ('monolithic', 'synthesis') AND p_chunk_index <> -1 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_chunk_index for monolithic/synthesis operation must be -1' USING ERRCODE = '22023';
    END IF;
    IF p_estimated_tokens IS NULL OR p_estimated_tokens <= 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_estimated_tokens must be positive' USING ERRCODE = '22023';
    END IF;
    IF p_lease_duration IS NULL OR p_lease_duration <= INTERVAL '0 seconds' THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_lease_duration must be positive' USING ERRCODE = '22023';
    END IF;

    v_now := clock_timestamp();
    v_current_pacific_date := (timezone('America/Los_Angeles', v_now))::DATE;

    -- Lock L1: Parent Idempotency Row
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

    -- Lock L2: Global Quota Config
    SELECT * INTO v_global_config
    FROM public.project_quota_configs
    WHERE project_id = p_project_id AND quota_scope = 'global'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CONFIG_NOT_FOUND: Global quota configuration missing for project "%"', p_project_id USING ERRCODE = 'P0002';
    END IF;

    -- Lock L3: Scope Quota Config
    SELECT * INTO v_scope_config
    FROM public.project_quota_configs
    WHERE project_id = p_project_id AND quota_scope = p_quota_scope
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CONFIG_NOT_FOUND: Scope quota configuration missing for scope "%"', p_quota_scope USING ERRCODE = 'P0002';
    END IF;

    -- Global Active Dispatches Check
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

    -- TPM Check (Accounting for committed and settled_failure actual tokens)
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
      AND r.status IN ('committed', 'settled_failure')
      AND r.committed_at >= v_now - INTERVAL '60 seconds';

    v_global_rolling_tpm := v_global_in_flight_tpm + v_global_committed_tpm;

    IF (v_global_rolling_tpm + p_estimated_tokens) > v_global_config.max_tpm THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_TPM_GLOBAL'::TEXT;
        RETURN;
    END IF;

    -- Scope Active Dispatches Check
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

    -- Mint Reservation
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

REVOKE ALL ON FUNCTION public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL, VARCHAR) TO service_role, codenotes_definer;
ALTER FUNCTION public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL, VARCHAR) OWNER TO codenotes_definer;

-- -----------------------------------------------------------------------------
-- Step 3: Replace claim_or_adopt_dispatch_slot()
-- Incorporates Post-Lock Timestamp Refresh and Reservation Status Allowlist
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_or_adopt_dispatch_slot(
    p_user_id                  UUID,
    p_parent_key               VARCHAR,
    p_operation_type           VARCHAR,
    p_chunk_index              INTEGER,
    p_reservation_token        UUID,
    p_lease_token              UUID,
    p_worker_id                VARCHAR,
    p_generation               INTEGER,
    p_project_id               VARCHAR DEFAULT 'codenotes',
    p_quota_scope              VARCHAR DEFAULT 'gemini-2.0-flash',
    p_model_name               VARCHAR DEFAULT 'gemini-2.0-flash',
    p_estimated_tokens         INTEGER DEFAULT 0,
    p_lease_duration           INTERVAL DEFAULT INTERVAL '75 seconds'
)
RETURNS TABLE (
    allowed                    BOOLEAN,
    adopted                    BOOLEAN,
    status_code                VARCHAR,
    attempt_id                 UUID,
    attempt_number             INTEGER,
    generation                 INTEGER,
    lease_until                TIMESTAMPTZ,
    adopted_payload            JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_now                      TIMESTAMPTZ;
    v_pacific_today            DATE;
    v_parent_status            VARCHAR(20);
    v_global_cfg               RECORD;
    v_scope_cfg                RECORD;
    v_res                      RECORD;
    v_existing_attempt         RECORD;
    v_existing_chunk           RECORD;
    v_new_note_id              UUID;
    v_new_attempt_id           UUID;
    v_next_attempt_number      INTEGER;
    v_new_lease_until          TIMESTAMPTZ;
    v_global_rpm               INTEGER;
    v_scope_rpm                INTEGER;
    v_global_rpd               INTEGER;
    v_scope_rpd                INTEGER;
    v_global_active_holds      INTEGER;
    v_scope_active_holds       INTEGER;
    v_global_dispatched        INTEGER;
    v_scope_dispatched         INTEGER;
BEGIN
    -- Authorization & Role-Switching Protection
    IF current_setting('role', true) IN ('authenticated', 'anon') OR SESSION_USER IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an authenticated user role context'
            USING ERRCODE = '42501';
    END IF;

    -- Calculate current Pacific date
    v_pacific_today := (timezone('America/Los_Angeles', clock_timestamp()))::DATE;

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

    -- Refresh timestamp immediately after acquiring L4 lock
    v_now := clock_timestamp();

    -- Validate Fencing & Lease Ownership
    IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN
        RETURN QUERY SELECT false, false, 'STALE_LEASE_OWNERSHIP'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    IF v_res.generation IS DISTINCT FROM p_generation THEN
        RETURN QUERY SELECT false, false, 'FENCING_GENERATION_MISMATCH'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    -- Post-lock reservation status validation
    IF v_res.status NOT IN ('active', 'dispatching') THEN
        IF v_res.status = 'settled_failure' THEN
            RETURN QUERY SELECT false, false, 'RESERVATION_ALREADY_SETTLED_FAILURE'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        ELSIF v_res.status IN ('committed', 'released', 'reconciled_zero_usage') THEN
            RETURN QUERY SELECT false, false, 'RESERVATION_ALREADY_TERMINAL'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        ELSE
            RETURN QUERY SELECT false, false, 'RESERVATION_INVALID_STATUS'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        END IF;
        RETURN;
    END IF;

    -- Lease expiry check against refreshed timestamp
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
      AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted', 'failed_output');

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
          AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted', 'failed_output');

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
      AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted', 'failed_output');

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
          AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted', 'failed_output');

        IF (v_scope_rpd + 1) > v_scope_cfg.max_rpd THEN
            RETURN QUERY SELECT false, false, 'RATE_LIMIT_SCOPE_RPD_EXCEEDED'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
            RETURN;
        END IF;
    END IF;

    -- Check 5: Global TPM (Accounting for failed_output)
    SELECT COALESCE(SUM(r.estimated_tokens), 0) INTO v_global_active_holds
    FROM public.rate_limit_reservations r
    WHERE r.project_id = p_project_id
      AND r.status = 'active'
      AND r.lease_until > v_now
      AND r.reservation_token <> p_reservation_token;

    SELECT COALESCE(SUM(
        CASE WHEN a.status IN ('completed', 'adopted', 'failed_output') THEN COALESCE(a.actual_total_tokens, a.estimated_tokens) ELSE a.estimated_tokens END
    ), 0) INTO v_global_dispatched
    FROM public.rate_limit_dispatch_attempts a
    WHERE a.project_id = p_project_id
      AND a.dispatched_at >= v_now - INTERVAL '60 seconds'
      AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted', 'failed_output');

    IF (v_global_active_holds + v_global_dispatched + p_estimated_tokens) > v_global_cfg.max_tpm THEN
        RETURN QUERY SELECT false, false, 'RATE_LIMIT_GLOBAL_TPM_EXCEEDED'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    -- Check 6: Scope TPM (Accounting for failed_output)
    IF p_quota_scope <> 'global' THEN
        SELECT COALESCE(SUM(r.estimated_tokens), 0) INTO v_scope_active_holds
        FROM public.rate_limit_reservations r
        WHERE r.project_id = p_project_id
          AND r.quota_scope = p_quota_scope
          AND r.status = 'active'
          AND r.lease_until > v_now
          AND r.reservation_token <> p_reservation_token;

        SELECT COALESCE(SUM(
            CASE WHEN a.status IN ('completed', 'adopted', 'failed_output') THEN COALESCE(a.actual_total_tokens, a.estimated_tokens) ELSE a.estimated_tokens END
        ), 0) INTO v_scope_dispatched
        FROM public.rate_limit_dispatch_attempts a
        WHERE a.project_id = p_project_id
          AND a.quota_scope = p_quota_scope
          AND a.dispatched_at >= v_now - INTERVAL '60 seconds'
          AND a.status IN ('dispatch_claimed', 'dispatched', 'completed', 'ambiguous', 'adopted', 'failed_output');

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
        'DISPATCH_SLOT_CLAIMED'::VARCHAR,
        v_new_attempt_id,
        v_next_attempt_number,
        p_generation,
        v_new_lease_until,
        NULL::JSONB;
    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_or_adopt_dispatch_slot(UUID, VARCHAR, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_or_adopt_dispatch_slot(UUID, VARCHAR, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL) TO service_role, codenotes_definer;
ALTER FUNCTION public.claim_or_adopt_dispatch_slot(UUID, VARCHAR, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL) OWNER TO codenotes_definer;

-- -----------------------------------------------------------------------------
-- Step 4: Replace complete_dispatch_attempt()
-- Incorporates Terminal State Protection
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
    IF current_setting('role', true) IN ('authenticated', 'anon') OR SESSION_USER IN ('authenticated', 'anon') THEN
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

    IF v_parent_status NOT IN ('processing', 'pending') THEN
        IF v_parent_status = 'completed' THEN
            -- Check if attempt was completed
            SELECT * INTO v_attempt
            FROM public.rate_limit_dispatch_attempts
            WHERE attempt_id = p_attempt_id AND reservation_token = p_reservation_token;
            IF FOUND AND v_attempt.status = 'completed' THEN
                RETURN QUERY SELECT true, 'ALREADY_COMPLETED'::VARCHAR, v_attempt.completed_at;
                RETURN;
            END IF;
        END IF;
        RETURN QUERY SELECT false, 'PARENT_GENERATION_NOT_ACTIVE'::VARCHAR, NULL::TIMESTAMPTZ;
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

    -- Terminal check under L4/L5 locks: Prevent overwriting settled_failure or failed_output
    IF v_res.status IN ('committed', 'settled_failure', 'released', 'reconciled_zero_usage')
       OR v_attempt.status IN ('completed', 'failed_output', 'superseded') THEN
        IF v_attempt.status = 'completed' AND v_res.status = 'committed' THEN
            RETURN QUERY SELECT true, 'ALREADY_COMPLETED'::VARCHAR, v_attempt.completed_at;
        ELSE
            RETURN QUERY SELECT false, 'ATTEMPT_ALREADY_TERMINAL'::VARCHAR, NULL::TIMESTAMPTZ;
        END IF;
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

REVOKE ALL ON FUNCTION public.complete_dispatch_attempt(UUID, UUID, UUID, VARCHAR, INTEGER, VARCHAR, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, UUID, VARCHAR, VARCHAR, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_dispatch_attempt(UUID, UUID, UUID, VARCHAR, INTEGER, VARCHAR, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, UUID, VARCHAR, VARCHAR, TEXT, TEXT, TEXT) TO service_role, codenotes_definer;
ALTER FUNCTION public.complete_dispatch_attempt(UUID, UUID, UUID, VARCHAR, INTEGER, VARCHAR, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, UUID, VARCHAR, VARCHAR, TEXT, TEXT, TEXT) OWNER TO codenotes_definer;

-- -----------------------------------------------------------------------------
-- Step 5: Create settle_failed_dispatch_usage()
-- Complete settlement routine with atomic state transitions and audit logging
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.settle_failed_dispatch_usage(
    p_attempt_id               UUID,
    p_reservation_token        UUID,
    p_lease_token              UUID,
    p_worker_id                VARCHAR,
    p_fencing_generation       INTEGER,
    p_total_tokens             INTEGER,
    p_prompt_tokens            INTEGER DEFAULT NULL,
    p_candidate_tokens         INTEGER DEFAULT NULL,
    p_thoughts_tokens          INTEGER DEFAULT NULL,
    p_error_code               VARCHAR DEFAULT 'MALFORMED_OUTPUT',
    p_error_message            TEXT DEFAULT NULL,
    p_evidence_payload         JSONB DEFAULT NULL
)
RETURNS TABLE (
    success                    BOOLEAN,
    status_code                VARCHAR,
    settled_at                 TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_unlocked_user_id         UUID;
    v_unlocked_parent_key      VARCHAR(64);
    v_parent_status            VARCHAR(20);
    v_res                      RECORD;
    v_attempt                  RECORD;
    v_max_attempt_number       INTEGER;
    v_now                      TIMESTAMPTZ;
BEGIN
    -- 1. Security & Caller Context Protection
    IF current_setting('role', true) IN ('authenticated', 'anon') OR SESSION_USER IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an authenticated user role context'
            USING ERRCODE = '42501';
    END IF;

    -- 2. Strict Input Validation & Sanity Caps
    IF p_attempt_id IS NULL OR p_reservation_token IS NULL OR p_lease_token IS NULL
       OR p_worker_id IS NULL OR p_fencing_generation IS NULL THEN
        RETURN QUERY SELECT false, 'INVALID_INPUT_PARAMETERS'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF p_total_tokens IS NULL OR p_total_tokens < 0 OR p_total_tokens > 20000000 THEN
        RETURN QUERY SELECT false, 'INVALID_TOKEN_METRICS'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF (p_prompt_tokens IS NOT NULL AND p_prompt_tokens < 0)
       OR (p_candidate_tokens IS NOT NULL AND p_candidate_tokens < 0)
       OR (p_thoughts_tokens IS NOT NULL AND p_thoughts_tokens < 0) THEN
        RETURN QUERY SELECT false, 'NEGATIVE_COMPONENT_TOKENS'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- 3. Token Arithmetic Validation
    IF p_prompt_tokens IS NOT NULL AND p_candidate_tokens IS NOT NULL AND p_thoughts_tokens IS NOT NULL THEN
        -- Case A: Complete Component Evidence -> Strict Equality Required
        IF (p_prompt_tokens::BIGINT + p_candidate_tokens::BIGINT + p_thoughts_tokens::BIGINT) <> p_total_tokens::BIGINT THEN
            RETURN QUERY SELECT false, 'INCONSISTENT_TOKEN_ARITHMETIC'::VARCHAR, NULL::TIMESTAMPTZ;
            RETURN;
        END IF;
    ELSE
        -- Case B: Partial Component Evidence -> Component Ceiling Checks
        IF (p_prompt_tokens IS NOT NULL AND p_prompt_tokens > p_total_tokens)
           OR (p_candidate_tokens IS NOT NULL AND p_candidate_tokens > p_total_tokens)
           OR (p_thoughts_tokens IS NOT NULL AND p_thoughts_tokens > p_total_tokens) THEN
            RETURN QUERY SELECT false, 'COMPONENT_EXCEEDS_TOTAL'::VARCHAR, NULL::TIMESTAMPTZ;
            RETURN;
        END IF;

        IF (COALESCE(p_prompt_tokens, 0)::BIGINT + COALESCE(p_candidate_tokens, 0)::BIGINT + COALESCE(p_thoughts_tokens, 0)::BIGINT) > p_total_tokens::BIGINT THEN
            RETURN QUERY SELECT false, 'INCONSISTENT_TOKEN_ARITHMETIC'::VARCHAR, NULL::TIMESTAMPTZ;
            RETURN;
        END IF;
    END IF;

    -- 4. Evidence Payload Size Bound (64 KB maximum)
    IF p_evidence_payload IS NOT NULL AND pg_column_size(p_evidence_payload) > 65536 THEN
        RETURN QUERY SELECT false, 'EVIDENCE_PAYLOAD_TOO_LARGE'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- =========================================================================
    -- DETERMINISTIC LOCK HIERARCHY: L1 (Idempotency) -> L4 (Reservation) -> L5 (Attempt)
    -- =========================================================================
    -- Unlocked lookup of parent coordinates
    SELECT user_id, parent_key INTO v_unlocked_user_id, v_unlocked_parent_key
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'RESERVATION_NOT_FOUND'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Lock L1: Parent Idempotency Row
    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = v_unlocked_user_id AND key = v_unlocked_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'PARENT_GENERATION_NOT_FOUND'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Lock L4: Reservation Row
    SELECT * INTO v_res
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token
    FOR UPDATE;

    -- Re-verify coordinate consistency under L4 lock
    IF v_res.user_id IS DISTINCT FROM v_unlocked_user_id OR v_res.parent_key IS DISTINCT FROM v_unlocked_parent_key THEN
        RETURN QUERY SELECT false, 'CONCURRENT_COORDINATE_MUTATION'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Lock L5: Dispatch Attempt Row
    SELECT * INTO v_attempt
    FROM public.rate_limit_dispatch_attempts
    WHERE attempt_id = p_attempt_id AND reservation_token = p_reservation_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'ATTEMPT_NOT_FOUND'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- 5. Validate Fencing & Lease Ownership
    IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN
        RETURN QUERY SELECT false, 'STALE_LEASE_OWNERSHIP'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.generation IS DISTINCT FROM p_fencing_generation THEN
        RETURN QUERY SELECT false, 'FENCING_GENERATION_MISMATCH'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- 6. Canonical Replay Verification (Evaluated under L1, L4, L5 locks before lease check)
    IF v_attempt.status = 'failed_output' AND v_res.status = 'settled_failure' THEN
        IF v_attempt.actual_total_tokens = p_total_tokens
           AND v_attempt.actual_prompt_tokens IS NOT DISTINCT FROM p_prompt_tokens
           AND v_attempt.actual_candidate_tokens IS NOT DISTINCT FROM p_candidate_tokens
           AND v_attempt.actual_thoughts_tokens IS NOT DISTINCT FROM p_thoughts_tokens
           AND v_attempt.error_code IS NOT DISTINCT FROM p_error_code
           AND COALESCE(v_attempt.response_payload, '{}'::jsonb) = COALESCE(p_evidence_payload, '{}'::jsonb) THEN
            RETURN QUERY SELECT true, 'ALREADY_SETTLED'::VARCHAR, v_attempt.completed_at;
            RETURN;
        ELSE
            RETURN QUERY SELECT false, 'CONFLICTING_REPLAY_PARAMS'::VARCHAR, NULL::TIMESTAMPTZ;
            RETURN;
        END IF;
    END IF;

    -- 7. Refresh Timestamp Under Acquired Locks
    v_now := clock_timestamp();

    -- 8. Lease Expiry Check (Sweeper owns expired non-terminal holds)
    IF v_now > v_res.lease_until THEN
        RETURN QUERY SELECT false, 'LEASE_EXPIRED_DURING_DISPATCH'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- 9. Latest Attempt Validation (Prevent mutating superseded attempts)
    SELECT MAX(attempt_number) INTO v_max_attempt_number
    FROM public.rate_limit_dispatch_attempts
    WHERE reservation_token = p_reservation_token;

    IF v_attempt.attempt_number IS DISTINCT FROM v_max_attempt_number THEN
        RETURN QUERY SELECT false, 'SUPERSEDED_ATTEMPT_MUTATION'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- 10. Positive Source-State Allowlists
    -- 10A. Parent Idempotency Allowlist
    IF v_parent_status NOT IN ('processing', 'pending') THEN
        IF v_parent_status = 'completed' THEN
            RETURN QUERY SELECT false, 'PARENT_GENERATION_ALREADY_COMPLETED'::VARCHAR, NULL::TIMESTAMPTZ;
        ELSIF v_parent_status = 'failed' THEN
            RETURN QUERY SELECT false, 'PARENT_GENERATION_ALREADY_FAILED'::VARCHAR, NULL::TIMESTAMPTZ;
        ELSE
            RETURN QUERY SELECT false, 'PARENT_GENERATION_INVALID_SOURCE_STATE'::VARCHAR, NULL::TIMESTAMPTZ;
        END IF;
        RETURN;
    END IF;

    -- 10B. Reservation Allowlist
    IF v_res.status NOT IN ('dispatching', 'dispatched') THEN
        IF v_res.status = 'committed' THEN
            RETURN QUERY SELECT false, 'RESERVATION_ALREADY_COMMITTED'::VARCHAR, NULL::TIMESTAMPTZ;
        ELSE
            RETURN QUERY SELECT false, 'RESERVATION_INVALID_SOURCE_STATE'::VARCHAR, NULL::TIMESTAMPTZ;
        END IF;
        RETURN;
    END IF;

    -- 10C. Attempt Allowlist
    IF v_attempt.status NOT IN ('dispatch_claimed', 'dispatched') THEN
        IF v_attempt.status IN ('completed', 'adopted') THEN
            RETURN QUERY SELECT false, 'ATTEMPT_ALREADY_COMPLETED'::VARCHAR, NULL::TIMESTAMPTZ;
        ELSE
            RETURN QUERY SELECT false, 'ATTEMPT_INVALID_SOURCE_STATE'::VARCHAR, NULL::TIMESTAMPTZ;
        END IF;
        RETURN;
    END IF;

    -- =========================================================================
    -- ATOMIC STATE MUTATIONS & AUDIT EVENT INSERTION
    -- =========================================================================
    -- 1. Mutate Attempt Row (L5)
    UPDATE public.rate_limit_dispatch_attempts
    SET status = 'failed_output',
        actual_total_tokens = p_total_tokens,
        actual_prompt_tokens = p_prompt_tokens,
        actual_candidate_tokens = p_candidate_tokens,
        actual_thoughts_tokens = p_thoughts_tokens,
        response_payload = p_evidence_payload,
        error_code = p_error_code,
        error_message = p_error_message,
        completed_at = v_now,
        updated_at = v_now
    WHERE attempt_id = p_attempt_id;

    -- 2. Mutate Reservation Row (L4) (Explicit lease termination lease_until = v_now)
    UPDATE public.rate_limit_reservations
    SET status = 'settled_failure',
        lease_until = v_now,
        actual_total_tokens = p_total_tokens,
        actual_prompt_tokens = p_prompt_tokens,
        actual_candidate_tokens = p_candidate_tokens,
        actual_thoughts_tokens = p_thoughts_tokens,
        unconsumed_total_tokens = GREATEST(0, v_res.estimated_tokens - p_total_tokens),
        overage_total_tokens = GREATEST(0, p_total_tokens - v_res.estimated_tokens),
        reconcile_reason = 'PROVIDER_SUCCESS_MALFORMED_OUTPUT',
        reconcile_evidence = p_evidence_payload,
        reconcile_source = 'WORKER_DISPATCH_SETTLEMENT',
        committed_at = v_now,
        updated_at = v_now
    WHERE reservation_token = p_reservation_token;

    -- 3. Mutate Parent Idempotency Row (L1) -> Terminal failure, no note published!
    UPDATE public.generation_idempotency
    SET status = 'failed',
        error_code = p_error_code,
        error_message = p_error_message,
        lease_until = NULL,
        updated_at = v_now
    WHERE user_id = v_unlocked_user_id AND key = v_unlocked_parent_key;

    -- 4. Insert Immutable Audit Event (Strict append-only, chunk_index >= -1 enabled)
    INSERT INTO public.rate_limit_events (
        project_id, quota_scope, user_id, parent_key, chunk_index,
        reservation_token, event_type, model_name, worker_id,
        total_tokens, prompt_tokens, candidate_tokens, thoughts_tokens,
        payload, created_at
    ) VALUES (
        v_res.project_id, v_res.quota_scope, v_res.user_id, v_res.parent_key, v_res.chunk_index,
        p_reservation_token, 'SETTLE_FAILURE', v_res.model_name, p_worker_id,
        p_total_tokens, p_prompt_tokens, p_candidate_tokens, p_thoughts_tokens,
        COALESCE(p_evidence_payload, '{}'::jsonb), v_now
    );

    RETURN QUERY SELECT true, 'SUCCESS'::VARCHAR, v_now;
    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_failed_dispatch_usage(UUID, UUID, UUID, VARCHAR, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_failed_dispatch_usage(UUID, UUID, UUID, VARCHAR, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, TEXT, JSONB) TO service_role, codenotes_definer;
ALTER FUNCTION public.settle_failed_dispatch_usage(UUID, UUID, UUID, VARCHAR, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, TEXT, JSONB) OWNER TO codenotes_definer;

COMMIT;
