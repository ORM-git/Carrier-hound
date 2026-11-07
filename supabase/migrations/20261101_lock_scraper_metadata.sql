-- ==============================================================================
-- Migration: Lock Scraper Metadata & Materialize Worldwide Company Counts
-- Date: 2026-11-01
-- File: supabase/migrations/20261101_lock_scraper_metadata.sql
-- Status: PENDING APPLICATION (Run in Supabase SQL editor by project owner)
--   If/when applied: record with  node scripts/record-migration.cjs 20261101_lock_scraper_metadata
--
-- Security & Performance Improvements:
-- 1. Scraper Metadata Lockdown:
--    - Revokes SELECT on public.companies from anon, authenticated
--    - Revokes SELECT on public.ingest_runs from anon, authenticated
--    - Preserves SELECT and administrative access for service_role
--    - Enforces Row Level Security (RLS) on both tables
-- 2. Materialized View Conversion:
--    - Converts public.worldwide_company_counts from a dynamic view into a
--      precomputed MATERIALIZED VIEW to eliminate intermittent statement timeouts (57014)
--    - Preserves exact columns: (name, slug, country, active_job_count)
--    - Creates unique index on (slug) to support CONCURRENT refresh
--    - Grants SELECT on public.worldwide_company_counts to anon, authenticated, service_role
-- 3. Ingestion Trigger:
--    - Automatically refreshes public.worldwide_company_counts when an ingest run completes
--      (AFTER INSERT OR UPDATE OF finished_at, status ON public.ingest_runs)
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. LOCK DOWN SCRAPER METADATA: public.companies
-- ------------------------------------------------------------------------------

-- Revoke read privileges from anon and authenticated clients
REVOKE SELECT ON public.companies FROM anon, authenticated;

-- Ensure service_role retains full access for crawler, ingestion, and admin APIs
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companies TO service_role;

-- Ensure Row Level Security remains active
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

-- Drop legacy permissive public read policy
DROP POLICY IF EXISTS "companies_public_read" ON public.companies;
DROP POLICY IF EXISTS "Allow public select on companies" ON public.companies;

-- Explicit policy restricting table access to service_role
DROP POLICY IF EXISTS "companies_service_role_access" ON public.companies;
CREATE POLICY "companies_service_role_access"
  ON public.companies
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- 2. LOCK DOWN INGEST RUN HISTORY: public.ingest_runs
-- ------------------------------------------------------------------------------

-- Revoke read privileges from anon and authenticated clients
REVOKE SELECT ON public.ingest_runs FROM anon, authenticated;

-- Ensure service_role retains full access for ingestion pipelines and observability APIs
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ingest_runs TO service_role;

-- Ensure Row Level Security remains active
ALTER TABLE public.ingest_runs ENABLE ROW LEVEL SECURITY;

-- Drop legacy permissive public read policy
DROP POLICY IF EXISTS "ingest_runs_public_read" ON public.ingest_runs;
DROP POLICY IF EXISTS "Allow public select on ingest_runs" ON public.ingest_runs;

-- Explicit policy restricting table access to service_role
DROP POLICY IF EXISTS "ingest_runs_service_role_access" ON public.ingest_runs;
CREATE POLICY "ingest_runs_service_role_access"
  ON public.ingest_runs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- 3. CONVERT public.worldwide_company_counts TO MATERIALIZED VIEW
-- ------------------------------------------------------------------------------

-- Type-aware drop (no CASCADE) handling prior view or materialized view
DO $$ DECLARE k "char"; BEGIN SELECT c.relkind INTO k FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='worldwide_company_counts'; IF k='v' THEN DROP VIEW public.worldwide_company_counts; ELSIF k='m' THEN DROP MATERIALIZED VIEW public.worldwide_company_counts; END IF; END $$;

-- Create Materialized View preserving identical output columns:
-- (name, slug, country, active_job_count)
CREATE MATERIALIZED VIEW public.worldwide_company_counts AS
SELECT
  c.name,
  c.slug,
  COALESCE(c.country, c.country_code, 'Worldwide') AS country,
  COUNT(j.id)::int AS active_job_count
