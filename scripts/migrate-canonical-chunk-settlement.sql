-- =============================================================================
-- Migration: scripts/migrate-canonical-chunk-settlement.sql
-- Architecture: CodeNotes AI — Canonical Chunk Settlement & Quota Replay Hardening
-- Safety: Fully transactional (BEGIN ... COMMIT); Advisory locked;
--         Universal Lock Hierarchy L1 -> L2/L3 -> L4 -> L5 -> L6.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- SECTION 1: TRANSACTION-SCOPED ADVISORY MIGRATION LOCK
-- -----------------------------------------------------------------------------
SELECT pg_advisory_xact_lock(849204859284729107);

-- -----------------------------------------------------------------------------
-- SECTION 2: CANONICAL ROUTINE — claim_or_adopt_dispatch_slot
-- Hardens attempt adoption to:
-- 1. Strictly match requested operation_type (no monolithic/chunk cross-adoption).
-- 2. Verify payload and coordinate integrity between attempt and chunk.
-- 3. Reconcile reservation (committed + token accounting) and quota event (COMMIT).
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
    v_existing_event           RECORD;
    v_new_note_id              UUID;
    v_new_attempt_id           UUID;
    v_next_attempt_number      INTEGER;
    v_new_lease_until          TIMESTAMPTZ;
    v_global_rpm               INTEGER;
    v_scope_rpm                INTEGER;
    v_global_rpd               INTEGER;
    v_scope_rpd                INTEGER;
    v_global_active_holds      BIGINT;
    v_scope_active_holds       BIGINT;
    v_global_dispatched        BIGINT;
    v_scope_dispatched         BIGINT;
    v_unconsumed_total         INTEGER;
    v_overage_total            INTEGER;
