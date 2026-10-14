-- ==============================================================================
-- DO NOT APPLY / REVIEW PENDING — LOCAL DRAFT ONLY
-- CareerMonke (Carrier-hound) — Consolidated Pending Migrations & Indexes
-- File: supabase/scripts/apply-pending.sql
-- Status: UNDER REVIEW — DO NOT PASTE OR RUN ON LIVE PRODUCTION DATABASE
--
-- ARCHITECTURE & RISK PLAN (COMMENTS ONLY — NO EXECUTION CLAIMS):
-- 1. Generated STORED Column Risk:
--    - 'search_vector tsvector GENERATED ALWAYS AS (...) STORED' rewrites the table
--      on disk, acquiring an ACCESS EXCLUSIVE lock on public.jobs during column creation.
-- 2. Non-Concurrent Index Lock Risk & Phase Separation:
--    - This consolidated draft contains exactly 21 CREATE INDEX statements:
--        * 17 indexes on public.jobs (8 auxiliary filter/search + 9 query performance).
--        * 2 indexes on public.tailored_resumes.
--        * 2 indexes on public.ai_usage_quotas.
--    - Plain 'CREATE INDEX' acquires a SHARE lock that blocks concurrent INSERT/UPDATE/DELETE.
--    - For live production deployment, schema changes, backfills, and index builds
--      should be separated into 3 distinct phases:
--        * Phase A (Schema DDL): Column additions, new tables, RLS locks.
--        * Phase B (Backfill DML): Staged data backfills in safe off-peak batches.
--        * Phase C (Indexes DDL): Built with 'CREATE INDEX CONCURRENTLY', which MUST run
--          outside of a transaction block to avoid locking table writes.
-- 3. Constraint Validation:
--    - 'CHECK' constraints on existing live tables can be added as 'NOT VALID'
--      and validated in a separate step to prevent blocking writes on large datasets.
-- 4. Strict Paid-Data RLS Protection:
--    - Raw public.jobs SELECT revoked from anon/authenticated; access stays via public.jobs_public.
--    - Unsafe SECURITY DEFINER RPC get_jobs_with_facets dropped.
-- 5. No Invented Defaults:
--    - currency and period added without invented defaults; missing values remain NULL.
-- ==============================================================================

-- ==============================================================================
-- SECTION 1: EXTENSIONS
-- ==============================================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ==============================================================================
-- SECTION 2: REPAIRED MIGRATION — 20261001_filter_upgrades.sql
-- ==============================================================================

-- 2.1 Add filter & taxonomy columns safely (idempotent, discovered_at without DEFAULT NOW() initially, no invented currency/period defaults)
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

-- 2.2 Add CHECK constraints (allows NULL period; uses 'country_restricted' with underscore)
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_period_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_period_check
  CHECK (period IS NULL OR period IN ('year', 'month', 'hour'));

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_seniority_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_seniority_check
  CHECK (seniority IN ('entry', 'mid', 'senior', 'staff', 'lead', 'director', 'unknown'));

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_remote_eligibility_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_remote_eligibility_check
  CHECK (remote_eligibility IN ('worldwide', 'country_restricted', 'unknown'));

-- 2.3 Backfill discovered_at preserving historical first_seen_at recency, then set future default
UPDATE public.jobs
SET discovered_at = COALESCE(first_seen_at, created_at, NOW())
WHERE discovered_at IS NULL;

ALTER TABLE public.jobs
  ALTER COLUMN discovered_at SET DEFAULT NOW();

-- 2.4 Backfill categories array from existing category
UPDATE public.jobs
SET categories = ARRAY[category]
WHERE (categories IS NULL OR cardinality(categories) = 0) AND category IS NOT NULL;

-- 2.5 Backfill country_code: exact normalized country name/ISO from country; unambiguous full country names from location only. Ambiguous stays NULL; existing non-null preserved.
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

-- 2.6 Backfill remote_eligibility & eligible_countries together from ONE single decision code
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

