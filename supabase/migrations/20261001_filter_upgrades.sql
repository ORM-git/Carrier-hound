-- ============================================================
-- Migration: Upgrade jobs schema for CareerMonke filters
-- Run in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- 1. Enable required extensions for search performance
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- 2. Add new columns safely (preserving status and remote_scope; discovered_at without DEFAULT NOW() initially, no invented currency/period defaults)
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS salary_min NUMERIC,
  ADD COLUMN IF NOT EXISTS salary_max NUMERIC,
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS period TEXT,
  ADD COLUMN IF NOT EXISTS seniority TEXT DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS remote_eligibility TEXT DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS eligible_countries TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS country_code VARCHAR(2),
  ADD COLUMN IF NOT EXISTS categories TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_job_id TEXT;

-- 3. Add CHECK constraints (allows NULL period; uses 'country_restricted' with underscore)
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_period_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_period_check
  CHECK (period IS NULL OR period IN ('year', 'month', 'hour'));

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_seniority_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_seniority_check
  CHECK (seniority IN ('entry', 'mid', 'senior', 'staff', 'lead', 'director', 'unknown'));

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_remote_eligibility_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_remote_eligibility_check
  CHECK (remote_eligibility IN ('worldwide', 'country_restricted', 'unknown'));

-- 4. Backfill discovered_at preserving historical first_seen_at recency, then set future default
UPDATE public.jobs
SET discovered_at = COALESCE(first_seen_at, created_at, NOW())
WHERE discovered_at IS NULL;

ALTER TABLE public.jobs
  ALTER COLUMN discovered_at SET DEFAULT NOW();

-- 5. Backfill categories array from existing category
UPDATE public.jobs
SET categories = ARRAY[category]
WHERE (categories IS NULL OR cardinality(categories) = 0) AND category IS NOT NULL;

-- 6. Backfill country_code: exact normalized country name/ISO from country; unambiguous full country names from location only. Ambiguous stays NULL; existing non-null preserved.
UPDATE public.jobs
SET country_code = CASE
  -- 1. Explicit country column: exact normalized country name or ISO code (highest precedence)
  WHEN country ILIKE 'United States' OR country ILIKE 'USA' OR country = 'US' THEN 'US'
  WHEN country ILIKE 'Canada' OR country = 'CA' THEN 'CA'
  WHEN country ILIKE 'United Kingdom' OR country = 'GB' OR country = 'UK' THEN 'GB'
  WHEN country ILIKE 'Germany' OR country ILIKE 'Deutschland' OR country = 'DE' THEN 'DE'
  WHEN country ILIKE 'India' OR country = 'IN' THEN 'IN'
  WHEN country ILIKE 'Australia' OR country = 'AU' THEN 'AU'
  WHEN country ILIKE 'France' OR country = 'FR' THEN 'FR'
  WHEN country ILIKE 'Japan' OR country = 'JP' THEN 'JP'
  -- 2. Unambiguous FULL country name evidence from location only (NO city or state code inference)
  WHEN location ~* '\y(United States|USA)\y' THEN 'US'
  WHEN location ~* '\y(Canada)\y' THEN 'CA'
  WHEN location ~* '\y(Germany|Deutschland)\y' THEN 'DE'
  WHEN location ~* '\y(United Kingdom)\y' THEN 'GB'
  WHEN location ~* '\y(Australia)\y' THEN 'AU'
  WHEN location ~* '\y(India)\y' THEN 'IN'
  WHEN location ~* '\y(France)\y' THEN 'FR'
  WHEN location ~* '\y(Japan)\y' THEN 'JP'
  -- 3. Ambiguous values remain unchanged / NULL
  ELSE country_code
END
WHERE country_code IS NULL;

