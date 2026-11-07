-- ==============================================================================
-- Migration: Lock Paid Jobs Data & Server-Verified Pro Access
-- Date: 2026-10-10
-- Scope: jobs_public view, RLS on public.jobs, strictly locked paid fields
-- ==============================================================================

-- 1. Create or replace secure public view exposing ONLY unblurred preview columns
-- Locked columns (company, salary_text, description, apply_url) are strictly masked/omitted.
CREATE OR REPLACE VIEW public.jobs_public AS
SELECT
  id,
  title,
  location,
  remote,
  remote_scope,
  remote_eligibility,
  job_type,
  category,
  country,
  country_code,
  seniority,
  verified,
  source_type,
  first_seen_at,
  last_seen_at,
  discovered_at,
  posted_at,
  created_at,
  status,
  is_active,
  -- Locked fields: Never served to anonymous or non-Pro users
  'Verified Employer'::text AS company,
  NULL::text AS salary_text,
  NULL::text AS description,
  NULL::text AS apply_url,
  '{}'::text[] AS skills
FROM public.jobs
WHERE is_active = true OR status = 'active';

-- 2. Grant access to public view for anonymous and authenticated clients (and service role)
GRANT SELECT ON public.jobs_public TO anon, authenticated, service_role;

-- 3. Restrict direct SELECT on public.jobs so client keys cannot read locked columns
REVOKE SELECT ON public.jobs FROM anon, authenticated;

-- Ensure RLS is enabled on public.jobs
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

-- Drop legacy open policies that allowed anon/authenticated to SELECT raw locked columns
DROP POLICY IF EXISTS "jobs_public_read" ON public.jobs;
DROP POLICY IF EXISTS "jobs_anon_read" ON public.jobs;
DROP POLICY IF EXISTS "jobs_authenticated_read" ON public.jobs;

-- Only service role has full access to the raw table.
-- Pro users fetch unlocked data via the server-verified /api/jobs/pro route.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'jobs' AND policyname = 'jobs_service_role_access'
  ) THEN
    CREATE POLICY "jobs_service_role_access" ON public.jobs
      FOR ALL TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "jobs_service_role_access" ON public.jobs;
--   DROP VIEW IF EXISTS public.jobs_public;
--   REVOKE SELECT ON public.jobs_public FROM anon, authenticated, service_role;
--   GRANT SELECT ON public.jobs TO anon, authenticated;
--   NOTE: re-enables RLS on public.jobs (first enabled in 20261001_filter_upgrades.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: this migration itself drops POLICY jobs_public_read - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops POLICY jobs_anon_read - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops POLICY jobs_authenticated_read - restore it from the earlier migration that created it (or from backup) if rolling back.
-- ============================================================================
