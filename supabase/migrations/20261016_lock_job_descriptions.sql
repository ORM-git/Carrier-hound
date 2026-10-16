-- ==============================================================================
-- Migration: Lock Job Descriptions Table & Revoke Public Anon Access
-- Date: 2026-10-16
-- Scope: RLS and table privileges on public.job_descriptions
-- Status: NOT APPLIED (Prepared migration file for owner execution)
--
-- Security Context:
-- 1. In migration 20261001_phase1_storage_optimization.sql, policy
--    "job_descriptions_public_read" allowed public SELECT on active job descriptions.
-- 2. In migration 20261010_lock_paid_jobs_data.sql, direct SELECT on public.jobs was
--    revoked for anon/authenticated to gate descriptions, salaries, and apply URLs
--    behind CareerMonke Pro.
-- 3. However, public.job_descriptions retained table-level SELECT and the open RLS
--    policy, allowing unauthenticated guests to potentially query PostgREST directly
--    (GET /rest/v1/job_descriptions) and bypass the Pro paywall.
-- 4. Application audit confirms neither the frontend nor server routes read from
--    public.job_descriptions with client keys. Pro users fetch unlocked data via
--    the server-verified /api/jobs/pro endpoint using service_role credentials.
-- ==============================================================================

-- 1. Ensure Row Level Security is strictly enabled
ALTER TABLE public.job_descriptions ENABLE ROW LEVEL SECURITY;

-- 2. Drop legacy public read policy that permitted unauthenticated reads
DROP POLICY IF EXISTS "job_descriptions_public_read" ON public.job_descriptions;
DROP POLICY IF EXISTS "job_descriptions_anon_read" ON public.job_descriptions;
DROP POLICY IF EXISTS "job_descriptions_authenticated_read" ON public.job_descriptions;

-- 3. Revoke all table-level privileges from anon and authenticated roles
REVOKE ALL ON TABLE public.job_descriptions FROM anon, authenticated;
REVOKE SELECT ON TABLE public.job_descriptions FROM anon, authenticated;

-- 4. Explicitly grant full permissions to service_role (used by ingestion & Pro endpoints)
GRANT ALL ON TABLE public.job_descriptions TO service_role;

-- 5. Add explicit service_role policy for completeness
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'job_descriptions'
      AND policyname = 'job_descriptions_service_role_all'
  ) THEN
    CREATE POLICY "job_descriptions_service_role_all" ON public.job_descriptions
      FOR ALL TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
