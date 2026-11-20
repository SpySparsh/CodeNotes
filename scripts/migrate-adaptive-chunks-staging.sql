-- =============================================================================
-- Migration: scripts/migrate-adaptive-chunks-staging.sql
-- Architecture: CodeNotes Adaptive Long-Video Note Generation (Production Staging)
-- Phase: 1U — Close Remaining Catalog Validation False-Pass Paths
-- Engine: PostgreSQL 15+ (Compatible with Supabase / AWS RDS / Self-Hosted Postgres)
-- Safety: Fully transactional (BEGIN ... COMMIT); Advisory lock; Idempotent DDL/DML;
--         Rolls back completely on any preflight failure or constraint violation.
--
-- WORKSTREAM REMEDIATION SUMMARY (PHASE 1U CATALOG VALIDATION HARDENING):
-- 1. Complete Check-Constraint Expression Validation (Finding 1):
--    - Replaced prefix-only checks with complete end-to-end expressions (^...$) for all 26 check constraints.
--    - Explicitly rejects unexpected suffixes (IS NULL, IS NOT NULL), casts, logical branches (OR, AND),
--      and operators across all 26 constraints, completely closing false-pass mutations like (status IN (...)) IS NOT NULL
--      or (max_rpm > 0 OR true).
-- 2. Complete Partial-Index Predicate Validation (Finding 2):
--    - Replaced prefix-only predicate matching with complete end-to-end anchored validation (^...$) for both
--      partial unique indexes (idx_reservations_active_unique and idx_reconciliation_auth_active_unique).
--    - Explicitly rejects IS NULL, IS NOT NULL, and unauthorized conjunctions/disjunctions/inequalities,
--      preserving canonical active reservation statuses and the ACTIVE ticket predicate.
--    - Retains tri-state index validity verification (indisvalid, indisready, indislive).
-- 3. Comprehensive RLS Policy Inventory & Definer Isolation (Finding 3):
--    - Replaced name-filtered counts with an unrestricted inventory check enforcing exactly 5 policies total
--      across the 5 new adaptive tables (strictly 1 definer policy per relation, rejecting any unexpected policy with any name).
--    - Explicitly inspects all 6 relations to reject any permissive policy granted to PUBLIC (grantee OID 0).
--    - Respects and preserves legitimate pre-existing application policies on public.generation_idempotency
--      while validating p_codenotes_definer_parent and FORCE RLS requirements.
-- 4. Complete Invariant Preservation:
--    - Retains 100% of Phase 1K–1T invariants: universal lock hierarchy, lease fencing, single atomic transaction,
--      upgrade-safe 15-minute ticket default, and definer least-privilege security model.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- SECTION 1: TRANSACTION-SCOPED ADVISORY MIGRATION LOCK
-- -----------------------------------------------------------------------------
-- Preempts concurrent migration runners using a unique 64-bit advisory lock key.
SELECT pg_advisory_xact_lock(849204859284729104);

-- -----------------------------------------------------------------------------
-- SECTION 2: DEDICATED FUNCTION-OWNER ROLE & SAFE OWNERSHIP PREVALIDATION (DEF-1 & DEF-2)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_is_super BOOLEAN;
    v_has_membership BOOLEAN;
BEGIN
    -- 1. DEF-2: Validate migration executor authority on schema public
    IF NOT has_schema_privilege(CURRENT_USER, 'public', 'CREATE') THEN
        RAISE EXCEPTION 'PREFLIGHT_FAILED: Migration executor "%" lacks CREATE privilege on schema public.' , CURRENT_USER
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(rolsuper, false) INTO v_is_super FROM pg_roles WHERE rolname = CURRENT_USER;

    -- 2. DEF-1 & DEF-2: Manage dedicated non-login function owner role with deterministic attributes
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'codenotes_definer') THEN
        CREATE ROLE codenotes_definer WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
    ELSE
        -- Fail closed if pre-existing role has unsafe attributes or bypassrls
        IF EXISTS (
            SELECT 1 FROM pg_roles 
            WHERE rolname = 'codenotes_definer' 
              AND (rolcanlogin = true OR rolsuper = true OR rolcreaterole = true OR rolcreatedb = true OR rolbypassrls = true)
        ) THEN
            RAISE EXCEPTION 'PREFLIGHT_FAILED: Pre-existing role codenotes_definer has unsafe attributes (canlogin, superuser, createrole, createdb, or bypassrls).'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- Enforce NOBYPASSRLS deterministically across all environments (managed and self-hosted)
    ALTER ROLE codenotes_definer NOBYPASSRLS;

    -- 3. DEF-2: Genuinely prevalidate and grant role membership to migration executor without blanket suppression
    v_has_membership := pg_has_role(CURRENT_USER, 'codenotes_definer', 'MEMBER');

    IF NOT v_has_membership AND NOT v_is_super THEN
        -- Non-superusers require explicit role membership to execute ALTER FUNCTION ... OWNER TO
        EXECUTE format('GRANT codenotes_definer TO %I', CURRENT_USER);

        -- Immediately re-verify effective membership
        IF NOT pg_has_role(CURRENT_USER, 'codenotes_definer', 'MEMBER') THEN
            RAISE EXCEPTION 'PREFLIGHT_FAILED: Migration executor "%" could not obtain effective membership in role codenotes_definer.', CURRENT_USER
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- 4. DEF-2 & DEF-3: Validate migration executor authority over exact target routine identities
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        WHERE p.oid = ANY(ARRAY[
            'public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL)'::regprocedure,
            'public.mark_reservation_dispatching(UUID, UUID, VARCHAR, INTEGER, INTERVAL)'::regprocedure,
            'public.complete_chunk_and_commit_quota(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR)'::regprocedure,
            'public.renew_uncertain_lease(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, INTERVAL)'::regprocedure,
            'public.release_quota_reservation(UUID, UUID, VARCHAR, INTEGER)'::regprocedure,
            'public.release_aborted_dispatch(UUID, UUID, VARCHAR, INTEGER, TEXT)'::regprocedure,
            'public.reconcile_stale_reservations(INTEGER)'::regprocedure,
            'public.reconcile_day_boundary_rollover(INTEGER)'::regprocedure,
            'public.reconcile_uncertain_zero_usage(UUID, UUID, VARCHAR, TEXT)'::regprocedure,
            'public.create_reconciliation_authorization(UUID, VARCHAR, TEXT, VARCHAR)'::regprocedure,
            'public.revoke_reconciliation_authorization(UUID, TEXT)'::regprocedure
        ])
        AND NOT pg_has_role(CURRENT_USER, p.proowner, 'MEMBER')
        AND NOT v_is_super
    ) THEN
        RAISE EXCEPTION 'PREFLIGHT_FAILED: Migration executor "%" lacks ownership authority over one or more existing target routines in schema public.', CURRENT_USER
            USING ERRCODE = '42501';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- SECTION 3: DEFENSIVE ENVIRONMENT & PREFLIGHT VALIDATION GATES
-- -----------------------------------------------------------------------------
-- Gate 1: Role Existence Check (service_role and service_role_admin)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        RAISE EXCEPTION 'PREFLIGHT_FAILED: Required application role "service_role" does not exist.' 
            USING ERRCODE = '42883';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role_admin') THEN
        RAISE EXCEPTION 'PREFLIGHT_FAILED: Required administrative role "service_role_admin" does not exist.' 
            USING ERRCODE = '42883';
    END IF;
END $$;

-- Gate 2: Parent Schema Prerequisite Validation (Exact Ordered Composite Key & Forced RLS)
DO $$
DECLARE
    v_has_ordered_key BOOLEAN := FALSE;
    v_con RECORD;
    v_col1 NAME;
    v_col2 NAME;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'generation_idempotency'
    ) THEN
        RAISE EXCEPTION 'PREFLIGHT_FAILED: Missing prerequisite table "public.generation_idempotency". Cannot proceed.' 
            USING ERRCODE = '42P01';
    END IF;

    -- DEF-1: Validate parent table's actual RLS enabled and forced state
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'generation_idempotency'
          AND c.relrowsecurity = TRUE AND c.relforcerowsecurity = TRUE
    ) THEN
        RAISE EXCEPTION 'PREFLIGHT_FAILED: public.generation_idempotency must have ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY enabled.'
            USING ERRCODE = '42501';
    END IF;

    FOR v_con IN
        SELECT conkey, conrelid
        FROM pg_constraint
        WHERE conrelid = 'public.generation_idempotency'::regclass
          AND contype IN ('p', 'u')
          AND array_length(conkey, 1) = 2
    LOOP
        SELECT attname INTO v_col1 FROM pg_attribute WHERE attrelid = v_con.conrelid AND attnum = v_con.conkey[1];
        SELECT attname INTO v_col2 FROM pg_attribute WHERE attrelid = v_con.conrelid AND attnum = v_con.conkey[2];
        IF v_col1 = 'user_id' AND v_col2 = 'key' THEN
            v_has_ordered_key := TRUE;
            EXIT;
        END IF;
    END LOOP;

    IF NOT v_has_ordered_key THEN
        RAISE EXCEPTION 'PREFLIGHT_FAILED: public.generation_idempotency lacks exact ordered unique/primary key (user_id, key).'
            USING ERRCODE = '42P16';
    END IF;
END $$;

-- Gate 3: Model Configuration Precondition Check
DO $$
DECLARE
    v_server_version INTEGER;
BEGIN
    SELECT current_setting('server_version_num')::INTEGER INTO v_server_version;
    IF v_server_version < 150000 THEN
        RAISE EXCEPTION 'PREFLIGHT_FAILED: PostgreSQL 15.0 or greater is required. Detected version: %', v_server_version 
            USING ERRCODE = '0A000';
    END IF;
END $$;

-- Gate 4: Search Path Sanitization
SET search_path = pg_catalog, public;

-- Gate 5: Active Transaction Verification
DO $$
BEGIN
    IF txid_current() IS NULL THEN
        RAISE EXCEPTION 'PREFLIGHT_FAILED: Migration must run inside an active transaction block.' 
            USING ERRCODE = '25001';
    END IF;
END $$;

-- Gate 6: Comprehensive Adaptive Schema Preflight & Partial Table Compatibility Validation
DO $$
DECLARE
    v_c_null TEXT;
BEGIN
    -- 1. Check public.project_quota_configs
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'project_quota_configs') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'project_quota_configs' AND column_name = 'project_id' AND data_type = 'character varying' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'project_quota_configs' AND column_name = 'quota_scope' AND data_type = 'character varying' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'project_quota_configs' AND column_name = 'max_active_dispatches' AND data_type = 'integer' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'project_quota_configs' AND column_name = 'max_rpm' AND data_type = 'integer' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'project_quota_configs' AND column_name = 'max_tpm' AND data_type = 'integer' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'project_quota_configs' AND column_name = 'max_rpd' AND data_type = 'integer' AND is_nullable = 'NO') THEN
            RAISE EXCEPTION 'PREFLIGHT_FAILED: Existing public.project_quota_configs lacks required columns, types, or NOT NULL constraints.' USING ERRCODE = '42703';
        END IF;
    END IF;

    -- 2. Check public.rate_limit_reservations
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'reservation_token' AND data_type = 'uuid' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'project_id' AND data_type = 'character varying' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'quota_scope' AND data_type = 'character varying' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'user_id' AND data_type = 'uuid' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'parent_key' AND data_type = 'character varying' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'chunk_index' AND data_type = 'integer' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'lease_token' AND data_type = 'uuid' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'worker_id' AND data_type = 'character varying' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'generation' AND data_type = 'integer' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'status' AND data_type = 'character varying' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'estimated_tokens' AND data_type = 'integer' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'lease_until' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_reservations' AND column_name = 'created_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO') THEN
            RAISE EXCEPTION 'PREFLIGHT_FAILED: Existing public.rate_limit_reservations lacks required adaptive columns or exact data types.' USING ERRCODE = '42703';
        END IF;
    END IF;

    -- 3. Check public.rate_limit_events
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'rate_limit_events') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_events' AND column_name = 'event_id' AND data_type = 'uuid' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_events' AND column_name = 'project_id' AND data_type = 'character varying' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_events' AND column_name = 'reservation_token' AND data_type = 'uuid' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_events' AND column_name = 'event_type' AND data_type = 'character varying' AND is_nullable = 'NO') THEN
            RAISE EXCEPTION 'PREFLIGHT_FAILED: Existing public.rate_limit_events lacks required adaptive audit columns or exact data types.' USING ERRCODE = '42703';
        END IF;

        -- Ensure token fields are nullable to support administrative waiver and release events
        SELECT is_nullable INTO v_c_null FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'rate_limit_events' AND column_name = 'total_tokens';
        IF v_c_null IS NOT NULL AND v_c_null <> 'YES' THEN
            ALTER TABLE public.rate_limit_events ALTER COLUMN total_tokens DROP NOT NULL;
        END IF;

        SELECT is_nullable INTO v_c_null FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'rate_limit_events' AND column_name = 'prompt_tokens';
        IF v_c_null IS NOT NULL AND v_c_null <> 'YES' THEN
            ALTER TABLE public.rate_limit_events ALTER COLUMN prompt_tokens DROP NOT NULL;
        END IF;

        SELECT is_nullable INTO v_c_null FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'rate_limit_events' AND column_name = 'candidate_tokens';
        IF v_c_null IS NOT NULL AND v_c_null <> 'YES' THEN
            ALTER TABLE public.rate_limit_events ALTER COLUMN candidate_tokens DROP NOT NULL;
        END IF;

        -- Explicit migration / check for thoughts_tokens in rate_limit_events
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rate_limit_events' AND column_name = 'thoughts_tokens') THEN
            ALTER TABLE public.rate_limit_events ADD COLUMN thoughts_tokens INTEGER CHECK (thoughts_tokens IS NULL OR thoughts_tokens >= 0);
        ELSE
            SELECT is_nullable INTO v_c_null FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'rate_limit_events' AND column_name = 'thoughts_tokens';
            IF v_c_null IS NOT NULL AND v_c_null <> 'YES' THEN
                ALTER TABLE public.rate_limit_events ALTER COLUMN thoughts_tokens DROP NOT NULL;
            END IF;
        END IF;
    END IF;

    -- 4. Check public.chunk_generations
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'chunk_generations') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chunk_generations' AND column_name = 'chunk_id' AND data_type = 'uuid' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chunk_generations' AND column_name = 'user_id' AND data_type = 'uuid' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chunk_generations' AND column_name = 'parent_key' AND data_type = 'character varying' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chunk_generations' AND column_name = 'chunk_index' AND data_type = 'integer' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chunk_generations' AND column_name = 'reservation_token' AND data_type = 'uuid' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chunk_generations' AND column_name = 'status' AND data_type = 'character varying' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chunk_generations' AND column_name = 'chunk_notes' AND data_type = 'jsonb')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chunk_generations' AND column_name = 'completed_at' AND data_type = 'timestamp with time zone') THEN
            RAISE EXCEPTION 'PREFLIGHT_FAILED: Existing public.chunk_generations lacks required adaptive columns or exact data types.' USING ERRCODE = '42703';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chunk_generations' AND column_name = 'thoughts_tokens') THEN
            ALTER TABLE public.chunk_generations ADD COLUMN thoughts_tokens INTEGER CHECK (thoughts_tokens IS NULL OR thoughts_tokens >= 0);
        END IF;
    END IF;

    -- 5. Check public.reconciliation_authorizations
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'reconciliation_authorizations') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reconciliation_authorizations' AND column_name = 'ticket_id' AND data_type = 'uuid' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reconciliation_authorizations' AND column_name = 'reservation_token' AND data_type = 'uuid' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reconciliation_authorizations' AND column_name = 'authorized_by' AND data_type = 'character varying' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reconciliation_authorizations' AND column_name = 'justification' AND data_type = 'text' AND is_nullable = 'NO')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reconciliation_authorizations' AND column_name = 'external_audit_ref' AND data_type = 'character varying' AND is_nullable = 'NO') THEN
            RAISE EXCEPTION 'PREFLIGHT_FAILED: Existing public.reconciliation_authorizations lacks required ticket columns, exact data types, or NOT NULL constraints.' USING ERRCODE = '42703';
        END IF;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- SECTION 4: CONFIGURABLE PROJECT QUOTA LIMITS (FAIL-CLOSED)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_quota_configs (
    project_id            VARCHAR(64)              NOT NULL,
    quota_scope           VARCHAR(64)              NOT NULL,
    max_active_dispatches INTEGER                  NOT NULL CHECK (max_active_dispatches > 0),
    max_rpm               INTEGER                  NOT NULL CHECK (max_rpm > 0),
    max_tpm               INTEGER                  NOT NULL CHECK (max_tpm > 0),
    max_rpd               INTEGER                  NOT NULL CHECK (max_rpd > 0),
    updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_project_quota_configs PRIMARY KEY (project_id, quota_scope)
);

-- Seed configuration matching CodeNotes application project IDs ('codenotes', 'default', 'codenotes-default')
-- and production model: gemini-2.5-flash.
INSERT INTO public.project_quota_configs (project_id, quota_scope, max_active_dispatches, max_rpm, max_tpm, max_rpd)
VALUES 
    ('codenotes', 'global', 10, 15, 1000000, 1500),
    ('codenotes', 'gemini-2.5-flash', 10, 15, 1000000, 1500),
    ('codenotes', 'models/gemini-2.5-flash', 10, 15, 1000000, 1500),
    ('default', 'global', 10, 15, 1000000, 1500),
    ('default', 'gemini-2.5-flash', 10, 15, 1000000, 1500),
    ('default', 'models/gemini-2.5-flash', 10, 15, 1000000, 1500),
    ('codenotes-default', 'global', 10, 15, 1000000, 1500),
    ('codenotes-default', 'gemini-2.5-flash', 10, 15, 1000000, 1500),
    ('codenotes-default', 'models/gemini-2.5-flash', 10, 15, 1000000, 1500)
ON CONFLICT (project_id, quota_scope) DO NOTHING;

-- -----------------------------------------------------------------------------
-- SECTION 5: TABLE DDL — RATE LIMIT RESERVATIONS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rate_limit_reservations (
    reservation_token           UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id                  VARCHAR(64)              NOT NULL,
    quota_scope                 VARCHAR(64)              NOT NULL,
    user_id                     UUID                     NOT NULL,
    parent_key                  VARCHAR(64)              NOT NULL,
    chunk_index                 INTEGER                  NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 100),
    model_name                  VARCHAR(64)              NOT NULL,
    lease_token                 UUID                     NOT NULL DEFAULT gen_random_uuid(),
    worker_id                   VARCHAR(255)             NOT NULL,
    generation                  INTEGER                  NOT NULL DEFAULT 1 CHECK (generation >= 1),
    status                      VARCHAR(30)              NOT NULL DEFAULT 'active',
    estimated_tokens            INTEGER                  NOT NULL CHECK (estimated_tokens > 0),
    actual_total_tokens         INTEGER                  CHECK (actual_total_tokens IS NULL OR actual_total_tokens >= 0),
    actual_prompt_tokens        INTEGER                  CHECK (actual_prompt_tokens IS NULL OR actual_prompt_tokens >= 0),
    actual_candidate_tokens     INTEGER                  CHECK (actual_candidate_tokens IS NULL OR actual_candidate_tokens >= 0),
    actual_thoughts_tokens      INTEGER                  CHECK (actual_thoughts_tokens IS NULL OR actual_thoughts_tokens >= 0),
    unconsumed_total_tokens     INTEGER                  CHECK (unconsumed_total_tokens IS NULL OR unconsumed_total_tokens >= 0),
    overage_total_tokens        INTEGER                  CHECK (overage_total_tokens IS NULL OR overage_total_tokens >= 0),
    lease_until                 TIMESTAMP WITH TIME ZONE NOT NULL,
    dispatching_at              TIMESTAMP WITH TIME ZONE,
    dispatched_at               TIMESTAMP WITH TIME ZONE,
    uncertain_at                TIMESTAMP WITH TIME ZONE,
    committed_at                TIMESTAMP WITH TIME ZONE,
    released_at                 TIMESTAMP WITH TIME ZONE,
    reconciled_at               TIMESTAMP WITH TIME ZONE,
    reconcile_reason            TEXT,
    reconcile_evidence          JSONB,
    reconcile_source            VARCHAR(30),
    quota_date_pacific          DATE                     NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date),
    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_reservation_parent_generation
        FOREIGN KEY (user_id, parent_key)
        REFERENCES public.generation_idempotency(user_id, key)
        ON DELETE RESTRICT,

    CONSTRAINT chk_reservation_status CHECK (
        status IN (
            'active',
            'dispatching',
            'dispatched',
            'uncertain',
            'committed',
            'released',
            'expired_day_boundary',
            'reconciled_zero_usage'
        )
    )
);