BEGIN
    IF current_setting('role', true) IN ('authenticated', 'anon') OR SESSION_USER IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an authenticated user role context'
            USING ERRCODE = '42501';
    END IF;

    v_now := clock_timestamp();
    v_pacific_today := (timezone('America/Los_Angeles', v_now))::DATE;

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

    -- Permit active or already-completed parent generations to proceed to adoption check
    IF v_parent_status NOT IN ('processing', 'pending', 'completed') THEN
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

    v_now := clock_timestamp();

    -- Validate Reservation Coordinates
    IF v_res.user_id IS DISTINCT FROM p_user_id
       OR v_res.parent_key IS DISTINCT FROM p_parent_key
       OR (p_operation_type = 'chunk' AND v_res.chunk_index IS DISTINCT FROM p_chunk_index) THEN
        RETURN QUERY SELECT false, false, 'RESERVATION_COORDINATE_MISMATCH'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
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

    -- Terminal non-adoptable reservation states rejection
    IF v_res.status = 'settled_failure' THEN
        RETURN QUERY SELECT false, false, 'RESERVATION_ALREADY_SETTLED_FAILURE'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    ELSIF v_res.status IN ('released', 'reconciled_zero_usage', 'expired_day_boundary') THEN
        RETURN QUERY SELECT false, false, 'RESERVATION_ALREADY_TERMINAL'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    ELSIF v_res.status NOT IN ('active', 'dispatching', 'dispatched', 'committed') THEN
        RETURN QUERY SELECT false, false, 'RESERVATION_INVALID_STATUS'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
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
        -- Validate attempt operation type matches requested operation
        IF v_existing_attempt.operation_type IS DISTINCT FROM p_operation_type THEN
            RETURN QUERY SELECT false, false, 'OPERATION_TYPE_MISMATCH'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
            RETURN;
        END IF;

        -- Validate available attempt identity and coordinate fields against reservation and request
        -- Note: rate_limit_dispatch_attempts contains reservation_token, operation_type, project_id, and quota_scope.
        -- user_id, parent_key, and chunk_index do NOT exist on rate_limit_dispatch_attempts; they reside on rate_limit_reservations.
        IF v_existing_attempt.reservation_token IS DISTINCT FROM p_reservation_token
           OR v_existing_attempt.project_id IS DISTINCT FROM v_res.project_id
           OR v_existing_attempt.quota_scope IS DISTINCT FROM v_res.quota_scope THEN
            RETURN QUERY SELECT false, false, 'ATTEMPT_COORDINATE_MISMATCH'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
            RETURN;
        END IF;

        -- Ensure completed attempt has a stored payload to adopt
        IF v_existing_attempt.response_payload IS NULL THEN
            RETURN QUERY SELECT false, false, 'COMPLETED_ATTEMPT_MISSING_PAYLOAD'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
            RETURN;
        END IF;

        -- Case A: Chunk Generation Adoption
        IF p_operation_type = 'chunk' THEN
            -- Validate existing COMMIT event BEFORE any mutations
            SELECT * INTO v_existing_event
            FROM public.rate_limit_events
            WHERE reservation_token = p_reservation_token AND event_type = 'COMMIT'
            LIMIT 1;

            IF FOUND THEN
                -- Strictly validate existing COMMIT event identity and accounting using null-safe comparisons
                IF v_existing_event.project_id IS DISTINCT FROM v_res.project_id
                   OR v_existing_event.quota_scope IS DISTINCT FROM v_res.quota_scope
                   OR v_existing_event.user_id IS DISTINCT FROM p_user_id
                   OR v_existing_event.parent_key IS DISTINCT FROM p_parent_key
                   OR v_existing_event.chunk_index IS DISTINCT FROM p_chunk_index
                   OR v_existing_event.total_tokens IS DISTINCT FROM v_existing_attempt.actual_total_tokens
                   OR v_existing_event.prompt_tokens IS DISTINCT FROM v_existing_attempt.actual_prompt_tokens
                   OR v_existing_event.candidate_tokens IS DISTINCT FROM v_existing_attempt.actual_candidate_tokens
                   OR v_existing_event.thoughts_tokens IS DISTINCT FROM v_existing_attempt.actual_thoughts_tokens THEN
                    RAISE EXCEPTION 'CONFLICTING_COMMIT_EVENT: Existing COMMIT event accounting conflicts with attempt'
                        USING ERRCODE = '23505';
                END IF;
            END IF;

            SELECT chunk_id, reservation_token, chunk_notes INTO v_existing_chunk
            FROM public.chunk_generations
            WHERE user_id = p_user_id AND parent_key = p_parent_key AND chunk_index = p_chunk_index
            FOR UPDATE;

            IF FOUND THEN
                IF v_existing_chunk.reservation_token = p_reservation_token THEN
                    -- Check for conflicting payload between attempt and existing chunk
                    IF v_existing_attempt.response_payload IS NOT NULL
                       AND v_existing_chunk.chunk_notes IS NOT NULL
                       AND v_existing_chunk.chunk_notes IS DISTINCT FROM v_existing_attempt.response_payload THEN
                        RAISE EXCEPTION 'CONFLICTING_CHUNK_PAYLOAD: Existing chunk notes conflict with attempt payload'
                            USING ERRCODE = '23505';
                    END IF;
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
            END IF;

            -- Reconcile Reservation and Quota Events
            IF v_existing_attempt.actual_total_tokens IS NOT NULL AND v_existing_attempt.actual_total_tokens <= v_res.estimated_tokens THEN
                v_unconsumed_total := v_res.estimated_tokens - v_existing_attempt.actual_total_tokens;
                v_overage_total := 0;
            ELSIF v_existing_attempt.actual_total_tokens IS NOT NULL THEN
                v_unconsumed_total := 0;
                v_overage_total := v_existing_attempt.actual_total_tokens - v_res.estimated_tokens;
            ELSE
                v_unconsumed_total := 0;
                v_overage_total := 0;
            END IF;

            UPDATE public.rate_limit_reservations
            SET status = 'committed',
                actual_total_tokens = COALESCE(v_existing_attempt.actual_total_tokens, actual_total_tokens),
                actual_prompt_tokens = COALESCE(v_existing_attempt.actual_prompt_tokens, actual_prompt_tokens),
                actual_candidate_tokens = COALESCE(v_existing_attempt.actual_candidate_tokens, actual_candidate_tokens),
                actual_thoughts_tokens = COALESCE(v_existing_attempt.actual_thoughts_tokens, actual_thoughts_tokens),
                unconsumed_total_tokens = v_unconsumed_total,
                overage_total_tokens = v_overage_total,
                committed_at = COALESCE(committed_at, v_now),
                updated_at = v_now
            WHERE reservation_token = p_reservation_token;

            -- Reconcile COMMIT Quota Event if not already present and validated
            IF v_existing_event.event_id IS NULL THEN
                INSERT INTO public.rate_limit_events (
                    project_id, quota_scope, user_id, parent_key, chunk_index,
                    reservation_token, event_type, model_name, worker_id,
                    total_tokens, prompt_tokens, candidate_tokens, thoughts_tokens,
                    payload, created_at
                ) VALUES (
                    v_res.project_id, v_res.quota_scope, p_user_id, p_parent_key, p_chunk_index,
                    p_reservation_token, 'COMMIT', p_model_name, p_worker_id,
                    v_existing_attempt.actual_total_tokens, v_existing_attempt.actual_prompt_tokens,
                    v_existing_attempt.actual_candidate_tokens, v_existing_attempt.actual_thoughts_tokens,
                    jsonb_build_object(
                        'estimated_tokens', v_res.estimated_tokens,
                        'actual_total_tokens', v_existing_attempt.actual_total_tokens,
                        'unconsumed_total_tokens', v_unconsumed_total,
                        'overage_total_tokens', v_overage_total,
                        'thoughts_tokens', v_existing_attempt.actual_thoughts_tokens,
                        'disposition', 'CHUNK_COMMITTED',
                        'adopted', true
                    ),
                    v_now
                );
            END IF;

            IF v_existing_chunk.chunk_id IS NOT NULL THEN
                RETURN QUERY SELECT true, true, 'ADOPTED_EXISTING_CHUNK'::VARCHAR, v_existing_attempt.attempt_id, v_existing_attempt.attempt_number, v_existing_attempt.generation, v_existing_attempt.lease_until, v_existing_attempt.response_payload;
            ELSE
                RETURN QUERY SELECT true, true, 'ADOPTED_AND_RESTORED_CHUNK'::VARCHAR, v_existing_attempt.attempt_id, v_existing_attempt.attempt_number, v_existing_attempt.generation, v_existing_attempt.lease_until, v_existing_attempt.response_payload;
            END IF;
            RETURN;
        END IF;

        -- Case B: Monolithic Generation Adoption
        IF p_operation_type = 'monolithic' THEN
            -- Validate existing COMMIT event BEFORE any mutations
            SELECT * INTO v_existing_event
            FROM public.rate_limit_events
            WHERE reservation_token = p_reservation_token AND event_type = 'COMMIT'
            LIMIT 1;

            IF FOUND THEN
                -- Strictly validate existing COMMIT event identity and accounting using null-safe comparisons
                IF v_existing_event.project_id IS DISTINCT FROM v_res.project_id
                   OR v_existing_event.quota_scope IS DISTINCT FROM v_res.quota_scope
                   OR v_existing_event.user_id IS DISTINCT FROM p_user_id
                   OR v_existing_event.parent_key IS DISTINCT FROM p_parent_key
                   OR v_existing_event.chunk_index IS DISTINCT FROM -1
                   OR v_existing_event.total_tokens IS DISTINCT FROM v_existing_attempt.actual_total_tokens
                   OR v_existing_event.prompt_tokens IS DISTINCT FROM v_existing_attempt.actual_prompt_tokens
                   OR v_existing_event.candidate_tokens IS DISTINCT FROM v_existing_attempt.actual_candidate_tokens
                   OR v_existing_event.thoughts_tokens IS DISTINCT FROM v_existing_attempt.actual_thoughts_tokens THEN
                    RAISE EXCEPTION 'CONFLICTING_COMMIT_EVENT: Existing COMMIT event accounting conflicts with attempt'
                        USING ERRCODE = '23505';
                END IF;
            END IF;

            IF NOT EXISTS (SELECT 1 FROM public.notes WHERE attempt_id = v_existing_attempt.attempt_id) THEN
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
            END IF;

            -- Reconcile monolithic reservation token accounting from attempt authoritative values
            IF v_existing_attempt.actual_total_tokens IS NOT NULL AND v_existing_attempt.actual_total_tokens <= v_res.estimated_tokens THEN
                v_unconsumed_total := v_res.estimated_tokens - v_existing_attempt.actual_total_tokens;
                v_overage_total := 0;
            ELSIF v_existing_attempt.actual_total_tokens IS NOT NULL THEN
                v_unconsumed_total := 0;
                v_overage_total := v_existing_attempt.actual_total_tokens - v_res.estimated_tokens;
            ELSE
                v_unconsumed_total := 0;
                v_overage_total := 0;
            END IF;

            UPDATE public.rate_limit_reservations
            SET status = 'committed',
                actual_total_tokens = COALESCE(v_existing_attempt.actual_total_tokens, actual_total_tokens),
                actual_prompt_tokens = COALESCE(v_existing_attempt.actual_prompt_tokens, actual_prompt_tokens),
                actual_candidate_tokens = COALESCE(v_existing_attempt.actual_candidate_tokens, actual_candidate_tokens),
                actual_thoughts_tokens = COALESCE(v_existing_attempt.actual_thoughts_tokens, actual_thoughts_tokens),
                unconsumed_total_tokens = v_unconsumed_total,
                overage_total_tokens = v_overage_total,
                committed_at = COALESCE(committed_at, v_now),
                updated_at = v_now
            WHERE reservation_token = p_reservation_token;

            -- Reconcile COMMIT Quota Event for Monolithic if not already present and validated
            IF v_existing_event.event_id IS NULL THEN
                INSERT INTO public.rate_limit_events (
                    project_id, quota_scope, user_id, parent_key, chunk_index,
                    reservation_token, event_type, model_name, worker_id,
                    total_tokens, prompt_tokens, candidate_tokens, thoughts_tokens,
                    payload, created_at
                ) VALUES (
                    v_res.project_id, v_res.quota_scope, p_user_id, p_parent_key, -1,
                    p_reservation_token, 'COMMIT', p_model_name, p_worker_id,
                    v_existing_attempt.actual_total_tokens, v_existing_attempt.actual_prompt_tokens,
                    v_existing_attempt.actual_candidate_tokens, v_existing_attempt.actual_thoughts_tokens,
                    jsonb_build_object(
                        'estimated_tokens', v_res.estimated_tokens,
                        'actual_total_tokens', v_existing_attempt.actual_total_tokens,
                        'unconsumed_total_tokens', v_unconsumed_total,
                        'overage_total_tokens', v_overage_total,
                        'thoughts_tokens', v_existing_attempt.actual_thoughts_tokens,
                        'disposition', 'NOTE_COMMITTED',
                        'adopted', true
                    ),
                    v_now
                );
            END IF;

            RETURN QUERY SELECT true, true, 'ADOPTED_MONOLITHIC_NOTE'::VARCHAR, v_existing_attempt.attempt_id, v_existing_attempt.attempt_number, v_existing_attempt.generation, v_existing_attempt.lease_until, v_existing_attempt.response_payload;
            RETURN;
        END IF;

        -- Case C: Synthesis Adoption
        IF p_operation_type = 'synthesis' THEN
            RETURN QUERY SELECT true, true, 'ADOPTED_SYNTHESIS'::VARCHAR, v_existing_attempt.attempt_id, v_existing_attempt.attempt_number, v_existing_attempt.generation, v_existing_attempt.lease_until, v_existing_attempt.response_payload;
            RETURN;
        END IF;
    END IF;

    -- Item 1: Do not permit new dispatch claims against completed parents
    IF v_parent_status = 'completed' THEN
        RETURN QUERY SELECT false, false, 'PARENT_GENERATION_ALREADY_COMPLETED'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    -- If reservation was already committed and no attempt was adopted, reject as terminal:
    IF v_res.status = 'committed' THEN
        RETURN QUERY SELECT false, false, 'RESERVATION_ALREADY_TERMINAL'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
    END IF;

    -- For a new dispatch claim on an active/dispatching reservation, check lease expiry:
    IF v_now > v_res.lease_until THEN
        RETURN QUERY SELECT false, false, 'LEASE_EXPIRED_DURING_EXECUTION'::VARCHAR, NULL::UUID, NULL::INTEGER, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::JSONB;
        RETURN;
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
-- SECTION 3: CANONICAL SETTLEMENT ROUTINE — complete_dispatch_attempt
-- Fully unified, idempotent settlement for:
-- 1. Attempt status, tokens and response_payload
-- 2. Reservation status, actual tokens, unconsumed & overage tokens, committed_at
-- 3. Chunk persistence / reconciliation in chunk_generations
-- 4. COMMIT quota event accounting in rate_limit_events
-- 5. Safe idempotent return on retry without skipping unreconciled records
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
    -- Optional coordinates / monolithic parameters:
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
    v_attempt_id               UUID := p_attempt_id;
    v_attempt                  RECORD;
    v_res                      RECORD;
    v_chunk                    RECORD;
    v_existing_event           RECORD;
    v_parent_status            VARCHAR(20);
    v_new_note_id              UUID;
    v_unconsumed_total         INTEGER;
    v_overage_total            INTEGER;
    v_is_already_completed     BOOLEAN := false;
    v_final_payload            JSONB;
    v_final_total              INTEGER;
    v_final_prompt             INTEGER;
    v_final_candidate          INTEGER;
    v_final_thoughts           INTEGER;