-- 2.7 Backfill salary_min, salary_max: DEFERRED
-- Naive regex parsing removed from runnable draft to prevent corrupting currency/period/amounts
-- or assuming USD/year defaults. Reliable salary backfill will be handled via dedicated script.

-- 2.8 Backfill seniority: Higher-level titles win over associate/entry; bare lead removed
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

-- 2.9 Search column & Weighted tsvector
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(company, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) STORED;

-- 2.10 Filter-upgrade auxiliary indexes (immutable predicates only)
DROP INDEX IF EXISTS public.jobs_active_discovered_idx;
CREATE INDEX IF NOT EXISTS jobs_active_discovered_idx
  ON public.jobs (discovered_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

CREATE INDEX IF NOT EXISTS jobs_search_vector_idx
  ON public.jobs USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS jobs_categories_gin_idx
  ON public.jobs USING GIN (categories);

CREATE INDEX IF NOT EXISTS jobs_salary_min_idx ON public.jobs (salary_min) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS jobs_seniority_idx ON public.jobs (seniority) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS jobs_country_code_idx ON public.jobs (country_code) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS jobs_remote_scope_idx ON public.jobs (remote_scope) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_source_job_id_unique
  ON public.jobs (source, source_job_id)
  WHERE source IS NOT NULL AND source_job_id IS NOT NULL;

-- 2.11 Row Level Security: Keep raw public.jobs locked; public access stays through public.jobs_public only
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "jobs_public_read" ON public.jobs;
REVOKE SELECT ON public.jobs FROM anon, authenticated;
GRANT SELECT ON public.jobs_public TO anon, authenticated, service_role;

-- 2.12 Ensure unsafe SECURITY DEFINER RPC get_jobs_with_facets is dropped
DROP FUNCTION IF EXISTS public.get_jobs_with_facets(TEXT, TEXT[], TEXT, BOOLEAN, TEXT, TEXT, TEXT, INT, INT);

-- ==============================================================================
-- SECTION 3: MIGRATION — 20261010_tailored_resumes.sql (Unchanged)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.tailored_resumes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id            TEXT NOT NULL,
  job_title         TEXT NOT NULL,
  company           TEXT NOT NULL,
  ats_score         INTEGER DEFAULT 85,
  tailored_data     JSONB,
  cover_letter_data JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT tailored_resumes_user_job_unique UNIQUE (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS tailored_resumes_user_job_idx
  ON public.tailored_resumes (user_id, job_id);

CREATE INDEX IF NOT EXISTS tailored_resumes_user_updated_idx
  ON public.tailored_resumes (user_id, updated_at DESC);

ALTER TABLE public.tailored_resumes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tailored_resumes' AND policyname = 'tailored_resumes_owner_select') THEN
    CREATE POLICY "tailored_resumes_owner_select" ON public.tailored_resumes FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tailored_resumes' AND policyname = 'tailored_resumes_owner_insert') THEN
    CREATE POLICY "tailored_resumes_owner_insert" ON public.tailored_resumes FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tailored_resumes' AND policyname = 'tailored_resumes_owner_update') THEN
    CREATE POLICY "tailored_resumes_owner_update" ON public.tailored_resumes FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tailored_resumes' AND policyname = 'tailored_resumes_owner_delete') THEN
    CREATE POLICY "tailored_resumes_owner_delete" ON public.tailored_resumes FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- ==============================================================================
-- SECTION 4: MIGRATION — 20261011_ai_usage_quotas.sql (Unchanged)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.ai_usage_quotas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  operation    TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_usage_quotas_user_date_op_key UNIQUE (user_id, period_date, operation)
);

CREATE INDEX IF NOT EXISTS ai_usage_quotas_user_date_idx
  ON public.ai_usage_quotas (user_id, period_date);

CREATE INDEX IF NOT EXISTS ai_usage_quotas_user_idx
  ON public.ai_usage_quotas (user_id);

ALTER TABLE public.ai_usage_quotas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ai_usage_quotas' AND policyname = 'ai_usage_quotas_owner_select'
  ) THEN
    CREATE POLICY "ai_usage_quotas_owner_select" ON public.ai_usage_quotas
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