-- 7. Backfill remote_eligibility & eligible_countries together from ONE single decision code
WITH decisions AS (
  SELECT id,
    CASE
      -- 1. Non-remote: remote_scope != 'remote' -> unknown, empty
      WHEN remote_scope IS DISTINCT FROM 'remote' THEN 1

      -- 2. Region phrases (Europe, EMEA, APAC, etc.) stay unknown unless mapped reliably
      WHEN location ~* '\y(europe|emea|apac|latam|asia)\y' THEN 2

      -- 3. Explicit US restrictions (including US Remote with worldwide exclusion)
      WHEN location ~* '\y(us only|usa only|united states only)\y'
        OR (location ~* '\y(united states|usa)\y' AND location ~* '\y(not accepted|ineligible|only)\y')
        OR location ~* '\y(anywhere in the us|anywhere in the usa)\y'
        OR country ILIKE 'United States' OR country_code = 'US' THEN 3

      -- 4. Explicit India restrictions
      WHEN country ILIKE 'India' OR country_code = 'IN' OR location ~* '\y(india only|anywhere in india)\y' THEN 4

      -- 5. Genuine Worldwide: explicit worldwide evidence without country/region qualifiers or exclusions
      -- Note: 'global' alone is NOT enough! Must be explicit worldwide / anywhere in the world
      WHEN (location ~* '\y(worldwide|anywhere in the world|work from anywhere)\y')
        AND location !~* '\y(only|us|usa|united states|uk|canada|europe|emea|apac|latam|asia|india|germany)\y' THEN 5

      -- 6. Other explicit country code
      WHEN country_code IS NOT NULL AND country_code != '' THEN 6

      -- 7. Plain Remote alone or unmapped
      ELSE 7
    END AS code,
    country_code
  FROM public.jobs
  WHERE remote_eligibility = 'unknown' OR remote_eligibility IS NULL
)
UPDATE public.jobs j
SET
  remote_eligibility = CASE d.code
    WHEN 3 THEN 'country_restricted'
    WHEN 4 THEN 'country_restricted'
    WHEN 5 THEN 'worldwide'
    WHEN 6 THEN 'country_restricted'
    ELSE 'unknown'
  END,
  eligible_countries = CASE d.code
    WHEN 3 THEN ARRAY['US']
    WHEN 4 THEN ARRAY['IN']
    WHEN 5 THEN ARRAY['*']
    WHEN 6 THEN ARRAY[d.country_code]
    ELSE '{}'::text[]
  END
FROM decisions d
WHERE j.id = d.id;

-- 8. Backfill salary_min, salary_max: DEFERRED
-- Naive regex parsing removed from runnable draft to prevent corrupting currency/period/amounts
-- or assuming USD/year defaults. Reliable salary backfill will be handled via dedicated script.

-- 9. Backfill seniority: Higher-level titles win over associate/entry; bare lead removed
UPDATE public.jobs
SET seniority = CASE
  -- 1. Executive & Director level (Higher-level titles win over associate/entry, e.g. Associate Director, Associate VP)
  WHEN title ~* '\y(director|vp|vice president|head of|chief)\y' THEN 'director'

  -- 2. Staff & Principal level
  WHEN title ~* '\y(staff|principal|distinguished)\y' THEN 'staff'

  -- 3. Lead engineering level (Require specific role context; bare 'lead' removed so 'Lead Generation' stays unknown)
  WHEN title ~* '\y(tech lead|team lead|engineering lead|lead engineer|lead developer|lead architect|lead data scientist)\y' THEN 'lead'

  -- 4. Senior level (Senior Associate must win over entry associate)
  WHEN title ~* '\y(senior|sr\.?|level 3|l3|sde 3|sde iii)\y' THEN 'senior'

  -- 5. Mid level
  WHEN title ~* '\y(mid|intermediate|mid-level|level 2|l2|sde 2|sde ii)\y' THEN 'mid'

  -- 6. Entry level & Internships (Only reached if not matched by higher-level director/senior/lead above)
  WHEN title ~* '\y(intern|internship|fresher|graduate|trainee|apprentice)\y' THEN 'entry'
  WHEN title ~* '\y(junior|entry|associate|jr\.?|level 1|l1|sde 1|sde i)\y' THEN 'entry'

  ELSE 'unknown'
END
WHERE seniority = 'unknown' OR seniority IS NULL;

-- 10. Search column & Weighted tsvector
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(company, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) STORED;

