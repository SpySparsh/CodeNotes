-- ============================================================================
-- CodeNotes — Hardening Migration: youtube_transcripts & rate_limit_buckets
-- ============================================================================
-- Purpose:
--   Lock down internal infrastructure tables from direct PostgREST exposure.
--   Prevents anonymous and authenticated web clients from reading, poisoning,
--   tampering with, or deleting cached transcripts and rate-limiting counters.
--   Hardens default privileges so future tables created by the application role
--   do not automatically inherit broad public access.
--
-- Access Control Strategy:
--   - Revoke all table privileges from PUBLIC, anon, and authenticated.
--   - Enable and FORCE Row Level Security (RLS) on both tables with 0 client policies (default deny).
--   - Revoke default privileges in schema public for anon and authenticated.
--   - The server-side backend connects as table owner ('postgres') with BYPASSRLS
--     via direct pooler connections, retaining uninterrupted query access.
--
-- Idempotent: safe to run multiple times.
-- ============================================================================

-- 1. Enable and Force Row Level Security on internal tables
ALTER TABLE public.youtube_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.youtube_transcripts FORCE ROW LEVEL SECURITY;

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_buckets FORCE ROW LEVEL SECURITY;

-- 2. Revoke privileges from PUBLIC and API client roles
DO $$
BEGIN
  -- Revoke from PUBLIC pseudo-role on all application and internal tables
  REVOKE ALL ON TABLE public.notes FROM PUBLIC;
  REVOKE ALL ON TABLE public.generation_idempotency FROM PUBLIC;
  REVOKE ALL ON TABLE public.youtube_transcripts FROM PUBLIC;
  REVOKE ALL ON TABLE public.rate_limit_buckets FROM PUBLIC;

  -- Revoke from anon role if present (Supabase PostgREST unauthenticated role)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.notes FROM anon;
    REVOKE ALL ON TABLE public.generation_idempotency FROM anon;
    REVOKE ALL ON TABLE public.youtube_transcripts FROM anon;
    REVOKE ALL ON TABLE public.rate_limit_buckets FROM anon;
    -- Prevent future tables created in public from automatically granting access to anon
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  END IF;

  -- Revoke from authenticated role if present (Supabase PostgREST authenticated role)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- Revoke all privileges first to strip TRUNCATE, REFERENCES, TRIGGER and any inherited defaults
    REVOKE ALL ON TABLE public.notes FROM authenticated;
    REVOKE ALL ON TABLE public.generation_idempotency FROM authenticated;
    REVOKE ALL ON TABLE public.youtube_transcripts FROM authenticated;
    REVOKE ALL ON TABLE public.rate_limit_buckets FROM authenticated;

    -- Grant strictly the required CRUD operations for authenticated users (enforced by RLS)
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notes TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.generation_idempotency TO authenticated;

    -- Prevent future tables created in public from automatically granting access to authenticated
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
  END IF;
END $$;