-- ==============================================================================
-- SECTION 5: RECOMMENDED PERFORMANCE INDEXES (Plain CREATE INDEX IF NOT EXISTS)
-- ==============================================================================

-- 5.1 Default active feed & pagination (eliminates Seq Scan + Top-N Sort on Q1, Q9a, Q9b, Q10)
CREATE INDEX IF NOT EXISTS idx_jobs_active_first_seen_id
  ON public.jobs (first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- 5.2 Remote filter + default sort (Q2)
CREATE INDEX IF NOT EXISTS idx_jobs_active_remote_scope_first_seen
  ON public.jobs (remote_scope, first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- 5.3 Country filter + default sort (Q3)
CREATE INDEX IF NOT EXISTS idx_jobs_active_country_first_seen
  ON public.jobs (country, first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- 5.4 Category filter + default sort (Q5)
CREATE INDEX IF NOT EXISTS idx_jobs_active_category_first_seen
  ON public.jobs (category, first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- 5.5 Salary numeric filter + default sort (Q4)
CREATE INDEX IF NOT EXISTS idx_jobs_active_salary_min_first_seen
  ON public.jobs (salary_min, first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active' AND salary_min IS NOT NULL;

-- 5.6 Posted date sort + recency cutoff (Q8)
CREATE INDEX IF NOT EXISTS idx_jobs_active_posted_first_seen
  ON public.jobs (posted_at DESC, first_seen_at DESC, id DESC)
  WHERE is_active = true AND status = 'active';

-- 5.7 Trigram GIN indexes for ILIKE '%keyword%' on title, company, and location (Q6, Q7)
DROP INDEX IF EXISTS public.jobs_title_trgm_idx;
CREATE INDEX IF NOT EXISTS idx_jobs_title_trgm
  ON public.jobs USING GIN (title gin_trgm_ops);

DROP INDEX IF EXISTS public.jobs_company_trgm_idx;
CREATE INDEX IF NOT EXISTS idx_jobs_company_trgm
  ON public.jobs USING GIN (company gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_jobs_location_trgm
  ON public.jobs USING GIN (location gin_trgm_ops);

-- ==============================================================================
-- SECTION 6: VERIFICATION SELECTS
-- ==============================================================================
SELECT
  -- 1. Extensions check
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS has_ext_pg_trgm,
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') AS has_ext_unaccent,

  -- 2. New tables check
  EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'tailored_resumes'
  ) AS has_table_tailored_resumes,
  EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ai_usage_quotas'
  ) AS has_table_ai_usage_quotas,

  -- 3. New columns on public.jobs check
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'categories'
  ) AS has_col_jobs_categories,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'eligible_countries'
  ) AS has_col_jobs_eligible_countries,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'period'
  ) AS has_col_jobs_period,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'search_vector'
  ) AS has_col_jobs_search_vector,

  -- 4. Security & RPC checks (jobs_public_read and get_jobs_with_facets must be FALSE)
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'jobs' AND policyname = 'jobs_public_read'
  ) AS has_unsafe_jobs_public_read_policy,
  EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_jobs_with_facets'
  ) AS has_unsafe_get_jobs_with_facets_rpc,

  -- 5. Recommended indexes count (expected: 9 index objects across the 7 index groups)
  (
    SELECT COUNT(*)::INT
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'jobs'
      AND indexname IN (
        'idx_jobs_active_first_seen_id',
        'idx_jobs_active_remote_scope_first_seen',
        'idx_jobs_active_country_first_seen',
        'idx_jobs_active_category_first_seen',
        'idx_jobs_active_salary_min_first_seen',
        'idx_jobs_active_posted_first_seen',
        'idx_jobs_title_trgm',
        'idx_jobs_company_trgm',
        'idx_jobs_location_trgm'
      )
  ) AS recommended_jobs_indexes_created;