BEGIN
    IF current_setting('role', true) IN ('authenticated', 'anon') OR SESSION_USER IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an authenticated user role context'
            USING ERRCODE = '42501';
    END IF;

    v_now := clock_timestamp();

    -- Lock L1: Parent Idempotency Row
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

    -- Validate Fencing & Lease Ownership
    IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN
        RETURN QUERY SELECT false, 'STALE_LEASE_OWNERSHIP'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.generation IS DISTINCT FROM p_fencing_generation THEN
        RETURN QUERY SELECT false, 'FENCING_GENERATION_MISMATCH'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Validate Reservation Coordinates if provided
    IF (p_user_id IS NOT NULL AND v_res.user_id IS DISTINCT FROM p_user_id)
       OR (p_parent_key IS NOT NULL AND v_res.parent_key IS DISTINCT FROM p_parent_key) THEN
        RETURN QUERY SELECT false, 'RESERVATION_COORDINATE_MISMATCH'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Lock L5: Attempt
    -- If no attempt_id was provided (e.g. legacy wrapper caller), locate or synthesize the attempt
    -- strictly under canonical L1/L4 lock protection
    IF v_attempt_id IS NULL THEN
        -- Check if an attempt already exists for this reservation
        SELECT attempt_id INTO v_attempt_id
        FROM public.rate_limit_dispatch_attempts
        WHERE reservation_token = p_reservation_token
          AND operation_type = p_operation_type
        ORDER BY attempt_number DESC
        LIMIT 1;

        -- If no attempt exists for this legacy reservation, synthesize attempt #1
        IF v_attempt_id IS NULL THEN
            v_attempt_id := gen_random_uuid();
            INSERT INTO public.rate_limit_dispatch_attempts (
                attempt_id, reservation_token, attempt_number, generation, worker_id,
                project_id, quota_scope, operation_type, status, estimated_tokens,
                lease_until, dispatched_at, quota_date_pacific, created_at, updated_at
            ) VALUES (
                v_attempt_id, p_reservation_token, 1, p_fencing_generation, p_worker_id,
                v_res.project_id, v_res.quota_scope, p_operation_type, 'dispatched', v_res.estimated_tokens,
                v_res.lease_until, COALESCE(v_res.dispatching_at, v_now), v_res.quota_date_pacific, v_now, v_now
            )
            ON CONFLICT (reservation_token, attempt_number) DO NOTHING;

            -- Re-query to converge on whichever attempt won the insert
            SELECT attempt_id INTO v_attempt_id
            FROM public.rate_limit_dispatch_attempts
            WHERE reservation_token = p_reservation_token
              AND attempt_number = 1;
        END IF;
    END IF;

    SELECT * INTO v_attempt
    FROM public.rate_limit_dispatch_attempts
    WHERE attempt_id = v_attempt_id AND reservation_token = p_reservation_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'ATTEMPT_NOT_FOUND'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_attempt.operation_type IS DISTINCT FROM p_operation_type THEN
        RETURN QUERY SELECT false, 'OPERATION_TYPE_MISMATCH'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Validate attempt coordinates against reservation
    -- Note: rate_limit_dispatch_attempts contains reservation_token, operation_type, project_id, and quota_scope.
    -- user_id, parent_key, and chunk_index exist on rate_limit_reservations.
    IF v_attempt.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_attempt.project_id IS DISTINCT FROM v_res.project_id
       OR v_attempt.quota_scope IS DISTINCT FROM v_res.quota_scope THEN
        RETURN QUERY SELECT false, 'ATTEMPT_COORDINATE_MISMATCH'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Terminal state verification: Prevent overwriting settled_failure or failed_output
    IF v_res.status IN ('settled_failure', 'released', 'reconciled_zero_usage', 'expired_day_boundary')
       OR v_attempt.status IN ('failed_output', 'superseded') THEN
        RETURN QUERY SELECT false, 'ATTEMPT_ALREADY_TERMINAL'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Item 3: Handle an attempt already marked completed even if its reservation is not yet committed
    IF v_attempt.status IN ('completed', 'adopted') THEN
        v_is_already_completed := true;
    END IF;

    -- Item 2: Separate adoption of immutable completed work from completion of unfinished work.
    -- For an UNFINISHED attempt:
    -- - The worker completing it MUST have valid lease ownership on the attempt: worker_id = p_worker_id.
    -- - The generation MUST match: generation = p_fencing_generation.
    -- - The lease MUST NOT be expired.
    -- A new worker cannot complete an unfinished attempt without valid current lease ownership and fencing.
    IF NOT v_is_already_completed THEN
        IF v_attempt.worker_id IS DISTINCT FROM p_worker_id THEN
            RETURN QUERY SELECT false, 'STALE_LEASE_OWNERSHIP'::VARCHAR, NULL::TIMESTAMPTZ;
            RETURN;
        END IF;

        IF v_attempt.generation IS DISTINCT FROM p_fencing_generation THEN
            RETURN QUERY SELECT false, 'FENCING_GENERATION_MISMATCH'::VARCHAR, NULL::TIMESTAMPTZ;
            RETURN;
        END IF;

        IF v_now > v_res.lease_until OR v_now > v_attempt.lease_until THEN
            RETURN QUERY SELECT false, 'LEASE_EXPIRED_DURING_EXECUTION'::VARCHAR, NULL::TIMESTAMPTZ;
            RETURN;
        END IF;
    END IF;

    -- Item 3: Use the attempt's persisted response payload and actual token counters as authoritative.
    -- Reject conflicting incoming payloads or token counts.
    IF v_attempt.response_payload IS NOT NULL AND p_response_payload IS NOT NULL
       AND v_attempt.response_payload IS DISTINCT FROM p_response_payload THEN
        RETURN QUERY SELECT false, 'CONFLICTING_ATTEMPT_PAYLOAD'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_attempt.actual_total_tokens IS NOT NULL AND p_total_tokens IS NOT NULL
       AND v_attempt.actual_total_tokens <> p_total_tokens THEN
        RETURN QUERY SELECT false, 'CONFLICTING_TOKEN_COUNT'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_attempt.actual_prompt_tokens IS NOT NULL AND p_prompt_tokens IS NOT NULL
       AND v_attempt.actual_prompt_tokens <> p_prompt_tokens THEN
        RETURN QUERY SELECT false, 'CONFLICTING_TOKEN_COUNT'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_attempt.actual_candidate_tokens IS NOT NULL AND p_candidate_tokens IS NOT NULL
       AND v_attempt.actual_candidate_tokens <> p_candidate_tokens THEN
        RETURN QUERY SELECT false, 'CONFLICTING_TOKEN_COUNT'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_attempt.actual_thoughts_tokens IS NOT NULL AND p_thoughts_tokens IS NOT NULL
       AND v_attempt.actual_thoughts_tokens <> p_thoughts_tokens THEN
        RETURN QUERY SELECT false, 'CONFLICTING_TOKEN_COUNT'::VARCHAR, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Authoritative values: persist existing attempt values; only fallback to incoming parameters if null
    v_final_payload   := COALESCE(v_attempt.response_payload, p_response_payload);
    v_final_total     := COALESCE(v_attempt.actual_total_tokens, p_total_tokens);
    v_final_prompt    := COALESCE(v_attempt.actual_prompt_tokens, p_prompt_tokens);
    v_final_candidate := COALESCE(v_attempt.actual_candidate_tokens, p_candidate_tokens);
    v_final_thoughts  := COALESCE(v_attempt.actual_thoughts_tokens, p_thoughts_tokens);

    -- Calculate token overage and unconsumed hold using authoritative total tokens
    IF v_final_total IS NOT NULL AND v_final_total <= v_res.estimated_tokens THEN
        v_unconsumed_total := v_res.estimated_tokens - v_final_total;
        v_overage_total := 0;
    ELSIF v_final_total IS NOT NULL THEN
        v_unconsumed_total := 0;
        v_overage_total := v_final_total - v_res.estimated_tokens;
    ELSE
        v_unconsumed_total := 0;
        v_overage_total := 0;
    END IF;

    -- Lock & Validate Existing Quota Event (COMMIT) strictly BEFORE any settlement mutations
    SELECT * INTO v_existing_event
    FROM public.rate_limit_events
    WHERE reservation_token = p_reservation_token AND event_type = 'COMMIT'
    LIMIT 1;

    IF FOUND THEN
        -- Strictly validate existing COMMIT event identity and accounting using null-safe comparisons
        IF v_existing_event.project_id IS DISTINCT FROM v_res.project_id
           OR v_existing_event.quota_scope IS DISTINCT FROM v_res.quota_scope
           OR v_existing_event.user_id IS DISTINCT FROM v_res.user_id
           OR v_existing_event.parent_key IS DISTINCT FROM v_res.parent_key
           OR v_existing_event.chunk_index IS DISTINCT FROM v_res.chunk_index
           OR v_existing_event.total_tokens IS DISTINCT FROM v_final_total
           OR v_existing_event.prompt_tokens IS DISTINCT FROM v_final_prompt
           OR v_existing_event.candidate_tokens IS DISTINCT FROM v_final_candidate
           OR v_existing_event.thoughts_tokens IS DISTINCT FROM v_final_thoughts THEN
            RAISE EXCEPTION 'CONFLICTING_COMMIT_EVENT: Existing COMMIT event accounting conflicts with attempt'
                USING ERRCODE = '23505';
        END IF;
    END IF;

    -- =========================================================================
    -- OPERATION-SPECIFIC PERSISTENCE & STATE HARMONIZATION
    -- =========================================================================
    IF p_operation_type = 'chunk' THEN
        -- Lock L6: Chunk Generations row if exists
        SELECT * INTO v_chunk
        FROM public.chunk_generations
        WHERE user_id = v_res.user_id AND parent_key = v_res.parent_key AND chunk_index = v_res.chunk_index
        FOR UPDATE;

        IF v_chunk.chunk_id IS NOT NULL THEN
            IF v_chunk.reservation_token IS DISTINCT FROM p_reservation_token THEN
                RETURN QUERY SELECT false, 'CONFLICTING_RESERVATION_COMPLETION'::VARCHAR, NULL::TIMESTAMPTZ;
                RETURN;
            END IF;

            -- Ensure chunk payload is not conflicting with authoritative payload
            IF v_chunk.chunk_notes IS NOT NULL AND v_final_payload IS NOT NULL
               AND v_chunk.chunk_notes IS DISTINCT FROM v_final_payload THEN
                RETURN QUERY SELECT false, 'CONFLICTING_CHUNK_PAYLOAD'::VARCHAR, NULL::TIMESTAMPTZ;
                RETURN;
            END IF;

            -- Reconcile / update chunk, preserving existing chunk_notes if already present
            UPDATE public.chunk_generations
            SET status = 'completed',
                model_name = p_model_name,
                total_tokens = COALESCE(v_final_total, total_tokens),
                prompt_tokens = COALESCE(v_final_prompt, prompt_tokens),
                candidate_tokens = COALESCE(v_final_candidate, candidate_tokens),
                thoughts_tokens = COALESCE(v_final_thoughts, thoughts_tokens),
                chunk_notes = COALESCE(v_chunk.chunk_notes, v_final_payload),
                completed_at = COALESCE(completed_at, v_now)
            WHERE chunk_id = v_chunk.chunk_id;
        ELSE
            -- Insert missing chunk
            INSERT INTO public.chunk_generations (
                chunk_id, user_id, parent_key, chunk_index, reservation_token,
                status, chunk_notes, completed_at, total_tokens, prompt_tokens,
                candidate_tokens, thoughts_tokens, model_name
            ) VALUES (
                gen_random_uuid(), v_res.user_id, v_res.parent_key, v_res.chunk_index, p_reservation_token,
                'completed', v_final_payload, v_now,
                v_final_total, v_final_prompt, v_final_candidate, v_final_thoughts, p_model_name
            );
        END IF;

    ELSIF p_operation_type = 'monolithic' THEN
        IF NOT EXISTS (SELECT 1 FROM public.notes WHERE attempt_id = v_attempt_id) THEN
            v_new_note_id := gen_random_uuid();
            INSERT INTO public.notes (
                id, user_id, parent_key, attempt_id, video_id, video_title, video_url,
                thumbnail_url, overview, key_concepts, detailed_notes, shorthands
            ) VALUES (
                v_new_note_id, v_res.user_id, v_res.parent_key, v_attempt_id,
                COALESCE(p_video_id, v_final_payload->>'videoId'),
                COALESCE(p_video_title, v_final_payload->>'videoTitle'),
                COALESCE(p_video_url, v_final_payload->>'videoUrl'),
                COALESCE(p_thumbnail_url, v_final_payload->>'thumbnailUrl'),
                v_final_payload->>'overview',
                ARRAY(SELECT jsonb_array_elements_text(v_final_payload->'keyConcepts')),
                v_final_payload->>'detailedNotes',
                ARRAY(SELECT jsonb_array_elements_text(v_final_payload->'shorthands'))
            );

            UPDATE public.generation_idempotency
            SET status = 'completed',
                note_id = v_new_note_id,
                lease_until = NULL,
                updated_at = v_now
            WHERE user_id = v_res.user_id AND key = v_res.parent_key;
        END IF;
    END IF;

    -- Atomic Attempt Update: Preserve existing historical attempt identity (worker_id, generation, attempt_number)
    UPDATE public.rate_limit_dispatch_attempts
    SET status = 'completed',
        response_payload = v_final_payload,
        actual_total_tokens = v_final_total,
        actual_prompt_tokens = v_final_prompt,
        actual_candidate_tokens = v_final_candidate,
        actual_thoughts_tokens = v_final_thoughts,
        completed_at = COALESCE(completed_at, v_now),
        updated_at = v_now
    WHERE attempt_id = v_attempt_id;

    -- Atomic Reservation Update: Commit reservation with authoritative accounting
    UPDATE public.rate_limit_reservations
    SET status = 'committed',
        actual_total_tokens = v_final_total,
        actual_prompt_tokens = v_final_prompt,
        actual_candidate_tokens = v_final_candidate,
        actual_thoughts_tokens = v_final_thoughts,
        unconsumed_total_tokens = v_unconsumed_total,
        overage_total_tokens = v_overage_total,
        committed_at = COALESCE(committed_at, v_now),
        updated_at = v_now
    WHERE reservation_token = p_reservation_token;

    -- Atomic Quota Event (COMMIT): insert only if not already present and validated
    IF v_existing_event.event_id IS NULL THEN
        INSERT INTO public.rate_limit_events (
            project_id, quota_scope, user_id, parent_key, chunk_index,
            reservation_token, event_type, model_name, worker_id,
            total_tokens, prompt_tokens, candidate_tokens, thoughts_tokens,
            payload, created_at
        ) VALUES (
            v_res.project_id, v_res.quota_scope, v_res.user_id, v_res.parent_key, v_res.chunk_index,
            p_reservation_token, 'COMMIT', p_model_name, p_worker_id,
            v_final_total, v_final_prompt, v_final_candidate, v_final_thoughts,
            jsonb_build_object(
                'estimated_tokens', v_res.estimated_tokens,
                'actual_total_tokens', v_final_total,
                'unconsumed_total_tokens', v_unconsumed_total,
                'overage_total_tokens', v_overage_total,
                'thoughts_tokens', v_final_thoughts,
                'disposition', CASE WHEN p_operation_type = 'chunk' THEN 'CHUNK_COMMITTED' ELSE 'NOTE_COMMITTED' END
            ),
            v_now
        );
    END IF;

    IF v_is_already_completed THEN
        RETURN QUERY SELECT true, 'ALREADY_COMPLETED'::VARCHAR, COALESCE(v_attempt.completed_at, v_now);
    ELSE
        RETURN QUERY SELECT true, 'SUCCESS'::VARCHAR, v_now;
    END IF;
    RETURN;