-- DEF-5: Detect and migrate old unconditional reservation uniqueness constraint/index
ALTER TABLE public.rate_limit_reservations DROP CONSTRAINT IF EXISTS uq_reservation_parent_chunk;
DROP INDEX IF EXISTS public.uq_reservation_parent_chunk;
DROP INDEX IF EXISTS public.idx_reservations_active_unique;

-- DEF-5: Partial unique index strictly preventing duplicate active/in-flight/committed executions
-- while safely permitting subsequent retries when previous attempts reached terminal states (released, reconciled_zero_usage).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_active_unique 
    ON public.rate_limit_reservations (user_id, parent_key, chunk_index) 
    WHERE status IN ('active', 'dispatching', 'dispatched', 'uncertain', 'committed');

-- Trigger protecting immutability of quota_date_pacific once a provider dispatch authorization has occurred
CREATE OR REPLACE FUNCTION public.protect_reservation_quota_date()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.dispatching_at IS NOT NULL AND NEW.quota_date_pacific IS DISTINCT FROM OLD.quota_date_pacific THEN
        RAISE EXCEPTION 'IMMUTABLE_FIELD: Dispatched reservation quota_date_pacific cannot be modified.'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_reservation_quota_date ON public.rate_limit_reservations;

CREATE TRIGGER trg_protect_reservation_quota_date
    BEFORE UPDATE ON public.rate_limit_reservations
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_reservation_quota_date();

-- Supporting indices for high-concurrency admission checks
CREATE INDEX IF NOT EXISTS idx_reservations_active_concurrency 
    ON public.rate_limit_reservations(project_id, quota_scope, status, lease_until);

CREATE INDEX IF NOT EXISTS idx_reservations_tpm_window 
    ON public.rate_limit_reservations(project_id, quota_scope, status, dispatching_at, lease_until);

CREATE INDEX IF NOT EXISTS idx_reservations_pacific_rpd 
    ON public.rate_limit_reservations(project_id, quota_scope, dispatching_at);

CREATE INDEX IF NOT EXISTS idx_reservations_stale_sweeper 
    ON public.rate_limit_reservations(status, lease_until);

-- -----------------------------------------------------------------------------
-- SECTION 6: TABLE DDL — RATE LIMIT EVENTS (AUDIT LOG)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rate_limit_events (
    event_id                    UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id                  VARCHAR(64)              NOT NULL,
    quota_scope                 VARCHAR(64)              NOT NULL,
    user_id                     UUID                     NOT NULL,
    parent_key                  VARCHAR(64)              NOT NULL,
    chunk_index                 INTEGER                  NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 100),
    reservation_token           UUID                     NOT NULL,
    event_type                  VARCHAR(30)              NOT NULL,
    model_name                  VARCHAR(64)              NOT NULL,
    worker_id                   VARCHAR(255)             NOT NULL,
    total_tokens                INTEGER                  CHECK (total_tokens IS NULL OR total_tokens >= 0),
    prompt_tokens               INTEGER                  CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
    candidate_tokens            INTEGER                  CHECK (candidate_tokens IS NULL OR candidate_tokens >= 0),
    thoughts_tokens             INTEGER                  CHECK (thoughts_tokens IS NULL OR thoughts_tokens >= 0),
    payload                     JSONB                    NOT NULL,
    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_rate_limit_events_reservation
        FOREIGN KEY (reservation_token)
        REFERENCES public.rate_limit_reservations(reservation_token)
        ON DELETE RESTRICT,
    
    CONSTRAINT chk_event_type CHECK (
        event_type IN (
            'RESERVE',
            'COMMIT',
            'RELEASE',
            'RECONCILE_STALE',
            'RECONCILE_DAY_BOUNDARY',
            'RECONCILE_ZERO',
            'RECONCILE_ZERO_USAGE'
        )
    ),
    
    -- Idempotent event uniqueness: At most one COMMIT event per reservation token
    CONSTRAINT uq_rate_limit_events_reservation_commit
        UNIQUE (reservation_token, event_type)
);

-- Append-Only Security Trigger on rate_limit_events
CREATE OR REPLACE FUNCTION public.prevent_audit_event_tampering()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'SECURITY_VIOLATION: Table public.rate_limit_events is strictly append-only. UPDATE and DELETE operations are forbidden.'
        USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rate_limit_events_append_only ON public.rate_limit_events;

CREATE TRIGGER trg_rate_limit_events_append_only
    BEFORE UPDATE OR DELETE ON public.rate_limit_events
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_audit_event_tampering();

CREATE INDEX IF NOT EXISTS idx_events_project_tpm_window 
    ON public.rate_limit_events(project_id, event_type, created_at, total_tokens);

