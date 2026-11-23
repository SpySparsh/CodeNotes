-- ============================================================================
-- Migration: Add Quota Configuration for Gemini 3.5 Flash-Lite
-- Target Project ID: codenotes (only project ID used by the application)
-- Model Target: gemini-3.5-flash-lite
--
-- Verified Quota Ceilings:
--   - Concurrency Cap (max_active_dispatches): 10 (preserved internal ceiling)
--   - Rate Limit RPM (max_rpm): 15
--   - Token Bucket TPM (max_tpm): 250000
--   - Daily Requests RPD (max_rpd): 500
-- ============================================================================

INSERT INTO public.project_quota_configs (
    project_id,
    quota_scope,
    max_active_dispatches,
    max_rpm,
    max_tpm,
    max_rpd,
    updated_at
) VALUES (
    'codenotes',
    'gemini-3.5-flash-lite',
    10,
    15,
    250000,
    500,
    clock_timestamp()
)
ON CONFLICT (project_id, quota_scope) DO NOTHING;

-- Explicit Post-Insert Verification Block
DO $$
DECLARE
    v_cfg RECORD;
BEGIN
    SELECT * INTO v_cfg
    FROM public.project_quota_configs
    WHERE project_id = 'codenotes' AND quota_scope = 'gemini-3.5-flash-lite';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'VERIFICATION_FAILED: Quota config not found for (codenotes, gemini-3.5-flash-lite)'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_cfg.max_active_dispatches IS DISTINCT FROM 10
       OR v_cfg.max_rpm IS DISTINCT FROM 15
       OR v_cfg.max_tpm IS DISTINCT FROM 250000
       OR v_cfg.max_rpd IS DISTINCT FROM 500 THEN
        RAISE EXCEPTION 'VERIFICATION_FAILED: Quota ceilings diverge from specification. Found: max_active=%, rpm=%, tpm=%, rpd=%',
            v_cfg.max_active_dispatches, v_cfg.max_rpm, v_cfg.max_tpm, v_cfg.max_rpd
            USING ERRCODE = '22023';
    END IF;

    RAISE NOTICE 'VERIFICATION_PASSED: Quota config verified for (codenotes, gemini-3.5-flash-lite) [active=10, rpm=15, tpm=250000, rpd=500]';
END $$;