-- 11. Performance Indexes (Immutable partial index predicates only)
DROP INDEX IF EXISTS public.jobs_active_discovered_idx;
CREATE INDEX IF NOT EXISTS jobs_active_discovered_idx
  ON public.jobs (discovered_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- Search GIN index
CREATE INDEX IF NOT EXISTS jobs_search_vector_idx
  ON public.jobs USING GIN (search_vector);

-- Trigram indexes on title, company, and location
DROP INDEX IF EXISTS public.jobs_title_trgm_idx;
CREATE INDEX IF NOT EXISTS idx_jobs_title_trgm
  ON public.jobs USING GIN (title gin_trgm_ops);

DROP INDEX IF EXISTS public.jobs_company_trgm_idx;
CREATE INDEX IF NOT EXISTS idx_jobs_company_trgm
  ON public.jobs USING GIN (company gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_jobs_location_trgm
  ON public.jobs USING GIN (location gin_trgm_ops);

-- Category GIN index for fast array membership
CREATE INDEX IF NOT EXISTS jobs_categories_gin_idx
  ON public.jobs USING GIN (categories);

-- Filter column indexes
CREATE INDEX IF NOT EXISTS jobs_salary_min_idx ON public.jobs (salary_min) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS jobs_seniority_idx ON public.jobs (seniority) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS jobs_country_code_idx ON public.jobs (country_code) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS jobs_remote_scope_idx ON public.jobs (remote_scope) WHERE status = 'active';

-- Unique source index
CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_source_job_id_unique
  ON public.jobs (source, source_job_id)
  WHERE source IS NOT NULL AND source_job_id IS NOT NULL;

-- 12. Row Level Security: Keep raw public.jobs locked; public access stays through public.jobs_public only
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "jobs_public_read" ON public.jobs;
REVOKE SELECT ON public.jobs FROM anon, authenticated;
GRANT SELECT ON public.jobs_public TO anon, authenticated, service_role;

-- 13. Ensure unsafe SECURITY DEFINER RPC get_jobs_with_facets is dropped
-- (Direct PostgREST query path in src/lib/api/jobs.ts is used instead)
DROP FUNCTION IF EXISTS public.get_jobs_with_facets(TEXT, TEXT[], TEXT, BOOLEAN, TEXT, TEXT, TEXT, INT, INT);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.jobs_active_discovered_idx;
--   DROP INDEX IF EXISTS public.jobs_search_vector_idx;
--   DROP INDEX IF EXISTS public.idx_jobs_title_trgm;
--   DROP INDEX IF EXISTS public.idx_jobs_company_trgm;
--   DROP INDEX IF EXISTS public.idx_jobs_location_trgm;
--   DROP INDEX IF EXISTS public.jobs_categories_gin_idx;
--   DROP INDEX IF EXISTS public.jobs_salary_min_idx;
--   DROP INDEX IF EXISTS public.jobs_seniority_idx;
--   DROP INDEX IF EXISTS public.jobs_country_code_idx;
--   DROP INDEX IF EXISTS public.jobs_remote_scope_idx;
--   DROP INDEX IF EXISTS public.jobs_source_source_job_id_unique;
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS discovered_at;
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS search_vector;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_period_check;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_seniority_check;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_remote_eligibility_check;
--   ALTER TABLE public.jobs DISABLE ROW LEVEL SECURITY;
--   REVOKE SELECT ON public.jobs_public FROM anon, authenticated, service_role;
--   GRANT SELECT ON public.jobs TO anon, authenticated;
--   NOTE: constraint jobs_period_check was dropped and re-added by this file with a new definition; restore its prior definition from the earlier migration that created it.
--   NOTE: constraint jobs_seniority_check was dropped and re-added by this file with a new definition; restore its prior definition from the earlier migration that created it.
--   NOTE: constraint jobs_remote_eligibility_check was dropped and re-added by this file with a new definition; restore its prior definition from the earlier migration that created it.
--   NOTE: extension pg_trgm left in place (shared; drop manually only if unused elsewhere).
--   NOTE: extension unaccent left in place (shared; drop manually only if unused elsewhere).
--   NOTE: this migration itself drops INDEX jobs_title_trgm_idx - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops INDEX jobs_company_trgm_idx - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops POLICY jobs_public_read - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops FUNCTION get_jobs_with_facets - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================