-- -----------------------------------------------------------------------------
-- SECTION 7: TABLE DDL — CHUNK GENERATIONS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chunk_generations (
    chunk_id                    UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID                     NOT NULL,
    parent_key                  VARCHAR(64)              NOT NULL,
    chunk_index                 INTEGER                  NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 100),
    reservation_token           UUID                     NOT NULL UNIQUE,
    status                      VARCHAR(20)              NOT NULL DEFAULT 'completed',
    model_name                  VARCHAR(64)              NOT NULL,
    total_tokens                INTEGER                  NOT NULL CHECK (total_tokens >= 0),
    prompt_tokens               INTEGER                  NOT NULL CHECK (prompt_tokens >= 0),
    candidate_tokens            INTEGER                  NOT NULL CHECK (candidate_tokens >= 0),
    thoughts_tokens             INTEGER                  CHECK (thoughts_tokens IS NULL OR thoughts_tokens >= 0),
    chunk_notes                 JSONB                    NOT NULL,
    completed_at                TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT fk_chunk_generations_parent
        FOREIGN KEY (user_id, parent_key) 
        REFERENCES public.generation_idempotency(user_id, key) 
        ON DELETE RESTRICT,

    CONSTRAINT fk_chunk_generations_reservation
        FOREIGN KEY (reservation_token) 
        REFERENCES public.rate_limit_reservations(reservation_token) 
        ON DELETE RESTRICT,
        
    CONSTRAINT uq_chunk_generations_user_parent_chunk
        UNIQUE (user_id, parent_key, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunk_generations_lookup 
    ON public.chunk_generations(user_id, parent_key, chunk_index);

-- -----------------------------------------------------------------------------
-- SECTION 8: TABLE DDL — ADMINISTRATIVE RECONCILIATION AUTHORIZATIONS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reconciliation_authorizations (
    ticket_id                   UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_token           UUID                     NOT NULL,
    authorized_by               VARCHAR(64)              NOT NULL,
    justification               TEXT                     NOT NULL,
    external_audit_ref          VARCHAR(255)             NOT NULL,
    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (CURRENT_TIMESTAMP + '00:15:00'::interval),
    consumed_at                 TIMESTAMP WITH TIME ZONE,
    consumed_by                 VARCHAR(255),
    revoked_at                  TIMESTAMP WITH TIME ZONE,
    revoked_by                  VARCHAR(64),
    revoked_reason              TEXT,
    status                      VARCHAR(20)              NOT NULL DEFAULT 'ACTIVE',
    
    CONSTRAINT fk_reconciliation_auth_reservation 
        FOREIGN KEY (reservation_token) 
        REFERENCES public.rate_limit_reservations(reservation_token) 
        ON DELETE RESTRICT,

    CONSTRAINT chk_ticket_status 
        CHECK (status IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED'))
);

-- DEF-6: Drop legacy unconditional unique constraint on reservation_token if present
ALTER TABLE public.reconciliation_authorizations DROP CONSTRAINT IF EXISTS reconciliation_authorizations_reservation_token_key;
DROP INDEX IF EXISTS public.reconciliation_authorizations_reservation_token_key;
DROP INDEX IF EXISTS public.idx_reconciliation_auth_active_unique;

-- DEF-6: Partial unique index enforcing at most ONE ACTIVE ticket per reservation.
-- Allows expired or revoked tickets to be replaced without deleting historical audit rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_auth_active_unique
    ON public.reconciliation_authorizations (reservation_token)
    WHERE status = 'ACTIVE';

-- Phase 1S: Safe migration step ensuring expires_at column default is 15 minutes across fresh installs and Phase 1Q upgrades
DO $$
DECLARE
    v_data_type text;
BEGIN
    SELECT data_type INTO v_data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'reconciliation_authorizations'
      AND column_name = 'expires_at';

    IF v_data_type IS NULL THEN
        RAISE EXCEPTION 'MIGRATION_FAILED: public.reconciliation_authorizations.expires_at column is missing.' USING ERRCODE = '42703';
    END IF;

    IF v_data_type <> 'timestamp with time zone' THEN
        RAISE EXCEPTION 'MIGRATION_FAILED: public.reconciliation_authorizations.expires_at has unexpected data type: %', v_data_type USING ERRCODE = '42804';
    END IF;

    -- Explicitly alter column default to 15-minute expression without mutating historical rows
    ALTER TABLE public.reconciliation_authorizations
        ALTER COLUMN expires_at SET DEFAULT (CURRENT_TIMESTAMP + '00:15:00'::interval);
END $$;

CREATE OR REPLACE FUNCTION public.protect_reconciliation_ticket()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'IMMUTABLE_TABLE: Administrative reconciliation tickets cannot be deleted.' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'CONSUMED' THEN
            RAISE EXCEPTION 'TICKET_ALREADY_CONSUMED: Cannot modify a consumed reconciliation authorization ticket.' USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'REVOKED' THEN
            RAISE EXCEPTION 'TICKET_ALREADY_REVOKED: Cannot modify a revoked reconciliation authorization ticket.' USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'EXPIRED' THEN
            RAISE EXCEPTION 'TICKET_ALREADY_EXPIRED: Cannot modify an expired reconciliation authorization ticket.' USING ERRCODE = '23514';
        END IF;
        IF NEW.ticket_id IS DISTINCT FROM OLD.ticket_id 
           OR NEW.reservation_token IS DISTINCT FROM OLD.reservation_token
           OR NEW.authorized_by IS DISTINCT FROM OLD.authorized_by
           OR NEW.justification IS DISTINCT FROM OLD.justification
           OR NEW.external_audit_ref IS DISTINCT FROM OLD.external_audit_ref
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
           OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
            RAISE EXCEPTION 'IMMUTABLE_FIELD: Ticket authorization details and expiry are strictly immutable.' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_reconciliation_ticket ON public.reconciliation_authorizations;

CREATE TRIGGER trg_protect_reconciliation_ticket
    BEFORE UPDATE OR DELETE ON public.reconciliation_authorizations
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_reconciliation_ticket();

-- -----------------------------------------------------------------------------
-- SECTION 9: TABLE PRIVILEGES, DEDICATED OWNER POLICIES & ROW LEVEL SECURITY
-- -----------------------------------------------------------------------------
REVOKE ALL ON TABLE public.project_quota_configs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rate_limit_reservations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rate_limit_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.chunk_generations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.reconciliation_authorizations FROM PUBLIC, anon, authenticated;

ALTER TABLE public.project_quota_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chunk_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_authorizations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.project_quota_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.chunk_generations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_authorizations FORCE ROW LEVEL SECURITY;

-- DEF-1: Schema usage and table grants for dedicated function owner (codenotes_definer)
GRANT USAGE, CREATE ON SCHEMA public TO codenotes_definer;

-- DEF-1: project_quota_configs: SELECT and column-level UPDATE on updated_at for row locking (FOR UPDATE)
GRANT SELECT, UPDATE (updated_at) ON TABLE public.project_quota_configs TO codenotes_definer;

-- DEF-1: generation_idempotency: SELECT and column-level UPDATE on updated_at for parent row locking (FOR UPDATE)
GRANT SELECT, UPDATE (updated_at) ON TABLE public.generation_idempotency TO codenotes_definer;

-- DEF-1: Adaptive tables: least-privilege operations
GRANT SELECT, INSERT, UPDATE ON TABLE public.rate_limit_reservations TO codenotes_definer;
GRANT SELECT, INSERT ON TABLE public.rate_limit_events TO codenotes_definer; -- Strictly NO UPDATE/DELETE
GRANT SELECT, INSERT, UPDATE ON TABLE public.chunk_generations TO codenotes_definer;
GRANT SELECT, INSERT, UPDATE ON TABLE public.reconciliation_authorizations TO codenotes_definer;

-- DEF-1: Explicit RLS policies on ALL accessed tables for codenotes_definer
-- Allows codenotes_definer to operate under FORCE ROW LEVEL SECURITY without superuser/BYPASSRLS
DROP POLICY IF EXISTS p_codenotes_definer_parent ON public.generation_idempotency;
CREATE POLICY p_codenotes_definer_parent ON public.generation_idempotency FOR ALL TO codenotes_definer USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS p_codenotes_definer_configs ON public.project_quota_configs;
CREATE POLICY p_codenotes_definer_configs ON public.project_quota_configs FOR ALL TO codenotes_definer USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS p_codenotes_definer_reservations ON public.rate_limit_reservations;
CREATE POLICY p_codenotes_definer_reservations ON public.rate_limit_reservations FOR ALL TO codenotes_definer USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS p_codenotes_definer_events ON public.rate_limit_events;
CREATE POLICY p_codenotes_definer_events ON public.rate_limit_events FOR ALL TO codenotes_definer USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS p_codenotes_definer_chunks ON public.chunk_generations;
CREATE POLICY p_codenotes_definer_chunks ON public.chunk_generations FOR ALL TO codenotes_definer USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS p_codenotes_definer_tickets ON public.reconciliation_authorizations;
CREATE POLICY p_codenotes_definer_tickets ON public.reconciliation_authorizations FOR ALL TO codenotes_definer USING (true) WITH CHECK (true);

DO $$
BEGIN
    -- Application backend role (service_role): Read-only access; mutations mediated exclusively via SECURITY DEFINER
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.project_quota_configs FROM service_role;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.rate_limit_reservations FROM service_role;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.rate_limit_events FROM service_role;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.chunk_generations FROM service_role;
        REVOKE ALL ON TABLE public.reconciliation_authorizations FROM service_role;

        GRANT SELECT ON TABLE public.project_quota_configs TO service_role;
        GRANT SELECT ON TABLE public.rate_limit_reservations TO service_role;
        GRANT SELECT ON TABLE public.rate_limit_events TO service_role;
        GRANT SELECT ON TABLE public.chunk_generations TO service_role;
    END IF;

    -- Administrative auditor role (service_role_admin): Read-only access; mutations mediated exclusively via SECURITY DEFINER
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role_admin') THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.project_quota_configs FROM service_role_admin;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.rate_limit_reservations FROM service_role_admin;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.rate_limit_events FROM service_role_admin;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.chunk_generations FROM service_role_admin;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.reconciliation_authorizations FROM service_role_admin;

        GRANT SELECT ON TABLE public.project_quota_configs TO service_role_admin;
        GRANT SELECT ON TABLE public.rate_limit_reservations TO service_role_admin;
        GRANT SELECT ON TABLE public.rate_limit_events TO service_role_admin;
        GRANT SELECT ON TABLE public.chunk_generations TO service_role_admin;
        GRANT SELECT ON TABLE public.reconciliation_authorizations TO service_role_admin;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- SECTION 10: ROUTINE 1 — reserve_quota (EXCLUSIVE ADMISSION MECHANISM)
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
    p_lease_duration       INTERVAL
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
    -- DEF-2: Caller Authorization & Role-Switching Protection
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
    IF p_chunk_index IS NULL OR p_chunk_index < 0 OR p_chunk_index >= 100 THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'INVALID_CHUNK_INDEX'::TEXT;
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

    -- Idempotency Check on Existing Active/Committed Reservation
    SELECT * INTO v_existing_res
    FROM public.rate_limit_reservations
    WHERE user_id = p_user_id AND parent_key = p_parent_key AND chunk_index = p_chunk_index
      AND status IN ('active', 'dispatching', 'dispatched', 'uncertain', 'committed');

    IF FOUND THEN
        -- DEF-5: Complete Replay Consistency Cross-Check across Res, Chunk, and Event
        IF v_existing_res.status = 'committed' THEN
            SELECT * INTO v_existing_chunk
            FROM public.chunk_generations
            WHERE user_id = p_user_id AND parent_key = p_parent_key AND chunk_index = p_chunk_index;

            SELECT * INTO v_existing_event
            FROM public.rate_limit_events
            WHERE reservation_token = v_existing_res.reservation_token AND event_type = 'COMMIT';

            -- DEF-5: Complete Replay Consistency Cross-Check across Res, Chunk, and Event
            IF v_existing_chunk.chunk_id IS NULL 
               OR v_existing_event.event_id IS NULL
               OR v_existing_res.user_id IS DISTINCT FROM p_user_id
               OR v_existing_chunk.user_id IS DISTINCT FROM p_user_id
               OR v_existing_event.user_id IS DISTINCT FROM p_user_id
               OR v_existing_res.parent_key IS DISTINCT FROM p_parent_key
               OR v_existing_chunk.parent_key IS DISTINCT FROM p_parent_key
               OR v_existing_event.parent_key IS DISTINCT FROM p_parent_key
               OR v_existing_res.chunk_index IS DISTINCT FROM p_chunk_index
               OR v_existing_chunk.chunk_index IS DISTINCT FROM p_chunk_index
               OR v_existing_event.chunk_index IS DISTINCT FROM p_chunk_index
               OR v_existing_res.project_id IS DISTINCT FROM p_project_id
               OR v_existing_event.project_id IS DISTINCT FROM p_project_id
               OR v_existing_res.quota_scope IS DISTINCT FROM p_quota_scope
               OR v_existing_event.quota_scope IS DISTINCT FROM p_quota_scope
               OR v_existing_res.model_name IS DISTINCT FROM p_model_name
               OR v_existing_chunk.model_name IS DISTINCT FROM p_model_name
               OR v_existing_event.model_name IS DISTINCT FROM p_model_name
               OR v_existing_chunk.reservation_token IS DISTINCT FROM v_existing_res.reservation_token
               OR v_existing_event.reservation_token IS DISTINCT FROM v_existing_res.reservation_token
               OR v_existing_res.worker_id IS DISTINCT FROM v_existing_event.worker_id
               OR v_existing_chunk.status IS DISTINCT FROM 'completed'
               OR v_existing_res.committed_at IS NULL
               OR v_existing_chunk.completed_at IS NULL
               OR v_existing_event.created_at IS NULL
               OR v_existing_res.committed_at < v_existing_res.created_at
               OR v_existing_chunk.completed_at < v_existing_chunk.created_at
               OR v_existing_event.created_at < v_existing_res.committed_at
               OR v_existing_res.actual_total_tokens IS DISTINCT FROM v_existing_chunk.total_tokens
               OR v_existing_event.total_tokens IS DISTINCT FROM v_existing_chunk.total_tokens
               OR v_existing_res.actual_prompt_tokens IS DISTINCT FROM v_existing_chunk.prompt_tokens
               OR v_existing_event.prompt_tokens IS DISTINCT FROM v_existing_chunk.prompt_tokens
               OR v_existing_res.actual_candidate_tokens IS DISTINCT FROM v_existing_chunk.candidate_tokens
               OR v_existing_event.candidate_tokens IS DISTINCT FROM v_existing_chunk.candidate_tokens
               OR v_existing_res.actual_thoughts_tokens IS DISTINCT FROM v_existing_chunk.thoughts_tokens
               OR v_existing_event.thoughts_tokens IS DISTINCT FROM v_existing_chunk.thoughts_tokens
               OR (v_existing_event.payload->>'disposition') IS DISTINCT FROM 'CHUNK_COMMITTED'
               OR v_existing_chunk.chunk_notes IS NULL 
               OR v_existing_chunk.chunk_notes = '{}'::jsonb THEN
                RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'COMMITTED_STATE_INCONSISTENT'::TEXT;
                RETURN;
            END IF;

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
            -- DEF-4: Validate immutable active reservation identity against current request
            IF v_existing_res.project_id IS DISTINCT FROM p_project_id
               OR v_existing_res.quota_scope IS DISTINCT FROM p_quota_scope
               OR v_existing_res.model_name IS DISTINCT FROM p_model_name
               OR v_existing_res.estimated_tokens IS DISTINCT FROM p_estimated_tokens THEN
                RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'ACTIVE_RESERVATION_PARAMETER_MISMATCH'::TEXT;
                RETURN;
            END IF;

            RETURN QUERY SELECT v_existing_res.reservation_token, v_existing_res.lease_token, v_existing_res.generation, v_existing_res.lease_until, TRUE, 'ALREADY_RESERVED'::TEXT;
            RETURN;
        END IF;

        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'CHUNK_RESERVATION_CONFLICT'::TEXT;
        RETURN;
    END IF;

    -- Exclusive Admission Locks in Deterministic Order (Global -> Scope FOR UPDATE)
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

    -- Evaluate Global Tier Quota Limits
    -- Concurrency: Expired undispatched active reservations do not consume concurrency; uncertain requests retained until resolved
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

    -- RPM counts actual dispatch authorizations in the last 60 seconds across all terminal states
    SELECT COALESCE(COUNT(*), 0) INTO v_global_rpm
    FROM public.rate_limit_reservations
    WHERE project_id = p_project_id
      AND dispatching_at IS NOT NULL
      AND dispatching_at >= v_now - INTERVAL '60 seconds';

    IF v_global_rpm >= v_global_config.max_rpm THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_RPM_GLOBAL'::TEXT;
        RETURN;
    END IF;

    -- DEF-3: Rolling TPM uses provider dispatch time for confirmed committed tokens,
    -- and retains uncommitted in-flight estimates for active (with active lease), dispatching, dispatched,
    -- AND uncertain requests so that unresolved requests do not disappear merely because a lease expired.
    SELECT COALESCE(SUM(COALESCE(actual_total_tokens, estimated_tokens)), 0) INTO v_global_committed_tpm
    FROM public.rate_limit_reservations
    WHERE project_id = p_project_id
      AND status = 'committed'
      AND dispatching_at IS NOT NULL
      AND dispatching_at >= v_now - INTERVAL '60 seconds';

    SELECT COALESCE(SUM(estimated_tokens), 0) INTO v_global_in_flight_tpm
    FROM public.rate_limit_reservations 
    WHERE project_id = p_project_id 
      AND (
          (status = 'active' AND lease_until > v_now AND created_at >= v_now - INTERVAL '60 seconds')
          OR (status IN ('dispatching', 'dispatched', 'uncertain'))
      );

    v_global_rolling_tpm := v_global_committed_tpm + v_global_in_flight_tpm;
    IF v_global_rolling_tpm + p_estimated_tokens > v_global_config.max_tpm THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_TPM_GLOBAL'::TEXT;
        RETURN;
    END IF;

    -- RPD counts actual dispatch authorizations for Pacific date (never undispatched active)
    SELECT COALESCE(COUNT(*), 0) INTO v_global_rpd
    FROM public.rate_limit_reservations
    WHERE project_id = p_project_id
      AND dispatching_at IS NOT NULL
      AND (dispatching_at AT TIME ZONE 'America/Los_Angeles')::date = v_current_pacific_date;

    IF v_global_rpd >= v_global_config.max_rpd THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_RPD_GLOBAL'::TEXT;
        RETURN;
    END IF;

    -- Evaluate Model-Scope Tier Quota Limits (Identical Semantics)
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

    SELECT COALESCE(COUNT(*), 0) INTO v_scope_rpm
    FROM public.rate_limit_reservations
    WHERE project_id = p_project_id AND quota_scope = p_quota_scope
      AND dispatching_at IS NOT NULL
      AND dispatching_at >= v_now - INTERVAL '60 seconds';

    IF v_scope_rpm >= v_scope_config.max_rpm THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_RPM_SCOPE'::TEXT;
        RETURN;
    END IF;

    SELECT COALESCE(SUM(COALESCE(actual_total_tokens, estimated_tokens)), 0) INTO v_scope_committed_tpm
    FROM public.rate_limit_reservations
    WHERE project_id = p_project_id AND quota_scope = p_quota_scope
      AND status = 'committed'
      AND dispatching_at IS NOT NULL
      AND dispatching_at >= v_now - INTERVAL '60 seconds';

    SELECT COALESCE(SUM(estimated_tokens), 0) INTO v_scope_in_flight_tpm
    FROM public.rate_limit_reservations 
    WHERE project_id = p_project_id AND quota_scope = p_quota_scope
      AND (
          (status = 'active' AND lease_until > v_now AND created_at >= v_now - INTERVAL '60 seconds')
          OR (status IN ('dispatching', 'dispatched', 'uncertain'))
      );

    v_scope_rolling_tpm := v_scope_committed_tpm + v_scope_in_flight_tpm;
    IF v_scope_rolling_tpm + p_estimated_tokens > v_scope_config.max_tpm THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_TPM_SCOPE'::TEXT;
        RETURN;
    END IF;

    SELECT COALESCE(COUNT(*), 0) INTO v_scope_rpd
    FROM public.rate_limit_reservations
    WHERE project_id = p_project_id AND quota_scope = p_quota_scope
      AND dispatching_at IS NOT NULL
      AND (dispatching_at AT TIME ZONE 'America/Los_Angeles')::date = v_current_pacific_date;

    IF v_scope_rpd >= v_scope_config.max_rpd THEN
        RETURN QUERY SELECT NULL::UUID, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ, FALSE, 'RATE_LIMIT_EXCEEDED_RPD_SCOPE'::TEXT;
        RETURN;
    END IF;

    -- Atomic Admission: Issue Reservation Token & Append RESERVE Event
    v_res_token := gen_random_uuid();
    v_lease_token := gen_random_uuid();
    v_lease_until := v_now + p_lease_duration;

    INSERT INTO public.rate_limit_reservations (
        reservation_token,
        project_id,
        quota_scope,
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

    INSERT INTO public.rate_limit_events (
        project_id,
        quota_scope,
        user_id,
        parent_key,
        chunk_index,
        reservation_token,
        event_type,
        model_name,
        worker_id,
        total_tokens,
        prompt_tokens,
        candidate_tokens,
        thoughts_tokens,
        payload,
        created_at
    ) VALUES (
        p_project_id,
        p_quota_scope,
        p_user_id,
        p_parent_key,
        p_chunk_index,
        v_res_token,
        'RESERVE',
        p_model_name,
        p_worker_id,
        p_estimated_tokens,
        0,
        0,
        NULL,
        jsonb_build_object(
            'estimated_tokens', p_estimated_tokens,
            'lease_duration', p_lease_duration,
            'lease_until', v_lease_until
        ),
        v_now
    );

    RETURN QUERY SELECT v_res_token, v_lease_token, 1, v_lease_until, TRUE, 'GRANTED'::TEXT;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 11: ROUTINE 2 — mark_reservation_dispatching (DISPATCH BOUNDARY)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_reservation_dispatching(
    p_reservation_token    UUID,
    p_lease_token          UUID,
    p_worker_id            VARCHAR,
    p_generation           INTEGER,
    p_lease_duration       INTERVAL
)
RETURNS TABLE (
    success                BOOLEAN,
    status_code            TEXT,
    new_lease_until        TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_user_id              UUID;
    v_parent_key           VARCHAR(64);
    v_parent_status        VARCHAR(20);
    v_res                  RECORD;
    v_now                  TIMESTAMPTZ;
    v_updated_lease_until  TIMESTAMPTZ;
BEGIN
    -- DEF-2: Caller Authorization & Role-Switching Protection
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

    IF p_lease_duration IS NULL OR p_lease_duration <= '0 seconds'::interval OR p_lease_duration > '300 seconds'::interval THEN
        RETURN QUERY SELECT FALSE, 'INVALID_LEASE_DURATION'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Universal Lock Order: Parent -> Reservation
    SELECT user_id, parent_key INTO v_user_id, v_parent_key
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_NOT_FOUND'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = v_user_id AND key = v_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'PARENT_GENERATION_NOT_FOUND'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF v_parent_status NOT IN ('processing', 'pending') THEN
        RETURN QUERY SELECT FALSE, 'PARENT_GENERATION_NOT_ACTIVE'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    SELECT * INTO v_res
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token
    FOR UPDATE;

    v_now := clock_timestamp();

    -- Fencing checks
    IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN
        RETURN QUERY SELECT FALSE, 'STALE_LEASE_OWNERSHIP'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.generation IS DISTINCT FROM p_generation THEN
        RETURN QUERY SELECT FALSE, 'FENCING_GENERATION_MISMATCH'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.status IN ('dispatching', 'dispatched', 'uncertain', 'committed') THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_ALREADY_DISPATCHED'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.status <> 'active' THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_NOT_ACTIVE'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_now > v_res.lease_until THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_LEASE_EXPIRED'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    v_updated_lease_until := v_now + p_lease_duration;

    -- Dispatch Authorization Boundary: Permanently stamps the authorization attempt timestamp
    -- and Pacific attribution date. Database authorization is established here prior to HTTP transmission.
    UPDATE public.rate_limit_reservations
    SET status = 'dispatching',
        dispatching_at = v_now,
        quota_date_pacific = (v_now AT TIME ZONE 'America/Los_Angeles')::date,
        lease_until = v_updated_lease_until,
        updated_at = v_now
    WHERE reservation_token = p_reservation_token;

    RETURN QUERY SELECT TRUE, 'SUCCESS'::TEXT, v_updated_lease_until;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 12: ROUTINE 3 — complete_chunk_and_commit_quota (REPLAY INTEGRITY)
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
    v_parent_status        VARCHAR(20);
    v_res                  RECORD;
    v_chunk                RECORD;
    v_event                RECORD;
    v_now                  TIMESTAMPTZ;
    v_unconsumed_total     INTEGER;
    v_overage_total        INTEGER;
BEGIN
    -- DEF-2: Caller Authorization & Role-Switching Protection
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

    -- Token Input Parameter Validation (Non-negative; no arbitrary arithmetic constraints)
    IF p_total_tokens IS NULL OR p_total_tokens < 0 THEN
        RETURN QUERY SELECT FALSE, 'INVALID_TOTAL_TOKENS'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF p_prompt_tokens IS NULL OR p_prompt_tokens < 0 THEN
        RETURN QUERY SELECT FALSE, 'INVALID_PROMPT_TOKENS'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF p_candidate_tokens IS NULL OR p_candidate_tokens < 0 THEN
        RETURN QUERY SELECT FALSE, 'INVALID_CANDIDATE_TOKENS'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF p_thoughts_tokens IS NOT NULL AND p_thoughts_tokens < 0 THEN
        RETURN QUERY SELECT FALSE, 'INVALID_THOUGHTS_TOKENS'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF p_model_name IS NULL OR trim(p_model_name) = '' THEN
        RETURN QUERY SELECT FALSE, 'MISSING_MODEL_IDENTITY'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Validate CodeNotes GeneratedNotes JSON Contract matching TypeScript
    IF p_chunk_notes IS NULL 
       OR jsonb_typeof(p_chunk_notes) <> 'object' 
       OR p_chunk_notes = '{}'::jsonb THEN
        RETURN QUERY SELECT FALSE, 'EMPTY_OR_INVALID_CHUNK_PAYLOAD'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF jsonb_typeof(p_chunk_notes->'overview') <> 'string'
       OR length(trim(p_chunk_notes->>'overview')) = 0
       OR jsonb_typeof(p_chunk_notes->'detailedNotes') <> 'string'
       OR length(trim(p_chunk_notes->>'detailedNotes')) = 0
       OR jsonb_typeof(p_chunk_notes->'keyConcepts') <> 'array'
       OR jsonb_typeof(p_chunk_notes->'shorthands') <> 'array' THEN
        RETURN QUERY SELECT FALSE, 'MALFORMED_CHUNK_NOTES_SCHEMA'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_chunk_notes->'keyConcepts') elem 
        WHERE jsonb_typeof(elem) <> 'string'
    ) THEN
        RETURN QUERY SELECT FALSE, 'MALFORMED_KEY_CONCEPTS_ELEMENT'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_chunk_notes->'shorthands') elem 
        WHERE jsonb_typeof(elem) <> 'string'
    ) THEN
        RETURN QUERY SELECT FALSE, 'MALFORMED_SHORTHANDS_ELEMENT'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Universal Lock Order: Parent -> Reservation -> Chunk (DEF-8 Lock Hierarchy)
    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = p_user_id AND key = p_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'PARENT_GENERATION_NOT_FOUND'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF v_parent_status NOT IN ('processing', 'pending') THEN
        RETURN QUERY SELECT FALSE, 'PARENT_GENERATION_NOT_ACTIVE'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    SELECT * INTO v_res
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_NOT_FOUND'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.user_id IS DISTINCT FROM p_user_id 
       OR v_res.parent_key IS DISTINCT FROM p_parent_key 
       OR v_res.chunk_index IS DISTINCT FROM p_chunk_index THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_COORDINATE_MISMATCH'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.model_name IS DISTINCT FROM p_model_name THEN
        RETURN QUERY SELECT FALSE, 'MODEL_MISMATCH'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    SELECT * INTO v_chunk
    FROM public.chunk_generations
    WHERE user_id = p_user_id AND parent_key = p_parent_key AND chunk_index = p_chunk_index
    FOR UPDATE;

    IF v_chunk.chunk_id IS NOT NULL THEN
        IF v_chunk.reservation_token IS DISTINCT FROM p_reservation_token THEN
            RETURN QUERY SELECT FALSE, 'CONFLICTING_RESERVATION_COMPLETION'::TEXT, NULL::TIMESTAMPTZ;
            RETURN;
        END IF;
    END IF;

    v_now := clock_timestamp();

    -- Comprehensive Three-Way Replay & Chronological Inconsistency Detection
    IF v_res.status = 'committed' THEN
        SELECT * INTO v_event
        FROM public.rate_limit_events
        WHERE reservation_token = p_reservation_token AND event_type = 'COMMIT';

        IF v_event.event_id IS NULL OR v_chunk.chunk_id IS NULL THEN
            RETURN QUERY SELECT FALSE, 'COMMITTED_STATE_INCONSISTENT'::TEXT, NULL::TIMESTAMPTZ;
            RETURN;
        END IF;

        IF v_res.user_id IS DISTINCT FROM p_user_id
           OR v_chunk.user_id IS DISTINCT FROM p_user_id
           OR v_event.user_id IS DISTINCT FROM p_user_id
           OR v_res.parent_key IS DISTINCT FROM p_parent_key
           OR v_chunk.parent_key IS DISTINCT FROM p_parent_key
           OR v_event.parent_key IS DISTINCT FROM p_parent_key
           OR v_res.chunk_index IS DISTINCT FROM p_chunk_index
           OR v_chunk.chunk_index IS DISTINCT FROM p_chunk_index
           OR v_event.chunk_index IS DISTINCT FROM p_chunk_index
           OR v_res.project_id IS DISTINCT FROM v_event.project_id
           OR v_res.quota_scope IS DISTINCT FROM v_event.quota_scope
           OR v_res.model_name IS DISTINCT FROM p_model_name
           OR v_chunk.model_name IS DISTINCT FROM p_model_name
           OR v_event.model_name IS DISTINCT FROM p_model_name
           OR v_chunk.reservation_token IS DISTINCT FROM p_reservation_token
           OR v_event.reservation_token IS DISTINCT FROM p_reservation_token
           OR v_res.worker_id IS DISTINCT FROM v_event.worker_id
           OR v_chunk.status IS DISTINCT FROM 'completed'
           OR v_res.committed_at IS NULL
           OR v_chunk.completed_at IS NULL
           OR v_event.created_at IS NULL
           OR v_res.committed_at < v_res.created_at
           OR v_chunk.completed_at < v_chunk.created_at
           OR v_event.created_at < v_res.committed_at
           OR v_res.actual_total_tokens IS DISTINCT FROM p_total_tokens
           OR v_chunk.total_tokens IS DISTINCT FROM p_total_tokens
           OR v_event.total_tokens IS DISTINCT FROM p_total_tokens
           OR v_res.actual_prompt_tokens IS DISTINCT FROM p_prompt_tokens
           OR v_chunk.prompt_tokens IS DISTINCT FROM p_prompt_tokens
           OR v_event.prompt_tokens IS DISTINCT FROM p_prompt_tokens
           OR v_res.actual_candidate_tokens IS DISTINCT FROM p_candidate_tokens
           OR v_chunk.candidate_tokens IS DISTINCT FROM p_candidate_tokens
           OR v_event.candidate_tokens IS DISTINCT FROM p_candidate_tokens
           OR v_res.actual_thoughts_tokens IS DISTINCT FROM p_thoughts_tokens
           OR v_chunk.thoughts_tokens IS DISTINCT FROM p_thoughts_tokens
           OR v_event.thoughts_tokens IS DISTINCT FROM p_thoughts_tokens
           OR (v_event.payload->>'disposition') IS DISTINCT FROM 'CHUNK_COMMITTED'
           OR v_chunk.chunk_notes IS DISTINCT FROM p_chunk_notes THEN
            RETURN QUERY SELECT FALSE, 'COMMITTED_STATE_INCONSISTENT'::TEXT, NULL::TIMESTAMPTZ;
            RETURN;
        END IF;

        RETURN QUERY SELECT TRUE, 'ALREADY_COMMITTED'::TEXT, v_res.committed_at;
        RETURN;
    END IF;

    -- Terminal state verification
    IF v_res.status IN ('released', 'expired_day_boundary', 'reconciled_zero_usage') THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_ALREADY_TERMINAL'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Ownership and lease verification
    IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN
        RETURN QUERY SELECT FALSE, 'STALE_LEASE_OWNERSHIP'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.generation IS DISTINCT FROM p_fencing_generation THEN
        RETURN QUERY SELECT FALSE, 'FENCING_GENERATION_MISMATCH'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.status NOT IN ('dispatching', 'dispatched', 'uncertain') THEN
        RETURN QUERY SELECT FALSE, 'INVALID_RESERVATION_STATE'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Invariant: Lease expiry revokes completion authority regardless of status.
    IF v_now > v_res.lease_until THEN
        RETURN QUERY SELECT FALSE, 'LEASE_EXPIRED_DURING_EXECUTION'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Token unconsumed and overage calculations
    IF p_total_tokens <= v_res.estimated_tokens THEN
        v_unconsumed_total := v_res.estimated_tokens - p_total_tokens;
        v_overage_total := 0;
    ELSE
        v_unconsumed_total := 0;
        v_overage_total := p_total_tokens - v_res.estimated_tokens;
    END IF;

    -- Atomic Mutation: Update Reservation -> Upsert Chunk -> Insert Event
    UPDATE public.rate_limit_reservations
    SET status = 'committed',
        actual_total_tokens = p_total_tokens,
        actual_prompt_tokens = p_prompt_tokens,
        actual_candidate_tokens = p_candidate_tokens,
        actual_thoughts_tokens = p_thoughts_tokens,
        unconsumed_total_tokens = v_unconsumed_total,
        overage_total_tokens = v_overage_total,
        committed_at = v_now,
        updated_at = v_now
    WHERE reservation_token = p_reservation_token;

    INSERT INTO public.chunk_generations (
        chunk_id,
        user_id,
        parent_key,
        chunk_index,
        reservation_token,
        status,
        model_name,
        total_tokens,
        prompt_tokens,
        candidate_tokens,
        thoughts_tokens,
        chunk_notes,
        completed_at,
        created_at
    ) VALUES (
        gen_random_uuid(),
        p_user_id,
        p_parent_key,
        p_chunk_index,
        p_reservation_token,
        'completed',
        p_model_name,
        p_total_tokens,
        p_prompt_tokens,
        p_candidate_tokens,
        p_thoughts_tokens,
        p_chunk_notes,
        v_now,
        v_now
    )
    ON CONFLICT (user_id, parent_key, chunk_index) DO UPDATE
    SET reservation_token = EXCLUDED.reservation_token,
        status = 'completed',
        model_name = EXCLUDED.model_name,
        total_tokens = EXCLUDED.total_tokens,
        prompt_tokens = EXCLUDED.prompt_tokens,
        candidate_tokens = EXCLUDED.candidate_tokens,
        thoughts_tokens = EXCLUDED.thoughts_tokens,
        chunk_notes = EXCLUDED.chunk_notes,
        completed_at = EXCLUDED.completed_at;

    INSERT INTO public.rate_limit_events (
        project_id,
        quota_scope,
        user_id,
        parent_key,
        chunk_index,
        reservation_token,
        event_type,
        model_name,
        worker_id,
        total_tokens,
        prompt_tokens,
        candidate_tokens,
        thoughts_tokens,
        payload,
        created_at
    ) VALUES (
        v_res.project_id,
        v_res.quota_scope,
        p_user_id,
        p_parent_key,
        p_chunk_index,
        p_reservation_token,
        'COMMIT',
        p_model_name,
        p_worker_id,
        p_total_tokens,
        p_prompt_tokens,
        p_candidate_tokens,
        p_thoughts_tokens,
        jsonb_build_object(
            'estimated_tokens', v_res.estimated_tokens,
            'actual_total_tokens', p_total_tokens,
            'unconsumed_total_tokens', v_unconsumed_total,
            'overage_total_tokens', v_overage_total,
            'thoughts_tokens', p_thoughts_tokens
        ),
        v_now
    );

    RETURN QUERY SELECT TRUE, 'SUCCESS'::TEXT, v_now;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 13: ROUTINE 4 — renew_uncertain_lease (AUTHORITATIVE 8-ARG ROUTINE)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.renew_uncertain_lease(
    p_user_id              UUID,
    p_parent_key           VARCHAR,
    p_chunk_index          INTEGER,
    p_reservation_token    UUID,
    p_lease_token          UUID,
    p_worker_id            VARCHAR,
    p_fencing_generation   INTEGER,
    p_lease_duration       INTERVAL
)
RETURNS TABLE (
    success                BOOLEAN,
    status_code            TEXT,
    new_lease_token        UUID,
    new_generation         INTEGER,
    new_lease_until        TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_parent_status        VARCHAR(20);
    v_res                  RECORD;
    v_now                  TIMESTAMPTZ;
    v_new_lease_token      UUID;
    v_new_generation       INTEGER;
    v_new_lease_until      TIMESTAMPTZ;
BEGIN
    -- DEF-2: Caller Authorization & Role-Switching Protection
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

    IF p_lease_duration IS NULL OR p_lease_duration <= '0 seconds'::interval OR p_lease_duration > '300 seconds'::interval THEN
        RETURN QUERY SELECT FALSE, 'INVALID_LEASE_DURATION'::TEXT, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Universal Lock Order: Parent -> Reservation
    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = p_user_id AND key = p_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'PARENT_GENERATION_NOT_FOUND'::TEXT, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF v_parent_status NOT IN ('processing', 'pending') THEN
        RETURN QUERY SELECT FALSE, 'PARENT_GENERATION_NOT_ACTIVE'::TEXT, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    SELECT * INTO v_res
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_NOT_FOUND'::TEXT, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.user_id IS DISTINCT FROM p_user_id 
       OR v_res.parent_key IS DISTINCT FROM p_parent_key 
       OR v_res.chunk_index IS DISTINCT FROM p_chunk_index THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_COORDINATE_MISMATCH'::TEXT, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN
        RETURN QUERY SELECT FALSE, 'STALE_LEASE_OWNERSHIP'::TEXT, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.generation IS DISTINCT FROM p_fencing_generation THEN
        RETURN QUERY SELECT FALSE, 'FENCING_GENERATION_MISMATCH'::TEXT, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.status IN ('committed', 'released', 'expired_day_boundary', 'reconciled_zero_usage') THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_ALREADY_TERMINAL'::TEXT, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_res.status NOT IN ('dispatching', 'dispatched', 'uncertain') THEN
        RETURN QUERY SELECT FALSE, 'INVALID_RESERVATION_STATE'::TEXT, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    v_now := clock_timestamp();

    -- Invariant: Lease expiry revokes authority. Heartbeat/renewal cannot revive an expired lease.
    IF v_now > v_res.lease_until THEN
        RETURN QUERY SELECT FALSE, 'LEASE_EXPIRED'::TEXT, NULL::UUID, NULL::INTEGER, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    v_new_lease_token := gen_random_uuid();
    v_new_generation := v_res.generation + 1;
    v_new_lease_until := v_now + p_lease_duration;

    UPDATE public.rate_limit_reservations
    SET lease_token = v_new_lease_token,
        generation = v_new_generation,
        lease_until = v_new_lease_until,
        updated_at = v_now
    WHERE reservation_token = p_reservation_token;

    RETURN QUERY SELECT TRUE, 'SUCCESS'::TEXT, v_new_lease_token, v_new_generation, v_new_lease_until;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 14: ROUTINE 5 — release_quota_reservation (UNDISPATCHED ACTIVE ONLY)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_quota_reservation(
    p_reservation_token    UUID,
    p_lease_token          UUID,
    p_worker_id            VARCHAR,
    p_generation           INTEGER
)
RETURNS TABLE (
    success                BOOLEAN,
    status_code            TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_user_id              UUID;
    v_parent_key           VARCHAR(64);
    v_parent_status        VARCHAR(20);
    v_res                  RECORD;
    v_now                  TIMESTAMPTZ;
BEGIN
    -- DEF-2: Caller Authorization & Role-Switching Protection
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

    -- Universal Lock Order: Parent -> Reservation
    SELECT user_id, parent_key INTO v_user_id, v_parent_key
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = v_user_id AND key = v_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'PARENT_GENERATION_NOT_FOUND'::TEXT;
        RETURN;
    END IF;
    IF v_parent_status NOT IN ('processing', 'pending') THEN
        RETURN QUERY SELECT FALSE, 'PARENT_GENERATION_NOT_ACTIVE'::TEXT;
        RETURN;
    END IF;

    SELECT * INTO v_res
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token
    FOR UPDATE;

    v_now := clock_timestamp();

    IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN
        RETURN QUERY SELECT FALSE, 'STALE_LEASE_OWNERSHIP'::TEXT;
        RETURN;
    END IF;

    IF v_res.generation IS DISTINCT FROM p_generation THEN
        RETURN QUERY SELECT FALSE, 'FENCING_GENERATION_MISMATCH'::TEXT;
        RETURN;
    END IF;

    IF v_res.status IN ('committed', 'released', 'expired_day_boundary', 'reconciled_zero_usage') THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_ALREADY_TERMINAL'::TEXT;
        RETURN;
    END IF;

    IF v_res.status <> 'active' THEN
        RETURN QUERY SELECT FALSE, 'DISPATCH_ALREADY_INITIATED'::TEXT;
        RETURN;
    END IF;

    -- DEF-2: Lease expiry revokes release authority. Sweeper handles expired active reservations.
    IF v_now > v_res.lease_until THEN
        RETURN QUERY SELECT FALSE, 'LEASE_EXPIRED'::TEXT;
        RETURN;
    END IF;

    -- Undispatched release: Provably never dispatched; usage is confirmed zero
    UPDATE public.rate_limit_reservations
    SET status = 'released',
        released_at = v_now,
        unconsumed_total_tokens = v_res.estimated_tokens,
        overage_total_tokens = 0,
        reconcile_reason = 'CLIENT_ABORT_PRE_DISPATCH',
        reconcile_source = 'CLIENT_RELEASE',
        updated_at = v_now
    WHERE reservation_token = p_reservation_token;

    INSERT INTO public.rate_limit_events (
        project_id,
        quota_scope,
        user_id,
        parent_key,
        chunk_index,
        reservation_token,
        event_type,
        model_name,
        worker_id,
        total_tokens,
        prompt_tokens,
        candidate_tokens,
        thoughts_tokens,
        payload,
        created_at
    ) VALUES (
        v_res.project_id,
        v_res.quota_scope,
        v_res.user_id,
        v_res.parent_key,
        v_res.chunk_index,
        p_reservation_token,
        'RELEASE',
        v_res.model_name,
        p_worker_id,
        0,
        0,
        0,
        NULL,
        jsonb_build_object(
            'disposition', 'PRE_DISPATCH_CLIENT_ABORT',
            'released_reason', 'CLIENT_ABORT_PRE_DISPATCH',
            'unconsumed_total_tokens', v_res.estimated_tokens
        ),
        v_now
    );

    RETURN QUERY SELECT TRUE, 'SUCCESS'::TEXT;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 15: ROUTINE 6 — release_aborted_dispatch (DEF-3 POST-DISPATCH ABORT)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_aborted_dispatch(
    p_reservation_token    UUID,
    p_lease_token          UUID,
    p_worker_id            VARCHAR,
    p_generation           INTEGER,
    p_reason               TEXT
)
RETURNS TABLE (
    success                BOOLEAN,
    status_code            TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_user_id              UUID;
    v_parent_key           VARCHAR(64);
    v_parent_status        VARCHAR(20);
    v_res                  RECORD;
    v_now                  TIMESTAMPTZ;
BEGIN
    -- DEF-2: Caller Authorization & Role-Switching Protection
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

    -- Universal Lock Order: Parent -> Reservation
    SELECT user_id, parent_key INTO v_user_id, v_parent_key
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = v_user_id AND key = v_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'PARENT_GENERATION_NOT_FOUND'::TEXT;
        RETURN;
    END IF;
    IF v_parent_status NOT IN ('processing', 'pending') THEN
        RETURN QUERY SELECT FALSE, 'PARENT_GENERATION_NOT_ACTIVE'::TEXT;
        RETURN;
    END IF;

    SELECT * INTO v_res
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token
    FOR UPDATE;

    v_now := clock_timestamp();

    IF v_res.lease_token IS DISTINCT FROM p_lease_token OR v_res.worker_id IS DISTINCT FROM p_worker_id THEN
        RETURN QUERY SELECT FALSE, 'STALE_LEASE_OWNERSHIP'::TEXT;
        RETURN;
    END IF;

    IF v_res.generation IS DISTINCT FROM p_generation THEN
        RETURN QUERY SELECT FALSE, 'FENCING_GENERATION_MISMATCH'::TEXT;
        RETURN;
    END IF;

    IF v_res.status IN ('committed', 'released', 'expired_day_boundary', 'reconciled_zero_usage') THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_ALREADY_TERMINAL'::TEXT;
        RETURN;
    END IF;

    -- DEF-3: Idempotent Aborted-Dispatch Handling
    IF v_res.status = 'uncertain' THEN
        IF v_res.reconcile_source = 'WORKER_ABORT' THEN
            -- Already successfully transitioned by worker abort with identical fencing coordinates; return stable idempotent success
            RETURN QUERY SELECT TRUE, 'ALREADY_ABORTED_UNCERTAIN'::TEXT;
            RETURN;
        ELSE
            -- Uncertain via another source (e.g. sweeper lease expiry); worker cannot override
            RETURN QUERY SELECT FALSE, 'RESERVATION_ALREADY_UNCERTAIN'::TEXT;
            RETURN;
        END IF;
    END IF;

    IF v_res.status NOT IN ('dispatching', 'dispatched') THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_NOT_DISPATCHED'::TEXT;
        RETURN;
    END IF;

    -- DEF-2: Lease expiry revokes abort authority. Sweeper handles expired dispatches.
    IF v_now > v_res.lease_until THEN
        RETURN QUERY SELECT FALSE, 'LEASE_EXPIRED_DURING_DISPATCH'::TEXT;
        RETURN;
    END IF;

    -- DEF-3: An aborted dispatch has unknown provider usage; it MUST NOT be marked 'released'
    -- (which would silently release its token capacity from TPM).
    -- It transitions to 'uncertain' with worker-abort evidence, permanently retaining RPD/RPM
    -- and conservative in-flight TPM accounting until explicitly reconciled or committed.
    UPDATE public.rate_limit_reservations
    SET status = 'uncertain',
        uncertain_at = v_now,
        reconcile_reason = COALESCE(p_reason, 'WORKER_ABORT_DISPATCHED'),
        reconcile_source = 'WORKER_ABORT',
        updated_at = v_now
    WHERE reservation_token = p_reservation_token;

    INSERT INTO public.rate_limit_events (
        project_id,
        quota_scope,
        user_id,
        parent_key,
        chunk_index,
        reservation_token,
        event_type,
        model_name,
        worker_id,
        total_tokens,
        prompt_tokens,
        candidate_tokens,
        thoughts_tokens,
        payload,
        created_at
    ) VALUES (
        v_res.project_id,
        v_res.quota_scope,
        v_res.user_id,
        v_res.parent_key,
        v_res.chunk_index,
        p_reservation_token,
        'RELEASE',
        v_res.model_name,
        p_worker_id,
        NULL,
        NULL,
        NULL,
        NULL,
        jsonb_build_object(
            'disposition', 'DISPATCH_ABORTED_UNCERTAIN_USAGE',
            'actual_usage_verified', false,
            'reason', COALESCE(p_reason, 'WORKER_ABORT_DISPATCHED'),
            'estimated_tokens_held', v_res.estimated_tokens
        ),
        v_now
    );

    RETURN QUERY SELECT TRUE, 'SUCCESS'::TEXT;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 16: ROUTINE 7 — reconcile_stale_reservations (BOUNDED BATCHES)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_stale_reservations(
    p_batch_size           INTEGER
)
RETURNS TABLE (
    reconciled_count       INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_limit                INTEGER;
    v_now                  TIMESTAMPTZ;
    v_count                INTEGER := 0;
    v_rec                  RECORD;
BEGIN
    -- DEF-2: Caller Authorization & Role-Switching Protection
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

    -- Bounded batch size: clamped between 1 and 500 (default 50)
    v_limit := LEAST(GREATEST(COALESCE(p_batch_size, 50), 1), 500);
    v_now := clock_timestamp();

    -- 1. Expired 'active' reservations (provably NEVER dispatched) -> safely mark 'released'
    FOR v_rec IN 
        SELECT reservation_token, project_id, quota_scope, user_id, parent_key, chunk_index, model_name, estimated_tokens
        FROM public.rate_limit_reservations
        WHERE status = 'active'
          AND v_now > lease_until
        ORDER BY lease_until ASC
        LIMIT v_limit
        FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE public.rate_limit_reservations
        SET status = 'released',
            reconciled_at = v_now,
            reconcile_reason = 'SWEEPER_EXPIRED_ACTIVE',
            reconcile_source = 'SWEEPER',
            updated_at = v_now
        WHERE reservation_token = v_rec.reservation_token;

        INSERT INTO public.rate_limit_events (
            project_id,
            quota_scope,
            user_id,
            parent_key,
            chunk_index,
            reservation_token,
            event_type,
            model_name,
            worker_id,
            total_tokens,
            prompt_tokens,
            candidate_tokens,
            thoughts_tokens,
            payload,
            created_at
        ) VALUES (
            v_rec.project_id,
            v_rec.quota_scope,
            v_rec.user_id,
            v_rec.parent_key,
            v_rec.chunk_index,
            v_rec.reservation_token,
            'RECONCILE_STALE',
            v_rec.model_name,
            'sweeper',
            0,
            0,
            0,
            NULL,
            jsonb_build_object(
                'disposition', 'PRE_DISPATCH_SWEEPER_RELEASE',
                'reason', 'SWEEPER_EXPIRED_ACTIVE',
                'unconsumed_total_tokens', v_rec.estimated_tokens
            ),
            v_now
        );

        v_count := v_count + 1;
    END LOOP;

    -- 2. Expired in-flight 'dispatching' or 'dispatched' reservations -> transition to 'uncertain'
    -- Ambiguous dispatches are never automatically redispatched solely because a lease expires.
    FOR v_rec IN 
        SELECT reservation_token
        FROM public.rate_limit_reservations
        WHERE status IN ('dispatching', 'dispatched')
          AND v_now > lease_until
        ORDER BY lease_until ASC
        LIMIT (v_limit - v_count)
        FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE public.rate_limit_reservations
        SET status = 'uncertain',
            uncertain_at = v_now,
            reconcile_reason = 'SWEEPER_LEASE_EXPIRED_DURING_DISPATCH',
            reconcile_source = 'SWEEPER',
            updated_at = v_now
        WHERE reservation_token = v_rec.reservation_token;

        v_count := v_count + 1;
    END LOOP;

    RETURN QUERY SELECT v_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 17: ROUTINE 8 — reconcile_day_boundary_rollover (BOUNDED BATCHES)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_day_boundary_rollover(
    p_batch_size           INTEGER
)
RETURNS TABLE (
    reconciled_count       INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_limit                INTEGER;
    v_now                  TIMESTAMPTZ;
    v_current_pacific_date DATE;
    v_count                INTEGER := 0;
    v_rec                  RECORD;
BEGIN
    -- DEF-2: Caller Authorization & Role-Switching Protection
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

    -- Bounded batch size: clamped between 1 and 500 (default 100)
    v_limit := LEAST(GREATEST(COALESCE(p_batch_size, 100), 1), 500);
    v_now := clock_timestamp();
    v_current_pacific_date := (v_now AT TIME ZONE 'America/Los_Angeles')::date;

    FOR v_rec IN 
        SELECT reservation_token, project_id, quota_scope, user_id, parent_key, chunk_index, model_name, estimated_tokens
        FROM public.rate_limit_reservations
        WHERE status = 'active'
          AND v_current_pacific_date > quota_date_pacific
          AND v_now > lease_until
        ORDER BY created_at ASC
        LIMIT v_limit
        FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE public.rate_limit_reservations
        SET status = 'expired_day_boundary',
            reconciled_at = v_now,
            unconsumed_total_tokens = v_rec.estimated_tokens,
            overage_total_tokens = 0,
            reconcile_reason = 'PACIFIC_DAY_ROLLOVER_EXPIRED_ACTIVE',
            reconcile_source = 'ROLLOVER_SWEEPER',
            updated_at = v_now
        WHERE reservation_token = v_rec.reservation_token;

        INSERT INTO public.rate_limit_events (
            project_id,
            quota_scope,
            user_id,
            parent_key,
            chunk_index,
            reservation_token,
            event_type,
            model_name,
            worker_id,
            total_tokens,
            prompt_tokens,
            candidate_tokens,
            thoughts_tokens,
            payload,
            created_at
        ) VALUES (
            v_rec.project_id,
            v_rec.quota_scope,
            v_rec.user_id,
            v_rec.parent_key,
            v_rec.chunk_index,
            v_rec.reservation_token,
            'RECONCILE_DAY_BOUNDARY',
            v_rec.model_name,
            'sweeper',
            0,
            0,
            0,
            NULL,
            jsonb_build_object(
                'disposition', 'PACIFIC_DAY_ROLLOVER_EXPIRED_ACTIVE',
                'reason', 'PACIFIC_DAY_ROLLOVER_EXPIRED_ACTIVE',
                'unconsumed_total_tokens', v_rec.estimated_tokens
            ),
            v_now
        );

        v_count := v_count + 1;
    END LOOP;

    RETURN QUERY SELECT v_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 18: ADMINISTRATIVE RECONCILIATION ROUTINES (ROUTINES 9, 10, 11)
-- -----------------------------------------------------------------------------
-- ROUTINE 9: reconcile_uncertain_zero_usage (LOCK ORDER: Parent -> Reservation -> Ticket)
CREATE OR REPLACE FUNCTION public.reconcile_uncertain_zero_usage(
    p_ticket_id            UUID,
    p_reservation_token    UUID,
    p_admin_worker_id      VARCHAR,
    p_admin_reason         TEXT
)
RETURNS TABLE (
    success                BOOLEAN,
    status_code            TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_unlocked_user_id     UUID;
    v_unlocked_parent_key  VARCHAR(64);
    v_unlocked_chunk_index INTEGER;
    v_ticket               RECORD;
    v_parent_status        VARCHAR(20);
    v_res                  RECORD;
    v_now                  TIMESTAMPTZ;
BEGIN
    -- DEF-2: Restrict strictly to authorized administrative role or superuser
    IF NOT (
        session_user = 'service_role_admin' 
        OR pg_has_role(session_user, 'service_role_admin', 'MEMBER')
        OR (SELECT COALESCE(rolsuper, false) FROM pg_roles WHERE rolname = session_user)
    ) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Zero-usage reconciliation is restricted to authorized administrators (service_role_admin or superuser)' 
            USING ERRCODE = '42501';
    END IF;

    IF current_setting('role', true) IN ('authenticated', 'anon', 'service_role') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an application or worker role context' 
            USING ERRCODE = '42501';
    END IF;

    IF p_ticket_id IS NULL THEN
        RETURN QUERY SELECT FALSE, 'MISSING_TICKET_ID'::TEXT;
        RETURN;
    END IF;

    IF p_reservation_token IS NULL THEN
        RETURN QUERY SELECT FALSE, 'MISSING_RESERVATION_TOKEN'::TEXT;
        RETURN;
    END IF;

    IF p_admin_worker_id IS NULL OR trim(p_admin_worker_id) = '' THEN
        RETURN QUERY SELECT FALSE, 'MISSING_ADMIN_IDENTITY'::TEXT;
        RETURN;
    END IF;

    IF p_admin_reason IS NULL OR trim(p_admin_reason) = '' THEN
        RETURN QUERY SELECT FALSE, 'MISSING_ADMIN_REASON'::TEXT;
        RETURN;
    END IF;

    -- Step 1: Read reservation's parent coordinates without row lock
    SELECT user_id, parent_key, chunk_index
    INTO v_unlocked_user_id, v_unlocked_parent_key, v_unlocked_chunk_index
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    -- DEF-8 Universal Lock Order: Parent -> Reservation -> Ticket
    -- Step 2: Lock 1 — Lock Parent Generation Row
    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = v_unlocked_user_id AND key = v_unlocked_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'PARENT_GENERATION_NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    IF v_parent_status NOT IN ('processing', 'pending') THEN
        RETURN QUERY SELECT FALSE, 'INVALID_PARENT_STATE'::TEXT;
        RETURN;
    END IF;

    -- Step 3: Lock 2 — Lock Reservation Row
    SELECT * INTO v_res
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    -- Step 4: Lock 3 — Lock Pre-Registered Administrative Authorization Ticket
    SELECT * INTO v_ticket
    FROM public.reconciliation_authorizations
    WHERE ticket_id = p_ticket_id AND reservation_token = p_reservation_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'RECONCILIATION_TICKET_NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    v_now := clock_timestamp();

    IF v_ticket.status = 'CONSUMED' OR v_ticket.consumed_at IS NOT NULL THEN
        RETURN QUERY SELECT FALSE, 'TICKET_ALREADY_CONSUMED'::TEXT;
        RETURN;
    END IF;

    IF v_ticket.status = 'REVOKED' THEN
        RETURN QUERY SELECT FALSE, 'TICKET_ALREADY_REVOKED'::TEXT;
        RETURN;
    END IF;

    IF v_ticket.status = 'EXPIRED' THEN
        RETURN QUERY SELECT FALSE, 'TICKET_EXPIRED'::TEXT;
        RETURN;
    END IF;

    IF v_ticket.expires_at <= v_now THEN
        UPDATE public.reconciliation_authorizations
        SET status = 'EXPIRED'
        WHERE ticket_id = p_ticket_id AND status = 'ACTIVE';

        RETURN QUERY SELECT FALSE, 'TICKET_EXPIRED'::TEXT;
        RETURN;
    END IF;

    -- Step 5: Revalidate under acquired locks
    IF v_res.user_id IS DISTINCT FROM v_unlocked_user_id
       OR v_res.parent_key IS DISTINCT FROM v_unlocked_parent_key
       OR v_res.chunk_index IS DISTINCT FROM v_unlocked_chunk_index THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_IDENTITY_MISMATCH'::TEXT;
        RETURN;
    END IF;

    IF v_res.status IN ('committed', 'released', 'expired_day_boundary', 'reconciled_zero_usage') THEN
        RETURN QUERY SELECT FALSE, 'RESERVATION_ALREADY_TERMINAL'::TEXT;
        RETURN;
    END IF;

    IF v_res.status <> 'uncertain' THEN
        RETURN QUERY SELECT FALSE, 'INVALID_RESERVATION_STATE'::TEXT;
        RETURN;
    END IF;

    -- Atomic execution — Consume ticket and reconcile reservation to administrative waiver
    UPDATE public.reconciliation_authorizations
    SET status = 'CONSUMED',
        consumed_at = v_now,
        consumed_by = session_user
    WHERE ticket_id = p_ticket_id;

    -- Actual tokens remain NULL when usage cannot be verified.
    -- Released capacity is recorded as unconsumed_total_tokens. Evidence records ADMINISTRATIVE_WAIVER.
    UPDATE public.rate_limit_reservations
    SET status = 'reconciled_zero_usage',
        actual_total_tokens = NULL,
        actual_prompt_tokens = NULL,
        actual_candidate_tokens = NULL,
        actual_thoughts_tokens = NULL,
        unconsumed_total_tokens = v_res.estimated_tokens,
        overage_total_tokens = 0,
        reconciled_at = v_now,
        reconcile_reason = p_admin_reason,
        reconcile_evidence = jsonb_build_object(
            'disposition', 'ADMINISTRATIVE_WAIVER',
            'actual_usage_verified', false,
            'ticket_id', p_ticket_id,
            'authorized_by', v_ticket.authorized_by,
            'justification', v_ticket.justification,
            'external_audit_ref', v_ticket.external_audit_ref,
            'ticket_created_at', v_ticket.created_at,
            'admin_reason', p_admin_reason,
            'admin_worker_id', p_admin_worker_id,
            'operator_session_user', session_user,
            'reconciled_at', v_now,
            'estimated_tokens_waived', v_res.estimated_tokens
        ),
        reconcile_source = 'ADMIN_AUTHORIZATION',
        updated_at = v_now
    WHERE reservation_token = p_reservation_token;

    -- Audit event inserted; dispatching_at is NOT touched, preserving RPD/RPM
    INSERT INTO public.rate_limit_events (
        project_id,
        quota_scope,
        user_id,
        parent_key,
        chunk_index,
        reservation_token,
        event_type,
        model_name,
        worker_id,
        total_tokens,
        prompt_tokens,
        candidate_tokens,
        thoughts_tokens,
        payload,
        created_at
    ) VALUES (
        v_res.project_id,
        v_res.quota_scope,
        v_res.user_id,
        v_res.parent_key,
        v_res.chunk_index,
        p_reservation_token,
        'RECONCILE_ZERO_USAGE',
        v_res.model_name,
        p_admin_worker_id,
        NULL,
        NULL,
        NULL,
        NULL,
        jsonb_build_object(
            'disposition', 'ADMINISTRATIVE_WAIVER',
            'actual_usage_verified', false,
            'ticket_id', p_ticket_id,
            'authorized_by', v_ticket.authorized_by,
            'external_audit_ref', v_ticket.external_audit_ref,
            'admin_reason', p_admin_reason,
            'admin_worker_id', p_admin_worker_id,
            'operator_session_user', session_user,
            'estimated_tokens_waived', v_res.estimated_tokens
        ),
        v_now
    );

    RETURN QUERY SELECT TRUE, 'SUCCESS'::TEXT;
END;
$$;

-- ROUTINE 10: create_reconciliation_authorization (DEF-6 & DEF-7 SAFE TICKET REISSUANCE)
CREATE OR REPLACE FUNCTION public.create_reconciliation_authorization(
    p_reservation_token    UUID,
    p_authorized_by        VARCHAR,
    p_justification        TEXT,
    p_external_audit_ref   VARCHAR
)
RETURNS TABLE (
    ticket_id              UUID,
    success                BOOLEAN,
    status_code            TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_ticket_id            UUID;
    v_unlocked_user_id     UUID;
    v_unlocked_parent_key  VARCHAR(64);
    v_parent_status        VARCHAR(20);
    v_res                  RECORD;
    v_now                  TIMESTAMPTZ;
BEGIN
    -- DEF-2: Restrict strictly to service_role_admin or superuser
    IF NOT (
        session_user = 'service_role_admin' 
        OR pg_has_role(session_user, 'service_role_admin', 'MEMBER')
        OR (SELECT COALESCE(rolsuper, false) FROM pg_roles WHERE rolname = session_user)
    ) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Ticket creation is restricted to service_role_admin' 
            USING ERRCODE = '42501';
    END IF;

    IF current_setting('role', true) IN ('authenticated', 'anon', 'service_role') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an application or worker role context' 
            USING ERRCODE = '42501';
    END IF;

    IF p_reservation_token IS NULL THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'MISSING_RESERVATION_TOKEN'::TEXT;
        RETURN;
    END IF;

    IF p_authorized_by IS NULL OR trim(p_authorized_by) = '' THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'MISSING_AUTHORIZED_BY'::TEXT;
        RETURN;
    END IF;

    IF char_length(p_authorized_by) > 64 THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'INVALID_AUTHORIZED_BY_LENGTH'::TEXT;
        RETURN;
    END IF;

    IF p_justification IS NULL OR trim(p_justification) = '' THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'MISSING_JUSTIFICATION'::TEXT;
        RETURN;
    END IF;

    IF p_external_audit_ref IS NULL OR trim(p_external_audit_ref) = '' THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'MISSING_EXTERNAL_AUDIT_REF'::TEXT;
        RETURN;
    END IF;

    IF char_length(p_external_audit_ref) > 255 THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'INVALID_EXTERNAL_AUDIT_REF_LENGTH'::TEXT;
        RETURN;
    END IF;

    -- Step 1: Snapshot coordinates without row lock
    SELECT user_id, parent_key INTO v_unlocked_user_id, v_unlocked_parent_key
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'RESERVATION_NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    -- DEF-7 Universal Lock Order: Lock Parent -> Lock Reservation
    -- Step 2: Lock Parent Generation Row
    SELECT status INTO v_parent_status
    FROM public.generation_idempotency
    WHERE user_id = v_unlocked_user_id AND key = v_unlocked_parent_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'PARENT_GENERATION_NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    IF v_parent_status NOT IN ('processing', 'pending') THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'INVALID_PARENT_STATE'::TEXT;
        RETURN;
    END IF;

    -- Step 3: Lock Reservation Row
    SELECT * INTO v_res
    FROM public.rate_limit_reservations
    WHERE reservation_token = p_reservation_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'RESERVATION_NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    IF v_res.user_id IS DISTINCT FROM v_unlocked_user_id 
       OR v_res.parent_key IS DISTINCT FROM v_unlocked_parent_key THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'RESERVATION_COORDINATE_MISMATCH'::TEXT;
        RETURN;
    END IF;

    IF v_res.status <> 'uncertain' THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'RESERVATION_NOT_UNCERTAIN'::TEXT;
        RETURN;
    END IF;

    -- DEF-6: Explicitly lock existing ACTIVE tickets for this reservation before capturing timestamp
    PERFORM ra.ticket_id
    FROM public.reconciliation_authorizations AS ra
    WHERE ra.reservation_token = p_reservation_token 
      AND ra.status = 'ACTIVE'
    ORDER BY ra.ticket_id
    FOR UPDATE;

    v_now := clock_timestamp();

    -- DEF-6: Transition any expired-but-still-ACTIVE tickets to EXPIRED before inserting replacement
    UPDATE public.reconciliation_authorizations
    SET status = 'EXPIRED'
    WHERE reservation_token = p_reservation_token 
      AND status = 'ACTIVE' 
      AND expires_at <= v_now;

    -- DEF-6: Prevent duplicate active tickets while allowing replacement of expired or revoked tickets
    IF EXISTS (
        SELECT 1 FROM public.reconciliation_authorizations
        WHERE reservation_token = p_reservation_token 
          AND status = 'ACTIVE'
    ) THEN
        RETURN QUERY SELECT NULL::UUID, FALSE, 'ACTIVE_TICKET_EXISTS'::TEXT;
        RETURN;
    END IF;

    v_ticket_id := gen_random_uuid();

    -- DEF-6: Concurrency Protection — Catch concurrent ticket insertions and return controlled status
    BEGIN
        INSERT INTO public.reconciliation_authorizations (
            ticket_id,
            reservation_token,
            authorized_by,
            justification,
            external_audit_ref,
            created_at,
            expires_at,
            status
        ) VALUES (
            v_ticket_id,
            p_reservation_token,
            p_authorized_by,
            p_justification,
            p_external_audit_ref,
            v_now,
            v_now + '00:15:00'::interval,
            'ACTIVE'
        );
    EXCEPTION
        WHEN unique_violation THEN
            RETURN QUERY SELECT NULL::UUID, FALSE, 'CONCURRENT_ACTIVE_TICKET_CONFLICT'::TEXT;
            RETURN;
    END;

    RETURN QUERY SELECT v_ticket_id, TRUE, 'SUCCESS'::TEXT;
END;
$$;

-- ROUTINE 11: revoke_reconciliation_authorization (TICKET REVOCATION WITHOUT AUDIT LOSS)
CREATE OR REPLACE FUNCTION public.revoke_reconciliation_authorization(
    p_ticket_id            UUID,
    p_revoke_reason        TEXT
)
RETURNS TABLE (
    success                BOOLEAN,
    status_code            TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
    v_ticket               RECORD;
    v_now                  TIMESTAMPTZ;
BEGIN
    -- DEF-2: Restrict strictly to service_role_admin or superuser
    IF NOT (
        session_user = 'service_role_admin' 
        OR pg_has_role(session_user, 'service_role_admin', 'MEMBER')
        OR (SELECT COALESCE(rolsuper, false) FROM pg_roles WHERE rolname = session_user)
    ) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Ticket revocation is restricted to service_role_admin' 
            USING ERRCODE = '42501';
    END IF;

    IF current_setting('role', true) IN ('authenticated', 'anon', 'service_role') THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Routine cannot be executed in an application or worker role context' 
            USING ERRCODE = '42501';
    END IF;

    IF p_ticket_id IS NULL THEN
        RETURN QUERY SELECT FALSE, 'MISSING_TICKET_ID'::TEXT;
        RETURN;
    END IF;

    IF p_revoke_reason IS NULL OR trim(p_revoke_reason) = '' THEN
        RETURN QUERY SELECT FALSE, 'MISSING_REVOKE_REASON'::TEXT;
        RETURN;
    END IF;

    SELECT * INTO v_ticket
    FROM public.reconciliation_authorizations
    WHERE ticket_id = p_ticket_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'TICKET_NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    v_now := clock_timestamp();

    IF v_ticket.status = 'CONSUMED' THEN
        RETURN QUERY SELECT FALSE, 'TICKET_ALREADY_CONSUMED'::TEXT;
        RETURN;
    END IF;

    IF v_ticket.status = 'REVOKED' THEN
        RETURN QUERY SELECT FALSE, 'TICKET_ALREADY_REVOKED'::TEXT;
        RETURN;
    END IF;

    IF v_ticket.status = 'EXPIRED' THEN
        RETURN QUERY SELECT FALSE, 'TICKET_ALREADY_EXPIRED'::TEXT;
        RETURN;
    END IF;

    IF v_ticket.expires_at <= v_now THEN
        UPDATE public.reconciliation_authorizations
        SET status = 'EXPIRED'
        WHERE ticket_id = p_ticket_id AND status = 'ACTIVE';

        RETURN QUERY SELECT FALSE, 'TICKET_ALREADY_EXPIRED'::TEXT;
        RETURN;
    END IF;

    UPDATE public.reconciliation_authorizations
    SET status = 'REVOKED',
        revoked_at = v_now,
        revoked_by = session_user,
        revoked_reason = p_revoke_reason
    WHERE ticket_id = p_ticket_id;

    RETURN QUERY SELECT TRUE, 'SUCCESS'::TEXT;
END;
$$;

-- -----------------------------------------------------------------------------
-- SECTION 19: ROUTINE PRIVILEGES, OWNERSHIP & HARDENING
-- -----------------------------------------------------------------------------
-- DEF-1 & DEF-2: Assign all 11 routines to dedicated non-login role codenotes_definer
ALTER FUNCTION public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL) OWNER TO codenotes_definer;
ALTER FUNCTION public.mark_reservation_dispatching(UUID, UUID, VARCHAR, INTEGER, INTERVAL) OWNER TO codenotes_definer;
ALTER FUNCTION public.complete_chunk_and_commit_quota(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR) OWNER TO codenotes_definer;
ALTER FUNCTION public.renew_uncertain_lease(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, INTERVAL) OWNER TO codenotes_definer;
ALTER FUNCTION public.release_quota_reservation(UUID, UUID, VARCHAR, INTEGER) OWNER TO codenotes_definer;
ALTER FUNCTION public.release_aborted_dispatch(UUID, UUID, VARCHAR, INTEGER, TEXT) OWNER TO codenotes_definer;
ALTER FUNCTION public.reconcile_stale_reservations(INTEGER) OWNER TO codenotes_definer;
ALTER FUNCTION public.reconcile_day_boundary_rollover(INTEGER) OWNER TO codenotes_definer;
ALTER FUNCTION public.reconcile_uncertain_zero_usage(UUID, UUID, VARCHAR, TEXT) OWNER TO codenotes_definer;
ALTER FUNCTION public.create_reconciliation_authorization(UUID, VARCHAR, TEXT, VARCHAR) OWNER TO codenotes_definer;
ALTER FUNCTION public.revoke_reconciliation_authorization(UUID, TEXT) OWNER TO codenotes_definer;

-- DEF-3 & DEF-7: Scoped ACL Sanitization strictly to exact routine identities
DO $$
DECLARE
    v_target_routines TEXT[] := ARRAY[
        'public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL)',
        'public.mark_reservation_dispatching(UUID, UUID, VARCHAR, INTEGER, INTERVAL)',
        'public.complete_chunk_and_commit_quota(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR)',
        'public.renew_uncertain_lease(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, INTERVAL)',
        'public.release_quota_reservation(UUID, UUID, VARCHAR, INTEGER)',
        'public.release_aborted_dispatch(UUID, UUID, VARCHAR, INTEGER, TEXT)',
        'public.reconcile_stale_reservations(INTEGER)',
        'public.reconcile_day_boundary_rollover(INTEGER)',
        'public.reconcile_uncertain_zero_usage(UUID, UUID, VARCHAR, TEXT)',
        'public.create_reconciliation_authorization(UUID, VARCHAR, TEXT, VARCHAR)',
        'public.revoke_reconciliation_authorization(UUID, TEXT)'
    ];
    v_routine TEXT;
    v_acl RECORD;
BEGIN
    FOREACH v_routine IN ARRAY v_target_routines LOOP
        FOR v_acl IN
            SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee
            FROM pg_proc p
            CROSS JOIN aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            LEFT JOIN pg_roles r ON r.oid = a.grantee
            WHERE p.oid = v_routine::regprocedure
        LOOP
            IF v_acl.grantee = 'PUBLIC' THEN
                EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_routine);
            ELSE
                EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_routine, v_acl.grantee);
            END IF;
        END LOOP;
    END LOOP;
END $$;

-- DEF-7: Explicit fallback revocation ensuring baseline security
REVOKE ALL ON FUNCTION public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL) FROM PUBLIC, anon, authenticated, service_role, service_role_admin;
REVOKE ALL ON FUNCTION public.mark_reservation_dispatching(UUID, UUID, VARCHAR, INTEGER, INTERVAL) FROM PUBLIC, anon, authenticated, service_role, service_role_admin;
REVOKE ALL ON FUNCTION public.complete_chunk_and_commit_quota(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR) FROM PUBLIC, anon, authenticated, service_role, service_role_admin;
REVOKE ALL ON FUNCTION public.renew_uncertain_lease(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, INTERVAL) FROM PUBLIC, anon, authenticated, service_role, service_role_admin;
REVOKE ALL ON FUNCTION public.release_quota_reservation(UUID, UUID, VARCHAR, INTEGER) FROM PUBLIC, anon, authenticated, service_role, service_role_admin;
REVOKE ALL ON FUNCTION public.release_aborted_dispatch(UUID, UUID, VARCHAR, INTEGER, TEXT) FROM PUBLIC, anon, authenticated, service_role, service_role_admin;
REVOKE ALL ON FUNCTION public.reconcile_stale_reservations(INTEGER) FROM PUBLIC, anon, authenticated, service_role, service_role_admin;
REVOKE ALL ON FUNCTION public.reconcile_day_boundary_rollover(INTEGER) FROM PUBLIC, anon, authenticated, service_role, service_role_admin;
REVOKE ALL ON FUNCTION public.reconcile_uncertain_zero_usage(UUID, UUID, VARCHAR, TEXT) FROM PUBLIC, anon, authenticated, service_role, service_role_admin;
REVOKE ALL ON FUNCTION public.create_reconciliation_authorization(UUID, VARCHAR, TEXT, VARCHAR) FROM PUBLIC, anon, authenticated, service_role, service_role_admin;
REVOKE ALL ON FUNCTION public.revoke_reconciliation_authorization(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role, service_role_admin;

DO $$
BEGIN
    -- Grant standard worker lifecycle routines (1-8) strictly to application backend role
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL) TO service_role;
        GRANT EXECUTE ON FUNCTION public.mark_reservation_dispatching(UUID, UUID, VARCHAR, INTEGER, INTERVAL) TO service_role;
        GRANT EXECUTE ON FUNCTION public.complete_chunk_and_commit_quota(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR) TO service_role;
        GRANT EXECUTE ON FUNCTION public.renew_uncertain_lease(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, INTERVAL) TO service_role;
        GRANT EXECUTE ON FUNCTION public.release_quota_reservation(UUID, UUID, VARCHAR, INTEGER) TO service_role;
        GRANT EXECUTE ON FUNCTION public.release_aborted_dispatch(UUID, UUID, VARCHAR, INTEGER, TEXT) TO service_role;
        GRANT EXECUTE ON FUNCTION public.reconcile_stale_reservations(INTEGER) TO service_role;
        GRANT EXECUTE ON FUNCTION public.reconcile_day_boundary_rollover(INTEGER) TO service_role;
    END IF;

    -- Grant administrative routines (9, 10, 11) strictly to admin role
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role_admin') THEN
        GRANT EXECUTE ON FUNCTION public.reconcile_uncertain_zero_usage(UUID, UUID, VARCHAR, TEXT) TO service_role_admin;
        GRANT EXECUTE ON FUNCTION public.create_reconciliation_authorization(UUID, VARCHAR, TEXT, VARCHAR) TO service_role_admin;
        GRANT EXECUTE ON FUNCTION public.revoke_reconciliation_authorization(UUID, TEXT) TO service_role_admin;
    END IF;
END $$;

-- DEF-1: Revoke CREATE on schema public from codenotes_definer post-transfer (retain only USAGE at runtime)
REVOKE CREATE ON SCHEMA public FROM codenotes_definer;
GRANT USAGE ON SCHEMA public TO codenotes_definer;

-- -----------------------------------------------------------------------------
-- SECTION 20: COMPREHENSIVE POSTFLIGHT INVARIANT & COMPATIBILITY VALIDATION
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_idx RECORD;
    v_con RECORD;
    v_table TEXT;
    v_tables TEXT[] := ARRAY[
        'generation_idempotency',
        'project_quota_configs',
        'rate_limit_reservations',
        'rate_limit_events',
        'chunk_generations',
        'reconciliation_authorizations'
    ];
    v_actual_cols TEXT[];
    
    -- 1. Exact Column Specifications: format 'name:type:typmod:notnull'
    -- typmod for varchar(N) is N + 4; -1 for unconstrained/primitive types
    v_exp_cols_idemp TEXT[] := ARRAY[
        'user_id:uuid:-1:true',
        'key:varchar:68:true',
        'status:varchar:24:true',
        'video_id:varchar:259:false',
        'video_url:text:-1:false',
        'note_id:uuid:-1:false',
        'error_message:text:-1:false',
        'error_code:varchar:104:false',
        'attempts:int4:-1:false',
        'lease_until:timestamptz:-1:false',
        'processing_owner:varchar:259:false',
        'created_at:timestamptz:-1:false',
        'updated_at:timestamptz:-1:false'
    ];

    v_exp_cols_configs TEXT[] := ARRAY[
        'project_id:varchar:68:true',
        'quota_scope:varchar:68:true',
        'max_active_dispatches:int4:-1:true',
        'max_rpm:int4:-1:true',
        'max_tpm:int4:-1:true',
        'max_rpd:int4:-1:true',
        'updated_at:timestamptz:-1:true'
    ];

    v_exp_cols_res TEXT[] := ARRAY[
        'reservation_token:uuid:-1:true',
        'project_id:varchar:68:true',
        'quota_scope:varchar:68:true',
        'user_id:uuid:-1:true',
        'parent_key:varchar:68:true',
        'chunk_index:int4:-1:true',
        'model_name:varchar:68:true',
        'lease_token:uuid:-1:true',
        'worker_id:varchar:259:true',
        'generation:int4:-1:true',
        'status:varchar:34:true',
        'estimated_tokens:int4:-1:true',
        'actual_total_tokens:int4:-1:false',
        'actual_prompt_tokens:int4:-1:false',
        'actual_candidate_tokens:int4:-1:false',
        'actual_thoughts_tokens:int4:-1:false',
        'unconsumed_total_tokens:int4:-1:false',
        'overage_total_tokens:int4:-1:false',
        'lease_until:timestamptz:-1:true',
        'dispatching_at:timestamptz:-1:false',
        'dispatched_at:timestamptz:-1:false',
        'uncertain_at:timestamptz:-1:false',
        'committed_at:timestamptz:-1:false',
        'released_at:timestamptz:-1:false',
        'reconciled_at:timestamptz:-1:false',
        'reconcile_reason:text:-1:false',
        'reconcile_evidence:jsonb:-1:false',
        'reconcile_source:varchar:34:false',
        'quota_date_pacific:date:-1:true',
        'created_at:timestamptz:-1:true',
        'updated_at:timestamptz:-1:true'
    ];

    v_exp_cols_events TEXT[] := ARRAY[
        'event_id:uuid:-1:true',
        'project_id:varchar:68:true',
        'quota_scope:varchar:68:true',
        'user_id:uuid:-1:true',
        'parent_key:varchar:68:true',
        'chunk_index:int4:-1:true',
        'reservation_token:uuid:-1:true',
        'event_type:varchar:34:true',
        'model_name:varchar:68:true',
        'worker_id:varchar:259:true',
        'total_tokens:int4:-1:false',
        'prompt_tokens:int4:-1:false',
        'candidate_tokens:int4:-1:false',
        'thoughts_tokens:int4:-1:false',
        'payload:jsonb:-1:true',
        'created_at:timestamptz:-1:true'
    ];

    v_exp_cols_chunks TEXT[] := ARRAY[
        'chunk_id:uuid:-1:true',
        'user_id:uuid:-1:true',
        'parent_key:varchar:68:true',
        'chunk_index:int4:-1:true',
        'reservation_token:uuid:-1:true',
        'status:varchar:24:true',
        'model_name:varchar:68:true',
        'total_tokens:int4:-1:true',
        'prompt_tokens:int4:-1:true',
        'candidate_tokens:int4:-1:true',
        'thoughts_tokens:int4:-1:false',
        'chunk_notes:jsonb:-1:true',
        'completed_at:timestamptz:-1:true',
        'created_at:timestamptz:-1:true'
    ];

    v_exp_cols_tickets TEXT[] := ARRAY[
        'ticket_id:uuid:-1:true',
        'reservation_token:uuid:-1:true',
        'authorized_by:varchar:68:true',
        'justification:text:-1:true',
        'external_audit_ref:varchar:259:true',
        'created_at:timestamptz:-1:true',
        'expires_at:timestamptz:-1:true',
        'consumed_at:timestamptz:-1:false',
        'consumed_by:varchar:259:false',
        'revoked_at:timestamptz:-1:false',
        'revoked_by:varchar:68:false',
        'revoked_reason:text:-1:false',
        'status:varchar:24:true'
    ];

    v_worker_routines TEXT[] := ARRAY[
        'public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL)',
        'public.mark_reservation_dispatching(UUID, UUID, VARCHAR, INTEGER, INTERVAL)',
        'public.complete_chunk_and_commit_quota(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR)',
        'public.renew_uncertain_lease(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, INTERVAL)',
        'public.release_quota_reservation(UUID, UUID, VARCHAR, INTEGER)',
        'public.release_aborted_dispatch(UUID, UUID, VARCHAR, INTEGER, TEXT)',
        'public.reconcile_stale_reservations(INTEGER)',
        'public.reconcile_day_boundary_rollover(INTEGER)'
    ];
    v_admin_routines TEXT[] := ARRAY[
        'public.reconcile_uncertain_zero_usage(UUID, UUID, VARCHAR, TEXT)',
        'public.create_reconciliation_authorization(UUID, VARCHAR, TEXT, VARCHAR)',
        'public.revoke_reconciliation_authorization(UUID, TEXT)'
    ];
    v_r TEXT;
    v_pol RECORD;
    v_acl RECORD;
    v_pk_cols TEXT[];
    v_actual_statuses TEXT[];
    v_actual_events TEXT[];
    v_actual_ticket_statuses TEXT[];
    v_actual_pred_statuses TEXT[];
    v_count INTEGER;
    v_def TEXT;
    v_pred TEXT;
    v_expr TEXT;
    v_convalidated BOOLEAN;
    v_actual_checks TEXT[];
    v_exp_checks_unqualified TEXT[] := ARRAY[
        'chunk_generations:chunk_generations_candidate_tokens_check',
        'chunk_generations:chunk_generations_chunk_index_check',
        'chunk_generations:chunk_generations_prompt_tokens_check',
        'chunk_generations:chunk_generations_thoughts_tokens_check',
        'chunk_generations:chunk_generations_total_tokens_check',
        'project_quota_configs:project_quota_configs_max_active_dispatches_check',
        'project_quota_configs:project_quota_configs_max_rpd_check',
        'project_quota_configs:project_quota_configs_max_rpm_check',
        'project_quota_configs:project_quota_configs_max_tpm_check',
        'rate_limit_events:chk_event_type',
        'rate_limit_events:rate_limit_events_candidate_tokens_check',
        'rate_limit_events:rate_limit_events_chunk_index_check',
        'rate_limit_events:rate_limit_events_prompt_tokens_check',
        'rate_limit_events:rate_limit_events_thoughts_tokens_check',
        'rate_limit_events:rate_limit_events_total_tokens_check',
        'rate_limit_reservations:chk_reservation_status',
        'rate_limit_reservations:rate_limit_reservations_actual_candidate_tokens_check',
        'rate_limit_reservations:rate_limit_reservations_actual_prompt_tokens_check',
        'rate_limit_reservations:rate_limit_reservations_actual_thoughts_tokens_check',
        'rate_limit_reservations:rate_limit_reservations_actual_total_tokens_check',
        'rate_limit_reservations:rate_limit_reservations_chunk_index_check',
        'rate_limit_reservations:rate_limit_reservations_estimated_tokens_check',
        'rate_limit_reservations:rate_limit_reservations_generation_check',
        'rate_limit_reservations:rate_limit_reservations_overage_total_tokens_check',
        'rate_limit_reservations:rate_limit_reservations_unconsumed_total_tokens_check',
        'reconciliation_authorizations:chk_ticket_status'
    ];
    v_exp_checks_qualified TEXT[] := ARRAY[
        'public.chunk_generations:chunk_generations_candidate_tokens_check',
        'public.chunk_generations:chunk_generations_chunk_index_check',
        'public.chunk_generations:chunk_generations_prompt_tokens_check',
        'public.chunk_generations:chunk_generations_thoughts_tokens_check',
        'public.chunk_generations:chunk_generations_total_tokens_check',
        'public.project_quota_configs:project_quota_configs_max_active_dispatches_check',
        'public.project_quota_configs:project_quota_configs_max_rpd_check',
        'public.project_quota_configs:project_quota_configs_max_rpm_check',
        'public.project_quota_configs:project_quota_configs_max_tpm_check',
        'public.rate_limit_events:chk_event_type',
        'public.rate_limit_events:rate_limit_events_candidate_tokens_check',
        'public.rate_limit_events:rate_limit_events_chunk_index_check',
        'public.rate_limit_events:rate_limit_events_prompt_tokens_check',
        'public.rate_limit_events:rate_limit_events_thoughts_tokens_check',
        'public.rate_limit_events:rate_limit_events_total_tokens_check',
        'public.rate_limit_reservations:chk_reservation_status',
        'public.rate_limit_reservations:rate_limit_reservations_actual_candidate_tokens_check',
        'public.rate_limit_reservations:rate_limit_reservations_actual_prompt_tokens_check',
        'public.rate_limit_reservations:rate_limit_reservations_actual_thoughts_tokens_check',
        'public.rate_limit_reservations:rate_limit_reservations_actual_total_tokens_check',
        'public.rate_limit_reservations:rate_limit_reservations_chunk_index_check',
        'public.rate_limit_reservations:rate_limit_reservations_estimated_tokens_check',
        'public.rate_limit_reservations:rate_limit_reservations_generation_check',
        'public.rate_limit_reservations:rate_limit_reservations_overage_total_tokens_check',
        'public.rate_limit_reservations:rate_limit_reservations_unconsumed_total_tokens_check',
        'public.reconciliation_authorizations:chk_ticket_status'
    ];
BEGIN
    -- 1. DEF-1 & DEF-4: Validate all 6 tables exist with RLS enabled and forced
    FOREACH v_table IN ARRAY v_tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c 
            JOIN pg_namespace n ON n.oid = c.relnamespace 
            WHERE n.nspname = 'public' AND c.relname = v_table 
              AND c.relrowsecurity = TRUE AND c.relforcerowsecurity = TRUE
        ) THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Table public.% lacks ENABLE/FORCE ROW LEVEL SECURITY.' , v_table USING ERRCODE = '42501';
        END IF;
    END LOOP;

    -- 2. Phase 1Q: Exact Catalog Column Inventory, Data Type, typmod, and Nullability Validation
    -- A. generation_idempotency
    SELECT array_agg(format('%s:%s:%s:%s', a.attname, t.typname, a.atttypmod, CASE WHEN a.attnotnull THEN 'true' ELSE 'false' END) ORDER BY a.attnum)
    INTO v_actual_cols
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relname = 'generation_idempotency' AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_actual_cols <> v_exp_cols_idemp THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: generation_idempotency column spec mismatch. Expected: %, Got: %',
            v_exp_cols_idemp, v_actual_cols USING ERRCODE = '42703';
    END IF;

    -- B. project_quota_configs
    SELECT array_agg(format('%s:%s:%s:%s', a.attname, t.typname, a.atttypmod, CASE WHEN a.attnotnull THEN 'true' ELSE 'false' END) ORDER BY a.attnum)
    INTO v_actual_cols
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relname = 'project_quota_configs' AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_actual_cols <> v_exp_cols_configs THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: project_quota_configs column spec mismatch. Expected: %, Got: %',
            v_exp_cols_configs, v_actual_cols USING ERRCODE = '42703';
    END IF;

    -- C. rate_limit_reservations
    SELECT array_agg(format('%s:%s:%s:%s', a.attname, t.typname, a.atttypmod, CASE WHEN a.attnotnull THEN 'true' ELSE 'false' END) ORDER BY a.attnum)
    INTO v_actual_cols
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relname = 'rate_limit_reservations' AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_actual_cols <> v_exp_cols_res THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_reservations column spec mismatch. Expected: %, Got: %',
            v_exp_cols_res, v_actual_cols USING ERRCODE = '42703';
    END IF;

    -- D. rate_limit_events
    SELECT array_agg(format('%s:%s:%s:%s', a.attname, t.typname, a.atttypmod, CASE WHEN a.attnotnull THEN 'true' ELSE 'false' END) ORDER BY a.attnum)
    INTO v_actual_cols
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relname = 'rate_limit_events' AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_actual_cols <> v_exp_cols_events THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_events column spec mismatch. Expected: %, Got: %',
            v_exp_cols_events, v_actual_cols USING ERRCODE = '42703';
    END IF;

    -- E. chunk_generations
    SELECT array_agg(format('%s:%s:%s:%s', a.attname, t.typname, a.atttypmod, CASE WHEN a.attnotnull THEN 'true' ELSE 'false' END) ORDER BY a.attnum)
    INTO v_actual_cols
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relname = 'chunk_generations' AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_actual_cols <> v_exp_cols_chunks THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: chunk_generations column spec mismatch. Expected: %, Got: %',
            v_exp_cols_chunks, v_actual_cols USING ERRCODE = '42703';
    END IF;

    -- F. reconciliation_authorizations
    SELECT array_agg(format('%s:%s:%s:%s', a.attname, t.typname, a.atttypmod, CASE WHEN a.attnotnull THEN 'true' ELSE 'false' END) ORDER BY a.attnum)
    INTO v_actual_cols
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relname = 'reconciliation_authorizations' AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_actual_cols <> v_exp_cols_tickets THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: reconciliation_authorizations column spec mismatch. Expected: %, Got: %',
            v_exp_cols_tickets, v_actual_cols USING ERRCODE = '42703';
    END IF;

    -- 3. Phase 1Q: Exact Primary Key Constraints & Ordered Key Columns Validation
    FOREACH v_table IN ARRAY v_tables LOOP
        SELECT array_agg(a.attname ORDER BY u.attpos) INTO v_pk_cols
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
        WHERE n.nspname = 'public' AND cl.relname = v_table AND c.contype = 'p';

        IF v_table = 'generation_idempotency' AND v_pk_cols <> ARRAY['user_id', 'key'] THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: generation_idempotency PK mismatch: %', v_pk_cols USING ERRCODE = '42P16';
        ELSIF v_table = 'project_quota_configs' AND v_pk_cols <> ARRAY['project_id', 'quota_scope'] THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: project_quota_configs PK mismatch: %', v_pk_cols USING ERRCODE = '42P16';
        ELSIF v_table = 'rate_limit_reservations' AND v_pk_cols <> ARRAY['reservation_token'] THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_reservations PK mismatch: %', v_pk_cols USING ERRCODE = '42P16';
        ELSIF v_table = 'rate_limit_events' AND v_pk_cols <> ARRAY['event_id'] THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_events PK mismatch: %', v_pk_cols USING ERRCODE = '42P16';
        ELSIF v_table = 'chunk_generations' AND v_pk_cols <> ARRAY['chunk_id'] THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: chunk_generations PK mismatch: %', v_pk_cols USING ERRCODE = '42P16';
        ELSIF v_table = 'reconciliation_authorizations' AND v_pk_cols <> ARRAY['ticket_id'] THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: reconciliation_authorizations PK mismatch: %', v_pk_cols USING ERRCODE = '42P16';
        END IF;
    END LOOP;

    -- 4. Phase 1Q: Exact Unique Constraints on chunk_generations
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = 'chunk_generations' AND c.contype = 'u'
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) = ARRAY['reservation_token']
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = 'chunk_generations' AND c.contype = 'u'
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) = ARRAY['user_id', 'parent_key', 'chunk_index']
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: chunk_generations unique constraints missing or incorrect.' USING ERRCODE = '42P16';
    END IF;

    -- 5. Phase 1S: Exact Foreign Key Constraints & Referential Actions via Relation OIDs
    -- 1. rate_limit_reservations -> generation_idempotency
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.rate_limit_reservations'::regclass
          AND c.confrelid = 'public.generation_idempotency'::regclass
          AND c.contype = 'f' AND c.confdeltype = 'r' AND c.confupdtype = 'a' AND c.convalidated = TRUE
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) = ARRAY['user_id', 'parent_key']
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum) = ARRAY['user_id', 'key']
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Foreign key rate_limit_reservations -> generation_idempotency invalid or not validated.' USING ERRCODE = '42830';
    END IF;

    -- 2. rate_limit_events -> rate_limit_reservations
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.rate_limit_events'::regclass
          AND c.confrelid = 'public.rate_limit_reservations'::regclass
          AND c.contype = 'f' AND c.confdeltype = 'r' AND c.confupdtype = 'a' AND c.convalidated = TRUE
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) = ARRAY['reservation_token']
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum) = ARRAY['reservation_token']
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Foreign key rate_limit_events -> rate_limit_reservations invalid or not validated.' USING ERRCODE = '42830';
    END IF;

    -- 3. chunk_generations -> generation_idempotency
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.chunk_generations'::regclass
          AND c.confrelid = 'public.generation_idempotency'::regclass
          AND c.contype = 'f' AND c.confdeltype = 'r' AND c.confupdtype = 'a' AND c.convalidated = TRUE
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) = ARRAY['user_id', 'parent_key']
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum) = ARRAY['user_id', 'key']
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Foreign key chunk_generations -> generation_idempotency invalid or not validated.' USING ERRCODE = '42830';
    END IF;

    -- 4. chunk_generations -> rate_limit_reservations
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.chunk_generations'::regclass
          AND c.confrelid = 'public.rate_limit_reservations'::regclass
          AND c.contype = 'f' AND c.confdeltype = 'r' AND c.confupdtype = 'a' AND c.convalidated = TRUE
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) = ARRAY['reservation_token']
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum) = ARRAY['reservation_token']
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Foreign key chunk_generations -> rate_limit_reservations invalid or not validated.' USING ERRCODE = '42830';
    END IF;

    -- 5. reconciliation_authorizations -> rate_limit_reservations
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.reconciliation_authorizations'::regclass
          AND c.confrelid = 'public.rate_limit_reservations'::regclass
          AND c.contype = 'f' AND c.confdeltype = 'r' AND c.confupdtype = 'a' AND c.convalidated = TRUE
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) = ARRAY['reservation_token']
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum) = ARRAY['reservation_token']
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Foreign key reconciliation_authorizations -> rate_limit_reservations invalid or not validated.' USING ERRCODE = '42830';
    END IF;

    -- 6. Phase 1T: Exact Check Constraint Inventory, Validation State & Semantic Invariants
    FOR v_con IN
        SELECT c.conname, cl.relname, c.convalidated
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        WHERE c.conrelid IN (
            'public.project_quota_configs'::regclass,
            'public.rate_limit_reservations'::regclass,
            'public.rate_limit_events'::regclass,
            'public.chunk_generations'::regclass,
            'public.reconciliation_authorizations'::regclass
        )
        AND c.contype = 'c'
    LOOP
        IF NOT v_con.convalidated THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Check constraint %.% is not validated.', v_con.relname, v_con.conname USING ERRCODE = '42804';
        END IF;
    END LOOP;

    -- Enforce exact individual inventory of all 26 check constraints across the five adaptive tables
    SELECT array_agg(format('%s:%s', c.conrelid::regclass, c.conname) ORDER BY format('%s:%s', c.conrelid::regclass, c.conname))
    INTO v_actual_checks
    FROM pg_constraint c
    WHERE c.conrelid IN (
        'public.project_quota_configs'::regclass,
        'public.rate_limit_reservations'::regclass,
        'public.rate_limit_events'::regclass,
        'public.chunk_generations'::regclass,
        'public.reconciliation_authorizations'::regclass
    )
    AND c.contype = 'c';

    IF v_actual_checks <> v_exp_checks_unqualified AND v_actual_checks <> v_exp_checks_qualified THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Exact check constraint inventory mismatch across adaptive tables.' USING ERRCODE = '42804';
    END IF;

    -- Secondary check: exact total count of 26 check constraints
    IF (
        SELECT count(*)
        FROM pg_constraint c
        WHERE c.conrelid IN (
            'public.project_quota_configs'::regclass,
            'public.rate_limit_reservations'::regclass,
            'public.rate_limit_events'::regclass,
            'public.chunk_generations'::regclass,
            'public.reconciliation_authorizations'::regclass
        )
        AND c.contype = 'c'
    ) <> 26 THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Expected exactly 26 check constraints across adaptive tables, found %', (
            SELECT count(*) FROM pg_constraint WHERE conrelid IN ('public.project_quota_configs'::regclass, 'public.rate_limit_reservations'::regclass, 'public.rate_limit_events'::regclass, 'public.chunk_generations'::regclass, 'public.reconciliation_authorizations'::regclass) AND contype = 'c'
        ) USING ERRCODE = '42804';
    END IF;

    -- C. Validate exact complete expressions for the 23 scalar, range, and nullable token check constraints
    FOR v_con IN
        SELECT c.conname, c.conrelid::regclass::text AS relname, pg_get_expr(c.conbin, c.conrelid, false) AS expr, c.convalidated
        FROM pg_constraint c
        WHERE c.conrelid IN (
            'public.project_quota_configs'::regclass,
            'public.rate_limit_reservations'::regclass,
            'public.rate_limit_events'::regclass,
            'public.chunk_generations'::regclass
        )
        AND c.contype = 'c'
        AND c.conname NOT IN ('chk_reservation_status', 'chk_event_type')
    LOOP
        IF NOT v_con.convalidated THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Check constraint % is not validated.', v_con.conname USING ERRCODE = '42804';
        END IF;

        IF v_con.conname = 'project_quota_configs_max_active_dispatches_check' AND v_con.expr <> '(max_active_dispatches > 0)' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'project_quota_configs_max_rpm_check' AND v_con.expr <> '(max_rpm > 0)' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'project_quota_configs_max_tpm_check' AND v_con.expr <> '(max_tpm > 0)' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'project_quota_configs_max_rpd_check' AND v_con.expr <> '(max_rpd > 0)' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname IN ('chunk_generations_chunk_index_check', 'rate_limit_events_chunk_index_check', 'rate_limit_reservations_chunk_index_check')
              AND v_con.expr <> '((chunk_index >= 0) AND (chunk_index < 100))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_reservations_generation_check' AND v_con.expr <> '(generation >= 1)' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_reservations_estimated_tokens_check' AND v_con.expr <> '(estimated_tokens > 0)' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'chunk_generations_total_tokens_check' AND v_con.expr <> '(total_tokens >= 0)' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'chunk_generations_prompt_tokens_check' AND v_con.expr <> '(prompt_tokens >= 0)' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'chunk_generations_candidate_tokens_check' AND v_con.expr <> '(candidate_tokens >= 0)' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_reservations_actual_total_tokens_check' AND v_con.expr <> '((actual_total_tokens IS NULL) OR (actual_total_tokens >= 0))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_reservations_actual_prompt_tokens_check' AND v_con.expr <> '((actual_prompt_tokens IS NULL) OR (actual_prompt_tokens >= 0))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_reservations_actual_candidate_tokens_check' AND v_con.expr <> '((actual_candidate_tokens IS NULL) OR (actual_candidate_tokens >= 0))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_reservations_actual_thoughts_tokens_check' AND v_con.expr <> '((actual_thoughts_tokens IS NULL) OR (actual_thoughts_tokens >= 0))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_reservations_unconsumed_total_tokens_check' AND v_con.expr <> '((unconsumed_total_tokens IS NULL) OR (unconsumed_total_tokens >= 0))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_reservations_overage_total_tokens_check' AND v_con.expr <> '((overage_total_tokens IS NULL) OR (overage_total_tokens >= 0))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_events_total_tokens_check' AND v_con.expr <> '((total_tokens IS NULL) OR (total_tokens >= 0))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_events_prompt_tokens_check' AND v_con.expr <> '((prompt_tokens IS NULL) OR (prompt_tokens >= 0))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_events_candidate_tokens_check' AND v_con.expr <> '((candidate_tokens IS NULL) OR (candidate_tokens >= 0))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'rate_limit_events_thoughts_tokens_check' AND v_con.expr <> '((thoughts_tokens IS NULL) OR (thoughts_tokens >= 0))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        ELSIF v_con.conname = 'chunk_generations_thoughts_tokens_check' AND v_con.expr <> '((thoughts_tokens IS NULL) OR (thoughts_tokens >= 0))' THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Constraint % expression invalid: %', v_con.conname, v_con.expr USING ERRCODE = '42804';
        END IF;
    END LOOP;

    -- D. Exact complete semantic validation for rate_limit_reservations.chk_reservation_status (8 canonical statuses)
    SELECT pg_get_expr(c.conbin, c.conrelid, false), c.convalidated
    INTO v_expr, v_convalidated
    FROM pg_constraint c
    WHERE c.conrelid = 'public.rate_limit_reservations'::regclass
      AND c.conname = 'chk_reservation_status'
      AND c.contype = 'c';

    IF v_expr IS NULL OR NOT v_convalidated THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_reservations.chk_reservation_status missing or not validated.' USING ERRCODE = '42804';
    END IF;

    -- Reject IS NULL / IS NOT NULL suffixes or bypasses (closes Negative Tests 1 & 2)
    IF v_expr ~* '\mIS\s+(NOT\s+)?NULL\M' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_reservations.chk_reservation_status contains unauthorized IS [NOT] NULL clause: %', v_expr USING ERRCODE = '42804';
    END IF;

    -- Reject logical bypasses, extra disjunctions, conjunctions, or inequalities
    IF v_expr ~* '\mOR\M' OR v_expr ~* '\mAND\M' OR v_expr ~ '[<>]|!=' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_reservations.chk_reservation_status contains unauthorized logical branching or inequality operators: %', v_expr USING ERRCODE = '42804';
    END IF;

    -- Validate complete end-to-end expression structure: must be strictly ANY/IN membership on status
    IF v_expr !~* '^\(\(?\(?status\)?(?:::text)?\s*=\s*ANY\s*\((ARRAY\[.+\](?:::text\[\])?|\(ARRAY\[.+\]\)::text\[\])\)\)$' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_reservations.chk_reservation_status complete expression structure invalid: %', v_expr USING ERRCODE = '42804';
    END IF;

    SELECT ARRAY(
        SELECT DISTINCT m[1]
        FROM regexp_matches(v_expr, '''([A-Za-z0-9_]+)''', 'g') AS m
        ORDER BY 1
    ) INTO v_actual_statuses;

    IF v_actual_statuses <> ARRAY['active', 'committed', 'dispatched', 'dispatching', 'expired_day_boundary', 'reconciled_zero_usage', 'released', 'uncertain'] THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_reservations.chk_reservation_status semantic mismatch. Expected: %, Got: %',
            ARRAY['active', 'committed', 'dispatched', 'dispatching', 'expired_day_boundary', 'reconciled_zero_usage', 'released', 'uncertain'],
            v_actual_statuses USING ERRCODE = '42804';
    END IF;

    -- E. Exact complete semantic validation for rate_limit_events.chk_event_type (7 canonical event types)
    SELECT pg_get_expr(c.conbin, c.conrelid, false), c.convalidated
    INTO v_expr, v_convalidated
    FROM pg_constraint c
    WHERE c.conrelid = 'public.rate_limit_events'::regclass
      AND c.conname = 'chk_event_type'
      AND c.contype = 'c';

    IF v_expr IS NULL OR NOT v_convalidated THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_events.chk_event_type missing or not validated.' USING ERRCODE = '42804';
    END IF;

    IF v_expr ~* '\mIS\s+(NOT\s+)?NULL\M' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_events.chk_event_type contains unauthorized IS [NOT] NULL clause: %', v_expr USING ERRCODE = '42804';
    END IF;

    IF v_expr ~* '\mOR\M' OR v_expr ~* '\mAND\M' OR v_expr ~ '[<>]|!=' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_events.chk_event_type contains unauthorized logical branching or inequality operators: %', v_expr USING ERRCODE = '42804';
    END IF;

    IF v_expr !~* '^\(\(?\(?event_type\)?(?:::text)?\s*=\s*ANY\s*\((ARRAY\[.+\](?:::text\[\])?|\(ARRAY\[.+\]\)::text\[\])\)\)$' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_events.chk_event_type complete expression structure invalid: %', v_expr USING ERRCODE = '42804';
    END IF;

    SELECT ARRAY(
        SELECT DISTINCT m[1]
        FROM regexp_matches(v_expr, '''([A-Za-z0-9_]+)''', 'g') AS m
        ORDER BY 1
    ) INTO v_actual_events;

    IF v_actual_events <> ARRAY['COMMIT', 'RECONCILE_DAY_BOUNDARY', 'RECONCILE_STALE', 'RECONCILE_ZERO', 'RECONCILE_ZERO_USAGE', 'RELEASE', 'RESERVE'] THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: rate_limit_events.chk_event_type semantic mismatch. Expected: %, Got: %',
            ARRAY['COMMIT', 'RECONCILE_DAY_BOUNDARY', 'RECONCILE_STALE', 'RECONCILE_ZERO', 'RECONCILE_ZERO_USAGE', 'RELEASE', 'RESERVE'],
            v_actual_events USING ERRCODE = '42804';
    END IF;

    -- F. Exact complete semantic validation for reconciliation_authorizations.chk_ticket_status (4 canonical statuses)
    SELECT pg_get_expr(c.conbin, c.conrelid, false), c.convalidated
    INTO v_expr, v_convalidated
    FROM pg_constraint c
    WHERE c.conrelid = 'public.reconciliation_authorizations'::regclass
      AND c.conname = 'chk_ticket_status'
      AND c.contype = 'c';

    IF v_expr IS NULL OR NOT v_convalidated THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: reconciliation_authorizations.chk_ticket_status missing or not validated.' USING ERRCODE = '42804';
    END IF;

    IF v_expr ~* '\mIS\s+(NOT\s+)?NULL\M' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: reconciliation_authorizations.chk_ticket_status contains unauthorized IS [NOT] NULL clause: %', v_expr USING ERRCODE = '42804';
    END IF;

    IF v_expr ~* '\mOR\M' OR v_expr ~* '\mAND\M' OR v_expr ~ '[<>]|!=' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: reconciliation_authorizations.chk_ticket_status contains unauthorized logical branching or inequality operators: %', v_expr USING ERRCODE = '42804';
    END IF;

    IF v_expr !~* '^\(\(?\(?status\)?(?:::text)?\s*=\s*ANY\s*\((ARRAY\[.+\](?:::text\[\])?|\(ARRAY\[.+\]\)::text\[\])\)\)$' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: reconciliation_authorizations.chk_ticket_status complete expression structure invalid: %', v_expr USING ERRCODE = '42804';
    END IF;

    SELECT ARRAY(
        SELECT DISTINCT m[1]
        FROM regexp_matches(v_expr, '''([A-Za-z0-9_]+)''', 'g') AS m
        ORDER BY 1
    ) INTO v_actual_ticket_statuses;

    IF v_actual_ticket_statuses <> ARRAY['ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED'] THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: reconciliation_authorizations.chk_ticket_status semantic mismatch. Expected: %, Got: %',
            ARRAY['ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED'],
            v_actual_ticket_statuses USING ERRCODE = '42804';
    END IF;

    -- 7. Phase 1S: Column Default Expressions Scoped by Relation OID via pg_attrdef
    IF NOT EXISTS (
        SELECT 1 FROM pg_attrdef ad
        JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        WHERE ad.adrelid = 'public.rate_limit_reservations'::regclass AND a.attname = 'reservation_token'
          AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%gen_random_uuid%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_attrdef ad
        JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        WHERE ad.adrelid = 'public.rate_limit_reservations'::regclass AND a.attname = 'quota_date_pacific'
          AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%America/Los_Angeles%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_attrdef ad
        JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        WHERE ad.adrelid = 'public.rate_limit_events'::regclass AND a.attname = 'event_id'
          AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%gen_random_uuid%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_attrdef ad
        JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        WHERE ad.adrelid = 'public.chunk_generations'::regclass AND a.attname = 'chunk_id'
          AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%gen_random_uuid%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_attrdef ad
        JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        WHERE ad.adrelid = 'public.reconciliation_authorizations'::regclass AND a.attname = 'ticket_id'
          AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%gen_random_uuid%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_attrdef ad
        JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        WHERE ad.adrelid = 'public.reconciliation_authorizations'::regclass AND a.attname = 'expires_at'
          AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%00:15:00%'
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: One or more column default expressions are missing or incorrect.' USING ERRCODE = '42804';
    END IF;

    -- 8. Phase 1T: Comprehensive Exact Index Validation (association, keys, include, am, unique, validity, predicate)
    -- Index 1: idx_reservations_active_unique (Partial Unique Index)
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE c.oid = 'public.idx_reservations_active_unique'::regclass
          AND i.indrelid = 'public.rate_limit_reservations'::regclass
          AND am.amname = 'btree'
          AND i.indisunique = TRUE
          AND i.indisvalid = TRUE
          AND i.indisready = TRUE
          AND i.indislive = TRUE
          AND i.indnkeyatts = 3 AND i.indnatts = 3
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) = ARRAY['user_id', 'parent_key', 'chunk_index']
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Index public.idx_reservations_active_unique structure or validity mismatch.' USING ERRCODE = '42809';
    END IF;

    SELECT pg_get_expr(i.indpred, i.indrelid)
    INTO v_pred
    FROM pg_index i
    WHERE i.indexrelid = 'public.idx_reservations_active_unique'::regclass
      AND i.indrelid = 'public.rate_limit_reservations'::regclass;

    IF v_pred IS NULL THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: idx_reservations_active_unique predicate missing.' USING ERRCODE = '42809';
    END IF;

    -- Explicitly reject IS NULL / IS NOT NULL clauses (closes Negative Tests 3 & 4)
    IF v_pred ~* '\mIS\s+(NOT\s+)?NULL\M' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: idx_reservations_active_unique predicate contains unauthorized IS [NOT] NULL clause: %', v_pred USING ERRCODE = '42809';
    END IF;

    -- Reject extra conjunctions, disjunctions, and inequalities (closes False-Pass Case 2)
    IF v_pred ~* '\mAND\M' OR v_pred ~* '\mOR\M' OR v_pred ~ '[<>]|!=' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: idx_reservations_active_unique predicate contains unauthorized conjunctions, disjunctions, or inequalities: %', v_pred USING ERRCODE = '42809';
    END IF;

    -- Complete end-to-end anchored predicate expression validation (^...$)
    IF v_pred !~* '^\(\(?\(?status\)?(?:::text)?\s*=\s*ANY\s*\((ARRAY\[.+\](?:::text\[\])?|\(ARRAY\[.+\]\)::text\[\])\)\)$' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: idx_reservations_active_unique complete predicate expression structure invalid: %', v_pred USING ERRCODE = '42809';
    END IF;

    SELECT ARRAY(
        SELECT DISTINCT m[1]
        FROM regexp_matches(v_pred, '''([A-Za-z0-9_]+)''', 'g') AS m
        ORDER BY 1
    ) INTO v_actual_pred_statuses;

    IF v_actual_pred_statuses <> ARRAY['active', 'committed', 'dispatched', 'dispatching', 'uncertain'] THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: idx_reservations_active_unique predicate literal mismatch. Expected: %, Got: %',
            ARRAY['active', 'committed', 'dispatched', 'dispatching', 'uncertain'],
            v_actual_pred_statuses USING ERRCODE = '42809';
    END IF;

    -- Index 2: idx_reservations_active_concurrency
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE c.oid = 'public.idx_reservations_active_concurrency'::regclass
          AND i.indrelid = 'public.rate_limit_reservations'::regclass
          AND am.amname = 'btree'
          AND i.indisunique = FALSE
          AND i.indisvalid = TRUE
          AND i.indisready = TRUE
          AND i.indislive = TRUE
          AND i.indnkeyatts = 4 AND i.indnatts = 4
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) = ARRAY['project_id', 'quota_scope', 'status', 'lease_until']
          AND i.indpred IS NULL
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Index public.idx_reservations_active_concurrency definition mismatch.' USING ERRCODE = '42809';
    END IF;

    -- Index 3: idx_reservations_tpm_window
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE c.oid = 'public.idx_reservations_tpm_window'::regclass
          AND i.indrelid = 'public.rate_limit_reservations'::regclass
          AND am.amname = 'btree'
          AND i.indisunique = FALSE
          AND i.indisvalid = TRUE
          AND i.indisready = TRUE
          AND i.indislive = TRUE
          AND i.indnkeyatts = 5 AND i.indnatts = 5
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) = ARRAY['project_id', 'quota_scope', 'status', 'dispatching_at', 'lease_until']
          AND i.indpred IS NULL
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Index public.idx_reservations_tpm_window definition mismatch.' USING ERRCODE = '42809';
    END IF;

    -- Index 4: idx_reservations_pacific_rpd
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE c.oid = 'public.idx_reservations_pacific_rpd'::regclass
          AND i.indrelid = 'public.rate_limit_reservations'::regclass
          AND am.amname = 'btree'
          AND i.indisunique = FALSE
          AND i.indisvalid = TRUE
          AND i.indisready = TRUE
          AND i.indislive = TRUE
          AND i.indnkeyatts = 3 AND i.indnatts = 3
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) = ARRAY['project_id', 'quota_scope', 'dispatching_at']
          AND i.indpred IS NULL
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Index public.idx_reservations_pacific_rpd definition mismatch.' USING ERRCODE = '42809';
    END IF;

    -- Index 5: idx_reservations_stale_sweeper
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE c.oid = 'public.idx_reservations_stale_sweeper'::regclass
          AND i.indrelid = 'public.rate_limit_reservations'::regclass
          AND am.amname = 'btree'
          AND i.indisunique = FALSE
          AND i.indisvalid = TRUE
          AND i.indisready = TRUE
          AND i.indislive = TRUE
          AND i.indnkeyatts = 2 AND i.indnatts = 2
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) = ARRAY['status', 'lease_until']
          AND i.indpred IS NULL
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Index public.idx_reservations_stale_sweeper definition mismatch.' USING ERRCODE = '42809';
    END IF;

    -- Index 6: idx_events_project_tpm_window
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE c.oid = 'public.idx_events_project_tpm_window'::regclass
          AND i.indrelid = 'public.rate_limit_events'::regclass
          AND am.amname = 'btree'
          AND i.indisunique = FALSE
          AND i.indisvalid = TRUE
          AND i.indisready = TRUE
          AND i.indislive = TRUE
          AND i.indnkeyatts = 4 AND i.indnatts = 4
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) = ARRAY['project_id', 'event_type', 'created_at', 'total_tokens']
          AND i.indpred IS NULL
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Index public.idx_events_project_tpm_window definition mismatch.' USING ERRCODE = '42809';
    END IF;

    -- Index 7: idx_chunk_generations_lookup
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE c.oid = 'public.idx_chunk_generations_lookup'::regclass
          AND i.indrelid = 'public.chunk_generations'::regclass
          AND am.amname = 'btree'
          AND i.indisunique = FALSE
          AND i.indisvalid = TRUE
          AND i.indisready = TRUE
          AND i.indislive = TRUE
          AND i.indnkeyatts = 3 AND i.indnatts = 3
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) = ARRAY['user_id', 'parent_key', 'chunk_index']
          AND i.indpred IS NULL
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Index public.idx_chunk_generations_lookup definition mismatch.' USING ERRCODE = '42809';
    END IF;

    -- Index 8: idx_reconciliation_auth_active_unique (Partial Unique Index)
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE c.oid = 'public.idx_reconciliation_auth_active_unique'::regclass
          AND i.indrelid = 'public.reconciliation_authorizations'::regclass
          AND am.amname = 'btree'
          AND i.indisunique = TRUE
          AND i.indisvalid = TRUE
          AND i.indisready = TRUE
          AND i.indislive = TRUE
          AND i.indnkeyatts = 1 AND i.indnatts = 1
          AND (SELECT array_agg(a.attname::text ORDER BY u.attpos) FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, attpos) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) = ARRAY['reservation_token']
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Index public.idx_reconciliation_auth_active_unique structure or validity mismatch.' USING ERRCODE = '42809';
    END IF;

    SELECT pg_get_expr(i.indpred, i.indrelid)
    INTO v_pred
    FROM pg_index i
    WHERE i.indexrelid = 'public.idx_reconciliation_auth_active_unique'::regclass
      AND i.indrelid = 'public.reconciliation_authorizations'::regclass;

    IF v_pred IS NULL THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: idx_reconciliation_auth_active_unique predicate missing.' USING ERRCODE = '42809';
    END IF;

    -- Explicitly reject IS NULL / IS NOT NULL clauses (closes Negative Tests 3 & 4)
    IF v_pred ~* '\mIS\s+(NOT\s+)?NULL\M' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: idx_reconciliation_auth_active_unique predicate contains unauthorized IS [NOT] NULL clause: %', v_pred USING ERRCODE = '42809';
    END IF;

    IF v_pred ~* '\mAND\M' OR v_pred ~* '\mOR\M' OR v_pred ~ '[<>]|!=' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: idx_reconciliation_auth_active_unique predicate contains unauthorized branching or inequalities: %', v_pred USING ERRCODE = '42809';
    END IF;

    -- Complete end-to-end anchored predicate expression validation (^...$)
    IF v_pred !~* '^\(\(?\(?status\)?(?:::text)?\s*=\s*''ACTIVE''(?:::text)?\)$' THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: idx_reconciliation_auth_active_unique complete predicate expression structure invalid: %', v_pred USING ERRCODE = '42809';
    END IF;

    SELECT ARRAY(
        SELECT DISTINCT m[1]
        FROM regexp_matches(v_pred, '''([A-Za-z0-9_]+)''', 'g') AS m
        ORDER BY 1
    ) INTO v_actual_pred_statuses;

    IF v_actual_pred_statuses <> ARRAY['ACTIVE'] THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: idx_reconciliation_auth_active_unique predicate literal mismatch. Expected: %, Got: %',
            ARRAY['ACTIVE'],
            v_actual_pred_statuses USING ERRCODE = '42809';
    END IF;

    -- Enforce exact inventory of 8 supporting btree indexes (must be valid, ready, live)
    IF (
        SELECT count(*)
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN (
              'idx_reservations_active_unique',
              'idx_reservations_active_concurrency',
              'idx_reservations_tpm_window',
              'idx_reservations_pacific_rpd',
              'idx_reservations_stale_sweeper',
              'idx_events_project_tpm_window',
              'idx_chunk_generations_lookup',
              'idx_reconciliation_auth_active_unique'
          )
          AND i.indisvalid = TRUE
          AND i.indisready = TRUE
          AND i.indislive = TRUE
    ) <> 8 THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Supporting index inventory mismatch. Expected exactly 8 valid, ready, live indexes.' USING ERRCODE = '42704';
    END IF;

    -- 9. Phase 1T: Exact Security Triggers (table association, function OID, timing, scope, event mask, enabled state, unconditional qualification, zero args)
    -- Trigger 1: trg_protect_reservation_quota_date (BEFORE UPDATE ROW)
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger trg
        WHERE trg.tgrelid = 'public.rate_limit_reservations'::regclass
          AND trg.tgname = 'trg_protect_reservation_quota_date'
          AND trg.tgfoid = 'public.protect_reservation_quota_date()'::regprocedure
          AND trg.tgenabled = 'O'
          AND trg.tgtype = 19
          AND NOT trg.tgisinternal
          AND trg.tgqual IS NULL
          AND trg.tgnargs = 0
          AND octet_length(trg.tgargs) = 0
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Trigger public.trg_protect_reservation_quota_date definition mismatch.' USING ERRCODE = '42704';
    END IF;

    -- Trigger 2: trg_rate_limit_events_append_only (BEFORE UPDATE OR DELETE ROW)
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger trg
        WHERE trg.tgrelid = 'public.rate_limit_events'::regclass
          AND trg.tgname = 'trg_rate_limit_events_append_only'
          AND trg.tgfoid = 'public.prevent_audit_event_tampering()'::regprocedure
          AND trg.tgenabled = 'O'
          AND trg.tgtype = 27
          AND NOT trg.tgisinternal
          AND trg.tgqual IS NULL
          AND trg.tgnargs = 0
          AND octet_length(trg.tgargs) = 0
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Trigger public.trg_rate_limit_events_append_only definition mismatch.' USING ERRCODE = '42704';
    END IF;

    -- Trigger 3: trg_protect_reconciliation_ticket (BEFORE UPDATE OR DELETE ROW)
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger trg
        WHERE trg.tgrelid = 'public.reconciliation_authorizations'::regclass
          AND trg.tgname = 'trg_protect_reconciliation_ticket'
          AND trg.tgfoid = 'public.protect_reconciliation_ticket()'::regprocedure
          AND trg.tgenabled = 'O'
          AND trg.tgtype = 27
          AND NOT trg.tgisinternal
          AND trg.tgqual IS NULL
          AND trg.tgnargs = 0
          AND octet_length(trg.tgargs) = 0
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Trigger public.trg_protect_reconciliation_ticket definition mismatch.' USING ERRCODE = '42704';
    END IF;

    -- Enforce exact inventory of 3 security triggers across adaptive tables
    IF (
        SELECT count(*)
        FROM pg_trigger trg
        WHERE trg.tgrelid IN (
            'public.rate_limit_reservations'::regclass,
            'public.rate_limit_events'::regclass,
            'public.reconciliation_authorizations'::regclass
        )
        AND NOT trg.tgisinternal
    ) <> 3 THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Security trigger count mismatch. Expected exactly 3.' USING ERRCODE = '42704';
    END IF;

    -- 10. DEF-1, DEF-2 & DEF-3: Validate codenotes_definer ownership on exact routine identities
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.oid = ANY(ARRAY[
            'public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL)'::regprocedure,
            'public.mark_reservation_dispatching(UUID, UUID, VARCHAR, INTEGER, INTERVAL)'::regprocedure,
            'public.complete_chunk_and_commit_quota(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR)'::regprocedure,
            'public.renew_uncertain_lease(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, INTERVAL)'::regprocedure,
            'public.release_quota_reservation(UUID, UUID, VARCHAR, INTEGER)'::regprocedure,
            'public.release_aborted_dispatch(UUID, UUID, VARCHAR, INTEGER, TEXT)'::regprocedure,
            'public.reconcile_stale_reservations(INTEGER)'::regprocedure,
            'public.reconcile_day_boundary_rollover(INTEGER)'::regprocedure,
            'public.reconcile_uncertain_zero_usage(UUID, UUID, VARCHAR, TEXT)'::regprocedure,
            'public.create_reconciliation_authorization(UUID, VARCHAR, TEXT, VARCHAR)'::regprocedure,
            'public.revoke_reconciliation_authorization(UUID, TEXT)'::regprocedure
        ])
        AND r.rolname <> 'codenotes_definer'
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: One or more target routines are not owned by codenotes_definer.' USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'codenotes_definer'
          AND (rolcanlogin = true OR rolsuper = true OR rolcreaterole = true OR rolcreatedb = true OR rolbypassrls = true)
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Role codenotes_definer has unsafe attributes.' USING ERRCODE = '42501';
    END IF;

    IF has_schema_privilege('codenotes_definer', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Role codenotes_definer unexpectedly retains CREATE privilege on schema public.' USING ERRCODE = '42501';
    END IF;

    -- 11. Phase 1T: Validate Explicit Internal RLS Policies (exact polroles equality, polpermissive, table association, cmd, USING and WITH CHECK)
    IF NOT EXISTS (
        SELECT 1 FROM pg_policy pol
        WHERE pol.polname = 'p_codenotes_definer_parent'
          AND pol.polrelid = 'public.generation_idempotency'::regclass
          AND pol.polcmd = '*'
          AND pol.polpermissive = true
          AND pol.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'codenotes_definer')]
          AND pg_get_expr(pol.polqual, pol.polrelid) = 'true'
          AND pg_get_expr(pol.polwithcheck, pol.polrelid) = 'true'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy pol
        WHERE pol.polname = 'p_codenotes_definer_configs'
          AND pol.polrelid = 'public.project_quota_configs'::regclass
          AND pol.polcmd = '*'
          AND pol.polpermissive = true
          AND pol.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'codenotes_definer')]
          AND pg_get_expr(pol.polqual, pol.polrelid) = 'true'
          AND pg_get_expr(pol.polwithcheck, pol.polrelid) = 'true'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy pol
        WHERE pol.polname = 'p_codenotes_definer_reservations'
          AND pol.polrelid = 'public.rate_limit_reservations'::regclass
          AND pol.polcmd = '*'
          AND pol.polpermissive = true
          AND pol.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'codenotes_definer')]
          AND pg_get_expr(pol.polqual, pol.polrelid) = 'true'
          AND pg_get_expr(pol.polwithcheck, pol.polrelid) = 'true'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy pol
        WHERE pol.polname = 'p_codenotes_definer_events'
          AND pol.polrelid = 'public.rate_limit_events'::regclass
          AND pol.polcmd = '*'
          AND pol.polpermissive = true
          AND pol.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'codenotes_definer')]
          AND pg_get_expr(pol.polqual, pol.polrelid) = 'true'
          AND pg_get_expr(pol.polwithcheck, pol.polrelid) = 'true'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy pol
        WHERE pol.polname = 'p_codenotes_definer_chunks'
          AND pol.polrelid = 'public.chunk_generations'::regclass
          AND pol.polcmd = '*'
          AND pol.polpermissive = true
          AND pol.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'codenotes_definer')]
          AND pg_get_expr(pol.polqual, pol.polrelid) = 'true'
          AND pg_get_expr(pol.polwithcheck, pol.polrelid) = 'true'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_policy pol
        WHERE pol.polname = 'p_codenotes_definer_tickets'
          AND pol.polrelid = 'public.reconciliation_authorizations'::regclass
          AND pol.polcmd = '*'
          AND pol.polpermissive = true
          AND pol.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'codenotes_definer')]
          AND pg_get_expr(pol.polqual, pol.polrelid) = 'true'
          AND pg_get_expr(pol.polwithcheck, pol.polrelid) = 'true'
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: One or more codenotes_definer RLS policies are missing or have incorrect table/role/permissive/expression associations.' USING ERRCODE = '42501';
    END IF;

    -- B. Enforce exact policy inventory on the 5 NEW adaptive tables (strictly 1 policy per table = exactly 5 policies total, ANY NAME)
    --    Closes Negative Test 7: Rejects any unexpected or extra policy with any name on the five new adaptive tables
    IF (
        SELECT count(*)
        FROM pg_policy pol
        WHERE pol.polrelid IN (
            'public.project_quota_configs'::regclass,
            'public.rate_limit_reservations'::regclass,
            'public.rate_limit_events'::regclass,
            'public.chunk_generations'::regclass,
            'public.reconciliation_authorizations'::regclass
        )
    ) <> 5 THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Unexpected or missing policies on new adaptive tables. Exactly 5 policies expected across the 5 adaptive relations.' USING ERRCODE = '42501';
    END IF;

    -- C. Reject ANY permissive policy granted to PUBLIC across all 6 adaptive tables (including generation_idempotency)
    --    In PostgreSQL, a policy granted to PUBLIC has polroles = '{0}' or 0 = ANY(polroles)
    --    Closes Negative Test 6: Rejects additional permissive PUBLIC policies with arbitrary names
    IF EXISTS (
        SELECT 1 FROM pg_policy pol
        WHERE pol.polrelid IN (
            'public.generation_idempotency'::regclass,
            'public.project_quota_configs'::regclass,
            'public.rate_limit_reservations'::regclass,
            'public.rate_limit_events'::regclass,
            'public.chunk_generations'::regclass,
            'public.reconciliation_authorizations'::regclass
        )
        AND pol.polpermissive = true
        AND (0 = ANY(pol.polroles) OR pol.polroles = '{0}' OR pol.polroles IS NULL)
    ) THEN
        RAISE EXCEPTION 'POSTMIGRATION_FAILED: Unauthorized permissive PUBLIC policy detected on adaptive or parent relations.' USING ERRCODE = '42501';
    END IF;

    -- D. Legitimate pre-existing parent policies on generation_idempotency are retained and respected (Negative Test 8)
    --    Any existing policies on generation_idempotency not granted to PUBLIC remain fully functional.

    -- 14. DEF-7: Comprehensive 55-Point Effective Routine Privilege Isolation Validation
    -- A. Validate all 8 worker routines
    FOREACH v_r IN ARRAY v_worker_routines LOOP
        IF NOT has_function_privilege('service_role', v_r, 'EXECUTE') THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: service_role lacks EXECUTE on worker routine %', v_r USING ERRCODE = '42501';
        END IF;
        IF has_function_privilege('service_role_admin', v_r, 'EXECUTE') THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: service_role_admin unexpectedly possesses EXECUTE on worker routine %', v_r USING ERRCODE = '42501';
        END IF;
        IF has_function_privilege('anon', v_r, 'EXECUTE') THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: anon unexpectedly possesses EXECUTE on worker routine %', v_r USING ERRCODE = '42501';
        END IF;
        IF has_function_privilege('authenticated', v_r, 'EXECUTE') THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: authenticated unexpectedly possesses EXECUTE on worker routine %', v_r USING ERRCODE = '42501';
        END IF;
        -- DEF-7: Valid inspection of PUBLIC pseudo-role via aclexplode (grantee OID 0)
        IF EXISTS (
            SELECT 1 FROM pg_proc p
            CROSS JOIN aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = v_r::regprocedure
              AND a.grantee = 0
              AND a.privilege_type = 'EXECUTE'
        ) THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: PUBLIC pseudo-role unexpectedly possesses EXECUTE on worker routine %', v_r USING ERRCODE = '42501';
        END IF;
    END LOOP;

    -- B. Validate all 3 administrative routines
    FOREACH v_r IN ARRAY v_admin_routines LOOP
        IF NOT has_function_privilege('service_role_admin', v_r, 'EXECUTE') THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: service_role_admin lacks EXECUTE on admin routine %', v_r USING ERRCODE = '42501';
        END IF;
        IF has_function_privilege('service_role', v_r, 'EXECUTE') THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: service_role unexpectedly possesses EXECUTE on admin routine %', v_r USING ERRCODE = '42501';
        END IF;
        IF has_function_privilege('anon', v_r, 'EXECUTE') THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: anon unexpectedly possesses EXECUTE on admin routine %', v_r USING ERRCODE = '42501';
        END IF;
        IF has_function_privilege('authenticated', v_r, 'EXECUTE') THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: authenticated unexpectedly possesses EXECUTE on admin routine %', v_r USING ERRCODE = '42501';
        END IF;
        -- DEF-7: Valid inspection of PUBLIC pseudo-role via aclexplode (grantee OID 0)
        IF EXISTS (
            SELECT 1 FROM pg_proc p
            CROSS JOIN aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = v_r::regprocedure
              AND a.grantee = 0
              AND a.privilege_type = 'EXECUTE'
        ) THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: PUBLIC pseudo-role unexpectedly possesses EXECUTE on admin routine %', v_r USING ERRCODE = '42501';
        END IF;
    END LOOP;

    -- 15. DEF-3 & DEF-7: Exhaustive Function ACL Audit on exact routine identities
    FOR v_acl IN
        SELECT p.proname, COALESCE(r.rolname, 'PUBLIC') AS grantee
        FROM pg_proc p
        CROSS JOIN aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        LEFT JOIN pg_roles r ON r.oid = a.grantee
        WHERE p.oid = ANY(ARRAY[
            'public.reserve_quota(UUID, VARCHAR, INTEGER, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTERVAL)'::regprocedure,
            'public.mark_reservation_dispatching(UUID, UUID, VARCHAR, INTEGER, INTERVAL)'::regprocedure,
            'public.complete_chunk_and_commit_quota(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, JSONB, INTEGER, INTEGER, INTEGER, INTEGER, VARCHAR)'::regprocedure,
            'public.renew_uncertain_lease(UUID, VARCHAR, INTEGER, UUID, UUID, VARCHAR, INTEGER, INTERVAL)'::regprocedure,
            'public.release_quota_reservation(UUID, UUID, VARCHAR, INTEGER)'::regprocedure,
            'public.release_aborted_dispatch(UUID, UUID, VARCHAR, INTEGER, TEXT)'::regprocedure,
            'public.reconcile_stale_reservations(INTEGER)'::regprocedure,
            'public.reconcile_day_boundary_rollover(INTEGER)'::regprocedure,
            'public.reconcile_uncertain_zero_usage(UUID, UUID, VARCHAR, TEXT)'::regprocedure,
            'public.create_reconciliation_authorization(UUID, VARCHAR, TEXT, VARCHAR)'::regprocedure,
            'public.revoke_reconciliation_authorization(UUID, TEXT)'::regprocedure
        ])
    LOOP
        -- Only service_role (for workers), service_role_admin (for admin), and codenotes_definer (owner) are permitted
        IF v_acl.grantee NOT IN ('codenotes_definer', 'service_role', 'service_role_admin') THEN
            RAISE EXCEPTION 'POSTMIGRATION_FAILED: Routine % has unauthorized grantee in proacl: %', v_acl.proname, v_acl.grantee
                USING ERRCODE = '42501';
        END IF;
    END LOOP;
END $$;

COMMIT;