FROM public.companies c
JOIN public.jobs j ON (j.company_id = c.id OR LOWER(TRIM(j.company)) = LOWER(TRIM(c.name)))
WHERE (j.is_active = true OR j.status = 'active')
  AND (
    j.remote_scope = 'worldwide'
    OR j.remote_eligibility = 'worldwide'
    OR j.location ILIKE '%worldwide%'
    OR j.location ILIKE '%anywhere%'
    OR j.location ILIKE '%global%'
    OR j.location ILIKE '%work from anywhere%'
  )
  AND c.slug IN (
    'openai', 'harvey', 'plaid', 'cohere', 'notion', 'supabase', 'cloudflare', 'databricks',
    'vanta', 'baseten', 'perplexity', 'samsara', 'cursor', 'synthesia', 'temporal', 'sentry',
    'elevenlabs', 'stripe', 'twilio', 'drata', 'gitlab', 'clickhouse', 'snowflake', 'webflow',
    'bitwarden', 'zapier', 'roblox', 'discord', 'midjourney', 'anyscale', 'llamaindex', 'replit',
    'deepgram', 'hopper', 'amplitude', 'coinbase', 'chainguard', 'zscaler', 'toast', 'sierra',
    'langchain', 'posthog', 'planetscale', 'airbnb', 'elastic', 'linear', 'watershed', 'runway',
    'confluent', '1password', 'klaviyo', 'lyft', 'duolingo', 'docker', 'coalition-technologies',
    'datadog', 'modal', 'pinecone', 'intercom', 'clickup', 'character-ai', 'infisical', 'deliveroo',
    'unio-digital', 'credit-wellness-llc', 'instacart', 'secureframe', 'snyk', 'warp', 'flexport',
    'neon', 'anthropic', 'launchdarkly', 'faire', 'sanctuary-computer-inc', 'iapwe', 'ramp'
  )
GROUP BY c.slug, c.name, c.country, c.country_code
HAVING COUNT(j.id) > 0
ORDER BY active_job_count DESC
WITH DATA;

-- Unique index required for non-blocking concurrent refresh and instant slug lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_worldwide_company_counts_slug
  ON public.worldwide_company_counts (slug);

-- Index for fast ordering by active_job_count
CREATE INDEX IF NOT EXISTS idx_worldwide_company_counts_active_job_count
  ON public.worldwide_company_counts (active_job_count DESC);

-- Public read access for the aggregated materialized view
GRANT SELECT ON public.worldwide_company_counts TO anon, authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 4. AUTOMATIC REFRESH FUNCTION AND TRIGGER
-- ------------------------------------------------------------------------------

-- Callable helper function to refresh the materialized view
CREATE OR REPLACE FUNCTION public.refresh_worldwide_company_counts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Attempt concurrent refresh first so existing readers are never blocked
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.worldwide_company_counts;
EXCEPTION
  WHEN OTHERS THEN
    -- Fallback to non-concurrent refresh if concurrent fails (e.g. if unpopulated)
    BEGIN
      REFRESH MATERIALIZED VIEW public.worldwide_company_counts;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE WARNING 'worldwide_company_counts refresh failed: %', SQLERRM;
    END;
END;
$$;

-- Trigger function executed at the conclusion of an ingestion run
CREATE OR REPLACE FUNCTION public.on_ingest_run_completed_refresh_worldwide()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.refresh_worldwide_company_counts();
  RETURN NEW;
END;
$$;

-- Secure execution privileges on the refresh functions
REVOKE ALL ON FUNCTION public.refresh_worldwide_company_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_worldwide_company_counts() TO service_role;
REVOKE ALL ON FUNCTION public.on_ingest_run_completed_refresh_worldwide() FROM PUBLIC, anon, authenticated;

-- Trigger firing whenever an ingest run finishes (finished_at set and status logged)
DROP TRIGGER IF EXISTS trigger_refresh_worldwide_company_counts ON public.ingest_runs;
CREATE TRIGGER trigger_refresh_worldwide_company_counts
  AFTER INSERT OR UPDATE OF finished_at, status ON public.ingest_runs
  FOR EACH ROW
  WHEN (NEW.finished_at IS NOT NULL)
  EXECUTE FUNCTION public.on_ingest_run_completed_refresh_worldwide();

-- ==============================================================================
-- 5. READ-ONLY POST-RUN VERIFICATION CHECKS
-- ==============================================================================
-- has_table_privilege anon on companies and authenticated on ingest_runs must be false;
-- count(*) from worldwide_company_counts > 0;
-- has_function_privilege('anon','public.refresh_worldwide_company_counts()','EXECUTE') must be false.
--
-- Verification queries (run in SQL Editor):
-- SELECT has_table_privilege('anon', 'public.companies', 'SELECT') AS anon_companies_select; -- Must be: false
-- SELECT has_table_privilege('authenticated', 'public.ingest_runs', 'SELECT') AS auth_ingest_runs_select; -- Must be: false
-- SELECT count(*) > 0 AS count_gt_zero FROM public.worldwide_company_counts; -- Must be: true
-- SELECT has_function_privilege('anon', 'public.refresh_worldwide_company_counts()', 'EXECUTE') AS anon_refresh_exec; -- Must be: false