END;
$$;


-- -----------------------------------------------------------------------------
-- SECTION 4: UNIFIED ROUTINE — complete_chunk_and_commit_quota
-- Bridges callers of complete_chunk_and_commit_quota to canonical settlement
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_chunk_and_commit_quota(
    p_user_id              UUID,
    p_parent_key           VARCHAR,
    p_chunk_index          INTEGER,
    p_reservation_token    UUID,
    p_lease_token          UUID,
    p_worker_id            VARCHAR,
    p_fencing_generation   INTEGER,
    p_chunk_notes          JSONB,
    p_total_tokens         INTEGER,
    p_prompt_tokens        INTEGER,
    p_candidate_tokens     INTEGER,
    p_thoughts_tokens      INTEGER,
    p_model_name           VARCHAR
)
RETURNS TABLE (
    success                BOOLEAN,
    status_code            TEXT,
    committed_at           TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_comp_res             RECORD;
BEGIN
    -- Route directly to canonical complete_dispatch_attempt with NULL attempt_id.
    -- Canonical routine will acquire L1 and L4 locks before discovering or synthesizing
    -- the dispatch attempt in strict lock hierarchy (L1 -> L4 -> L5).
    SELECT * INTO v_comp_res
    FROM public.complete_dispatch_attempt(
        NULL,
        p_reservation_token,
        p_lease_token,
        p_worker_id,
        p_fencing_generation,
        'chunk',
        p_chunk_notes,
        p_total_tokens,
        p_prompt_tokens,
        p_candidate_tokens,
        p_thoughts_tokens,
        p_model_name,
        p_user_id,
        p_parent_key
    );

    RETURN QUERY SELECT v_comp_res.success, v_comp_res.status_code::TEXT, v_comp_res.completed_at;
    RETURN;
END;
$$;

-- Grant execute privileges with explicit, unambiguous parameter signatures
GRANT EXECUTE ON FUNCTION public.claim_or_adopt_dispatch_slot(
    UUID, VARCHAR, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL
) TO service_role;

GRANT EXECUTE ON FUNCTION public.complete_dispatch_attempt(
    UUID, UUID, UUID, VARCHAR, INTEGER, VARCHAR, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, UUID, VARCHAR, VARCHAR, TEXT, TEXT, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION public.complete_chunk_and_commit_quota(
    UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR
) TO service_role;

-- Set routine ownership with explicit parameter signatures
ALTER FUNCTION public.claim_or_adopt_dispatch_slot(
    UUID, VARCHAR, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL
) OWNER TO codenotes_definer;

ALTER FUNCTION public.complete_dispatch_attempt(
    UUID, UUID, UUID, VARCHAR, INTEGER, VARCHAR, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR, UUID, VARCHAR, VARCHAR, TEXT, TEXT, TEXT
) OWNER TO codenotes_definer;

ALTER FUNCTION public.complete_chunk_and_commit_quota(
    UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR
) OWNER TO codenotes_definer;

COMMIT;
