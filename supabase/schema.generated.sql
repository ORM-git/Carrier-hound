-- ==============================================================================
-- CareerMonke Schema Representation (Generated from Migrations)
-- Freshness Header: Generated on 2026-11-19
-- Migrations Count: 87
-- DO NOT EDIT DIRECTLY. Regenerate using: npx tsx scripts/generate-schema-dump.ts
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- Migration: 20261001_filter_upgrades.sql
-- ------------------------------------------------------------------------------
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


-- ------------------------------------------------------------------------------
-- Migration: 20261001_ingestion_pipeline.sql
-- ------------------------------------------------------------------------------
-- ============================================================
-- Migration: Add Ingestion, Deduplication & Cleanup Pipeline
-- ============================================================

-- 1. Add missing columns safely without breaking existing records
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS remote BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_job_id TEXT,
  ADD COLUMN IF NOT EXISTS salary_min NUMERIC,
  ADD COLUMN IF NOT EXISTS salary_max NUMERIC,
  ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- 2. Relax job_type constraint to allow 'job', 'internship', and existing types
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_job_type_check 
  CHECK (job_type IN ('job', 'internship', 'full-time', 'part-time', 'contract', 'other'));

-- 3. Backfill newly added columns from existing rows (preserves existing data)
UPDATE public.jobs
SET
  remote = COALESCE(remote, remote_scope = 'remote'),
  is_active = COALESCE(is_active, status = 'active'),
  created_at = COALESCE(created_at, first_seen_at, NOW()),
  posted_at = COALESCE(posted_at, first_seen_at, NOW())
WHERE remote IS NULL OR is_active IS NULL OR created_at IS NULL;

-- 4. Unique constraint on (source, source_job_id) for ON CONFLICT upserting
DROP INDEX IF EXISTS public.jobs_source_source_job_id_unique;
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_source_job_id_key;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_source_source_job_id_key UNIQUE (source, source_job_id);

-- 5. Deduplicate existing rows with identical apply_url if any before unique constraint
DELETE FROM public.jobs a
USING public.jobs b
WHERE a.id > b.id
  AND a.apply_url IS NOT NULL
  AND a.apply_url = b.apply_url;

-- 6. Strict unique index on apply_url
DROP INDEX IF EXISTS public.jobs_apply_url_unique;
CREATE UNIQUE INDEX jobs_apply_url_unique
  ON public.jobs (apply_url)
  WHERE apply_url IS NOT NULL;

-- 7. Query and filter indexes for high performance
CREATE INDEX IF NOT EXISTS jobs_is_active_idx ON public.jobs (is_active);
CREATE INDEX IF NOT EXISTS jobs_last_seen_at_idx ON public.jobs (last_seen_at);
CREATE INDEX IF NOT EXISTS jobs_posted_at_idx ON public.jobs (posted_at);

-- 8. Update RLS policies: public read for active jobs (backward compatible with status)
DROP POLICY IF EXISTS "jobs_public_read" ON public.jobs;
CREATE POLICY "jobs_public_read"
  ON public.jobs
  FOR SELECT
  USING (is_active = true OR status = 'active');

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "jobs_public_read" ON public.jobs;
--   DROP INDEX IF EXISTS public.jobs_apply_url_unique;
--   DROP INDEX IF EXISTS public.jobs_is_active_idx;
--   DROP INDEX IF EXISTS public.jobs_last_seen_at_idx;
--   DROP INDEX IF EXISTS public.jobs_posted_at_idx;
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS remote;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_source_job_id_key;
--   NOTE: constraint jobs_job_type_check was dropped and re-added by this file with a new definition; restore its prior definition from the earlier migration that created it.
--   NOTE: constraint jobs_source_source_job_id_key was dropped and re-added by this file with a new definition; restore its prior definition from the earlier migration that created it.
--   NOTE: this migration itself drops INDEX jobs_source_source_job_id_unique - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops INDEX jobs_apply_url_unique - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261001_phase1_storage_optimization.sql
-- ------------------------------------------------------------------------------
-- ============================================================
-- Phase 1 Migration: Storage-Optimized 100k Ingestion & Verification
-- ============================================================

-- 1. COMPANIES TABLE (Normalized entity, eliminates repeating strings)
CREATE TABLE IF NOT EXISTS public.companies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  domain          TEXT,
  careers_url     TEXT,
  ats_type        TEXT,
  country         TEXT,
  country_code    CHAR(2),
  logo_url        TEXT,
  enabled         BOOLEAN DEFAULT true,
  failure_count   INTEGER DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_job_count  INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- 2. COMPANY BOARDS TABLE (Tracks ATS endpoints for automated discovery)
CREATE TABLE IF NOT EXISTS public.company_boards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  ats_type        TEXT NOT NULL, -- 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable'
  slug            TEXT NOT NULL,
  careers_url     TEXT,
  country         TEXT,
  country_code    CHAR(2),
  enabled         BOOLEAN DEFAULT true,
  last_success_at TIMESTAMPTZ,
  last_job_count  INTEGER DEFAULT 0,
  failure_count   INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT company_boards_ats_slug_unique UNIQUE (ats_type, slug)
);

-- 3. EXPAND JOBS TABLE WITH COMPACT VERIFICATION & TAXONOMY COLUMNS
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'ats' CHECK (source_type IN ('ats', 'api', 'feed', 'direct')),
  ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS country_code CHAR(2),
  ADD COLUMN IF NOT EXISTS remote_eligibility TEXT DEFAULT 'unknown' CHECK (remote_eligibility IN ('worldwide', 'country_restricted', 'unknown')),
  ADD COLUMN IF NOT EXISTS seniority TEXT DEFAULT 'unknown' CHECK (seniority IN ('entry', 'mid', 'senior', 'staff', 'lead', 'director', 'unknown')),
  ADD COLUMN IF NOT EXISTS salary_period TEXT DEFAULT 'yearly' CHECK (salary_period IN ('yearly', 'monthly', 'hourly'));

-- 4. SPLIT JOB DESCRIPTIONS (Saves ~93% space on primary jobs table)
CREATE TABLE IF NOT EXISTS public.job_descriptions (
  job_id           UUID PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  description_text TEXT,
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- Backfill job_descriptions from existing jobs.description if any
INSERT INTO public.job_descriptions (job_id, description_text)
SELECT id, description
FROM public.jobs
WHERE description IS NOT NULL
ON CONFLICT (job_id) DO NOTHING;

-- 5. OBSERVABILITY TABLE: INGEST RUNS
CREATE TABLE IF NOT EXISTS public.ingest_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at          TIMESTAMPTZ DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  duration_seconds    INTEGER,
  companies_processed INTEGER DEFAULT 0,
  total_active        INTEGER DEFAULT 0,
  total_verified      INTEGER DEFAULT 0,
  per_source_counts   JSONB DEFAULT '{}'::jsonb,
  status              TEXT DEFAULT 'running', -- 'success', 'warning', 'failed'
  error               TEXT
);

-- 6. PARTIAL INDEXES FOR 100K SCALE (High query speed, minimal disk overhead)
CREATE INDEX IF NOT EXISTS jobs_active_verified_idx
  ON public.jobs (country_code, seniority, job_type)
  WHERE is_active = true AND status = 'active';

CREATE INDEX IF NOT EXISTS jobs_company_id_idx
  ON public.jobs (company_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS jobs_verified_status_idx
  ON public.jobs (verified, is_active);

CREATE INDEX IF NOT EXISTS company_boards_lookup_idx
  ON public.company_boards (ats_type, enabled)
  WHERE enabled = true;

-- 7. ROW LEVEL SECURITY
ALTER TABLE public.companies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_boards   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_descriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingest_runs      ENABLE ROW LEVEL SECURITY;

-- Public read for companies & boards
DROP POLICY IF EXISTS "companies_public_read" ON public.companies;
CREATE POLICY "companies_public_read" ON public.companies FOR SELECT USING (true);

DROP POLICY IF EXISTS "company_boards_public_read" ON public.company_boards;
CREATE POLICY "company_boards_public_read" ON public.company_boards FOR SELECT USING (enabled = true);

-- Job descriptions readable only for active jobs
DROP POLICY IF EXISTS "job_descriptions_public_read" ON public.job_descriptions;
CREATE POLICY "job_descriptions_public_read" ON public.job_descriptions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.jobs j 
      WHERE j.id = job_id AND (j.is_active = true OR j.status = 'active')
    )
  );

-- Ingest runs readable for monitoring/admin
DROP POLICY IF EXISTS "ingest_runs_public_read" ON public.ingest_runs;
CREATE POLICY "ingest_runs_public_read" ON public.ingest_runs FOR SELECT USING (true);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "companies_public_read" ON public.companies;
--   DROP POLICY IF EXISTS "company_boards_public_read" ON public.company_boards;
--   DROP POLICY IF EXISTS "job_descriptions_public_read" ON public.job_descriptions;
--   DROP POLICY IF EXISTS "ingest_runs_public_read" ON public.ingest_runs;
--   DROP INDEX IF EXISTS public.jobs_active_verified_idx;
--   DROP INDEX IF EXISTS public.jobs_company_id_idx;
--   DROP INDEX IF EXISTS public.jobs_verified_status_idx;
--   DROP INDEX IF EXISTS public.company_boards_lookup_idx;
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS company_id;
--   ALTER TABLE public.companies DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.company_boards DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.job_descriptions DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.ingest_runs DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.companies CASCADE;
--   DROP TABLE IF EXISTS public.company_boards CASCADE;
--   DROP TABLE IF EXISTS public.job_descriptions CASCADE;
--   DROP TABLE IF EXISTS public.ingest_runs CASCADE;
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261008_phase1_candidate_and_tracker.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Phase 1 (v1.1) Migration: Candidate Profiles & Application Kanban Tracker
-- ============================================================================

-- 1. Candidate Profiles (Parsed & Confirmed Facts)
create table if not exists public.candidate_profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  name              text,
  email             text,
  phone             text,
  headline          text,
  summary           text,
  skills            text[] default '{}',
  experience_json   jsonb default '[]'::jsonb,
  education_json    jsonb default '[]'::jsonb,
  certifications    text[] default '{}',
  raw_resume_text   text,
  confirmed_at      timestamptz,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- RLS on candidate_profiles
alter table public.candidate_profiles enable row level security;

drop policy if exists "candidate_profiles_owner_select" on public.candidate_profiles;
create policy "candidate_profiles_owner_select"
  on public.candidate_profiles for select
  using (auth.uid() = user_id);

drop policy if exists "candidate_profiles_owner_insert" on public.candidate_profiles;
create policy "candidate_profiles_owner_insert"
  on public.candidate_profiles for insert
  with check (auth.uid() = user_id);

drop policy if exists "candidate_profiles_owner_update" on public.candidate_profiles;
create policy "candidate_profiles_owner_update"
  on public.candidate_profiles for update
  using (auth.uid() = user_id);

drop policy if exists "candidate_profiles_owner_delete" on public.candidate_profiles;
create policy "candidate_profiles_owner_delete"
  on public.candidate_profiles for delete
  using (auth.uid() = user_id);

-- 2. Applications (Kanban Tracker)
create table if not exists public.applications (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete cascade,
  job_id            uuid references public.jobs(id) on delete set null,
  company           text not null,
  title             text not null,
  location          text,
  salary_text       text,
  apply_url         text,
  stage             text not null check (stage in ('saved', 'applied', 'interview', 'offer', 'rejected')) default 'saved',
  notes             text,
  applied_at        timestamptz,
  follow_up_at      timestamptz,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- Indexes for performance
create index if not exists applications_user_stage_idx
  on public.applications (user_id, stage);

create index if not exists applications_user_created_idx
  on public.applications (user_id, created_at desc);

-- RLS on applications
alter table public.applications enable row level security;

drop policy if exists "applications_owner_select" on public.applications;
create policy "applications_owner_select"
  on public.applications for select
  using (auth.uid() = user_id);

drop policy if exists "applications_owner_insert" on public.applications;
create policy "applications_owner_insert"
  on public.applications for insert
  with check (auth.uid() = user_id);

drop policy if exists "applications_owner_update" on public.applications;
create policy "applications_owner_update"
  on public.applications for update
  using (auth.uid() = user_id);

drop policy if exists "applications_owner_delete" on public.applications;
create policy "applications_owner_delete"
  on public.applications for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "candidate_profiles_owner_select" ON public.candidate_profiles;
--   DROP POLICY IF EXISTS "candidate_profiles_owner_insert" ON public.candidate_profiles;
--   DROP POLICY IF EXISTS "candidate_profiles_owner_update" ON public.candidate_profiles;
--   DROP POLICY IF EXISTS "candidate_profiles_owner_delete" ON public.candidate_profiles;
--   DROP POLICY IF EXISTS "applications_owner_select" ON public.applications;
--   DROP POLICY IF EXISTS "applications_owner_insert" ON public.applications;
--   DROP POLICY IF EXISTS "applications_owner_update" ON public.applications;
--   DROP POLICY IF EXISTS "applications_owner_delete" ON public.applications;
--   DROP INDEX IF EXISTS public.applications_user_stage_idx;
--   DROP INDEX IF EXISTS public.applications_user_created_idx;
--   ALTER TABLE public.candidate_profiles DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.applications DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.candidate_profiles CASCADE;
--   DROP TABLE IF EXISTS public.applications CASCADE;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261008_phase2_daily_digest_cron.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- PHASE 2: DAILY AUTOMATED CRON & DIGEST QUEUE
-- CareerMonke / Career Hound v1.2
-- Idempotent daily scans, deterministic match score queuing, and run audit logs.
-- ==============================================================================

-- 1. Cron Execution Audit Logs
CREATE TABLE IF NOT EXISTS cron_run_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL DEFAULT 'daily_job_scan_and_digest',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  jobs_scanned_count INT DEFAULT 0,
  new_jobs_count INT DEFAULT 0,
  digests_queued_count INT DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cron_run_logs_started_at ON cron_run_logs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_run_logs_status ON cron_run_logs(status);

-- 2. Daily User Digests (Guaranteed Idempotent per User per Date)
CREATE TABLE IF NOT EXISTS daily_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  digest_date DATE NOT NULL DEFAULT CURRENT_DATE,
  matched_jobs JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'viewed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT daily_digests_user_date_unique UNIQUE (user_id, digest_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_digests_user_date ON daily_digests(user_id, digest_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_digests_status ON daily_digests(status);

-- Enable Row Level Security
ALTER TABLE cron_run_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_digests ENABLE ROW LEVEL SECURITY;

-- Candidates can view their own daily digests
CREATE POLICY "Users can view their own daily digests"
  ON daily_digests
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own digest status (mark viewed)"
  ON daily_digests
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role has full access
CREATE POLICY "Service role full access to cron logs"
  ON cron_run_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access to daily digests"
  ON daily_digests
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_cron_run_logs_started_at;
--   DROP INDEX IF EXISTS public.idx_cron_run_logs_status;
--   DROP INDEX IF EXISTS public.idx_daily_digests_user_date;
--   DROP INDEX IF EXISTS public.idx_daily_digests_status;
--   ALTER TABLE public.cron_run_logs DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.daily_digests DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.cron_run_logs CASCADE;
--   DROP TABLE IF EXISTS public.daily_digests CASCADE;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261008_phase3_subscriptions_and_billing.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- PHASE 3: BILLING — RAZORPAY + STRIPE SUBSCRIPTIONS & DUNNING
-- CareerMonke / Career Hound v2.0
-- Domestic (Rs 199/month) + International ($9/month), webhooks, grace period, dunning.
-- ==============================================================================

-- 1. Subscriptions Table
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('razorpay', 'stripe', 'manual')),
  customer_id TEXT,
  subscription_id TEXT,
  plan_id TEXT NOT NULL DEFAULT 'domestic_monthly_199',
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR', 'USD', 'EUR', 'GBP')),
  amount INT NOT NULL DEFAULT 19900, -- in smallest currency unit (paise or cents)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trialing', 'in_grace_period', 'past_due', 'canceled', 'unpaid')),
  current_period_start TIMESTAMPTZ DEFAULT NOW(),
  current_period_end TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
  grace_period_end TIMESTAMPTZ, -- Set on payment failure (7 days grace)
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT subscriptions_user_unique UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider ON subscriptions(provider, subscription_id);

-- 2. Dunning & Renewal Failure Audit Table
CREATE TABLE IF NOT EXISTS dunning_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subscription_id TEXT,
  event_type TEXT NOT NULL,
  failure_reason TEXT,
  attempt_count INT DEFAULT 1,
  grace_period_expires_at TIMESTAMPTZ,
  dunning_email_queued BOOLEAN DEFAULT TRUE,
  dunning_email_sent_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dunning_logs_user_id ON dunning_logs(user_id);

-- Enable Row Level Security
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_logs ENABLE ROW LEVEL SECURITY;

-- Users can view their own subscription
CREATE POLICY "Users can view own subscription"
  ON subscriptions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Service role full access for webhook handlers
CREATE POLICY "Service role full access to subscriptions"
  ON subscriptions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access to dunning logs"
  ON dunning_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_subscriptions_user_id;
--   DROP INDEX IF EXISTS public.idx_subscriptions_status;
--   DROP INDEX IF EXISTS public.idx_subscriptions_provider;
--   DROP INDEX IF EXISTS public.idx_dunning_logs_user_id;
--   ALTER TABLE public.subscriptions DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.dunning_logs DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.subscriptions CASCADE;
--   DROP TABLE IF EXISTS public.dunning_logs CASCADE;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261008_phase4_user_preferences_and_onboarding.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Phase 4 Migration: User Preferences & Onboarding State
-- ============================================================================

create table if not exists public.user_preferences (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  roles               text[] default '{}',
  categories          text[] default '{}',
  experience_level    text,
  employment_types    text[] default '{}',
  locations           text[] default '{}',
  remote_preference   text default 'any', -- 'remote', 'hybrid', 'onsite', 'any'
  work_auth           text,
  min_salary          numeric,
  salary_currency     text default 'USD',
  daily_digest_opt_in boolean default true,
  onboarding_completed boolean default false,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

alter table public.user_preferences enable row level security;

drop policy if exists "user_preferences_owner_select" on public.user_preferences;
create policy "user_preferences_owner_select"
  on public.user_preferences for select
  using (auth.uid() = user_id);

drop policy if exists "user_preferences_owner_insert" on public.user_preferences;
create policy "user_preferences_owner_insert"
  on public.user_preferences for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_preferences_owner_update" on public.user_preferences;
create policy "user_preferences_owner_update"
  on public.user_preferences for update
  using (auth.uid() = user_id);

drop policy if exists "user_preferences_owner_delete" on public.user_preferences;
create policy "user_preferences_owner_delete"
  on public.user_preferences for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "user_preferences_owner_select" ON public.user_preferences;
--   DROP POLICY IF EXISTS "user_preferences_owner_insert" ON public.user_preferences;
--   DROP POLICY IF EXISTS "user_preferences_owner_update" ON public.user_preferences;
--   DROP POLICY IF EXISTS "user_preferences_owner_delete" ON public.user_preferences;
--   ALTER TABLE public.user_preferences DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.user_preferences CASCADE;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261009_candidate_profile_location.sql
-- ------------------------------------------------------------------------------
-- ============================================================
-- Migration: Add location column to candidate_profiles table
-- ============================================================

ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS location TEXT;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS location;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261009_production_fixes.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- PRODUCTION INTEGRITY & SCHEMA SYNCHRONIZATION MIGRATION (NON-DESTRUCTIVE)
-- Date: 2026-10-09
-- Scope: candidate_profiles, user_preferences, applications, daily_digests, subscriptions
-- Safe for execution on live Supabase production database (Idempotent: IF NOT EXISTS)
-- ==============================================================================

-- 1. CANDIDATE PROFILES
-- Ensure candidate_profiles table and missing columns exist
CREATE TABLE IF NOT EXISTS public.candidate_profiles (
  user_id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name              TEXT,
  email             TEXT,
  phone             TEXT,
  headline          TEXT,
  summary           TEXT,
  skills            TEXT[] DEFAULT '{}',
  experience_json   JSONB DEFAULT '[]'::jsonb,
  education_json    JSONB DEFAULT '[]'::jsonb,
  certifications    TEXT[] DEFAULT '{}',
  raw_resume_text   TEXT,
  confirmed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Add any missing columns defensively (non-destructive)
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS experience_json JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS education_json JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS certifications TEXT[] DEFAULT '{}';
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS raw_resume_text TEXT;

-- Enable RLS and idempotent policies for candidate_profiles
ALTER TABLE public.candidate_profiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'candidate_profiles' AND policyname = 'candidate_profiles_owner_select') THEN
    CREATE POLICY "candidate_profiles_owner_select" ON public.candidate_profiles FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'candidate_profiles' AND policyname = 'candidate_profiles_owner_insert') THEN
    CREATE POLICY "candidate_profiles_owner_insert" ON public.candidate_profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'candidate_profiles' AND policyname = 'candidate_profiles_owner_update') THEN
    CREATE POLICY "candidate_profiles_owner_update" ON public.candidate_profiles FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'candidate_profiles' AND policyname = 'candidate_profiles_owner_delete') THEN
    CREATE POLICY "candidate_profiles_owner_delete" ON public.candidate_profiles FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;


-- 2. USER PREFERENCES
CREATE TABLE IF NOT EXISTS public.user_preferences (
  user_id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  roles                TEXT[] DEFAULT '{}',
  categories           TEXT[] DEFAULT '{}',
  experience_level     TEXT,
  employment_types     TEXT[] DEFAULT '{}',
  locations            TEXT[] DEFAULT '{}',
  remote_preference    TEXT DEFAULT 'any',
  work_auth            TEXT,
  min_salary           NUMERIC,
  salary_currency      TEXT DEFAULT 'USD',
  daily_digest_opt_in  BOOLEAN DEFAULT TRUE,
  onboarding_completed BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS and idempotent policies for user_preferences
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_preferences' AND policyname = 'user_preferences_owner_select') THEN
    CREATE POLICY "user_preferences_owner_select" ON public.user_preferences FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_preferences' AND policyname = 'user_preferences_owner_insert') THEN
    CREATE POLICY "user_preferences_owner_insert" ON public.user_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_preferences' AND policyname = 'user_preferences_owner_update') THEN
    CREATE POLICY "user_preferences_owner_update" ON public.user_preferences FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_preferences' AND policyname = 'user_preferences_owner_delete') THEN
    CREATE POLICY "user_preferences_owner_delete" ON public.user_preferences FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;


-- 3. APPLICATIONS TRACKER
CREATE TABLE IF NOT EXISTS public.applications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id            UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  company           TEXT NOT NULL,
  title             TEXT NOT NULL,
  location          TEXT,
  salary_text       TEXT,
  apply_url         TEXT,
  stage             TEXT NOT NULL CHECK (stage IN ('saved', 'applied', 'interview', 'offer', 'rejected')) DEFAULT 'saved',
  notes             TEXT,
  applied_at        TIMESTAMPTZ,
  follow_up_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS applications_user_stage_idx ON public.applications (user_id, stage);
CREATE INDEX IF NOT EXISTS applications_user_created_idx ON public.applications (user_id, created_at DESC);

ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'applications' AND policyname = 'applications_owner_select') THEN
    CREATE POLICY "applications_owner_select" ON public.applications FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'applications' AND policyname = 'applications_owner_insert') THEN
    CREATE POLICY "applications_owner_insert" ON public.applications FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'applications' AND policyname = 'applications_owner_update') THEN
    CREATE POLICY "applications_owner_update" ON public.applications FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'applications' AND policyname = 'applications_owner_delete') THEN
    CREATE POLICY "applications_owner_delete" ON public.applications FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;


-- 4. DAILY DIGESTS
CREATE TABLE IF NOT EXISTS public.daily_digests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  digest_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  matched_jobs JSONB NOT NULL DEFAULT '[]'::jsonb,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'viewed')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT daily_digests_user_date_unique UNIQUE (user_id, digest_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_digests_user_date ON public.daily_digests(user_id, digest_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_digests_status ON public.daily_digests(status);

ALTER TABLE public.daily_digests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'daily_digests' AND policyname = 'daily_digests_owner_select') THEN
    CREATE POLICY "daily_digests_owner_select" ON public.daily_digests FOR SELECT TO authenticated USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'daily_digests' AND policyname = 'daily_digests_owner_update') THEN
    CREATE POLICY "daily_digests_owner_update" ON public.daily_digests FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;


-- 5. SUBSCRIPTIONS & BILLING
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL CHECK (provider IN ('razorpay', 'stripe', 'manual')),
  customer_id          TEXT,
  subscription_id      TEXT,
  plan_id              TEXT NOT NULL DEFAULT 'domestic_monthly_199',
  currency             TEXT NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR', 'USD', 'EUR', 'GBP')),
  amount               INT NOT NULL DEFAULT 19900,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trialing', 'in_grace_period', 'past_due', 'canceled', 'unpaid')),
  current_period_start TIMESTAMPTZ DEFAULT NOW(),
  current_period_end   TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
  grace_period_end     TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  metadata             JSONB DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT subscriptions_user_unique UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.subscriptions(status);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'subscriptions' AND policyname = 'subscriptions_owner_select') THEN
    CREATE POLICY "subscriptions_owner_select" ON public.subscriptions FOR SELECT TO authenticated USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "daily_digests_owner_select" ON public.daily_digests;
--   DROP POLICY IF EXISTS "daily_digests_owner_update" ON public.daily_digests;
--   DROP POLICY IF EXISTS "subscriptions_owner_select" ON public.subscriptions;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS location;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS confirmed_at;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS experience_json;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS education_json;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS certifications;
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS raw_resume_text;
--   NOTE: re-declares table public.candidate_profiles (created in 20261008_phase1_candidate_and_tracker.sql); rollback of THIS file does not drop it.
--   NOTE: re-declares table public.user_preferences (created in 20261008_phase4_user_preferences_and_onboarding.sql); rollback of THIS file does not drop it.
--   NOTE: re-declares table public.applications (created in 20261008_phase1_candidate_and_tracker.sql); rollback of THIS file does not drop it.
--   NOTE: re-declares table public.daily_digests (created in 20261008_phase2_daily_digest_cron.sql); rollback of THIS file does not drop it.
--   NOTE: re-declares table public.subscriptions (created in 20261008_phase3_subscriptions_and_billing.sql); rollback of THIS file does not drop it.
--   NOTE: re-declares index applications_user_stage_idx (created in 20261008_phase1_candidate_and_tracker.sql); not dropped here.
--   NOTE: re-declares index applications_user_created_idx (created in 20261008_phase1_candidate_and_tracker.sql); not dropped here.
--   NOTE: re-declares index idx_daily_digests_user_date (created in 20261008_phase2_daily_digest_cron.sql); not dropped here.
--   NOTE: re-declares index idx_daily_digests_status (created in 20261008_phase2_daily_digest_cron.sql); not dropped here.
--   NOTE: re-declares index idx_subscriptions_user_id (created in 20261008_phase3_subscriptions_and_billing.sql); not dropped here.
--   NOTE: re-declares index idx_subscriptions_status (created in 20261008_phase3_subscriptions_and_billing.sql); not dropped here.
--   NOTE: re-declares policy "candidate_profiles_owner_select" on public.candidate_profiles (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "candidate_profiles_owner_insert" on public.candidate_profiles (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "candidate_profiles_owner_update" on public.candidate_profiles (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "candidate_profiles_owner_delete" on public.candidate_profiles (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "user_preferences_owner_select" on public.user_preferences (from 20261008_phase4_user_preferences_and_onboarding.sql).
--   NOTE: re-declares policy "user_preferences_owner_insert" on public.user_preferences (from 20261008_phase4_user_preferences_and_onboarding.sql).
--   NOTE: re-declares policy "user_preferences_owner_update" on public.user_preferences (from 20261008_phase4_user_preferences_and_onboarding.sql).
--   NOTE: re-declares policy "user_preferences_owner_delete" on public.user_preferences (from 20261008_phase4_user_preferences_and_onboarding.sql).
--   NOTE: re-declares policy "applications_owner_select" on public.applications (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "applications_owner_insert" on public.applications (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "applications_owner_update" on public.applications (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-declares policy "applications_owner_delete" on public.applications (from 20261008_phase1_candidate_and_tracker.sql).
--   NOTE: re-enables RLS on public.candidate_profiles (first enabled in 20261008_phase1_candidate_and_tracker.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: re-enables RLS on public.user_preferences (first enabled in 20261008_phase4_user_preferences_and_onboarding.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: re-enables RLS on public.applications (first enabled in 20261008_phase1_candidate_and_tracker.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: re-enables RLS on public.daily_digests (first enabled in 20261008_phase2_daily_digest_cron.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: re-enables RLS on public.subscriptions (first enabled in 20261008_phase3_subscriptions_and_billing.sql); rollback of THIS file leaves RLS as it was.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261010_lock_paid_jobs_data.sql
-- ------------------------------------------------------------------------------
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


-- ------------------------------------------------------------------------------
-- Migration: 20261010_tailored_resumes.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: Tailored Resumes & Cover Letters Per-Job Cache (Multi-User)
-- Date: 2026-10-10
-- Scope: tailored_resumes (stores tailored ATS resumes and cover letters per user & job)
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

-- Indexes for lightning fast per-job caching lookups
CREATE INDEX IF NOT EXISTS tailored_resumes_user_job_idx
  ON public.tailored_resumes (user_id, job_id);

CREATE INDEX IF NOT EXISTS tailored_resumes_user_updated_idx
  ON public.tailored_resumes (user_id, updated_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE public.tailored_resumes ENABLE ROW LEVEL SECURITY;

-- Idempotent RLS policies for owner access
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

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "tailored_resumes_owner_select" ON public.tailored_resumes;
--   DROP POLICY IF EXISTS "tailored_resumes_owner_insert" ON public.tailored_resumes;
--   DROP POLICY IF EXISTS "tailored_resumes_owner_update" ON public.tailored_resumes;
--   DROP POLICY IF EXISTS "tailored_resumes_owner_delete" ON public.tailored_resumes;
--   DROP INDEX IF EXISTS public.tailored_resumes_user_job_idx;
--   DROP INDEX IF EXISTS public.tailored_resumes_user_updated_idx;
--   ALTER TABLE public.tailored_resumes DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.tailored_resumes CASCADE;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261011_admin_page_views_and_blocked_users.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: Admin Analytics (page_views) & User Moderation (blocked_users)
-- ==============================================================================

-- 1. Create page_views table for lightweight non-blocking page-view tracking
CREATE TABLE IF NOT EXISTS public.page_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    path TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    referrer TEXT,
    ip_hash TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Performance indexes for analytics aggregation
CREATE INDEX IF NOT EXISTS idx_page_views_path ON public.page_views(path);
CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON public.page_views(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_views_user_id ON public.page_views(user_id);
CREATE INDEX IF NOT EXISTS idx_page_views_ip_hash ON public.page_views(ip_hash);

-- Enable Row Level Security
ALTER TABLE public.page_views ENABLE ROW LEVEL SECURITY;

-- Allow anonymous or authenticated clients to INSERT page views (fire-and-forget logging)
DROP POLICY IF EXISTS "Allow public insert to page_views" ON public.page_views;
CREATE POLICY "Allow public insert to page_views"
    ON public.page_views FOR INSERT
    WITH CHECK (true);

-- Allow ONLY admin email xbsuryakant@gmail.com to SELECT page_views
DROP POLICY IF EXISTS "Allow admin to select page_views" ON public.page_views;
CREATE POLICY "Allow admin to select page_views"
    ON public.page_views FOR SELECT
    USING (
        auth.jwt() ->> 'email' = 'xbsuryakant@gmail.com'
    );

-- 2. Create blocked_users table for immediate server-side revocation and moderation
CREATE TABLE IF NOT EXISTS public.blocked_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    reason TEXT DEFAULT 'Violation of Terms or Suspicious Activity',
    blocked_by TEXT DEFAULT 'admin',
    blocked_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Indexes for fast moderation lookup
CREATE INDEX IF NOT EXISTS idx_blocked_users_email ON public.blocked_users(email);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked_at ON public.blocked_users(blocked_at DESC);

-- Enable Row Level Security
ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;

-- Allow users to read their own blocked status or admin to read all
DROP POLICY IF EXISTS "Allow users or admin to read blocked_users" ON public.blocked_users;
CREATE POLICY "Allow users or admin to read blocked_users"
    ON public.blocked_users FOR SELECT
    USING (
        auth.uid() = user_id OR auth.jwt() ->> 'email' = 'xbsuryakant@gmail.com'
    );

-- Allow ONLY admin to insert, update, or delete blocked_users
DROP POLICY IF EXISTS "Allow admin to modify blocked_users" ON public.blocked_users;
CREATE POLICY "Allow admin to modify blocked_users"
    ON public.blocked_users FOR ALL
    USING (
        auth.jwt() ->> 'email' = 'xbsuryakant@gmail.com'
    );

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "Allow public insert to page_views" ON public.page_views;
--   DROP POLICY IF EXISTS "Allow admin to select page_views" ON public.page_views;
--   DROP POLICY IF EXISTS "Allow users or admin to read blocked_users" ON public.blocked_users;
--   DROP POLICY IF EXISTS "Allow admin to modify blocked_users" ON public.blocked_users;
--   DROP INDEX IF EXISTS public.idx_page_views_path;
--   DROP INDEX IF EXISTS public.idx_page_views_created_at;
--   DROP INDEX IF EXISTS public.idx_page_views_user_id;
--   DROP INDEX IF EXISTS public.idx_page_views_ip_hash;
--   DROP INDEX IF EXISTS public.idx_blocked_users_email;
--   DROP INDEX IF EXISTS public.idx_blocked_users_blocked_at;
--   ALTER TABLE public.page_views DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.blocked_users DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.page_views CASCADE;
--   DROP TABLE IF EXISTS public.blocked_users CASCADE;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261011_ai_usage_quotas.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: Durable AI Usage Quota Tracking
-- Date: 2026-10-11
-- Scope: ai_usage_quotas (persistent per-user daily AI call counters)
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

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "ai_usage_quotas_owner_select" ON public.ai_usage_quotas;
--   DROP INDEX IF EXISTS public.ai_usage_quotas_user_date_idx;
--   DROP INDEX IF EXISTS public.ai_usage_quotas_user_idx;
--   ALTER TABLE public.ai_usage_quotas DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.ai_usage_quotas CASCADE;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261016_lock_job_descriptions.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: Lock Job Descriptions Table & Revoke Public Anon Access
-- Date: 2026-10-16
-- Scope: RLS and table privileges on public.job_descriptions
-- Status: NOT APPLIED (Prepared migration file for owner execution)
--   If/when applied: record with  node scripts/record-migration.cjs 20261016_lock_job_descriptions
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

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "job_descriptions_service_role_all" ON public.job_descriptions;
--   NOTE: re-enables RLS on public.job_descriptions (first enabled in 20261001_phase1_storage_optimization.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: this migration itself drops POLICY job_descriptions_public_read - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops POLICY job_descriptions_anon_read - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops POLICY job_descriptions_authenticated_read - restore it from the earlier migration that created it (or from backup) if rolling back.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261016_worldwide_company_counts.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: Create Worldwide Remote Company Counts View
-- Date: 2026-10-16
-- Scope: public.worldwide_company_counts view
-- Status: PENDING APPLICATION (Run in Supabase SQL editor by project owner)
--   If/when applied: record with  node scripts/record-migration.cjs 20261016_worldwide_company_counts
--
-- SECURITY & PAID LOCK DISCIPLINE:
-- Why this view does NOT bypass the paid lock on jobs data:
-- 1. Aggregated Metrics Only: It exposes solely the aggregate active job count
--    (COUNT(j.id)) per company. It does NOT expose individual job records,
--    descriptions, salary figures, applicant contact details, or direct ATS apply URLs.
-- 2. Whitelisted Entities Only: Restricted via WHERE clause strictly to companies
--    already publicly visible in the static CareerMonke directory (src/data/companies.json).
--    Guests never see more organizations than they do in the public catalog today.
-- 3. Strict Column Boundary: Exposes only (name, slug, country, active_job_count).
--    All Pro-gated fields remain fully guarded by RLS on public.jobs and the
--    server-verified /api/jobs/pro entitlement endpoint.
-- ==============================================================================

CREATE OR REPLACE VIEW public.worldwide_company_counts AS
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
GROUP BY c.name, c.slug, c.country, c.country_code
HAVING COUNT(j.id) > 0
ORDER BY active_job_count DESC;

-- Grant read access to public and authenticated roles
GRANT SELECT ON public.worldwide_company_counts TO anon, authenticated, service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP VIEW IF EXISTS public.worldwide_company_counts;
--   REVOKE SELECT ON public.worldwide_company_counts FROM anon, authenticated, service_role;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261019_webhook_events.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: webhook_events idempotency table
-- Purpose: Atomic, race-safe webhook event deduplication for billing webhooks
-- (replaces the read-then-write metadata array approach, which is not atomic
-- and grows unbounded inside the subscriptions row).
-- NOTE: Owner applies this manually in the Supabase SQL Editor. Agents never run SQL.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.webhook_events (
  event_id     TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_type   TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- Webhooks are server-to-server only: no client-role access at all.
REVOKE ALL ON public.webhook_events FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.webhook_events TO service_role;

-- Optional periodic cleanup (keeps the table small; 90 days of events):
-- DELETE FROM public.webhook_events WHERE processed_at < now() - interval '90 days';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.webhook_events DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.webhook_events CASCADE;
--   REVOKE SELECT, INSERT, DELETE ON public.webhook_events FROM service_role;
--   GRANT ALL ON public.webhook_events TO anon, authenticated;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261020_admin_audit_log.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: Admin Audit Log
-- Date: 2026-10-20
-- Scope: Append-only audit trail for administrative mutations (bans, plan changes, etc.)
-- Security: Service-role only. Zero access for anon or authenticated roles.
-- ==============================================================================

-- 1. Create table public.admin_audit_log
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  admin_user_id uuid NOT NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash text NULL
);

-- 2. Performance indexes for administrative investigations and chronologically ordered reads
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
  ON public.admin_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_user_created_at
  ON public.admin_audit_log (admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
  ON public.admin_audit_log (action);

-- 3. Row Level Security & Access Permissions
-- Rows are strictly append-only; only the server-side service role may insert or read.
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke all privileges from client roles
REVOKE ALL ON TABLE public.admin_audit_log FROM anon, authenticated;

-- Grant full table access exclusively to service_role
GRANT ALL ON TABLE public.admin_audit_log TO service_role;

-- 4. Append-Only Enforcement Comment & Trigger
-- Rows in public.admin_audit_log must never be modified or deleted.
COMMENT ON TABLE public.admin_audit_log IS
  'Append-only administrative audit log. Updates and deletes are prohibited by trigger tr_prevent_admin_audit_log_mutation.';

CREATE OR REPLACE FUNCTION public.prevent_admin_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log rows are strictly append-only; UPDATE and DELETE operations are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_prevent_admin_audit_log_mutation ON public.admin_audit_log;
CREATE TRIGGER tr_prevent_admin_audit_log_mutation
  BEFORE UPDATE OR DELETE ON public.admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_admin_audit_log_mutation();

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP TRIGGER IF EXISTS tr_prevent_admin_audit_log_mutation ON public.admin_audit_log;
--   DROP INDEX IF EXISTS public.idx_admin_audit_log_created_at;
--   DROP INDEX IF EXISTS public.idx_admin_audit_log_admin_user_created_at;
--   DROP INDEX IF EXISTS public.idx_admin_audit_log_action;
--   ALTER TABLE public.admin_audit_log DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.admin_audit_log CASCADE;
--   DROP FUNCTION IF EXISTS public.prevent_admin_audit_log_mutation();
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261020_rate_limits.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Schema: Shared Rate Limit Store & Distributed Sliding-Window Throttling
-- Scope: Multi-instance serverless rate limiting for signup, login, and AI calls
-- File: supabase/migrations/20261020_rate_limits.sql
-- Status: APPLIED OUT-OF-BAND 2026-10-20 (owner-run in Supabase SQL editor).
-- Recorded here to close repo-vs-live drift (audit DB #58 / #65). DO NOT re-run.
-- ==============================================================================

-- 1. Create durable rate_limits table
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 1,
  window_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

-- 2. Index on expires_at for efficient cleanup/eviction of expired buckets
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires_at ON public.rate_limits (expires_at);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- Revoke direct table mutations from client roles
REVOKE ALL ON public.rate_limits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limits TO service_role;

-- 4. Atomic rate-limit checking function (token-bucket / sliding window)
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key TEXT,
  p_max_requests INTEGER,
  p_window_seconds INTEGER
)
RETURNS TABLE (
  allowed BOOLEAN,
  retry_after INTEGER,
  current_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_reset_at TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  -- Insert or increment atomically
  INSERT INTO public.rate_limits (key, count, window_start, expires_at)
  VALUES (
    p_key,
    1,
    v_now,
    v_now + (p_window_seconds || ' seconds')::interval
  )
  ON CONFLICT (key) DO UPDATE
  SET
    count = CASE
      WHEN public.rate_limits.expires_at <= v_now THEN 1
      ELSE public.rate_limits.count + 1
    END,
    window_start = CASE
      WHEN public.rate_limits.expires_at <= v_now THEN v_now
      ELSE public.rate_limits.window_start
    END,
    expires_at = CASE
      WHEN public.rate_limits.expires_at <= v_now THEN v_now + (p_window_seconds || ' seconds')::interval
      ELSE public.rate_limits.expires_at
    END
  RETURNING public.rate_limits.count, public.rate_limits.expires_at
  INTO v_count, v_reset_at;

  IF v_count > p_max_requests THEN
    RETURN QUERY SELECT
      false AS allowed,
      GREATEST(1, EXTRACT(EPOCH FROM (v_reset_at - v_now))::INTEGER) AS retry_after,
      v_count AS current_count;
  ELSE
    RETURN QUERY SELECT
      true AS allowed,
      0 AS retry_after,
      v_count AS current_count;
  END IF;
END;
$$;

-- Allow serverless functions and authenticated clients to invoke the check function
GRANT EXECUTE ON FUNCTION public.check_rate_limit(TEXT, INTEGER, INTEGER) TO anon, authenticated, service_role;

-- 5. Automated TTL cleanup function for cron maintenance
CREATE OR REPLACE FUNCTION public.cleanup_expired_rate_limits()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.rate_limits
  WHERE expires_at < clock_timestamp() - INTERVAL '1 hour';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_rate_limits_expires_at;
--   ALTER TABLE public.rate_limits DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.rate_limits CASCADE;
--   DROP FUNCTION IF EXISTS public.check_rate_limit(p_key TEXT, p_max_requests INTEGER, p_window_seconds INTEGER);
--   DROP FUNCTION IF EXISTS public.cleanup_expired_rate_limits();
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON public.rate_limits FROM service_role;
--   GRANT ALL ON public.rate_limits TO anon, authenticated;
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261028_ats_board_ingestion.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: ATS Company Board Token Registry & Consecutive Misses Tracking
-- Date: 2026-10-28
-- Scope: public.company_token_registry, public.jobs.consecutive_misses
-- Safety: Do NOT apply directly to production database during test/review.
-- ==============================================================================

-- 1. Add consecutive_misses column to public.jobs for stale board tracking
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS consecutive_misses INTEGER DEFAULT 0;

-- Optional index for stale tracking (commented out per migration safety):
-- Note: If needed in production, execute CONCURRENTLY outside a transaction block:
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_consecutive_misses_idx
--   ON public.jobs (consecutive_misses)
--   WHERE is_active = true;

-- 2. Create company_token_registry table for Greenhouse, Lever, and Ashby boards
CREATE TABLE IF NOT EXISTS public.company_token_registry (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company          TEXT NOT NULL,
  ats              TEXT NOT NULL CHECK (ats IN ('greenhouse', 'lever', 'ashby')),
  token            TEXT NOT NULL,
  country_hint     TEXT DEFAULT 'global',
  is_active        BOOLEAN DEFAULT true,
  last_verified_at TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT company_token_registry_ats_token_key UNIQUE (ats, token)
);

CREATE INDEX IF NOT EXISTS company_token_registry_ats_active_idx
  ON public.company_token_registry (ats, is_active)
  WHERE is_active = true;

-- 3. Row Level Security: Service-role only access (no public exposure)
ALTER TABLE public.company_token_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company_token_registry_service_all" ON public.company_token_registry;

REVOKE ALL ON public.company_token_registry FROM anon, authenticated;
GRANT ALL ON public.company_token_registry TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.company_token_registry_ats_active_idx;
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS consecutive_misses;
--   ALTER TABLE public.company_token_registry DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.company_token_registry CASCADE;
--   REVOKE ALL ON public.company_token_registry FROM service_role;
--   GRANT ALL ON public.company_token_registry TO anon, authenticated;
--   NOTE: this migration itself drops POLICY company_token_registry_service_all - restore it from the earlier migration that created it (or from backup) if rolling back.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261029_early_access_emails.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: Early Access Email Waitlist & Gmail Outgoing Send Log
-- Tables:
--   1. public.early_access_emails (email, created_at)
--   2. public.gmail_send_log (id, recipient_email, kind, sent_at)
--      Tracks:
--      - Outgoing message count for the 150 messages/day cap (sent_at)
--      - Double opt-in-light: at most 1 thank-you per distinct recipient_email ever
--      - Owner daily digest cursor: last_digest_at = MAX(sent_at) WHERE kind = 'digest'
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.early_access_emails (
  email      TEXT PRIMARY KEY CHECK (char_length(email) <= 254 AND position('@' in email) > 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_early_access_emails_created_at
  ON public.early_access_emails (created_at DESC);

ALTER TABLE public.early_access_emails ENABLE ROW LEVEL SECURITY;

-- Lock down direct client access; only server-side service_role can read/write
REVOKE ALL ON public.early_access_emails FROM anon, authenticated;
GRANT SELECT, INSERT ON public.early_access_emails TO service_role;

CREATE TABLE IF NOT EXISTS public.gmail_send_log (
  id              BIGSERIAL PRIMARY KEY,
  recipient_email TEXT,
  kind            TEXT NOT NULL DEFAULT 'thank_you' CHECK (kind IN ('thank_you', 'digest')),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gmail_send_log_sent_at
  ON public.gmail_send_log (sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_gmail_send_log_recipient_kind
  ON public.gmail_send_log (recipient_email, kind);

CREATE INDEX IF NOT EXISTS idx_gmail_send_log_kind_sent_at
  ON public.gmail_send_log (kind, sent_at DESC);

ALTER TABLE public.gmail_send_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.gmail_send_log FROM anon, authenticated;
GRANT SELECT, INSERT ON public.gmail_send_log TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_early_access_emails_created_at;
--   DROP INDEX IF EXISTS public.idx_gmail_send_log_sent_at;
--   DROP INDEX IF EXISTS public.idx_gmail_send_log_recipient_kind;
--   DROP INDEX IF EXISTS public.idx_gmail_send_log_kind_sent_at;
--   ALTER TABLE public.early_access_emails DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.gmail_send_log DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.early_access_emails CASCADE;
--   DROP TABLE IF EXISTS public.gmail_send_log CASCADE;
--   REVOKE SELECT, INSERT ON public.early_access_emails FROM service_role;
--   REVOKE SELECT, INSERT ON public.gmail_send_log FROM service_role;
--   GRANT ALL ON public.early_access_emails TO anon, authenticated;
--   GRANT ALL ON public.gmail_send_log TO anon, authenticated;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261030_early_access_approved.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: Manual Early Access Approval Gate
-- Table: public.early_access_approved (email, approved, created_at, updated_at)
--
-- Security & Operational Rules:
-- 1. Default approved = FALSE, NOT NULL.
-- 2. Email is stored lowercase (CHECK email = lower(trim(email))).
-- 3. RLS enabled: strictly REVOKE all from anon and authenticated.
-- 4. No client/user path may ever read or mutate this table.
-- 5. Only service_role can read/write for server-side verification and admin management.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.early_access_approved (
  email      TEXT PRIMARY KEY CHECK (char_length(email) <= 254 AND email = lower(trim(email))),
  approved   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_early_access_approved_lookup
  ON public.early_access_approved (email)
  WHERE approved = TRUE;

ALTER TABLE public.early_access_approved ENABLE ROW LEVEL SECURITY;

-- Revoke all permissions from untrusted roles
REVOKE ALL ON public.early_access_approved FROM PUBLIC, anon, authenticated;

-- Grant access strictly to service_role for server-side verification and manual updates
GRANT SELECT, INSERT, UPDATE, DELETE ON public.early_access_approved TO service_role;

-- Explicit fail-closed policies forbidding all anon and authenticated access
DROP POLICY IF EXISTS "Deny all user access on early_access_approved" ON public.early_access_approved;
CREATE POLICY "Deny all user access on early_access_approved"
  ON public.early_access_approved
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "Deny all user access on early_access_approved" ON public.early_access_approved;
--   DROP INDEX IF EXISTS public.idx_early_access_approved_lookup;
--   ALTER TABLE public.early_access_approved DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.early_access_approved CASCADE;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON public.early_access_approved FROM service_role;
--   GRANT ALL ON public.early_access_approved TO PUBLIC, anon, authenticated;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261031_account_delete_and_private_resumes.sql
-- ------------------------------------------------------------------------------
-- =============================================================================
-- Migration: 20261031_account_delete_and_private_resumes.sql
-- Purpose:
--   1. Ensure `saved_jobs` and `resumes` metadata tables exist with owner-only RLS
--      and ON DELETE CASCADE to auth.users(id).
--   2. Change `public.subscriptions.user_id` FK from ON DELETE CASCADE to
--      ON DELETE SET NULL (nullable) so reconciled subscription audit rows are
--      preserved when the auth user is deleted.
--   3. Enforce private `resumes` storage bucket (`public = FALSE`) with owner-only
--      storage.objects RLS policies (access strictly via signed URLs, never public URLs).
--   4. Document exact SQL / steps executed during account deletion before auth.users removal.
-- =============================================================================

-- 1. Saved Jobs table (owner-only RLS)
CREATE TABLE IF NOT EXISTS public.saved_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_jobs_user_id ON public.saved_jobs(user_id);

ALTER TABLE public.saved_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own saved_jobs" ON public.saved_jobs;
CREATE POLICY "Users can manage own saved_jobs"
  ON public.saved_jobs
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON TABLE public.saved_jobs FROM anon;

-- 2. Resumes metadata table (owner-only RLS, stores private storage object path only)
CREATE TABLE IF NOT EXISTS public.resumes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resumes_user_id ON public.resumes(user_id);

ALTER TABLE public.resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resumes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own resumes" ON public.resumes;
CREATE POLICY "Users can manage own resumes"
  ON public.resumes
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON TABLE public.resumes FROM anon;

-- 3. Preserve `public.subscriptions` rows on account deletion:
--    Make `user_id` nullable and change foreign key from ON DELETE CASCADE to ON DELETE SET NULL
ALTER TABLE public.subscriptions
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_user_id_fkey;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE SET NULL;

-- 4. Private `resumes` Storage Bucket (`public = FALSE`, owner-only access via signed URLs)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'resumes',
  'resumes',
  FALSE,
  5242880,
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = FALSE,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Remove any public/anon policies on storage.objects for `resumes`
DROP POLICY IF EXISTS "Public resume access" ON storage.objects;
DROP POLICY IF EXISTS "Owner can select own resume files" ON storage.objects;
DROP POLICY IF EXISTS "Owner can insert own resume files" ON storage.objects;
DROP POLICY IF EXISTS "Owner can update own resume files" ON storage.objects;
DROP POLICY IF EXISTS "Owner can delete own resume files" ON storage.objects;

-- Owner-only policies scoped strictly to `<auth.uid()>/<filename>` inside private bucket `resumes`
CREATE POLICY "Owner can select own resume files"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Owner can insert own resume files"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Owner can update own resume files"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Owner can delete own resume files"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- =============================================================================
-- Reference Account Deletion SQL Steps (executed via service_role in /api/account/delete):
--   Step 1 (Subscriptions): UPDATE public.subscriptions
--                              SET status = 'canceled', cancel_at_period_end = TRUE, canceled_at = now(), updated_at = now()
--                            WHERE user_id = :uid AND status IN ('active', 'trialing', 'in_grace_period');
--                           (Rows are kept; FK ON DELETE SET NULL clears user_id when auth user is deleted)
--   Step 2 (Profile):       DELETE FROM public.candidate_profiles WHERE user_id = :uid;
--                           DELETE FROM public.user_preferences   WHERE user_id = :uid;
--   Step 3 (Resumes):       DELETE FROM public.resumes            WHERE user_id = :uid;
--                           DELETE FROM public.tailored_resumes   WHERE user_id = :uid;
--   Step 4 (Saved Jobs):    DELETE FROM public.saved_jobs         WHERE user_id = :uid;
--   Step 5 (Applications):  DELETE FROM public.applications       WHERE user_id = :uid;
--                           DELETE FROM public.job_applications   WHERE user_id = :uid;
--   Step 6 (Early Access):  DELETE FROM public.early_access_emails WHERE lower(email) = lower(:email);
--   Step 7 (Storage Files): Recursively list (with pagination, 100 per page) and remove all objects
--                           under `resumes/:uid/**` via Supabase Storage API
--   Step 8 (Auth User):     Delete user `:uid` from `auth.users` via `auth.admin.deleteUser(:uid)`
-- =============================================================================

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "Users can manage own saved_jobs" ON public.saved_jobs;
--   DROP POLICY IF EXISTS "Users can manage own resumes" ON public.resumes;
--   DROP POLICY IF EXISTS "Owner can select own resume files" ON storage.objects;
--   DROP POLICY IF EXISTS "Owner can insert own resume files" ON storage.objects;
--   DROP POLICY IF EXISTS "Owner can update own resume files" ON storage.objects;
--   DROP POLICY IF EXISTS "Owner can delete own resume files" ON storage.objects;
--   DROP INDEX IF EXISTS public.idx_saved_jobs_user_id;
--   DROP INDEX IF EXISTS public.idx_resumes_user_id;
--   ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_user_id_fkey;
--   ALTER TABLE public.saved_jobs DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.resumes DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.saved_jobs CASCADE;
--   DROP TABLE IF EXISTS public.resumes CASCADE;
--   DELETE FROM storage.buckets WHERE id = 'resumes';
--   NOTE: constraint subscriptions_user_id_fkey was dropped and re-added by this file with a new definition; restore its prior definition from the earlier migration that created it.
--   NOTE: this migration itself drops POLICY public resume access - restore it from the earlier migration that created it (or from backup) if rolling back.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261101_company_logos_bucket.sql
-- ------------------------------------------------------------------------------
-- =============================================================================
-- Migration: 20261101_company_logos_bucket.sql
-- Purpose:
--   1. Create a public Supabase Storage bucket 'company-logos' for self-hosted
--      company logos in the landing page ticker strip (raster images only: png, jpeg, webp, gif).
--   2. Direct object downloads via public URLs (/storage/v1/object/public/company-logos/...)
--      work because `public = TRUE`. Public directory listing on storage.objects
--      is disallowed (no public SELECT policy).
--   3. Restrict writes (INSERT, UPDATE, DELETE) to service_role only.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'company-logos',
  'company-logos',
  TRUE,
  2097152,
  ARRAY[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = TRUE,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public listing must not be allowed: drop any public SELECT policy on storage.objects
DROP POLICY IF EXISTS "Public company logos read access" ON storage.objects;

-- Service role write access on storage.objects for company-logos bucket
DROP POLICY IF EXISTS "Service role write access on company logos" ON storage.objects;
CREATE POLICY "Service role write access on company logos"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'company-logos')
  WITH CHECK (bucket_id = 'company-logos');

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "Service role write access on company logos" ON storage.objects;
--   DELETE FROM storage.buckets WHERE id = 'company-logos';
--   NOTE: this migration itself drops POLICY public company logos read access - restore it from the earlier migration that created it (or from backup) if rolling back.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261101_lock_page_views_insert.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: Lock Down page_views Inserts & Enforce Service-Role Only Writes
-- Date: 2026-11-01
-- File: supabase/migrations/20261101_lock_page_views_insert.sql
-- Status: PENDING APPLICATION (Run in Supabase SQL editor by project owner)
--   If/when applied: record with  node scripts/record-migration.cjs 20261101_lock_page_views_insert
--
-- Security Context:
-- 1. In migration 20261011_admin_page_views_and_blocked_users.sql, policy
--    "Allow public insert to page_views" was created with WITH CHECK (true),
--    and default Supabase grants gave the anon and authenticated roles INSERT
--    privileges on public.page_views.
-- 2. This permitted anyone holding the public anon key to INSERT arbitrary rows
--    directly into public.page_views via PostgREST (forged paths, fake user agents,
--    forged ip_hash, unbounded row growth), bypassing /api/track validation and
--    poisoning admin analytics.
-- 3. The /api/track route writes using the service-role client (getSupabaseAdmin),
--    so revoking anon/authenticated INSERT and dropping the open policy closes
--    direct client injection without impacting legitimate tracking.
-- ==============================================================================

-- 1. Revoke INSERT privilege on public.page_views from anon and authenticated roles
REVOKE INSERT ON public.page_views FROM anon, authenticated;

-- 2. Drop legacy permissive public insert policy
DROP POLICY IF EXISTS "Allow public insert to page_views" ON public.page_views;

-- 3. Ensure service_role has INSERT privilege on public.page_views
GRANT INSERT ON public.page_views TO service_role;

-- 4. Leave the existing admin-email-only SELECT policy ("Allow admin to select page_views")
-- and every other table/policy untouched.

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   REVOKE INSERT ON public.page_views FROM service_role;
--   GRANT INSERT ON public.page_views TO anon, authenticated;
--   NOTE: this migration itself drops POLICY allow public insert to page_views - restore it from the earlier migration that created it (or from backup) if rolling back.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261101_lock_scraper_metadata.sql
-- ------------------------------------------------------------------------------
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

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP TRIGGER IF EXISTS trigger_refresh_worldwide_company_counts ON public.ingest_runs;
--   DROP POLICY IF EXISTS "companies_service_role_access" ON public.companies;
--   DROP POLICY IF EXISTS "ingest_runs_service_role_access" ON public.ingest_runs;
--   DROP INDEX IF EXISTS public.idx_worldwide_company_counts_slug;
--   DROP INDEX IF EXISTS public.idx_worldwide_company_counts_active_job_count;
--   DROP MATERIALIZED VIEW IF EXISTS public.worldwide_company_counts;
--   DROP FUNCTION IF EXISTS public.refresh_worldwide_company_counts();
--   DROP FUNCTION IF EXISTS public.on_ingest_run_completed_refresh_worldwide();
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON public.companies FROM service_role;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON public.ingest_runs FROM service_role;
--   REVOKE SELECT ON public.worldwide_company_counts FROM anon, authenticated, service_role;
--   GRANT SELECT ON public.companies TO anon, authenticated;
--   GRANT SELECT ON public.ingest_runs TO anon, authenticated;
--   NOTE: this replaces the earlier public.worldwide_company_counts (from 20261016_worldwide_company_counts.sql); after dropping the materialized view, restore the prior definition from that file.
--   NOTE: re-enables RLS on public.companies (first enabled in 20261001_phase1_storage_optimization.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: re-enables RLS on public.ingest_runs (first enabled in 20261001_phase1_storage_optimization.sql); rollback of THIS file leaves RLS as it was.
--   NOTE: this migration itself drops POLICY companies_public_read - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops POLICY allow public select on companies - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops POLICY ingest_runs_public_read - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops POLICY allow public select on ingest_runs - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops VIEW worldwide_company_counts - restore it from the earlier migration that created it (or from backup) if rolling back.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261101_user_preferences_eligibility_filter.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: Add eligibility_filter to user_preferences
-- Description: Supports country eligibility auto-filtering with user opt-out.
-- ============================================================================

ALTER TABLE public.user_preferences
ADD COLUMN IF NOT EXISTS eligibility_filter boolean DEFAULT true;

-- Backfill existing rows to true (default ON)
UPDATE public.user_preferences
SET eligibility_filter = true
WHERE eligibility_filter IS NULL;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS eligibility_filter;
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261103_plans_addons_usage.sql
-- ------------------------------------------------------------------------------
create table if not exists public.plans (
  code text primary key,
  name text not null,
  duration_days int not null,
  price_paise int not null,
  resume_quota int not null,
  cover_letter_quota int not null,
  quota_period_days int not null default 30,
  daily_generation_cap int not null default 30,
  sort_order int not null default 0,
  is_active boolean not null default true
);
insert into public.plans (code, name, duration_days, price_paise, resume_quota, cover_letter_quota, quota_period_days, sort_order) values
  ('weekly', 'Weekly', 7, 49900, 15, 15, 7, 1),
  ('monthly', 'Monthly', 30, 149900, 60, 60, 30, 2),
  ('quarterly', 'Quarterly', 90, 399900, 60, 60, 30, 3)
on conflict (code) do nothing;

create table if not exists public.addon_packs (
  code text primary key,
  price_paise int not null,
  sets int not null,
  validity_days int not null default 60,
  is_active boolean not null default true
);
insert into public.addon_packs (code, price_paise, sets) values
  ('addon_10', 14900, 10), ('addon_30', 39900, 30), ('addon_60', 69900, 60)
on conflict (code) do nothing;

create table if not exists public.user_addon_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pack_code text not null references public.addon_packs(code),
  sets_total int not null,
  sets_remaining int not null check (sets_remaining >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists addon_credits_user_expiry on public.user_addon_credits (user_id, expires_at);

create table if not exists public.plan_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('resume_tailor','cover_letter')),
  source text not null check (source in ('plan','addon')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index if not exists plan_usage_user_time on public.plan_usage_events (user_id, created_at);

create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'razorpay',
  provider_order_id text unique,
  plan_code text references public.plans(code),
  addon_code text references public.addon_packs(code),
  amount_paise int not null,
  currency text not null default 'INR',
  status text not null default 'created' check (status in ('created','paid','failed','expired')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);alter table public.plans enable row level security;
alter table public.addon_packs enable row level security;
alter table public.user_addon_credits enable row level security;
alter table public.plan_usage_events enable row level security;
alter table public.payment_orders enable row level security;
create policy "plans readable by all" on public.plans for select using (true);
create policy "addon packs readable by all" on public.addon_packs for select using (true);
create policy "users read own addon credits" on public.user_addon_credits for select using (auth.uid() = user_id);
create policy "users read own plan usage" on public.plan_usage_events for select using (auth.uid() = user_id);
create policy "users read own orders" on public.payment_orders for select using (auth.uid() = user_id);
-- no client write policies: all writes go through the service role

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "plans readable by all" ON public.plans;
--   DROP POLICY IF EXISTS "addon packs readable by all" ON public.addon_packs;
--   DROP POLICY IF EXISTS "users read own addon credits" ON public.user_addon_credits;
--   DROP POLICY IF EXISTS "users read own plan usage" ON public.plan_usage_events;
--   DROP POLICY IF EXISTS "users read own orders" ON public.payment_orders;
--   DROP INDEX IF EXISTS public.addon_credits_user_expiry;
--   DROP INDEX IF EXISTS public.plan_usage_user_time;
--   ALTER TABLE public.plans DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.addon_packs DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.user_addon_credits DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.plan_usage_events DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.payment_orders DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.plans CASCADE;
--   DROP TABLE IF EXISTS public.addon_packs CASCADE;
--   DROP TABLE IF EXISTS public.user_addon_credits CASCADE;
--   DROP TABLE IF EXISTS public.plan_usage_events CASCADE;
--   DROP TABLE IF EXISTS public.payment_orders CASCADE;
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261103b_consume_set_fn.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261103b_consume_set_fn.sql
-- Function to atomically consume one add-on set and insert plan_usage_event

create or replace function public.consume_addon_set(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_credit_id uuid;
  v_existing record;
begin
  -- 1. Check idempotency: repeat key returns earlier result and never burns twice
  select id, kind, source into v_existing
  from public.plan_usage_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'already_consumed', true
    );
  end if;

  -- 2. Lock and select earliest-expiring non-expired credit with remaining sets
  select id into v_credit_id
  from public.user_addon_credits
  where user_id = p_user_id
    and sets_remaining > 0
    and expires_at > now()
  order by expires_at asc
  limit 1
  for update;

  if v_credit_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'QUOTA_EXHAUSTED',
      'error', 'No active add-on sets available'
    );
  end if;

  -- 3. Decrement sets_remaining atomically (never below 0 via check constraint)
  update public.user_addon_credits
  set sets_remaining = sets_remaining - 1
  where id = v_credit_id;

  -- 4. Insert usage event
  insert into public.plan_usage_events (user_id, kind, source, idempotency_key, created_at)
  values (p_user_id, p_kind, 'addon', p_idempotency_key, now());

  return jsonb_build_object(
    'success', true,
    'source', 'addon',
    'credit_id', v_credit_id
  );
end;
$$;

revoke all on function public.consume_addon_set(uuid, text, text) from public;
grant execute on function public.consume_addon_set(uuid, text, text) to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.consume_addon_set(p_user_id uuid, p_kind text, p_idempotency_key text);
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261103c_fulfil_payment_fn.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261103c_fulfil_payment_fn.sql
-- Atomic payment order fulfillment and unique constraint on add-on credit order link

-- 1. Add nullable order_id column on user_addon_credits referencing payment_orders
alter table public.user_addon_credits
  add column if not exists order_id uuid references public.payment_orders(id) on delete set null;

-- 2. Unique index ensuring one payment order can never create multiple add-on credit rows
create unique index if not exists idx_user_addon_credits_order_id
  on public.user_addon_credits(order_id)
  where order_id is not null;

-- 3. Function to atomically transition payment_order to 'paid' and grant subscription/add-on credits
create or replace function public.fulfil_payment_order(
  p_provider_order_id text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_order record;
  v_existing record;
  v_duration int := 30;
  v_sets int := 10;
  v_validity int := 60;
  v_sub record;
  v_credit record;
begin
  -- 1. Conditional atomic update: only flip if currently 'created'
  update public.payment_orders
  set status = 'paid',
      paid_at = now()
  where provider_order_id = p_provider_order_id
    and user_id = p_user_id
    and status = 'created'
  returning * into v_order;

  -- 2. If no row updated, check if order was already paid or missing
  if v_order is null then
    select id, plan_code, addon_code, status into v_existing
    from public.payment_orders
    where provider_order_id = p_provider_order_id
      and user_id = p_user_id;

    if v_existing is null then
      return jsonb_build_object(
        'success', false,
        'code', 'ORDER_NOT_FOUND',
        'error', 'Payment order not found for user'
      );
    end if;

    if v_existing.status = 'paid' then
      return jsonb_build_object(
        'success', true,
        'already_paid', true,
        'order_id', v_existing.id,
        'message', 'Order already fulfilled and marked as paid'
      );
    end if;

    return jsonb_build_object(
      'success', false,
      'code', 'ORDER_INVALID_STATE',
      'error', 'Payment order is not in created state'
    );
  end if;

  -- 3. Fulfillment path A: Subscription plan purchase
  if v_order.plan_code is not null then
    select duration_days into v_duration
    from public.plans
    where code = v_order.plan_code;

    if v_duration is null or v_duration <= 0 then
      if v_order.plan_code = 'weekly' then
        v_duration := 7;
      elsif v_order.plan_code = 'quarterly' then
        v_duration := 90;
      else
        v_duration := 30;
      end if;
    end if;

    insert into public.subscriptions (
      user_id,
      plan_id,
      provider,
      currency,
      amount,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      metadata,
      updated_at
    ) values (
      p_user_id,
      v_order.plan_code,
      'razorpay',
      v_order.currency,
      v_order.amount_paise,
      'active',
      now(),
      now() + (v_duration * interval '1 day'),
      false,
      jsonb_build_object(
        'provider_order_id', p_provider_order_id,
        'payment_order_id', v_order.id,
        'verified_at', now()
      ),
      now()
    )
    on conflict (user_id) do update set
      plan_id = excluded.plan_id,
      status = 'active',
      current_period_start = now(),
      current_period_end = now() + (v_duration * interval '1 day'),
      cancel_at_period_end = false,
      metadata = excluded.metadata,
      updated_at = now()
    returning * into v_sub;

    return jsonb_build_object(
      'success', true,
      'type', 'plan',
      'plan_code', v_order.plan_code,
      'order_id', v_order.id,
      'period_end', v_sub.current_period_end
    );
  end if;

  -- 4. Fulfillment path B: Add-on pack purchase
  if v_order.addon_code is not null then
    select sets, validity_days into v_sets, v_validity
    from public.addon_packs
    where code = v_order.addon_code;

    if v_sets is null or v_sets <= 0 then
      if v_order.addon_code = 'addon_30' then
        v_sets := 30;
      elsif v_order.addon_code = 'addon_60' then
        v_sets := 60;
      else
        v_sets := 10;
      end if;
    end if;

    if v_validity is null or v_validity <= 0 then
      v_validity := 60;
    end if;

    insert into public.user_addon_credits (
      user_id,
      pack_code,
      sets_total,
      sets_remaining,
      expires_at,
      order_id,
      created_at
    ) values (
      p_user_id,
      v_order.addon_code,
      v_sets,
      v_sets,
      now() + (v_validity * interval '1 day'),
      v_order.id,
      now()
    )
    returning * into v_credit;

    return jsonb_build_object(
      'success', true,
      'type', 'addon',
      'addon_code', v_order.addon_code,
      'order_id', v_order.id,
      'sets_granted', v_sets,
      'credit_id', v_credit.id,
      'expires_at', v_credit.expires_at
    );
  end if;

  return jsonb_build_object(
    'success', false,
    'code', 'ORDER_ITEM_MISSING',
    'error', 'Order contains neither plan_code nor addon_code'
  );
end;
$$;

revoke all on function public.fulfil_payment_order(text, uuid) from public;
grant execute on function public.fulfil_payment_order(text, uuid) to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_user_addon_credits_order_id;
--   ALTER TABLE public.user_addon_credits DROP COLUMN IF EXISTS order_id;
--   DROP FUNCTION IF EXISTS public.fulfil_payment_order(p_provider_order_id text, p_user_id uuid);
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261103d_consume_atomic_fn.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261103d_consume_atomic_fn.sql
-- Atomic quota consumption and refund with advisory locking, IST daily cap, and credit row tracking

-- 1. Add nullable credit_id column to plan_usage_events referencing user_addon_credits
alter table public.plan_usage_events
  add column if not exists credit_id uuid references public.user_addon_credits(id) on delete set null;

-- Index for efficient credit refund and usage correlation
create index if not exists idx_plan_usage_credit_id
  on public.plan_usage_events(credit_id)
  where credit_id is not null;

-- 2. Atomic Plan Set Consumption
create or replace function public.consume_plan_set(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text,
  p_period_start timestamptz,
  p_quota int,
  p_daily_cap int default 30,
  p_day_start timestamptz default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing record;
  v_daily_count int := 0;
  v_plan_count int := 0;
begin
  -- Serializes operations per user across concurrent requests
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 1. Check idempotency: repeat key returns earlier result without burning twice
  select id, source, credit_id into v_existing
  from public.plan_usage_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true
    );
  end if;

  -- 2. Daily Cap check (IST day)
  if p_day_start is not null then
    select count(*) into v_daily_count
    from public.plan_usage_events
    where user_id = p_user_id and created_at >= p_day_start;

    if v_daily_count >= p_daily_cap then
      return jsonb_build_object(
        'success', false,
        'code', 'DAILY_LIMIT_REACHED',
        'error', 'Daily fair-use limit reached. Resets daily at midnight IST.'
      );
    end if;
  end if;

  -- 3. Plan Quota check for current stepped period
  select count(*) into v_plan_count
  from public.plan_usage_events
  where user_id = p_user_id
    and source = 'plan'
    and kind = p_kind
    and created_at >= p_period_start;

  if v_plan_count >= p_quota then
    return jsonb_build_object(
      'success', false,
      'code', 'PLAN_QUOTA_EXHAUSTED',
      'error', 'Plan quota exhausted for current period'
    );
  end if;

  -- 4. Record event
  begin
    insert into public.plan_usage_events (user_id, kind, source, idempotency_key, created_at)
    values (p_user_id, p_kind, 'plan', p_idempotency_key, now());
  exception when unique_violation then
    select id, source, credit_id into v_existing
    from public.plan_usage_events
    where user_id = p_user_id and idempotency_key = p_idempotency_key;

    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true
    );
  end;

  return jsonb_build_object(
    'success', true,
    'source', 'plan'
  );
end;
$$;

revoke all on function public.consume_plan_set(uuid, text, text, timestamptz, int, int, timestamptz) from public;
grant execute on function public.consume_plan_set(uuid, text, text, timestamptz, int, int, timestamptz) to service_role;

-- 3. Atomic Addon Set Consumption
create or replace function public.consume_addon_set(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text,
  p_daily_cap int default 30,
  p_day_start timestamptz default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_credit_id uuid;
  v_existing record;
  v_daily_count int := 0;
begin
  -- Serializes operations per user across concurrent requests
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 1. Check idempotency: repeat key returns earlier result and never burns twice
  select id, kind, source, credit_id into v_existing
  from public.plan_usage_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true
    );
  end if;

  -- 2. Daily Cap check (IST day)
  if p_day_start is not null then
    select count(*) into v_daily_count
    from public.plan_usage_events
    where user_id = p_user_id and created_at >= p_day_start;

    if v_daily_count >= p_daily_cap then
      return jsonb_build_object(
        'success', false,
        'code', 'DAILY_LIMIT_REACHED',
        'error', 'Daily fair-use limit reached. Resets daily at midnight IST.'
      );
    end if;
  end if;

  -- 3. Lock and select earliest-expiring non-expired credit with remaining sets
  select id into v_credit_id
  from public.user_addon_credits
  where user_id = p_user_id
    and sets_remaining > 0
    and expires_at > now()
  order by expires_at asc
  limit 1
  for update;

  if v_credit_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'QUOTA_EXHAUSTED',
      'error', 'Plan quota finished and no active add-on credits available.'
    );
  end if;

  -- 4. Decrement sets_remaining atomically (never below 0 via check constraint)
  update public.user_addon_credits
  set sets_remaining = sets_remaining - 1
  where id = v_credit_id;

  -- 5. Insert usage event storing the exact decremented credit_id
  begin
    insert into public.plan_usage_events (user_id, kind, source, credit_id, idempotency_key, created_at)
    values (p_user_id, p_kind, 'addon', v_credit_id, p_idempotency_key, now());
  exception when unique_violation then
    -- Revert decrement if concurrent idempotency race occurred
    update public.user_addon_credits
    set sets_remaining = sets_remaining + 1
    where id = v_credit_id;

    select id, source, credit_id into v_existing
    from public.plan_usage_events
    where user_id = p_user_id and idempotency_key = p_idempotency_key;

    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true
    );
  end;

  return jsonb_build_object(
    'success', true,
    'source', 'addon',
    'credit_id', v_credit_id
  );
end;
$$;

revoke all on function public.consume_addon_set(uuid, text, text, int, timestamptz) from public;
grant execute on function public.consume_addon_set(uuid, text, text, int, timestamptz) to service_role;

-- 4. Unified Atomic Consume (Cap + Plan + Add-on decisions in ONE transaction)
create or replace function public.consume_user_set(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text,
  p_period_start timestamptz,
  p_quota int,
  p_daily_cap int,
  p_day_start timestamptz
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_plan_res jsonb;
begin
  -- First attempt plan quota under advisory lock
  v_plan_res := public.consume_plan_set(
    p_user_id,
    p_kind,
    p_idempotency_key,
    p_period_start,
    p_quota,
    p_daily_cap,
    p_day_start
  );

  if (v_plan_res->>'success')::boolean = true then
    return v_plan_res;
  end if;

  -- If daily cap reached, fail immediately
  if v_plan_res->>'code' = 'DAILY_LIMIT_REACHED' then
    return v_plan_res;
  end if;

  -- If plan quota exhausted, fall back to add-on sets
  return public.consume_addon_set(
    p_user_id,
    p_kind,
    p_idempotency_key,
    p_daily_cap,
    p_day_start
  );
end;
$$;

revoke all on function public.consume_user_set(uuid, text, text, timestamptz, int, int, timestamptz) from public;
grant execute on function public.consume_user_set(uuid, text, text, timestamptz, int, int, timestamptz) to service_role;

-- 5. Atomic Quota Refund (Restores exact credit row and deletes usage event)
create or replace function public.refund_plan_or_addon_set(
  p_user_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_event record;
begin
  -- Serializes operations per user
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select id, source, credit_id into v_event
  from public.plan_usage_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if not found then
    return jsonb_build_object(
      'success', true,
      'refunded', false,
      'message', 'Usage event not found'
    );
  end if;

  -- If source was addon and credit_id is recorded, restore that exact row
  if v_event.source = 'addon' and v_event.credit_id is not null then
    update public.user_addon_credits
    set sets_remaining = least(sets_total, sets_remaining + 1)
    where id = v_event.credit_id
      and user_id = p_user_id;
  end if;

  -- Delete event from plan_usage_events
  delete from public.plan_usage_events
  where id = v_event.id;

  return jsonb_build_object(
    'success', true,
    'refunded', true,
    'source', v_event.source,
    'credit_id', v_event.credit_id
  );
end;
$$;

revoke all on function public.refund_plan_or_addon_set(uuid, text) from public;
grant execute on function public.refund_plan_or_addon_set(uuid, text) to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_plan_usage_credit_id;
--   ALTER TABLE public.plan_usage_events DROP COLUMN IF EXISTS credit_id;
--   DROP FUNCTION IF EXISTS public.consume_plan_set(p_user_id uuid, p_kind text, p_idempotency_key text, p_period_start timestamptz, p_quota int, p_daily_cap int, p_day_start timestamptz);
--   DROP FUNCTION IF EXISTS public.consume_user_set(p_user_id uuid, p_kind text, p_idempotency_key text, p_period_start timestamptz, p_quota int, p_daily_cap int, p_day_start timestamptz);
--   DROP FUNCTION IF EXISTS public.refund_plan_or_addon_set(p_user_id uuid, p_idempotency_key text);
--   NOTE: replaces function public.consume_addon_set (first defined in 20261103b_consume_set_fn.sql); restore the prior definition from that file if this change must be undone.
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261103e_weekly_price_692.sql
-- ------------------------------------------------------------------------------
update public.plans set price_paise = 69200 where code = 'weekly';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261103f_subscriptions_unique_user.sql
-- ------------------------------------------------------------------------------
-- Migration: Ensure unique index on subscriptions(user_id) for safe upsert on conflict
create unique index if not exists idx_subscriptions_user_id_unique on public.subscriptions (user_id);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_subscriptions_user_id_unique;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261103g_fulfil_payment_upgrade_extend.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261103g_fulfil_payment_upgrade_extend.sql
-- Money-path fulfillment hardening:
-- 1. Never mark order paid before entitlement grant succeeds (fail-closed and atomic).
-- 2. On renewal or upgrade with an active plan, new period end = max(current_period_end, now) + new plan duration.
-- 3. Never shorten an existing subscription period.
-- 4. Retries re-attempt the entitlement grant if previously incomplete.

create or replace function public.fulfil_payment_order(
  p_provider_order_id text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_order record;
  v_existing_sub record;
  v_existing_credit record;
  v_duration int := 30;
  v_sets int := 10;
  v_validity int := 60;
  v_sub record;
  v_credit record;
  v_base_time timestamptz;
  v_new_end timestamptz;
  v_period_start timestamptz;
begin
  -- 1. Lock the order row for update
  select * into v_order
  from public.payment_orders
  where provider_order_id = p_provider_order_id
    and user_id = p_user_id
  for update;

  if v_order is null then
    return jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_FOUND',
      'error', 'Payment order not found for user'
    );
  end if;

  -- 2. Verify state is valid (created or paid-retry)
  if v_order.status not in ('created', 'paid') then
    return jsonb_build_object(
      'success', false,
      'code', 'ORDER_INVALID_STATE',
      'error', 'Payment order is not in created or paid state'
    );
  end if;

  -- 3. Check if already fully fulfilled (idempotency check)
  if v_order.status = 'paid' then
    if v_order.plan_code is not null then
      select * into v_existing_sub
      from public.subscriptions
      where user_id = p_user_id;

      if v_existing_sub is not null and (
        (v_existing_sub.metadata->>'payment_order_id' = v_order.id::text) or
        (v_existing_sub.metadata->>'provider_order_id' = p_provider_order_id)
      ) then
        return jsonb_build_object(
          'success', true,
          'already_paid', true,
          'type', 'plan',
          'plan_code', v_order.plan_code,
          'order_id', v_order.id,
          'period_end', v_existing_sub.current_period_end,
          'message', 'Order already fulfilled and marked as paid'
        );
      end if;
      -- If subscription grant missing, proceed below to re-attempt grant!
    elsif v_order.addon_code is not null then
      select * into v_existing_credit
      from public.user_addon_credits
      where order_id = v_order.id;

      if v_existing_credit is not null then
        return jsonb_build_object(
          'success', true,
          'already_paid', true,
          'type', 'addon',
          'addon_code', v_order.addon_code,
          'order_id', v_order.id,
          'credit_id', v_existing_credit.id,
          'message', 'Order already fulfilled and marked as paid'
        );
      end if;
      -- If add-on grant missing, proceed below to re-attempt grant!
    end if;
  end if;

  -- 4. Fulfillment Path A: Subscription Plan purchase / renewal / upgrade
  if v_order.plan_code is not null then
    select duration_days into v_duration
    from public.plans
    where code = v_order.plan_code;

    if v_duration is null or v_duration <= 0 then
      if v_order.plan_code = 'weekly' then
        v_duration := 7;
      elsif v_order.plan_code = 'quarterly' then
        v_duration := 90;
      else
        v_duration := 30;
      end if;
    end if;

    -- Look up existing subscription to calculate extension
    select * into v_existing_sub
    from public.subscriptions
    where user_id = p_user_id;

    if v_existing_sub is not null and (v_existing_sub.status in ('active', 'trialing')) and v_existing_sub.current_period_end is not null then
      -- User has an active plan: new period end = max(current_period_end, now) + duration
      v_base_time := greatest(v_existing_sub.current_period_end, now());
      v_new_end := v_base_time + (v_duration * interval '1 day');
      -- Never shorten existing period
      if v_new_end < v_existing_sub.current_period_end then
        v_new_end := v_existing_sub.current_period_end;
      end if;
      v_period_start := coalesce(v_existing_sub.current_period_start, now());
    else
      -- Expired or no previous subscription: period end = now + duration
      v_period_start := now();
      v_new_end := now() + (v_duration * interval '1 day');
    end if;

    -- Grant subscription entitlement FIRST
    insert into public.subscriptions (
      user_id,
      plan_id,
      provider,
      currency,
      amount,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      metadata,
      updated_at
    ) values (
      p_user_id,
      v_order.plan_code,
      'razorpay',
      v_order.currency,
      v_order.amount_paise,
      'active',
      v_period_start,
      v_new_end,
      false,
      jsonb_build_object(
        'provider_order_id', p_provider_order_id,
        'payment_order_id', v_order.id,
        'verified_at', now()
      ),
      now()
    )
    on conflict (user_id) do update set
      plan_id = excluded.plan_id,
      status = 'active',
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = false,
      metadata = excluded.metadata,
      updated_at = now()
    returning * into v_sub;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    update public.payment_orders
    set status = 'paid',
        paid_at = coalesce(paid_at, now())
    where id = v_order.id
    returning * into v_order;

    return jsonb_build_object(
      'success', true,
      'type', 'plan',
      'plan_code', v_order.plan_code,
      'order_id', v_order.id,
      'period_end', v_sub.current_period_end
    );
  end if;

  -- 5. Fulfillment Path B: Add-on pack purchase
  if v_order.addon_code is not null then
    select sets, validity_days into v_sets, v_validity
    from public.addon_packs
    where code = v_order.addon_code;

    if v_sets is null or v_sets <= 0 then
      if v_order.addon_code = 'addon_30' then
        v_sets := 30;
      elsif v_order.addon_code = 'addon_60' then
        v_sets := 60;
      else
        v_sets := 10;
      end if;
    end if;

    if v_validity is null or v_validity <= 0 then
      v_validity := 60;
    end if;

    -- Grant add-on credit entitlement FIRST
    insert into public.user_addon_credits (
      user_id,
      pack_code,
      sets_total,
      sets_remaining,
      expires_at,
      order_id,
      created_at
    ) values (
      p_user_id,
      v_order.addon_code,
      v_sets,
      v_sets,
      now() + (v_validity * interval '1 day'),
      v_order.id,
      now()
    )
    on conflict (order_id) where order_id is not null do nothing
    returning * into v_credit;

    if v_credit is null then
      select * into v_credit
      from public.user_addon_credits
      where order_id = v_order.id;
    end if;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    update public.payment_orders
    set status = 'paid',
        paid_at = coalesce(paid_at, now())
    where id = v_order.id
    returning * into v_order;

    return jsonb_build_object(
      'success', true,
      'type', 'addon',
      'addon_code', v_order.addon_code,
      'order_id', v_order.id,
      'sets_granted', v_sets,
      'credit_id', v_credit.id,
      'expires_at', v_credit.expires_at
    );
  end if;

  return jsonb_build_object(
    'success', false,
    'code', 'ORDER_ITEM_MISSING',
    'error', 'Order contains neither plan_code nor addon_code'
  );
end;
$$;

revoke all on function public.fulfil_payment_order(text, uuid) from public;
grant execute on function public.fulfil_payment_order(text, uuid) to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   NOTE: replaces function public.fulfil_payment_order (first defined in 20261103c_fulfil_payment_fn.sql); restore the prior definition from that file if this change must be undone.
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261103h_ai_idempotency_scoped.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261103h_ai_idempotency_scoped.sql
-- Scopes plan_usage_events idempotency lookup by user + operation kind,
-- checks daily-cap before returning already_consumed,
-- adds response_payload column for cached replay,
-- and updates atomic consume/refund RPCs.

-- 1. Add nullable response_payload column to store generated result
alter table public.plan_usage_events
  add column if not exists response_payload jsonb;

-- 2. Drop legacy (user_id, idempotency_key) unique constraint if exists
alter table public.plan_usage_events
  drop constraint if exists plan_usage_events_user_id_idempotency_key_key;

-- 3. Add constraint scoped by (user_id, kind, idempotency_key)
alter table public.plan_usage_events
  drop constraint if exists plan_usage_events_user_kind_idempotency_unique;

alter table public.plan_usage_events
  add constraint plan_usage_events_user_kind_idempotency_unique
  unique (user_id, kind, idempotency_key);

-- Index for scoped lookup
create index if not exists idx_plan_usage_user_kind_idempotency
  on public.plan_usage_events(user_id, kind, idempotency_key);

-- 4. Atomic Plan Set Consumption (Daily cap FIRST, scoped by user_id and kind)
create or replace function public.consume_plan_set(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text,
  p_period_start timestamptz,
  p_quota int,
  p_daily_cap int default 30,
  p_day_start timestamptz default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing record;
  v_daily_count int := 0;
  v_plan_count int := 0;
begin
  -- Serializes operations per user across concurrent requests
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 1. Daily Cap check (IST day) FIRST: prevents bypassing cap via old idempotency key
  if p_day_start is not null then
    select count(*) into v_daily_count
    from public.plan_usage_events
    where user_id = p_user_id and created_at >= p_day_start;

    if v_daily_count >= p_daily_cap then
      return jsonb_build_object(
        'success', false,
        'code', 'DAILY_LIMIT_REACHED',
        'error', 'Daily fair-use limit reached. Resets daily at midnight IST.'
      );
    end if;
  end if;

  -- 2. Scoped Idempotency Check: scoped strictly by user_id AND kind
  select id, source, credit_id, response_payload into v_existing
  from public.plan_usage_events
  where user_id = p_user_id
    and kind = p_kind
    and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true,
      'result', v_existing.response_payload
    );
  end if;

  -- 3. Plan Quota check for current stepped period
  select count(*) into v_plan_count
  from public.plan_usage_events
  where user_id = p_user_id
    and source = 'plan'
    and kind = p_kind
    and created_at >= p_period_start;

  if v_plan_count >= p_quota then
    return jsonb_build_object(
      'success', false,
      'code', 'PLAN_QUOTA_EXHAUSTED',
      'error', 'Plan quota exhausted for current period'
    );
  end if;

  -- 4. Record event
  begin
    insert into public.plan_usage_events (user_id, kind, source, idempotency_key, created_at)
    values (p_user_id, p_kind, 'plan', p_idempotency_key, now());
  exception when unique_violation then
    select id, source, credit_id, response_payload into v_existing
    from public.plan_usage_events
    where user_id = p_user_id
      and kind = p_kind
      and idempotency_key = p_idempotency_key;

    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true,
      'result', v_existing.response_payload
    );
  end;

  return jsonb_build_object(
    'success', true,
    'source', 'plan'
  );
end;
$$;

revoke all on function public.consume_plan_set(uuid, text, text, timestamptz, int, int, timestamptz) from public;
grant execute on function public.consume_plan_set(uuid, text, text, timestamptz, int, int, timestamptz) to service_role;

-- 5. Atomic Addon Set Consumption (Daily cap FIRST, scoped by user_id and kind)
create or replace function public.consume_addon_set(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text,
  p_daily_cap int default 30,
  p_day_start timestamptz default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_credit_id uuid;
  v_existing record;
  v_daily_count int := 0;
begin
  -- Serializes operations per user across concurrent requests
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 1. Daily Cap check (IST day) FIRST
  if p_day_start is not null then
    select count(*) into v_daily_count
    from public.plan_usage_events
    where user_id = p_user_id and created_at >= p_day_start;

    if v_daily_count >= p_daily_cap then
      return jsonb_build_object(
        'success', false,
        'code', 'DAILY_LIMIT_REACHED',
        'error', 'Daily fair-use limit reached. Resets daily at midnight IST.'
      );
    end if;
  end if;

  -- 2. Scoped Idempotency Check: scoped strictly by user_id AND kind
  select id, kind, source, credit_id, response_payload into v_existing
  from public.plan_usage_events
  where user_id = p_user_id
    and kind = p_kind
    and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true,
      'result', v_existing.response_payload
    );
  end if;

  -- 3. Lock and select earliest-expiring non-expired credit with remaining sets
  select id into v_credit_id
  from public.user_addon_credits
  where user_id = p_user_id
    and sets_remaining > 0
    and expires_at > now()
  order by expires_at asc
  limit 1
  for update;

  if v_credit_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'QUOTA_EXHAUSTED',
      'error', 'Plan quota finished and no active add-on credits available.'
    );
  end if;

  -- 4. Decrement sets_remaining atomically (never below 0 via check constraint)
  update public.user_addon_credits
  set sets_remaining = sets_remaining - 1
  where id = v_credit_id;

  -- 5. Insert usage event storing the exact decremented credit_id
  begin
    insert into public.plan_usage_events (user_id, kind, source, credit_id, idempotency_key, created_at)
    values (p_user_id, p_kind, 'addon', v_credit_id, p_idempotency_key, now());
  exception when unique_violation then
    update public.user_addon_credits
    set sets_remaining = sets_remaining + 1
    where id = v_credit_id;

    select id, source, credit_id, response_payload into v_existing
    from public.plan_usage_events
    where user_id = p_user_id
      and kind = p_kind
      and idempotency_key = p_idempotency_key;

    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true,
      'result', v_existing.response_payload
    );
  end;

  return jsonb_build_object(
    'success', true,
    'source', 'addon',
    'credit_id', v_credit_id
  );
end;
$$;

revoke all on function public.consume_addon_set(uuid, text, text, int, timestamptz) from public;
grant execute on function public.consume_addon_set(uuid, text, text, int, timestamptz) to service_role;

-- 6. Unified Atomic Consume (Cap + Plan + Add-on decisions in ONE transaction)
create or replace function public.consume_user_set(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text,
  p_period_start timestamptz,
  p_quota int,
  p_daily_cap int,
  p_day_start timestamptz
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_plan_res jsonb;
begin
  -- 1. Daily cap and plan quota attempt under advisory lock
  v_plan_res := public.consume_plan_set(
    p_user_id,
    p_kind,
    p_idempotency_key,
    p_period_start,
    p_quota,
    p_daily_cap,
    p_day_start
  );

  if (v_plan_res->>'success')::boolean = true then
    return v_plan_res;
  end if;

  -- If daily cap reached, fail immediately
  if v_plan_res->>'code' = 'DAILY_LIMIT_REACHED' then
    return v_plan_res;
  end if;

  -- If plan quota exhausted, fall back to add-on sets
  return public.consume_addon_set(
    p_user_id,
    p_kind,
    p_idempotency_key,
    p_daily_cap,
    p_day_start
  );
end;
$$;

revoke all on function public.consume_user_set(uuid, text, text, timestamptz, int, int, timestamptz) from public;
grant execute on function public.consume_user_set(uuid, text, text, timestamptz, int, int, timestamptz) to service_role;

-- 7. Atomic Quota Refund (Scoped by user_id and optional kind)
create or replace function public.refund_plan_or_addon_set(
  p_user_id uuid,
  p_idempotency_key text,
  p_kind text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_event record;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select id, source, credit_id into v_event
  from public.plan_usage_events
  where user_id = p_user_id
    and idempotency_key = p_idempotency_key
    and (p_kind is null or kind = p_kind);

  if not found then
    return jsonb_build_object(
      'success', true,
      'refunded', false,
      'message', 'Usage event not found'
    );
  end if;

  if v_event.source = 'addon' and v_event.credit_id is not null then
    update public.user_addon_credits
    set sets_remaining = least(sets_total, sets_remaining + 1)
    where id = v_event.credit_id
      and user_id = p_user_id;
  end if;

  delete from public.plan_usage_events
  where id = v_event.id;

  return jsonb_build_object(
    'success', true,
    'refunded', true,
    'source', v_event.source,
    'credit_id', v_event.credit_id
  );
end;
$$;

revoke all on function public.refund_plan_or_addon_set(uuid, text, text) from public;
grant execute on function public.refund_plan_or_addon_set(uuid, text, text) to service_role;

-- 8. Persist generated response payload on successful completion
create or replace function public.record_plan_usage_result(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text,
  p_result jsonb
)
returns boolean
language plpgsql
security definer
as $$
begin
  update public.plan_usage_events
  set response_payload = p_result
  where user_id = p_user_id
    and kind = p_kind
    and idempotency_key = p_idempotency_key;

  return found;
end;
$$;

revoke all on function public.record_plan_usage_result(uuid, text, text, jsonb) from public;
grant execute on function public.record_plan_usage_result(uuid, text, text, jsonb) to service_role;

-- 9. Drop legacy 2-argument signature to avoid overloading ambiguity
drop function if exists public.refund_plan_or_addon_set(uuid, text);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_plan_usage_user_kind_idempotency;
--   ALTER TABLE public.plan_usage_events DROP COLUMN IF EXISTS response_payload;
--   ALTER TABLE public.plan_usage_events DROP CONSTRAINT IF EXISTS plan_usage_events_user_kind_idempotency_unique;
--   DROP FUNCTION IF EXISTS public.record_plan_usage_result(p_user_id uuid, p_kind text, p_idempotency_key text, p_result jsonb);
--   NOTE: replaces function public.consume_plan_set (first defined in 20261103d_consume_atomic_fn.sql); restore the prior definition from that file if this change must be undone.
--   NOTE: replaces function public.consume_addon_set (first defined in 20261103b_consume_set_fn.sql); restore the prior definition from that file if this change must be undone.
--   NOTE: replaces function public.consume_user_set (first defined in 20261103d_consume_atomic_fn.sql); restore the prior definition from that file if this change must be undone.
--   NOTE: replaces function public.refund_plan_or_addon_set (first defined in 20261103d_consume_atomic_fn.sql); restore the prior definition from that file if this change must be undone.
--   NOTE: constraint plan_usage_events_user_kind_idempotency_unique was dropped and re-added by this file with a new definition; restore its prior definition from the earlier migration that created it.
--   NOTE: this migration itself drops constraint plan_usage_events_user_id_idempotency_key_key - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261104_early_access_approval_fields.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: Admin Early Access Approvals Schema Support
-- Adds:
-- 1. status, approved_at, approved_by to public.early_access_emails
-- 2. approved_at, approved_by to public.early_access_approved
-- 3. Grants UPDATE on early_access_emails to service_role
-- 4. Idempotently syncs existing approved status
-- ==============================================================================

-- 1. Add status, approved_at, approved_by to early_access_emails
ALTER TABLE public.early_access_emails
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT;

CREATE INDEX IF NOT EXISTS idx_early_access_emails_status_created_at
  ON public.early_access_emails (status, created_at DESC);

-- Allow service_role to update early_access_emails for approvals/rejections
GRANT UPDATE ON public.early_access_emails TO service_role;

-- 2. Add approved_at, approved_by to early_access_approved
ALTER TABLE public.early_access_approved
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT;

-- 3. Sync existing approved records from early_access_approved into early_access_emails
UPDATE public.early_access_emails e
SET status = 'approved',
    approved_at = a.approved_at,
    approved_by = a.approved_by
FROM public.early_access_approved a
WHERE lower(trim(e.email)) = lower(trim(a.email)) AND a.approved = TRUE;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_early_access_emails_status_created_at;
--   ALTER TABLE public.early_access_emails DROP COLUMN IF EXISTS status;
--   ALTER TABLE public.early_access_approved DROP COLUMN IF EXISTS approved_at;
--   REVOKE UPDATE ON public.early_access_emails FROM service_role;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261104a_global_ai_budget.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261104a_global_ai_budget.sql
-- Hard global daily AI token budget and concurrency cap (cost-abuse gate).
-- Apply order: after every 20261103a-h migration.
--
-- Verification queries (run via service_role):
--   select proname from pg_proc where proname like 'ai_%';
--   select * from public.ai_global_budget_reserve(current_date, 1000, 2000000);
--   select public.ai_global_budget_settle(current_date, 1000, 850);
--   select public.ai_concurrency_acquire('test-lease-init', 25, 60);
--   select public.ai_concurrency_release('test-lease-init');

-- 1. Daily Token Budget Table
create table if not exists public.ai_global_budget_daily (
  period_date date primary key,
  reserved_tokens bigint not null default 0,
  used_tokens bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.ai_global_budget_daily enable row level security;
revoke all on table public.ai_global_budget_daily from public, anon, authenticated;
grant all on table public.ai_global_budget_daily to service_role;

-- 2. Concurrency Leases Table
create table if not exists public.ai_concurrency_leases (
  lease_id text primary key,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_ai_concurrency_leases_expires
  on public.ai_concurrency_leases (expires_at);

alter table public.ai_concurrency_leases enable row level security;
revoke all on table public.ai_concurrency_leases from public, anon, authenticated;
grant all on table public.ai_concurrency_leases to service_role;

-- 3. Atomic Token Budget Reservation RPC
-- Atomically checks if (used_tokens + reserved_tokens + p_tokens) <= p_cap.
-- If allowed, increments reserved_tokens and returns allowed = true with remaining budget.
-- If cap reached, leaves row unchanged and returns allowed = false with remaining budget.
create or replace function public.ai_global_budget_reserve(
  p_period date,
  p_tokens bigint,
  p_cap bigint
)
returns table(allowed boolean, remaining bigint)
language plpgsql
security definer
as $$
declare
  v_used bigint := 0;
  v_reserved bigint := 0;
  v_new_reserved bigint;
  v_allowed boolean := false;
  v_remaining bigint := 0;
begin
  -- Ensure period row exists
  insert into public.ai_global_budget_daily (period_date, reserved_tokens, used_tokens, updated_at)
  values (p_period, 0, 0, now())
  on conflict (period_date) do nothing;

  -- Lock row exclusively for atomic evaluation
  select used_tokens, reserved_tokens
  into v_used, v_reserved
  from public.ai_global_budget_daily
  where period_date = p_period
  for update;

  if (v_used + v_reserved + p_tokens) <= p_cap then
    v_allowed := true;
    v_new_reserved := v_reserved + p_tokens;
    update public.ai_global_budget_daily
    set reserved_tokens = v_new_reserved,
        updated_at = now()
    where period_date = p_period;
    v_remaining := p_cap - (v_used + v_new_reserved);
  else
    v_allowed := false;
    v_remaining := greatest(0::bigint, p_cap - (v_used + v_reserved));
  end if;

  return query select v_allowed, v_remaining;
end;
$$;

revoke all on function public.ai_global_budget_reserve(date, bigint, bigint) from public, anon, authenticated;
grant execute on function public.ai_global_budget_reserve(date, bigint, bigint) to service_role;

-- 4. Atomic Token Budget Settlement RPC
-- Releases unused reservation tokens (p_reserved) and records actual usage (p_actual).
create or replace function public.ai_global_budget_settle(
  p_period date,
  p_reserved bigint,
  p_actual bigint
)
returns void
language plpgsql
security definer
as $$
begin
  update public.ai_global_budget_daily
  set reserved_tokens = greatest(0::bigint, reserved_tokens - p_reserved),
      used_tokens = used_tokens + greatest(0::bigint, p_actual),
      updated_at = now()
  where period_date = p_period;
end;
$$;

revoke all on function public.ai_global_budget_settle(date, bigint, bigint) from public, anon, authenticated;
grant execute on function public.ai_global_budget_settle(date, bigint, bigint) to service_role;

-- 5. Concurrency Acquire RPC
-- Purges expired leases, counts active leases under exclusive table lock,
-- and inserts a new lease if under capacity.
create or replace function public.ai_concurrency_acquire(
  p_lease_id text,
  p_cap int,
  p_ttl_seconds int default 60
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_count int;
  v_ttl int := coalesce(nullif(p_ttl_seconds, 0), 60);
begin
  -- Exclusively serialize active concurrency count + insert
  lock table public.ai_concurrency_leases in exclusive mode;

  -- 1. Purge expired leases
  delete from public.ai_concurrency_leases
  where expires_at <= now();

  -- 2. Count active leases
  select count(*) into v_count
  from public.ai_concurrency_leases;

  -- 3. Check cap and acquire
  if v_count < p_cap then
    insert into public.ai_concurrency_leases (lease_id, acquired_at, expires_at)
    values (
      p_lease_id,
      now(),
      now() + (v_ttl || ' seconds')::interval
    )
    on conflict (lease_id) do update
      set expires_at = now() + (v_ttl || ' seconds')::interval;
    return true;
  else
    return false;
  end if;
end;
$$;

revoke all on function public.ai_concurrency_acquire(text, int, int) from public, anon, authenticated;
grant execute on function public.ai_concurrency_acquire(text, int, int) to service_role;

-- 6. Concurrency Release RPC
-- Releases acquired lease on request termination.
create or replace function public.ai_concurrency_release(
  p_lease_id text
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_deleted boolean;
begin
  delete from public.ai_concurrency_leases
  where lease_id = p_lease_id;
  v_deleted := found;
  return v_deleted;
end;
$$;

revoke all on function public.ai_concurrency_release(text) from public, anon, authenticated;
grant execute on function public.ai_concurrency_release(text) to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_ai_concurrency_leases_expires;
--   ALTER TABLE public.ai_global_budget_daily DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.ai_concurrency_leases DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.ai_global_budget_daily CASCADE;
--   DROP TABLE IF EXISTS public.ai_concurrency_leases CASCADE;
--   DROP FUNCTION IF EXISTS public.ai_global_budget_reserve(p_period date, p_tokens bigint, p_cap bigint);
--   DROP FUNCTION IF EXISTS public.ai_global_budget_settle(p_period date, p_reserved bigint, p_actual bigint);
--   DROP FUNCTION IF EXISTS public.ai_concurrency_acquire(p_lease_id text, p_cap int, p_ttl_seconds int);
--   DROP FUNCTION IF EXISTS public.ai_concurrency_release(p_lease_id text);
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261104b_payment_order_mode_isolation.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: 20261104b_payment_order_mode_isolation.sql
-- Fix Audit F01: Razorpay test-mode payments must never grant real Pro access or add-on credits.
--
-- Core Security Controls:
-- 1. Adds mode column ('test' | 'live') to public.payment_orders with CHECK constraint.
-- 2. Updates fulfil_payment_order to accept p_expected_mode (default 'live').
-- 3. Fail-Closed Mode Check: Rejects with MODE_MISMATCH if v_order.mode <> p_expected_mode.
-- 4. In test mode: Marks payment_orders status = 'paid', returns is_pro = false,
--    and strictly NEVER touches public.subscriptions or public.user_addon_credits.
-- 5. In live mode: Atomically grants subscription or add-on credits before marking paid.
-- ==============================================================================

-- 1. Add mode column to payment_orders table
ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live'
  CHECK (mode IN ('test', 'live'));

CREATE INDEX IF NOT EXISTS idx_payment_orders_mode
  ON public.payment_orders(mode);

-- Backfill existing orders: test IDs or fake IDs to 'test'
UPDATE public.payment_orders
SET mode = 'test'
WHERE provider_order_id LIKE 'order_test_%'
   OR provider_order_id LIKE 'fake_%'
   OR provider_order_id LIKE 'test_%';

-- 2. Replace fulfil_payment_order with mode isolation support
DROP FUNCTION IF EXISTS public.fulfil_payment_order(text, uuid);

CREATE OR REPLACE FUNCTION public.fulfil_payment_order(
  p_provider_order_id text,
  p_user_id uuid,
  p_expected_mode text default 'live'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order record;
  v_existing_sub record;
  v_existing_credit record;
  v_duration int := 30;
  v_sets int := 10;
  v_validity int := 60;
  v_sub record;
  v_credit record;
  v_base_time timestamptz;
  v_new_end timestamptz;
  v_period_start timestamptz;
BEGIN
  -- Validate expected mode parameter
  IF p_expected_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXPECTED_MODE',
      'error', 'Expected mode must be either test or live'
    );
  END IF;

  -- 1. Lock the order row for update
  SELECT * INTO v_order
  FROM public.payment_orders
  WHERE provider_order_id = p_provider_order_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF v_order IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_FOUND',
      'error', 'Payment order not found for user'
    );
  END IF;

  -- 2. Provider verification
  IF v_order.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay provider orders can be fulfilled via this function'
    );
  END IF;

  -- 3. Fail-closed Mode Check: Order mode must match expected fulfillment mode
  IF v_order.mode <> p_expected_mode THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MODE_MISMATCH',
      'error', format('Order mode (%s) does not match fulfillment mode (%s)', v_order.mode, p_expected_mode)
    );
  END IF;

  -- 4. Verify state is valid (created or paid-retry)
  IF v_order.status NOT IN ('created', 'paid') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_INVALID_STATE',
      'error', 'Payment order is not in created or paid state'
    );
  END IF;

  -- 5. TEST MODE ISOLATION: Zero real entitlements granted
  IF v_order.mode = 'test' THEN
    IF v_order.status = 'paid' THEN
      RETURN jsonb_build_object(
        'success', true,
        'test_mode', true,
        'is_pro', false,
        'already_paid', true,
        'order_id', v_order.id,
        'message', 'Test order already verified and marked as paid'
      );
    END IF;

    -- Mark test order paid, NEVER touch subscriptions or user_addon_credits
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'test_mode', true,
      'is_pro', false,
      'order_id', v_order.id,
      'already_paid', false,
      'message', 'Test payment verified; zero real entitlements granted'
    );
  END IF;

  -- 6. LIVE MODE: Idempotency check for already fulfilled live orders
  IF v_order.status = 'paid' THEN
    IF v_order.plan_code IS NOT NULL THEN
      SELECT * INTO v_existing_sub
      FROM public.subscriptions
      WHERE user_id = p_user_id;

      IF v_existing_sub IS NOT NULL AND (
        (v_existing_sub.metadata->>'payment_order_id' = v_order.id::text) OR
        (v_existing_sub.metadata->>'provider_order_id' = p_provider_order_id)
      ) THEN
        RETURN jsonb_build_object(
          'success', true,
          'already_paid', true,
          'is_pro', true,
          'type', 'plan',
          'plan_code', v_order.plan_code,
          'order_id', v_order.id,
          'period_end', v_existing_sub.current_period_end,
          'message', 'Order already fulfilled and marked as paid'
        );
      END IF;
      -- If subscription grant missing, proceed below to re-attempt grant!
    ELSIF v_order.addon_code IS NOT NULL THEN
      SELECT * INTO v_existing_credit
      FROM public.user_addon_credits
      WHERE order_id = v_order.id;

      IF v_existing_credit IS NOT NULL THEN
        RETURN jsonb_build_object(
          'success', true,
          'already_paid', true,
          'is_pro', false,
          'type', 'addon',
          'addon_code', v_order.addon_code,
          'order_id', v_order.id,
          'credit_id', v_existing_credit.id,
          'message', 'Order already fulfilled and marked as paid'
        );
      END IF;
      -- If add-on grant missing, proceed below to re-attempt grant!
    END IF;
  END IF;

  -- 7. Live Fulfillment Path A: Subscription Plan purchase / renewal / upgrade
  IF v_order.plan_code IS NOT NULL THEN
    SELECT duration_days INTO v_duration
    FROM public.plans
    WHERE code = v_order.plan_code;

    IF v_duration IS NULL OR v_duration <= 0 THEN
      IF v_order.plan_code = 'weekly' THEN
        v_duration := 7;
      ELSIF v_order.plan_code = 'quarterly' THEN
        v_duration := 90;
      ELSE
        v_duration := 30;
      END IF;
    END IF;

    -- Look up existing subscription to calculate extension
    SELECT * INTO v_existing_sub
    FROM public.subscriptions
    WHERE user_id = p_user_id;

    IF v_existing_sub IS NOT NULL AND (v_existing_sub.status IN ('active', 'trialing')) AND v_existing_sub.current_period_end IS NOT NULL THEN
      -- User has an active plan: new period end = max(current_period_end, now) + duration
      v_base_time := greatest(v_existing_sub.current_period_end, now());
      v_new_end := v_base_time + (v_duration * interval '1 day');
      -- Never shorten existing period
      IF v_new_end < v_existing_sub.current_period_end THEN
        v_new_end := v_existing_sub.current_period_end;
      END IF;
      v_period_start := coalesce(v_existing_sub.current_period_start, now());
    ELSE
      -- Expired or no previous subscription: period end = now + duration
      v_period_start := now();
      v_new_end := now() + (v_duration * interval '1 day');
    END IF;

    -- Grant subscription entitlement FIRST
    INSERT INTO public.subscriptions (
      user_id,
      plan_id,
      provider,
      currency,
      amount,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      metadata,
      updated_at
    ) VALUES (
      p_user_id,
      v_order.plan_code,
      'razorpay',
      v_order.currency,
      v_order.amount_paise,
      'active',
      v_period_start,
      v_new_end,
      false,
      jsonb_build_object(
        'provider_order_id', p_provider_order_id,
        'payment_order_id', v_order.id,
        'mode', 'live',
        'verified_at', now()
      ),
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      plan_id = excluded.plan_id,
      status = 'active',
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = false,
      metadata = excluded.metadata,
      updated_at = now()
    RETURNING * INTO v_sub;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'is_pro', true,
      'type', 'plan',
      'plan_code', v_order.plan_code,
      'order_id', v_order.id,
      'period_end', v_sub.current_period_end
    );
  END IF;

  -- 8. Live Fulfillment Path B: Add-on pack purchase
  IF v_order.addon_code IS NOT NULL THEN
    SELECT sets, validity_days INTO v_sets, v_validity
    FROM public.addon_packs
    WHERE code = v_order.addon_code;

    IF v_sets IS NULL OR v_sets <= 0 THEN
      IF v_order.addon_code = 'addon_30' THEN
        v_sets := 30;
      ELSIF v_order.addon_code = 'addon_60' THEN
        v_sets := 60;
      ELSE
        v_sets := 10;
      END IF;
    END IF;

    IF v_validity IS NULL OR v_validity <= 0 THEN
      v_validity := 60;
    END IF;

    -- Grant add-on credit entitlement FIRST
    INSERT INTO public.user_addon_credits (
      user_id,
      pack_code,
      sets_total,
      sets_remaining,
      expires_at,
      order_id,
      created_at
    ) VALUES (
      p_user_id,
      v_order.addon_code,
      v_sets,
      v_sets,
      now() + (v_validity * interval '1 day'),
      v_order.id,
      now()
    )
    ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_credit;

    IF v_credit IS NULL THEN
      SELECT * INTO v_credit
      FROM public.user_addon_credits
      WHERE order_id = v_order.id;
    END IF;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'is_pro', false,
      'type', 'addon',
      'addon_code', v_order.addon_code,
      'order_id', v_order.id,
      'sets_granted', v_sets,
      'credit_id', v_credit.id,
      'expires_at', v_credit.expires_at
    );
  END IF;

  RETURN jsonb_build_object(
    'success', false,
    'code', 'ORDER_ITEM_MISSING',
    'error', 'Order contains neither plan_code nor addon_code'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.fulfil_payment_order(text, uuid, text) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_payment_orders_mode;
--   ALTER TABLE public.payment_orders DROP COLUMN IF EXISTS mode;
--   NOTE: replaces function public.fulfil_payment_order (first defined in 20261103c_fulfil_payment_fn.sql); restore the prior definition from that file if this change must be undone.
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261105a_failed_events.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261105a_failed_events.sql
-- Description: Add failed_events dead-letter table for async background tasks
-- Table: public.failed_events
-- Access: RLS enabled, deny-all to anon/authenticated, service_role only

create table if not exists public.failed_events (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  event_id text not null,
  payload jsonb not null default '{}'::jsonb,
  error text not null,
  attempts int not null default 1,
  status text not null default 'pending' check (status in ('pending', 'replayed', 'dead')),
  first_failed_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  next_retry_at timestamptz not null default now()
);

-- Unique constraint ensuring idempotency on (source, event_id)
create unique index if not exists idx_failed_events_source_event
  on public.failed_events (source, event_id);

-- Operational index for querying pending events ready for retry
create index if not exists idx_failed_events_pending_retry
  on public.failed_events (status, next_retry_at)
  where status = 'pending';

-- Row Level Security (deny-all to anon/authenticated, service_role only)
alter table public.failed_events enable row level security;

revoke all on public.failed_events from public, anon, authenticated;
grant all on public.failed_events to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_failed_events_source_event;
--   DROP INDEX IF EXISTS public.idx_failed_events_pending_retry;
--   ALTER TABLE public.failed_events DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.failed_events CASCADE;
--   REVOKE ALL ON public.failed_events FROM service_role;
--   GRANT ALL ON public.failed_events TO public, anon, authenticated;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261105b_email_suppressions.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261105b_email_suppressions.sql
-- Description: Add email_suppressions table to prevent sending emails to bounced, unsubscribed, or blocked addresses
-- Table: public.email_suppressions
-- Access: RLS enabled, deny-all to anon/authenticated, service_role only

create table if not exists public.email_suppressions (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) <= 254 and position('@' in email) > 1),
  reason text not null default 'manual' check (reason in ('bounce', 'complaint', 'unsubscribe', 'manual', 'invalid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive unique index on email
create unique index if not exists idx_email_suppressions_lower_email
  on public.email_suppressions (lower(email));

-- Operational index for querying recent suppressions
create index if not exists idx_email_suppressions_created_at
  on public.email_suppressions (created_at desc);

-- Row Level Security (deny-all to anon/authenticated, service_role only)
alter table public.email_suppressions enable row level security;

revoke all on public.email_suppressions from public, anon, authenticated;
grant all on public.email_suppressions to service_role;

-- Enforce lowercase email on write (insert / update)
create or replace function public.trg_email_suppressions_lowercase()
returns trigger as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_email_suppressions_lowercase on public.email_suppressions;
create trigger trg_email_suppressions_lowercase
  before insert or update on public.email_suppressions
  for each row execute function public.trg_email_suppressions_lowercase();

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP TRIGGER IF EXISTS trg_email_suppressions_lowercase ON public.email_suppressions;
--   DROP INDEX IF EXISTS public.idx_email_suppressions_lower_email;
--   DROP INDEX IF EXISTS public.idx_email_suppressions_created_at;
--   ALTER TABLE public.email_suppressions DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.email_suppressions CASCADE;
--   DROP FUNCTION IF EXISTS public.trg_email_suppressions_lowercase();
--   REVOKE ALL ON public.email_suppressions FROM service_role;
--   GRANT ALL ON public.email_suppressions TO public, anon, authenticated;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261105b_web_vitals.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261105b_web_vitals.sql
-- Description: Core Web Vitals telemetry table for Real User Monitoring (RUM)
-- Table: public.web_vitals
-- Access: Row Level Security enabled, revoke all from anon and authenticated, service_role only

create table if not exists public.web_vitals (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name in ('LCP', 'INP', 'CLS', 'TTFB', 'FCP')),
  value double precision not null check (value >= 0),
  rating text check (rating in ('good', 'needs-improvement', 'poor')),
  route text not null,
  navigation_type text,
  created_at timestamptz not null default now()
);

-- Operational indexes for aggregating performance metrics by name and route over time
create index if not exists idx_web_vitals_name_route_created_at
  on public.web_vitals (name, route, created_at desc);

create index if not exists idx_web_vitals_created_at
  on public.web_vitals (created_at desc);

-- Row Level Security (deny-all to anon/authenticated, service_role only)
alter table public.web_vitals enable row level security;

-- Revoke all permissions from anon, authenticated, and public
revoke all on public.web_vitals from public, anon, authenticated;

-- Grant access to service_role only
grant all on public.web_vitals to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_web_vitals_name_route_created_at;
--   DROP INDEX IF EXISTS public.idx_web_vitals_created_at;
--   ALTER TABLE public.web_vitals DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.web_vitals CASCADE;
--   REVOKE ALL ON public.web_vitals FROM service_role;
--   GRANT ALL ON public.web_vitals TO public, anon, authenticated;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261105c_database_safety.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261105c_database_safety.sql
-- Description: Database safety migration (schema_migrations table, role-level timeouts, pg_stat_statements)
-- Access: schema_migrations has RLS enabled (deny-all to public/anon/authenticated, service_role only)
-- Notice: DO NOT apply this file automatically. Apply manually via Supabase SQL editor or CLI.

-- ============================================================================
-- ROLLBACK INSTRUCTIONS (execute in Supabase SQL editor if rollback is needed):
-- ============================================================================
--
-- 1. Reset role-level timeouts to database defaults:
--    alter role authenticator reset statement_timeout;
--    alter role authenticator reset lock_timeout;
--    alter role authenticator reset idle_in_transaction_session_timeout;
--
--    alter role anon reset statement_timeout;
--    alter role anon reset lock_timeout;
--    alter role anon reset idle_in_transaction_session_timeout;
--
--    alter role authenticated reset statement_timeout;
--    alter role authenticated reset lock_timeout;
--    alter role authenticated reset idle_in_transaction_session_timeout;
--
-- 2. Drop schema_migrations tracking table:
--    drop table if exists public.schema_migrations cascade;
--
-- 3. (Optional) Disable pg_stat_statements extension if no longer needed:
--    drop extension if exists pg_stat_statements;
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) SCHEMA_MIGRATIONS TRACKING TABLE
-- ----------------------------------------------------------------------------
create table if not exists public.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now(),
  applied_by text not null default current_user,
  checksum text
);

comment on table public.schema_migrations is 'Tracks applied database migrations with checksums and audit timestamps.';
comment on column public.schema_migrations.filename is 'Base migration filename (e.g., 20261105c_database_safety.sql).';
comment on column public.schema_migrations.applied_at is 'Timestamp when migration was manually executed.';
comment on column public.schema_migrations.applied_by is 'User or service account that executed the migration.';
comment on column public.schema_migrations.checksum is 'SHA-256 hash of the migration file contents at execution time.';

-- Enable Row Level Security (deny-all to public/anon/authenticated, service_role only)
alter table public.schema_migrations enable row level security;

revoke all on public.schema_migrations from public, anon, authenticated;
grant all on public.schema_migrations to service_role;

-- ----------------------------------------------------------------------------
-- (2) ROLE-LEVEL TIMEOUTS (service_role excluded for admin & cron longevity)
-- ----------------------------------------------------------------------------
-- Authenticator role (Supabase PostgREST connection pooler)
alter role authenticator set statement_timeout = '15s';
alter role authenticator set lock_timeout = '5s';
alter role authenticator set idle_in_transaction_session_timeout = '60s';

-- Anonymous public role
alter role anon set statement_timeout = '15s';
alter role anon set lock_timeout = '5s';
alter role anon set idle_in_transaction_session_timeout = '60s';

-- Authenticated end-user role
alter role authenticated set statement_timeout = '15s';
alter role authenticated set lock_timeout = '5s';
alter role authenticated set idle_in_transaction_session_timeout = '60s';

-- ----------------------------------------------------------------------------
-- (3) PG_STAT_STATEMENTS EXTENSION
-- ----------------------------------------------------------------------------
create extension if not exists pg_stat_statements;

-- ============================================================================
-- VERIFY QUERIES (execute in Supabase SQL editor to confirm configuration):
-- ============================================================================
--
-- 1. Verify schema_migrations table existence and RLS status:
--    select schemaname, tablename, rowsecurity
--    from pg_tables
--    where schemaname = 'public' and tablename = 'schema_migrations';
--
-- 2. Verify schema_migrations permissions (only service_role has access):
--    select grantee, privilege_type
--    from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'schema_migrations';
--
-- 3. Verify role-level timeout configurations for authenticator, anon, and authenticated:
--    select r.rolname, s.setconfig
--    from pg_roles r
--    left join pg_db_role_setting s on s.setrole = r.oid
--    where r.rolname in ('authenticator', 'anon', 'authenticated', 'service_role')
--    order by r.rolname;
--
-- 4. Verify pg_stat_statements extension status:
--    select extname, extversion, extrelocatable
--    from pg_extension
--    where extname = 'pg_stat_statements';
--
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261105d_email_suppressions_unique_constraint.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261105d_email_suppressions_unique_constraint.sql
-- Description: Add plain unique constraint on public.email_suppressions(email)
-- Context: The existing lowercase trigger (trg_email_suppressions_lowercase) already guarantees
-- equivalence by normalizing all emails on insert/update. PostgREST/Supabase requires a plain
-- unique constraint or index on the target column to support upsert with { onConflict: "email" }.
-- Notice: DO NOT apply this file automatically. Apply manually via Supabase SQL editor or CLI.

-- ============================================================================
-- ROLLBACK INSTRUCTIONS (execute in Supabase SQL editor if rollback is needed):
-- ============================================================================
-- alter table public.email_suppressions drop constraint if exists email_suppressions_email_key;
-- ============================================================================

-- 1. Ensure any duplicate lowercase records are resolved before constraint addition (safety guard)
-- (In fresh or cleaned databases this is a no-op; preserves earliest record)
delete from public.email_suppressions a
using public.email_suppressions b
where a.ctid < b.ctid
  and lower(trim(a.email)) = lower(trim(b.email));

-- 2. Add plain unique constraint on the email column if not already present
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_suppressions'::regclass
      and contype = 'u'
      and conname = 'email_suppressions_email_key'
  ) then
    alter table public.email_suppressions
      add constraint email_suppressions_email_key unique (email);
  end if;
end $$;

comment on constraint email_suppressions_email_key on public.email_suppressions is
  'Enforces unique email addresses for PostgREST onConflict upsert resolution.';

-- ============================================================================
-- VERIFICATION QUERY:
-- select conname, contype, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.email_suppressions'::regclass
--   and conname = 'email_suppressions_email_key';
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106a_data_retention.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106a_data_retention.sql
-- Purpose:   Retention enforcement for operational/log tables. One SECURITY
--            DEFINER function, callable only by service_role, purges rows past
--            each table's retention window (docs/retention-policy.md).
--            dry_run DEFAULTS TO TRUE (reviewer nit, 2026-11-06): a bare
--            select public.purge_operational_logs() only reports counts; pass
--            false explicitly to delete. Safer against SQL-editor fat-finger.
-- Status:    NOT APPLIED - owner applies in the Supabase SQL editor, then runs
--            node scripts/record-migration.cjs 20261106a_data_retention
-- Covers:    audit rows DB#4 (retention enforcement), DB#5 (purge jobs for
--            log tables); the 90-day webhook_events cleanup that previously
--            existed only as a comment in 20261019_webhook_events.sql.
-- Rollback:  DROP FUNCTION IF EXISTS public.purge_operational_logs(boolean);
-- ============================================================================

create or replace function public.purge_operational_logs(dry_run boolean default true)
returns table (table_name text, cutoff timestamptz, rows_matched bigint, rows_deleted bigint)
language plpgsql
security definer
set search_path = ''
as $func$
begin
  -- page_views: keep 90 days
  return query
    with del as (
      delete from public.page_views
      where created_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'page_views'::text, now() - interval '90 days',
           (select count(*) from public.page_views where created_at < now() - interval '90 days'),
           (select count(*) from del);

  -- gmail_send_log: keep 180 days (doubles as suppression evidence)
  return query
    with del as (
      delete from public.gmail_send_log
      where sent_at < now() - interval '180 days' and not dry_run
      returning 1
    )
    select 'gmail_send_log'::text, now() - interval '180 days',
           (select count(*) from public.gmail_send_log where sent_at < now() - interval '180 days'),
           (select count(*) from del);

  -- cron_run_logs: keep 90 days
  return query
    with del as (
      delete from public.cron_run_logs
      where started_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'cron_run_logs'::text, now() - interval '90 days',
           (select count(*) from public.cron_run_logs where started_at < now() - interval '90 days'),
           (select count(*) from del);

  -- admin_audit_log: keep 365 days
  return query
    with del as (
      delete from public.admin_audit_log
      where created_at < now() - interval '365 days' and not dry_run
      returning 1
    )
    select 'admin_audit_log'::text, now() - interval '365 days',
           (select count(*) from public.admin_audit_log where created_at < now() - interval '365 days'),
           (select count(*) from del);

  -- webhook_events: keep 90 days (implements the comment in 20261019_webhook_events.sql)
  return query
    with del as (
      delete from public.webhook_events
      where processed_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'webhook_events'::text, now() - interval '90 days',
           (select count(*) from public.webhook_events where processed_at < now() - interval '90 days'),
           (select count(*) from del);

  -- failed_events: keep replayed/dead rows for 90 days after the last attempt;
  -- pending rows are never purged (they still need replay).
  return query
    with del as (
      delete from public.failed_events
      where status in ('replayed', 'dead')
        and last_attempt_at < now() - interval '90 days'
        and not dry_run
      returning 1
    )
    select 'failed_events'::text, now() - interval '90 days',
           (select count(*) from public.failed_events
            where status in ('replayed', 'dead') and last_attempt_at < now() - interval '90 days'),
           (select count(*) from del);
end;
$func$;

comment on function public.purge_operational_logs(boolean) is
  'Retention purge for operational/log tables. Weekly via retention-cron.yml. Windows: page_views 90d, gmail_send_log 180d, cron_run_logs 90d, admin_audit_log 365d, webhook_events 90d, failed_events(replayed/dead) 90d. dry_run=true reports counts only.';

-- Only the service role (cron scripts) may run it.
revoke all on function public.purge_operational_logs(boolean) from public, anon, authenticated;
grant execute on function public.purge_operational_logs(boolean) to service_role;

-- ============================================================================
-- Verification (after applying):
--   select * from public.purge_operational_logs(true);  -- dry run, counts only
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106b_early_access_attribution.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: Early-access attribution columns (UTM / referrer)
-- File: supabase/migrations/20261106b_early_access_attribution.sql
-- Status: NOT APPLIED - owner runs in the Supabase SQL editor (additive,
--         nullable; safe while code ships first since inserts name columns
--         explicitly and the route omits them when absent).
--         Then record:  node scripts/record-migration.cjs 20261106b_early_access_attribution
-- Backend half of UTM capture (frontend: PR #287 / src/lib/analytics/utm.ts).
-- ==============================================================================

ALTER TABLE public.early_access_emails
  ADD COLUMN IF NOT EXISTS utm_source   TEXT CHECK (utm_source   IS NULL OR char_length(utm_source)   <= 200),
  ADD COLUMN IF NOT EXISTS utm_medium   TEXT CHECK (utm_medium   IS NULL OR char_length(utm_medium)   <= 200),
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT CHECK (utm_campaign IS NULL OR char_length(utm_campaign) <= 200),
  ADD COLUMN IF NOT EXISTS utm_term     TEXT CHECK (utm_term     IS NULL OR char_length(utm_term)     <= 200),
  ADD COLUMN IF NOT EXISTS utm_content  TEXT CHECK (utm_content  IS NULL OR char_length(utm_content)  <= 200),
  ADD COLUMN IF NOT EXISTS referrer     TEXT CHECK (referrer     IS NULL OR char_length(referrer)     <= 500),
  ADD COLUMN IF NOT EXISTS landing_path TEXT CHECK (landing_path IS NULL OR char_length(landing_path) <= 200);

COMMENT ON COLUMN public.early_access_emails.utm_source IS 'First-touch campaign attribution, session-scoped (backend half of UTM capture, 2026-11-06).';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.early_access_emails DROP COLUMN IF EXISTS utm_source;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106c_change_history_triggers.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106c_change_history_triggers.sql
-- Purpose:   Per-row change history on user and billing tables. A generic
--            trigger function logs non-sensitive audit metadata to
--            public.row_change_history on every INSERT/UPDATE/DELETE.
--            Full row images are NOT stored.
--            - user_preferences: changed column names only (no values).
--            - subscriptions, payment_orders, user_addon_credits: non-sensitive
--              fields only (status, plans, amounts, timestamps).
--              Provider/customer/subscription/order IDs and metadata are omitted.
--            - UPDATE operations record changed_columns list.
--            Includes 90-day retention purge function purge_row_change_history().
-- Status:    NOT APPLIED - owner applies in the Supabase SQL editor, then runs
--            node scripts/record-migration.cjs 20261106c_change_history_triggers
-- Covers:    audit row DB#10 (change-history triggers). admin_audit_log
--            (20261020) covers admin actions only; this covers row-level data
--            changes from any writer. The history insert is fail-open
--            (BEGIN/EXCEPTION -> RAISE WARNING): a write to a billing or
--            user table must never fail because of audit logging.
-- Scope:     subscriptions, payment_orders, user_addon_credits,
--            user_preferences. High-churn operational tables are intentionally
--            excluded to keep volume bounded.
-- Rollback:  DROP TRIGGER IF EXISTS trg_change_history_subscriptions ON public.subscriptions;
--            DROP TRIGGER IF EXISTS trg_change_history_payment_orders ON public.payment_orders;
--            DROP TRIGGER IF EXISTS trg_change_history_user_addon_credits ON public.user_addon_credits;
--            DROP TRIGGER IF EXISTS trg_change_history_user_preferences ON public.user_preferences;
--            DROP FUNCTION IF EXISTS public.purge_row_change_history(boolean);
--            DROP FUNCTION IF EXISTS public.log_row_change();
--            DROP TABLE IF EXISTS public.row_change_history;
-- ============================================================================

-- 1. Append-only history table with privacy-preserving schema
create table if not exists public.row_change_history (
  id              bigint generated always as identity primary key,
  changed_at      timestamptz not null default now(),
  table_name      text not null,
  row_id          text,
  operation       text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  changed_columns text[],
  old_row         jsonb,
  new_row         jsonb,
  changed_by      text
);

create index if not exists idx_row_change_history_table_row
  on public.row_change_history (table_name, row_id, changed_at desc);
create index if not exists idx_row_change_history_changed_at
  on public.row_change_history (changed_at desc);

-- 2. Lock down: service_role only, nothing for client roles
alter table public.row_change_history enable row level security;
revoke all on table public.row_change_history from anon, authenticated;
grant all on table public.row_change_history to service_role;

-- 3. Generic trigger function. search_path pinned to '' (audit DB#64) and all
--    references schema-qualified. Runs as definer so trigger inserts are not
--    subject to the calling role's table privileges.
create or replace function public.log_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $func$
declare
  v_raw_old         jsonb;
  v_raw_new         jsonb;
  v_old             jsonb := null;
  v_new             jsonb := null;
  v_changed_columns text[] := null;
  v_row_id          text;
  v_actor           text;
begin
  if TG_OP = 'DELETE' then
    v_raw_old := to_jsonb(OLD);
  elsif TG_OP = 'INSERT' then
    v_raw_new := to_jsonb(NEW);
  else
    v_raw_old := to_jsonb(OLD);
    v_raw_new := to_jsonb(NEW);
  end if;

  -- Covered tables key rows by id (uuid) or user_id (uuid).
  v_row_id := coalesce(
    coalesce(v_raw_new, v_raw_old) ->> 'id',
    coalesce(v_raw_new, v_raw_old) ->> 'user_id'
  );

  -- Compute list of changed column names on UPDATE
  if TG_OP = 'UPDATE' and v_raw_old is not null and v_raw_new is not null then
    select coalesce(array_agg(key order by key), '{}'::text[])
    into v_changed_columns
    from jsonb_each(v_raw_new) n
    where (v_raw_old -> n.key) is distinct from n.value;
  end if;

  -- Privacy filtering: never store full row images or sensitive identifiers
  -- user_preferences: changed column names only, no values (v_old and v_new stay null)
  -- subscriptions, payment_orders, user_addon_credits: non-sensitive fields only
  -- NEVER store provider, customer_id, subscription_id, provider_order_id, or metadata
  if TG_TABLE_NAME = 'subscriptions' then
    if v_raw_old is not null then
      v_old := jsonb_strip_nulls(jsonb_build_object(
        'status', v_raw_old ->> 'status',
        'plan_id', v_raw_old ->> 'plan_id',
        'amount', v_raw_old -> 'amount',
        'currency', v_raw_old ->> 'currency',
        'current_period_start', v_raw_old ->> 'current_period_start',
        'current_period_end', v_raw_old ->> 'current_period_end',
        'grace_period_end', v_raw_old ->> 'grace_period_end',
        'cancel_at_period_end', v_raw_old -> 'cancel_at_period_end',
        'created_at', v_raw_old ->> 'created_at',
        'updated_at', v_raw_old ->> 'updated_at'
      ));
    end if;
    if v_raw_new is not null then
      v_new := jsonb_strip_nulls(jsonb_build_object(
        'status', v_raw_new ->> 'status',
        'plan_id', v_raw_new ->> 'plan_id',
        'amount', v_raw_new -> 'amount',
        'currency', v_raw_new ->> 'currency',
        'current_period_start', v_raw_new ->> 'current_period_start',
        'current_period_end', v_raw_new ->> 'current_period_end',
        'grace_period_end', v_raw_new ->> 'grace_period_end',
        'cancel_at_period_end', v_raw_new -> 'cancel_at_period_end',
        'created_at', v_raw_new ->> 'created_at',
        'updated_at', v_raw_new ->> 'updated_at'
      ));
    end if;
  elsif TG_TABLE_NAME = 'payment_orders' then
    if v_raw_old is not null then
      v_old := jsonb_strip_nulls(jsonb_build_object(
        'status', v_raw_old ->> 'status',
        'plan_code', v_raw_old ->> 'plan_code',
        'addon_code', v_raw_old ->> 'addon_code',
        'amount_paise', v_raw_old -> 'amount_paise',
        'currency', v_raw_old ->> 'currency',
        'created_at', v_raw_old ->> 'created_at',
        'paid_at', v_raw_old ->> 'paid_at'
      ));
    end if;
    if v_raw_new is not null then
      v_new := jsonb_strip_nulls(jsonb_build_object(
        'status', v_raw_new ->> 'status',
        'plan_code', v_raw_new ->> 'plan_code',
        'addon_code', v_raw_new ->> 'addon_code',
        'amount_paise', v_raw_new -> 'amount_paise',
        'currency', v_raw_new ->> 'currency',
        'created_at', v_raw_new ->> 'created_at',
        'paid_at', v_raw_new ->> 'paid_at'
      ));
    end if;
  elsif TG_TABLE_NAME = 'user_addon_credits' then
    if v_raw_old is not null then
      v_old := jsonb_strip_nulls(jsonb_build_object(
        'pack_code', v_raw_old ->> 'pack_code',
        'sets_total', v_raw_old -> 'sets_total',
        'sets_remaining', v_raw_old -> 'sets_remaining',
        'expires_at', v_raw_old ->> 'expires_at',
        'created_at', v_raw_old ->> 'created_at'
      ));
    end if;
    if v_raw_new is not null then
      v_new := jsonb_strip_nulls(jsonb_build_object(
        'pack_code', v_raw_new ->> 'pack_code',
        'sets_total', v_raw_new -> 'sets_total',
        'sets_remaining', v_raw_new -> 'sets_remaining',
        'expires_at', v_raw_new ->> 'expires_at',
        'created_at', v_raw_new ->> 'created_at'
      ));
    end if;
  -- user_preferences and any unhandled table: v_old and v_new remain null
  end if;

  -- Best-effort actor: Supabase JWT subject when present, else the DB role.
  begin
    v_actor := coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    );
  exception when others then
    v_actor := null;
  end;
  v_actor := coalesce(v_actor, session_user);

  -- Fail-open per owner decision: a write to a billing or user table must
  -- never fail because of audit logging. Log a warning and continue.
  begin
    insert into public.row_change_history (
      table_name, row_id, operation, changed_columns, old_row, new_row, changed_by
    )
    values (
      TG_TABLE_NAME, v_row_id, TG_OP, v_changed_columns, v_old, v_new, v_actor
    );
  exception when others then
    raise warning 'row_change_history insert failed for % (row %, op %): %', TG_TABLE_NAME, v_row_id, TG_OP, SQLERRM;
  end;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$func$;

revoke all on function public.log_row_change() from public, anon, authenticated;
grant execute on function public.log_row_change() to service_role;

-- 4. Attach to the user and billing tables in scope
drop trigger if exists trg_change_history_subscriptions on public.subscriptions;
create trigger trg_change_history_subscriptions
  after insert or update or delete on public.subscriptions
  for each row execute function public.log_row_change();

drop trigger if exists trg_change_history_payment_orders on public.payment_orders;
create trigger trg_change_history_payment_orders
  after insert or update or delete on public.payment_orders
  for each row execute function public.log_row_change();

drop trigger if exists trg_change_history_user_addon_credits on public.user_addon_credits;
create trigger trg_change_history_user_addon_credits
  after insert or update or delete on public.user_addon_credits
  for each row execute function public.log_row_change();

drop trigger if exists trg_change_history_user_preferences on public.user_preferences;
create trigger trg_change_history_user_preferences
  after insert or update or delete on public.user_preferences
  for each row execute function public.log_row_change();

-- 5. Retention purge for row_change_history (older than 90 days)
create or replace function public.purge_row_change_history(dry_run boolean default true)
returns table (table_name text, cutoff timestamptz, rows_matched bigint, rows_deleted bigint)
language plpgsql
security definer
set search_path = ''
as $func$
begin
  return query
    with del as (
      delete from public.row_change_history
      where changed_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'row_change_history'::text, now() - interval '90 days',
           (select count(*) from public.row_change_history where changed_at < now() - interval '90 days'),
           (select count(*) from del);
end;
$func$;

comment on function public.purge_row_change_history(boolean) is
  'Retention purge for row_change_history. Purges records older than 90 days. dry_run=true reports counts only.';

revoke all on function public.purge_row_change_history(boolean) from public, anon, authenticated;
grant execute on function public.purge_row_change_history(boolean) to postgres, service_role;

-- ============================================================================
-- VERIFY (Supabase SQL editor):
--   select c.relname, c.rowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'row_change_history';
--   select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('log_row_change', 'purge_row_change_history');
--   select tgname, relname from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname like 'trg_change_history%';
--   select * from public.purge_row_change_history(true);
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106d_matview_refresh_log.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106d_matview_refresh_log.sql
-- Purpose:   Matview staleness metric (audit DB #17). Postgres does not track
--            last-refresh time natively, so a stuck refresh was invisible.
--            This logs every successful refresh of
--            public.worldwide_company_counts so scripts/db-health.sql can
--            report real refresh recency.
-- Status:    NOT APPLIED - owner applies in the Supabase SQL editor, then runs
--            node scripts/record-migration.cjs 20261106d_matview_refresh_log
-- Covers:    audit row DB#17 (matview staleness metric).
-- Notes:     The refresh function keeps its original semantics (concurrent
--            refresh with non-concurrent fallback) and its pinned search_path.
--            The log insert is fail-open (BEGIN/EXCEPTION -> RAISE WARNING):
--            logging must never fail a refresh, matching the owner decision on
--            change-history triggers (20261106c).
-- Rollback:  CREATE OR REPLACE the function from 20261101_lock_scraper_metadata.sql;
--            DROP TABLE IF EXISTS public.matview_refresh_log;
-- ============================================================================

-- 1. Refresh log
create table if not exists public.matview_refresh_log (
  id            bigint generated always as identity primary key,
  matview_name  text not null,
  refreshed_at  timestamptz not null default now(),
  duration_ms   integer
);

create index if not exists idx_matview_refresh_log_name_time
  on public.matview_refresh_log (matview_name, refreshed_at desc);

-- Service-role only: ops telemetry, nothing for client roles.
alter table public.matview_refresh_log enable row level security;
revoke all on table public.matview_refresh_log from anon, authenticated;
grant all on table public.matview_refresh_log to service_role;

-- 2. Instrument the refresh function (same semantics as 20261101, plus logging)
create or replace function public.refresh_worldwide_company_counts()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_started   timestamptz := clock_timestamp();
  v_refreshed boolean := false;
begin
  -- Attempt concurrent refresh first so existing readers are never blocked
  begin
    refresh materialized view concurrently public.worldwide_company_counts;
    v_refreshed := true;
  exception when others then
    -- Fallback to non-concurrent refresh (e.g. when unpopulated)
    begin
      refresh materialized view public.worldwide_company_counts;
      v_refreshed := true;
    exception when others then
      raise warning 'worldwide_company_counts refresh failed: %', SQLERRM;
    end;
  end;

  -- Staleness metric: record every successful refresh. Fail-open.
  if v_refreshed then
    begin
      insert into public.matview_refresh_log (matview_name, duration_ms)
      values (
        'worldwide_company_counts',
        greatest(0, floor(extract(epoch from clock_timestamp() - v_started) * 1000)::int)
      );
    exception when others then
      raise warning 'matview_refresh_log insert failed: %', SQLERRM;
    end;
  end if;
end;
$func$;

-- Re-assert execution privileges (CREATE OR REPLACE preserves ACLs; be explicit)
revoke all on function public.refresh_worldwide_company_counts() from public, anon, authenticated;
grant execute on function public.refresh_worldwide_company_counts() to service_role;


-- ------------------------------------------------------------------------------
-- Migration: 20261106e_funnel_events.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: 20261106e_funnel_events.sql
-- Date: 2026-11-06
-- Status: NOT APPLIED - owner must run this file in the Supabase SQL editor, then
--         record it with:  node scripts/record-migration.cjs 20261106e_funnel_events
-- Scope: Backend row "Funnel Tracking" - storage for signup -> onboard -> apply
--        funnel events. Inserts go through /api/track (eventType: "funnel") with a
--        server-side allowlist; the table itself is service_role only.
-- Rollback: DROP TABLE IF EXISTS public.funnel_events;
-- ==============================================================================

create table if not exists public.funnel_events (
  id uuid primary key default gen_random_uuid(),
  -- Funnel stage, allowlisted both here and in src/app/api/track/route.ts
  -- (ALLOWED_FUNNEL_EVENTS). The static test asserts both lists stay identical.
  event text not null check (
    event in (
      'signup_started',
      'signup_completed',
      'onboarding_started',
      'onboarding_completed',
      'apply_started',
      'apply_completed'
    )
  ),
  -- Signed-in actor when available; derived server-side from the session, never
  -- trusted from the request body. Pre-signup events have NULL here.
  user_id uuid references auth.users(id) on delete set null,
  -- Client-generated pseudonymous id tying pre-signup events to the later
  -- signup. Random token, no PII; capped at 64 chars app-side.
  anonymous_id text,
  path text,
  ip_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_funnel_events_event_created_at
  on public.funnel_events (event, created_at desc);
create index if not exists idx_funnel_events_created_at
  on public.funnel_events (created_at desc);
create index if not exists idx_funnel_events_user_id
  on public.funnel_events (user_id, created_at desc);
create index if not exists idx_funnel_events_anonymous_id
  on public.funnel_events (anonymous_id, created_at desc);

alter table public.funnel_events enable row level security;

-- Client roles get nothing; inserts happen via the service role in /api/track.
revoke all on table public.funnel_events from anon, authenticated;
grant all on table public.funnel_events to service_role;

comment on table public.funnel_events is
  'Signup->onboard->apply funnel events, inserted by /api/track (eventType=funnel). Service-role only. NOTE: add to purge_operational_logs retention classes when a retention window is agreed.';

-- Rollback:
--   drop table if exists public.funnel_events;


-- ------------------------------------------------------------------------------
-- Migration: 20261106f_funnel_events_retention.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: 20261106f_funnel_events_retention.sql
-- Date: 2026-11-06
-- Status: NOT APPLIED - owner must run this file in the Supabase SQL editor, then
--         record it with:  node scripts/record-migration.cjs 20261106f_funnel_events_retention
-- Apply AFTER 20261106a_data_retention and 20261106e_funnel_events: this replaces
-- public.purge_operational_logs wholesale and references public.funnel_events.
-- Scope: Reviewer follow-up on funnel tracking - funnel_events had no retention
--        class and would grow unbounded. Adds it at 90 days (same window as
--        page_views). dry_run DEFAULT TRUE is preserved: a bare
--        select public.purge_operational_logs() only reports counts.
-- NOTE for the frontend half: the funnel emitter must sit behind the analytics
--        consent gate (same gate as UTM capture, PR #287) - no consent, no events.
-- Rollback: re-apply supabase/migrations/20261106a_data_retention.sql
--           (restores the function without the funnel_events class).
-- ==============================================================================

create or replace function public.purge_operational_logs(dry_run boolean default true)
returns table (table_name text, cutoff timestamptz, rows_matched bigint, rows_deleted bigint)
language plpgsql
security definer
set search_path = ''
as $func$
begin
  -- page_views: keep 90 days
  return query
    with del as (
      delete from public.page_views
      where created_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'page_views'::text, now() - interval '90 days',
           (select count(*) from public.page_views where created_at < now() - interval '90 days'),
           (select count(*) from del);

  -- gmail_send_log: keep 180 days (doubles as suppression evidence)
  return query
    with del as (
      delete from public.gmail_send_log
      where sent_at < now() - interval '180 days' and not dry_run
      returning 1
    )
    select 'gmail_send_log'::text, now() - interval '180 days',
           (select count(*) from public.gmail_send_log where sent_at < now() - interval '180 days'),
           (select count(*) from del);

  -- cron_run_logs: keep 90 days
  return query
    with del as (
      delete from public.cron_run_logs
      where started_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'cron_run_logs'::text, now() - interval '90 days',
           (select count(*) from public.cron_run_logs where started_at < now() - interval '90 days'),
           (select count(*) from del);

  -- admin_audit_log: keep 365 days
  return query
    with del as (
      delete from public.admin_audit_log
      where created_at < now() - interval '365 days' and not dry_run
      returning 1
    )
    select 'admin_audit_log'::text, now() - interval '365 days',
           (select count(*) from public.admin_audit_log where created_at < now() - interval '365 days'),
           (select count(*) from del);

  -- webhook_events: keep 90 days (implements the comment in 20261019_webhook_events.sql)
  return query
    with del as (
      delete from public.webhook_events
      where processed_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'webhook_events'::text, now() - interval '90 days',
           (select count(*) from public.webhook_events where processed_at < now() - interval '90 days'),
           (select count(*) from del);

  -- failed_events: keep replayed/dead rows for 90 days after the last attempt;
  -- pending rows are never purged (they still need replay).
  return query
    with del as (
      delete from public.failed_events
      where status in ('replayed', 'dead')
        and last_attempt_at < now() - interval '90 days'
        and not dry_run
      returning 1
    )
    select 'failed_events'::text, now() - interval '90 days',
           (select count(*) from public.failed_events
            where status in ('replayed', 'dead') and last_attempt_at < now() - interval '90 days'),
           (select count(*) from del);

  -- funnel_events: keep 90 days (same window as page_views; added in 20261106f)
  return query
    with del as (
      delete from public.funnel_events
      where created_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'funnel_events'::text, now() - interval '90 days',
           (select count(*) from public.funnel_events where created_at < now() - interval '90 days'),
           (select count(*) from del);
end;
$func$;

comment on function public.purge_operational_logs(boolean) is
  'Retention purge for operational/log tables. Weekly via retention-cron.yml. Windows: page_views 90d, gmail_send_log 180d, cron_run_logs 90d, admin_audit_log 365d, webhook_events 90d, failed_events(replayed/dead) 90d, funnel_events 90d. dry_run=true reports counts only.';

-- Only the service role (cron scripts) may run it.
revoke all on function public.purge_operational_logs(boolean) from public, anon, authenticated;
grant execute on function public.purge_operational_logs(boolean) to service_role;

-- Rollback: re-apply 20261106a_data_retention.sql to restore the previous
-- function body (without the funnel_events class).


-- ------------------------------------------------------------------------------
-- Migration: 20261106g_drop_redundant_subscriptions_index.sql
-- ------------------------------------------------------------------------------
-- ==============================================================================
-- Migration: 20261106g_drop_redundant_subscriptions_index.sql
-- Date: 2026-11-06
-- Status: NOT APPLIED - owner must run this file in the Supabase SQL editor, then
--         record it with:  node scripts/record-migration.cjs 20261106g_drop_redundant_subscriptions_index
-- Scope: Database row "Redundant index cleanup" - idx_subscriptions_user_id is a
--        plain btree on subscriptions(user_id) that duplicates the unique index
--        backing CONSTRAINT subscriptions_user_unique UNIQUE (user_id)
--        (20261008_phase3_subscriptions_and_billing.sql). Every insert/update pays
--        for both. The unique constraint stays; uniqueness and lookups are unchanged.
--        Note: idx_subscriptions_user_id_unique (20261103f) also overlaps the same
--        constraint; left in place deliberately - drop candidates belong to a
--        separate review.
-- Locking: plain DROP INDEX on this per-user table takes a sub-second lock; the
--        CONCURRENTLY variant cannot run inside the SQL editor's implicit
--        transaction handling for multi-statement scripts, so it is not used.
-- Rollback: CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);
-- ==============================================================================

drop index if exists public.idx_subscriptions_user_id;

-- Rollback:
--   create index if not exists idx_subscriptions_user_id on public.subscriptions(user_id);


-- ------------------------------------------------------------------------------
-- Migration: 20261106h_soft_delete_tombstones.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106h_soft_delete_tombstones.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106h_soft_delete_tombstones
--
-- Database rows #1 (Soft Deletes), #5 (Anonymization on delete),
-- #26 (deleted_at tombstones).
--
-- What this does:
--   1. Adds `deleted_at` (soft-delete marker) to every user-owned content
--      table the account-deletion flow touches, plus `anonymized_at` on
--      early_access_emails (guarded by to_regclass so absent tables are skipped).
--   2. Adds `deleted_account_tombstones`: a minimal, PII-free audit record
--      (user_id + SHA-256 email hash + timestamps + purge deadline) kept
--      after the auth identity is removed. This is the "undo / retention
--      window" anchor: account data is recoverable for 30 days, then the
--      purge function hard-deletes the soft-deleted rows.
--   3. Adds purge_soft_deleted_account_data() to hard-delete rows past the
--      retention window. Call it from pg_cron / an Edge cron (owner step,
--      see Database row #21) or manually.
--
-- Retention window: 30 days (best-practice default for account-deletion
-- undo windows; adjust the interval argument when calling the purge).
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

-- 1. Soft-delete columns (guarded by to_regclass so missing tables are skipped)

DO $$ BEGIN
  IF to_regclass('public.candidate_profiles') IS NOT NULL THEN
    ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.user_preferences') IS NOT NULL THEN
    ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.resumes') IS NOT NULL THEN
    ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.tailored_resumes') IS NOT NULL THEN
    ALTER TABLE public.tailored_resumes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.saved_jobs') IS NOT NULL THEN
    ALTER TABLE public.saved_jobs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.applications') IS NOT NULL THEN
    ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.job_applications') IS NOT NULL THEN
    ALTER TABLE public.job_applications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.search_alerts') IS NOT NULL THEN
    ALTER TABLE public.search_alerts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.daily_digests') IS NOT NULL THEN
    ALTER TABLE public.daily_digests ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.ai_usage_quotas') IS NOT NULL THEN
    ALTER TABLE public.ai_usage_quotas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.ai_usage_ledger') IS NOT NULL THEN
    ALTER TABLE public.ai_usage_ledger ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.page_views') IS NOT NULL THEN
    ALTER TABLE public.page_views ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.user_roles') IS NOT NULL THEN
    ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.user_consents') IS NOT NULL THEN
    ALTER TABLE public.user_consents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.early_access_emails') IS NOT NULL THEN
    ALTER TABLE public.early_access_emails ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE public.early_access_emails ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
  END IF;
END $$;

-- Partial indexes keep the purge scan cheap without bloating hot paths.
DO $$ BEGIN
  IF to_regclass('public.candidate_profiles') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_candidate_profiles_deleted_at ON public.candidate_profiles (deleted_at) WHERE deleted_at IS NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.resumes') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_resumes_deleted_at ON public.resumes (deleted_at) WHERE deleted_at IS NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.applications') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_applications_deleted_at ON public.applications (deleted_at) WHERE deleted_at IS NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.job_applications') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_job_applications_deleted_at ON public.job_applications (deleted_at) WHERE deleted_at IS NOT NULL;
  END IF;
END $$;

-- 2. Tombstones --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.deleted_account_tombstones (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL,
  email_hash            TEXT NOT NULL,  -- SHA-256 hex of the lowercase email; lookup without PII
  deletion_completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hard_delete_after     TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days',
  purged_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deleted_account_tombstones_user_id
  ON public.deleted_account_tombstones (user_id);
CREATE INDEX IF NOT EXISTS idx_deleted_account_tombstones_purge_due
  ON public.deleted_account_tombstones (hard_delete_after) WHERE purged_at IS NULL;

ALTER TABLE public.deleted_account_tombstones ENABLE ROW LEVEL SECURITY;

-- No client access; only the service role (account-deletion flow) reads/writes.
REVOKE ALL ON public.deleted_account_tombstones FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.deleted_account_tombstones TO service_role;

-- 3. Purge function ----------------------------------------------------------
-- Hard-deletes soft-deleted rows whose retention window has elapsed and marks
-- the matching tombstones as purged. Fail-open per audit/history convention:
-- a failing table is reported as a WARNING and skipped, never aborts the run.

CREATE OR REPLACE FUNCTION public.purge_soft_deleted_account_data(
  retention INTERVAL DEFAULT INTERVAL '30 days'
)
RETURNS TABLE(purged_table TEXT, purged_rows BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cutoff TIMESTAMPTZ := now() - retention;
  t TEXT;
  n BIGINT;
  tables TEXT[] := ARRAY[
    'candidate_profiles', 'user_preferences', 'resumes', 'tailored_resumes',
    'saved_jobs', 'applications', 'job_applications', 'search_alerts',
    'daily_digests', 'ai_usage_quotas', 'ai_usage_ledger', 'page_views',
    'user_roles', 'user_consents', 'early_access_emails'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE deleted_at IS NOT NULL AND deleted_at < $1', t)
        USING cutoff;
      GET DIAGNOSTICS n = ROW_COUNT;
      purged_table := t;
      purged_rows := n;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'purge_soft_deleted_account_data: skipping %: %', t, SQLERRM;
    END;
  END LOOP;

  UPDATE public.deleted_account_tombstones
    SET purged_at = now()
    WHERE purged_at IS NULL AND hard_delete_after < now();
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'purge_soft_deleted_account_data: tombstone update failed: %', SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_soft_deleted_account_data(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_soft_deleted_account_data(INTERVAL) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually if this must be undone):
--   DROP FUNCTION IF EXISTS public.purge_soft_deleted_account_data(INTERVAL);
--   DROP TABLE IF EXISTS public.deleted_account_tombstones;
--   ALTER TABLE public.candidate_profiles  DROP COLUMN IF EXISTS deleted_at;
--   ... (repeat DROP COLUMN for each table above; anonymized_at on
--        early_access_emails)
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106i_push_subscriptions.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106i_push_subscriptions.sql
-- Purpose:   Web Push subscription storage (Backend sheet rank 13). Stores
--            browser push subscriptions so a future dispatcher can send
--            web-push notifications. Repo-side scaffolding only: no sender
--            ships until the owner makes the product decision (docs/
--            push-notifications.md).
-- Status:    NOT APPLIED - owner applies in the Supabase SQL editor, then runs
--            node scripts/record-migration.cjs 20261106i_push_subscriptions
-- Covers:    Backend sheet rank 13 (push notifications).
-- Notes:     RLS: users manage only their own subscriptions; the service
--            role bypasses RLS for the future dispatcher. Endpoint is unique
--            per spec (one browser subscription = one endpoint URL).
-- Rollback:  DROP TABLE IF EXISTS public.push_subscriptions;
-- ============================================================================

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);

create index if not exists idx_push_subscriptions_user
  on public.push_subscriptions (user_id)
  where revoked_at is null;

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_owner_select" on public.push_subscriptions;
create policy "push_subscriptions_owner_select"
  on public.push_subscriptions for select
  using (auth.uid() = user_id);

drop policy if exists "push_subscriptions_owner_insert" on public.push_subscriptions;
create policy "push_subscriptions_owner_insert"
  on public.push_subscriptions for insert
  with check (auth.uid() = user_id);

drop policy if exists "push_subscriptions_owner_update" on public.push_subscriptions;
create policy "push_subscriptions_owner_update"
  on public.push_subscriptions for update
  using (auth.uid() = user_id);

drop policy if exists "push_subscriptions_owner_delete" on public.push_subscriptions;
create policy "push_subscriptions_owner_delete"
  on public.push_subscriptions for delete
  using (auth.uid() = user_id);


-- ------------------------------------------------------------------------------
-- Migration: 20261106j_inbound_replies.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106j_inbound_replies.sql
-- Purpose:   Inbound reply storage (Backend sheet rank 14). The sender
--            mailbox (GMAIL_SENDER_EMAIL) had no inbound processing: replies
--            to product mail were invisible. This table stores polled
--            replies for review and downstream handling.
-- Status:    NOT APPLIED - owner applies in the Supabase SQL editor, then runs
--            node scripts/record-migration.cjs 20261106j_inbound_replies
-- Covers:    Backend sheet rank 14 (reply-to / inbound handling).
-- Notes:     RLS enabled with no user-facing policies: only the service role
--            (poller, admin tooling) can read or write. kind is a coarse
--            hint only; bounce/unsubscribe handling proper lives in the
--            dedicated sheet rows (38/39), not here.
-- Rollback:  DROP TABLE IF EXISTS public.inbound_replies;
-- ============================================================================

create table if not exists public.inbound_replies (
  id            uuid primary key default gen_random_uuid(),
  message_id    text not null unique,      -- Gmail message id (dedupe key)
  thread_id     text,
  from_address  text not null,
  subject       text,
  body_excerpt  text,                      -- truncated by the poller
  kind          text not null default 'reply'
                check (kind in ('reply', 'bounce_suspect', 'unsubscribe_suspect')),
  received_at   timestamptz not null,
  processed_at  timestamptz
);

create index if not exists idx_inbound_replies_received
  on public.inbound_replies (received_at desc);

alter table public.inbound_replies enable row level security;


-- ------------------------------------------------------------------------------
-- Migration: 20261106k_autocomplete_pg_trgm.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106k_autocomplete_pg_trgm.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106k_autocomplete_pg_trgm
--
-- Backend row "Autocomplete / Prefix Search": enables pg_trgm and adds a
-- GIN trigram index on public.jobs(title) so prefix suggestions from
-- GET /api/jobs/suggest stay fast as the jobs table grows. The endpoint
-- works without this migration; the index only accelerates it.
--
-- Note: public.jobs is created outside migrations (ingestion pipeline);
-- this only adds an index and an extension, it does not create the table.
-- ============================================================================

-- 1. Trigram extension (same style as pg_stat_statements in 20261105c) ------
create extension if not exists pg_trgm;

-- 2. Trigram GIN index on job titles ----------------------------------------
-- Supports ilike 'prefix%' and similarity() lookups on titles.
create index if not exists jobs_title_trgm_idx
  on public.jobs using gin (title gin_trgm_ops);

-- ============================================================================
-- VERIFY (Supabase SQL editor):
--   select extname from pg_extension where extname = 'pg_trgm';
--   select indexname from pg_indexes where tablename = 'jobs' and indexname = 'jobs_title_trgm_idx';
--
-- ROLLBACK:
--   drop index if exists public.jobs_title_trgm_idx;
--   drop extension if exists pg_trgm;  -- only if nothing else uses it
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106l_job_archival.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106l_job_archival.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106l_job_archival
--
-- Database row #8 (Archival strategy).
--
-- What this does:
--   1. Creates public.jobs_archive: cold storage for expired job listings,
--      same shape as public.jobs (via LIKE ... INCLUDING DEFAULTS INCLUDING
--      CONSTRAINTS, so future jobs columns should be mirrored here when
--      added) plus description_text (denormalized from job_descriptions at
--      archive time) and archived_at. No client access: RLS enabled, anon
--      and authenticated revoked, service_role only.
--   2. Creates public.archive_expired_jobs(dry_run, older_than): moves jobs
--      that have been inactive AND expired for longer than `older_than` out
--      of the hot jobs table into jobs_archive, preserving the description
--      text. dry_run DEFAULTS TO TRUE (reviewer precedent, 20261106a): a
--      bare call only counts. Fail-open per audit/history convention: on
--      error it raises a WARNING and reports zero archived instead of
--      aborting the caller.
--
-- Archival threshold: 90 days inactive (chosen default, not a measured
-- value - jobs older than that have no product value in search results and
-- stay recoverable in jobs_archive). Pass a different `older_than` when
-- calling to override.
--
-- Scheduling: wired into the weekly retention cron runner
-- (scripts/retention-cron.ts, .github/workflows/retention-cron.yml), which
-- skips the archive step with a warning until this migration is applied.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

-- 1. Archive table -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.jobs_archive (
  LIKE public.jobs INCLUDING DEFAULTS INCLUDING CONSTRAINTS
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_archive_pkey'
  ) THEN
    ALTER TABLE public.jobs_archive ADD CONSTRAINT jobs_archive_pkey PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE public.jobs_archive ADD COLUMN IF NOT EXISTS description_text TEXT;
ALTER TABLE public.jobs_archive ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_jobs_archive_archived_at ON public.jobs_archive (archived_at);

ALTER TABLE public.jobs_archive ENABLE ROW LEVEL SECURITY;

-- No client access; only the service role (archival cron, manual review)
-- reads or writes the archive.
REVOKE ALL ON public.jobs_archive FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.jobs_archive TO service_role;

-- 2. Archival function -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.archive_expired_jobs(
  dry_run BOOLEAN DEFAULT TRUE,
  older_than INTERVAL DEFAULT INTERVAL '90 days'
)
RETURNS TABLE(cutoff TIMESTAMPTZ, rows_matched BIGINT, rows_archived BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := now() - older_than;
  n_matched BIGINT;
  n_archived BIGINT := 0;
BEGIN
  SELECT count(*) INTO n_matched
  FROM public.jobs j
  WHERE j.is_active = false
    AND j.status = 'expired'
    AND j.last_seen_at < v_cutoff;

  IF NOT dry_run AND n_matched > 0 THEN
    WITH moved AS (
      DELETE FROM public.jobs j
      WHERE j.is_active = false
        AND j.status = 'expired'
        AND j.last_seen_at < v_cutoff
      RETURNING j.*
    )
    INSERT INTO public.jobs_archive
    SELECT m.*, jd.description_text, now()
    FROM moved m
    LEFT JOIN public.job_descriptions jd ON jd.job_id = m.id;
    GET DIAGNOSTICS n_archived = ROW_COUNT;
  END IF;

  cutoff := v_cutoff;
  rows_matched := n_matched;
  rows_archived := n_archived;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'archive_expired_jobs failed: %', SQLERRM;
  cutoff := v_cutoff;
  rows_matched := 0;
  rows_archived := 0;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_expired_jobs(BOOLEAN, INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_expired_jobs(BOOLEAN, INTERVAL) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.archive_expired_jobs(BOOLEAN, INTERVAL);
--   -- Optionally restore archived rows back into the hot table first:
--   -- INSERT INTO public.jobs SELECT <jobs columns> FROM public.jobs_archive
--   --   ON CONFLICT (id) DO NOTHING;
--   DROP TABLE IF EXISTS public.jobs_archive;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106m_reindex_maintenance.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106m_reindex_maintenance.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106m_reindex_maintenance
--
-- Database row #11 (REINDEX maintenance).
--
-- What this does:
--   Creates public.reindex_bloated_indexes(min_size_mb, dry_run): lists
--   public-schema indexes whose on-disk size exceeds min_size_mb and, when
--   dry_run is false, rebuilds them one by one with REINDEX INDEX. Index
--   bloat otherwise accumulates silently - autovacuum does not rebuild
--   indexes (Database row #11 evidence: "No reindex schedule").
--
-- Why plain REINDEX, not CONCURRENTLY: REINDEX (CONCURRENTLY) cannot run
--   inside a function's transaction block. Plain REINDEX INDEX takes a
--   short write lock on one index at a time; the weekly caller (retention
--   cron, Sunday 19:30 UTC = 01:00 IST Monday) runs off-peak and only
--   indexes above the size threshold are touched, so the lock window is
--   small. A failing index does not abort the run: its row is reported
--   with action 'failed' and the loop continues.
--
-- Size threshold: 50 MB (chosen default, not a measured value - small
--   indexes reindex in milliseconds and are not worth the lock; tune by
--   passing a different min_size_mb). dry_run DEFAULTS TO TRUE (reviewer
--   precedent, 20261106a): a bare call only reports candidates.
--
-- Scheduling: wired into the weekly retention cron runner
-- (scripts/retention-cron.ts, .github/workflows/retention-cron.yml), which
-- skips the reindex step with a warning until this migration is applied.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reindex_bloated_indexes(
  min_size_mb INTEGER DEFAULT 50,
  dry_run BOOLEAN DEFAULT TRUE
)
RETURNS TABLE(
  schema_name NAME,
  table_name NAME,
  index_name NAME,
  size_bytes BIGINT,
  size_pretty TEXT,
  action TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name,
           t.relname AS table_name,
           i.relname AS index_name,
           pg_relation_size(i.oid) AS size_bytes,
           pg_size_pretty(pg_relation_size(i.oid)) AS size_pretty
    FROM pg_class i
    JOIN pg_index x ON x.indexrelid = i.oid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    WHERE i.relkind = 'i'
      AND n.nspname = 'public'
      AND t.relkind IN ('r', 'm')
      AND pg_relation_size(i.oid) >= min_size_mb * 1024 * 1024
    ORDER BY pg_relation_size(i.oid) DESC
  LOOP
    schema_name := r.schema_name;
    table_name := r.table_name;
    index_name := r.index_name;
    size_bytes := r.size_bytes;
    size_pretty := r.size_pretty;
    IF dry_run THEN
      action := 'would_reindex';
    ELSE
      BEGIN
        EXECUTE format('REINDEX INDEX %I.%I', r.schema_name, r.index_name);
        action := 'reindexed';
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'REINDEX %.% failed: %', r.schema_name, r.index_name, SQLERRM;
        action := 'failed';
      END;
    END IF;
    RETURN NEXT;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'reindex_bloated_indexes failed: %', SQLERRM;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.reindex_bloated_indexes(INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reindex_bloated_indexes(INTEGER, BOOLEAN) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.reindex_bloated_indexes(INTEGER, BOOLEAN);
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106n_covering_index_jobs_list.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106n_covering_index_jobs_list.sql
-- STATUS: NOT APPLIED - apply this standalone statement in autocommit mode,
-- outside BEGIN/COMMIT, DO blocks, functions or transactional migration runners.
-- Review docs/concurrent-covering-index.md before applying, then record:
--   node scripts/record-migration.cjs 20261106n_covering_index_jobs_list
--
-- Database row #12 (Covering indexes (INCLUDE)).
--
-- What this does:
--   Creates jobs_active_list_covering_idx: a partial covering btree for the
--   hottest read in the product, the public jobs list
--   (src/lib/api/jobs.ts CARD_FIELDS over jobs / jobs_public, keyset
--   pagination ORDER BY first_seen_at DESC, id DESC, filter status =
--   'active'). Every selected column is a key column, the predicate column,
--   or an INCLUDE column, so the list page can be served as an index-only
--   scan instead of fetching each row from the heap.
--
-- Why the predicate is status = 'active' and not (is_active, status):
--   the jobs_public view (20261010_lock_paid_jobs_data.sql) filters
--   is_active = true OR status = 'active', so only status = 'active' is
--   implied by every list query. A tighter predicate would make the index
--   unusable for the view path. The predicate is immutable, matching the
--   20261001_filter_upgrades.sql convention.
--
-- Why is_active is an INCLUDE column: the jobs_public view filters
--   is_active = true OR status = 'active'; every column the view's WHERE
--   references must be readable from the index for an index-only scan.
--
-- Why the key order: the app keyset-paginates on (first_seen_at, id)
--   descending (src/lib/api/jobs.ts). The existing partial index
--   jobs_active_discovered_idx is on (discovered_at, id), which cannot
--   serve this ordering.
--
-- Build cost: CONCURRENTLY avoids the plain CREATE INDEX write-blocking lock,
-- but needs two scans and can wait for existing transactions. It is not lock-free.
-- This file contains one executable statement. Do not combine it with other
-- migrations in one SQL-editor batch, or use psql --single-transaction/-1.
-- A cancelled/failed concurrent build can leave an INVALID index under this name.
-- IF NOT EXISTS does not repair that state: inspect pg_index.indisvalid first,
-- then explicitly DROP INDEX CONCURRENTLY and retry as separate statements.
-- Schema shape and actual index definition must be checked before recording.
-- References: https://www.postgresql.org/docs/current/sql-createindex.html
--             https://www.postgresql.org/docs/current/app-psql.html
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_active_list_covering_idx
  ON public.jobs (first_seen_at DESC, id DESC)
  INCLUDE (
    is_active,
    title,
    company,
    location,
    remote,
    remote_scope,
    job_type,
    salary_text,
    last_seen_at,
    posted_at,
    category,
    country,
    country_code,
    apply_url
  )
  WHERE status = 'active';

-- ============================================================================
-- ROLLBACK (run manually as one autocommit statement, never in a transaction):
--   DROP INDEX CONCURRENTLY IF EXISTS public.jobs_active_list_covering_idx;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106o_not_valid_validate_pattern.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106o_not_valid_validate_pattern.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106o_not_valid_validate_pattern
--
-- Database row #13 (NOT VALID then VALIDATE).
--
-- Why: every CHECK on public.jobs so far was added inline
-- (20261001_ingestion_pipeline.sql, 20261001_filter_upgrades.sql): the
-- ALTER TABLE scans and validates the whole table while holding an
-- ACCESS EXCLUSIVE lock, which blocks writes on a big live table. The
-- two-phase pattern avoids that:
--
--   Phase 1 - ADD CONSTRAINT ... NOT VALID: no table scan; the lock is
--     held only long enough to register the constraint. New and updated
--     rows are enforced immediately; existing rows are trusted as-is.
--   Phase 2 - VALIDATE CONSTRAINT (run separately, off-peak): scans
--     existing rows under a SHARE UPDATE EXCLUSIVE lock, which does NOT
--     block ordinary reads, inserts, updates, or deletes.
--
-- Concrete constraint shipped here: jobs_salary_bounds_check
--   CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
-- No existing migration bounds salary_min vs salary_max (only enum-style
-- checks exist on jobs). Bad ranges break salary filters and sorts.
--
-- HOW TO APPLY (two separate SQL editor runs):
--   Run A (now): execute Phase 1 below. Then run the audit query from
--     scripts/db-health.sql section 16 (count of violating rows).
--   Run B (off-peak, once the audit is clean or remediated): uncomment and
--     execute Phase 2. If VALIDATE fails, the constraint stays NOT VALID -
--     writes keep working; remediate the rows the audit query lists, then
--     rerun Phase 2. Until Phase 2 runs, pg_constraint.convalidated stays
--     false for this constraint (visible in db-health section 16).
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

-- Phase 1: register the constraint without scanning the table -------------
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_salary_bounds_check
  CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
  NOT VALID;

-- Phase 2: validate existing rows off-peak (uncomment for Run B) ----------
-- ALTER TABLE public.jobs VALIDATE CONSTRAINT jobs_salary_bounds_check;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_salary_bounds_check;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106p_security_definer_search_path.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106p_security_definer_search_path.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106p_security_definer_search_path
--
-- Database row #60 (SECURITY DEFINER search_path pinning).
--
-- Why: a SECURITY DEFINER function runs with its owner's privileges; an
-- unpinned search_path lets a caller shadow unqualified names (tables,
-- operators, functions) with objects in schemas earlier on the path - the
-- classic search_path hijack. Sheet evidence: "Only the 2 matview functions
-- SET search_path; payment/AI RPCs unpinned." Audit of all migrations
-- confirms 14 unpinned definitions across 10 function names:
--   fulfil_payment_order   (20261103c/g, superseded by 20261104b)
--   consume_addon_set      (20261103b, superseded by 20261103d/h)
--   consume_plan_set       (20261103d, superseded by 20261103h)
--   consume_user_set       (20261103d, superseded by 20261103h)
--   refund_plan_or_addon_set (20261103d, superseded by 20261103h)
--   record_plan_usage_result (20261103h)
--   ai_global_budget_reserve / ai_global_budget_settle (20261104a)
--   ai_concurrency_acquire / ai_concurrency_release (20261104a)
-- CREATE OR REPLACE with different argument types creates overloads, so
-- both the old and new signatures may exist live. The DO block below pins
-- EVERY public-schema SECURITY DEFINER function, whatever its signature,
-- so no overload is missed; already-pinned functions get the same setting
-- reapplied (idempotent).
--
-- Value pinned: search_path = public - the same setting the already-pinned
-- house functions use (20261020 rate_limits, 20261101 matviews, 20261106
-- series). No function body changes; semantics unchanged because every
-- affected function only references public-schema objects.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN
    SELECT p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
  LOOP
    EXECUTE format(
      'ALTER FUNCTION public.%I(%s) SET search_path = public',
      f.proname, f.args
    );
  END LOOP;
END;
$$;

-- Verify afterwards (scripts/db-health.sql section 17 runs the same check):
--   SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prosecdef
--     AND (p.proconfig IS NULL OR NOT p.proconfig::text LIKE '%search_path%');
-- Expected: zero rows.

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DO $$
--   DECLARE f RECORD;
--   BEGIN
--     FOR f IN
--       SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
--       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public' AND p.prosecdef
--         AND p.proname IN ('fulfil_payment_order','consume_addon_set',
--           'consume_plan_set','consume_user_set','refund_plan_or_addon_set',
--           'record_plan_usage_result','ai_global_budget_reserve',
--           'ai_global_budget_settle','ai_concurrency_acquire',
--           'ai_concurrency_release')
--     LOOP
--       EXECUTE format('ALTER FUNCTION public.%I(%s) RESET search_path',
--         f.proname, f.args);
--     END LOOP;
--   END $$;
-- (Only the previously-unpinned functions are reset; the house-pinned ones
--  keep their setting.)
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106q_analyze_after_ingest.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106q_analyze_after_ingest.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106q_analyze_after_ingest
--
-- Database row #73 (ANALYZE after bulk load).
--
-- Why: ingestion (scripts/ingest.ts, .github/workflows/ingest.yml) bulk
-- upserts jobs / job_descriptions / companies, but statistics refresh is
-- left to autovacuum (sheet evidence: "Relies on autovacuum; no manual
-- ANALYZE in ingestion scripts"). Stale stats right after a big load are
-- when bad plans appear (wrong join order on the freshly-rewritten hot
-- table). Plain ANALYZE is legal inside a function (only VACUUM is barred
-- from transaction blocks) and takes only a SHARE UPDATE EXCLUSIVE lock,
-- so reads and writes continue.
--
-- What this does:
--   public.analyze_after_ingest(): runs ANALYZE on the three tables the
--   ingestion pipeline rewrites. SECURITY DEFINER with pinned search_path
--   (house rule since 20261106p); service_role only. Fail-open per
--   audit/history convention: on error it raises a WARNING instead of
--   aborting the caller - a stats refresh must never fail an ingest run.
--
-- Caller: scripts/ingest.ts calls it once at the end of a live run
-- (skipped on --dry), and skips cleanly with a warning until this
-- migration is applied.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.analyze_after_ingest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  ANALYZE public.jobs;
  ANALYZE public.job_descriptions;
  ANALYZE public.companies;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'analyze_after_ingest failed: %', SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.analyze_after_ingest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analyze_after_ingest() TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.analyze_after_ingest();
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261106s_resume_bucket_limits.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261106s_resume_bucket_limits.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106s_resume_bucket_limits
--
-- Backend row #70 (Upload Type & Size Validation), storage-side boundary.
--
-- Why: the code contract (src/lib/resume/parser.ts) allows up to 10 MB
-- (MAX_RESUME_UPLOAD_BYTES = 10 * 1024 * 1024) and extensions
-- pdf/docx/txt/md, but the bucket row created in
-- 20261031_account_delete_and_private_resumes.sql still says 5 MB and a
-- mime list without text/markdown. Files between 5-10 MB and .md uploads
-- pass code validation and then fail at the storage boundary with an
-- inconsistent error, and the storage layer is the last line of defense
-- when a caller bypasses the app entirely. Aligning the bucket with the
-- code contract makes the boundary real and consistent.
--
-- What this does:
--   1. Aligns storage.buckets for `resumes` with the code contract:
--      file_size_limit = 10485760 (10 MB, == MAX_RESUME_UPLOAD_BYTES) and
--      allowed_mime_types = pdf / docx (OOXML) / plain / markdown. The
--      legacy 'application/msword' (.doc) entry is dropped because the
--      code contract rejects .doc uploads.
--   2. Re-asserts the owner-path INSERT policy on storage.objects
--      (uploads only into <auth.uid()>/<filename>) so this migration is
--      self-contained even if the 20261031 policies were drifted.
--
-- ROLLBACK (re-apply the 20261031 bucket values):
--   UPDATE storage.buckets
--     SET file_size_limit = 5242880,
--         allowed_mime_types = ARRAY[
--           'application/pdf',
--           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
--           'application/msword',
--           'text/plain'
--         ]
--     WHERE id = 'resumes';
-- ============================================================================

UPDATE storage.buckets
  SET file_size_limit = 10485760,
      allowed_mime_types = ARRAY[
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
        'text/markdown'
      ]
  WHERE id = 'resumes';

DROP POLICY IF EXISTS "Owner can insert own resume files" ON storage.objects;
CREATE POLICY "Owner can insert own resume files"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );


-- ------------------------------------------------------------------------------
-- Migration: 20261107a_jobs_role_dedupe.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261107a_jobs_role_dedupe.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107a_jobs_role_dedupe
--
-- Backend sheet rank 98 (Dedup of ingested jobs): "Ingestion dedupe exists;
-- cross-board duplicates still possible."
--
-- Why: the unique constraints on jobs (source + source_job_id, apply_url) only
-- stop exact repeats. The same role (company + title + location) published by
-- two sources has different source ids and different apply URLs, so both rows
-- stay active. scripts/board-ingest.ts already skips such roles in application
-- code; there is no DB-side view or cleanup for rows that got in through other
-- paths or before that check existed.
--
-- What this does (additive; nothing is deleted, nothing changes until run):
--   1. public.jobs_slug(text) and public.jobs_role_key(company, title,
--      location): IMMUTABLE SQL mirrors of scripts/utils/sanitizer.ts slugify
--      and the board-ingest roleKey (company::title::location, empty location
--      = 'unspecified'). ASCII word characters only, like the JS regex.
--   2. jobs_role_key_active_idx: plain (non-unique) expression index over
--      active rows so duplicate lookups do not scan the table. Plain CREATE
--      INDEX takes a short write lock on jobs; run in a quiet window, or run
--      the CONCURRENTLY form from the comment (cannot be inside a transaction).
--   3. public.jobs_duplicate_roles: read-only view listing active role keys
--      with more than one row (service_role only).
--   4. public.dedupe_jobs_by_role(p_apply boolean DEFAULT false): picks one
--      keeper per active role key (verified first, then earliest first_seen_at,
--      then id) and reports the rest. Default is a DRY RUN that only returns
--      the plan. With p_apply = true it sets the non-keepers to
--      is_active = false, status = 'expired' (a value the status CHECK allows).
--      It never deletes rows. SECURITY DEFINER, pinned search_path,
--      service_role only.
--
-- Not enforced as a UNIQUE index on purpose: existing duplicates would make it
-- fail, and a hard constraint would reject legitimate same-title roles in one
-- city. Prevention stays in the ingest code (scripts/ingest.ts cross-source
-- check + board-ingest roleKey); this migration is the DB-side audit and
-- cleanup path.
--
-- Caveat (owner to confirm): a later ingest upsert for a deactivated row's
-- (source, source_job_id) sets it active again; the ingest-side check is what
-- keeps it from coming back as a duplicate.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.jobs_slug(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(lower(coalesce(p_text, '')), '[^a-zA-Z0-9_[:space:]-]', '', 'g'),
      '[[:space:]_-]+', '-', 'g'
    ),
    '-'
  );
$$;

CREATE OR REPLACE FUNCTION public.jobs_role_key(p_company text, p_title text, p_location text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT public.jobs_slug(p_company) || '::' || public.jobs_slug(p_title) || '::'
         || public.jobs_slug(coalesce(nullif(p_location, ''), 'unspecified'));
$$;

CREATE INDEX IF NOT EXISTS jobs_role_key_active_idx
  ON public.jobs (public.jobs_role_key(company, title, location))
  WHERE is_active IS TRUE;
-- CONCURRENTLY form (run alone, outside a transaction, if write locks matter):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_role_key_active_idx
--     ON public.jobs (public.jobs_role_key(company, title, location))
--     WHERE is_active IS TRUE;

CREATE OR REPLACE VIEW public.jobs_duplicate_roles
WITH (security_invoker = true) AS
SELECT
  public.jobs_role_key(company, title, location) AS role_key,
  count(*)                                       AS active_rows,
  array_agg(id ORDER BY first_seen_at NULLS LAST, id) AS job_ids,
  array_agg(DISTINCT source)                     AS sources
FROM public.jobs
WHERE is_active IS TRUE
GROUP BY public.jobs_role_key(company, title, location)
HAVING count(*) > 1;

REVOKE ALL ON public.jobs_duplicate_roles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.jobs_duplicate_roles TO service_role;

CREATE OR REPLACE FUNCTION public.dedupe_jobs_by_role(p_apply boolean DEFAULT false)
RETURNS TABLE (role_key text, kept_id uuid, duplicate_id uuid, applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_apply IS TRUE THEN
    RETURN QUERY
    WITH ranked AS (
      SELECT j.id,
             public.jobs_role_key(j.company, j.title, j.location) AS rk,
             row_number() OVER (
               PARTITION BY public.jobs_role_key(j.company, j.title, j.location)
               ORDER BY coalesce(j.verified, false) DESC, j.first_seen_at ASC NULLS LAST, j.id
             ) AS rn
      FROM public.jobs j
      WHERE j.is_active IS TRUE
    ),
    keepers AS (SELECT r.rk, r.id FROM ranked r WHERE r.rn = 1),
    upd AS (
      UPDATE public.jobs jb
         SET is_active = false, status = 'expired'
        FROM ranked r
       WHERE jb.id = r.id AND r.rn > 1
      RETURNING jb.id AS dup_id, r.rk AS dup_rk
    )
    SELECT upd.dup_rk, k.id, upd.dup_id, true
      FROM upd JOIN keepers k ON k.rk = upd.dup_rk;
  ELSE
    RETURN QUERY
    WITH ranked AS (
      SELECT j.id,
             public.jobs_role_key(j.company, j.title, j.location) AS rk,
             row_number() OVER (
               PARTITION BY public.jobs_role_key(j.company, j.title, j.location)
               ORDER BY coalesce(j.verified, false) DESC, j.first_seen_at ASC NULLS LAST, j.id
             ) AS rn
      FROM public.jobs j
      WHERE j.is_active IS TRUE
    )
    SELECT d.rk, k.id, d.id, false
      FROM ranked d JOIN ranked k ON k.rk = d.rk AND k.rn = 1
     WHERE d.rn > 1;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.dedupe_jobs_by_role(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dedupe_jobs_by_role(boolean) TO service_role;

-- ============================================================================
-- Usage (SQL editor, as service role / postgres):
--   SELECT * FROM public.jobs_duplicate_roles;                 -- read-only audit
--   SELECT * FROM public.dedupe_jobs_by_role();                -- dry run, changes nothing
--   SELECT * FROM public.dedupe_jobs_by_role(true);            -- deactivates non-keepers
--
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.dedupe_jobs_by_role(boolean);
--   DROP VIEW IF EXISTS public.jobs_duplicate_roles;
--   DROP INDEX IF EXISTS public.jobs_role_key_active_idx;
--   DROP FUNCTION IF EXISTS public.jobs_role_key(text, text, text);
--   DROP FUNCTION IF EXISTS public.jobs_slug(text);
--   -- Rows deactivated by dedupe_jobs_by_role(true) are not restored by the
--   -- rollback; re-activate from the dry-run output you saved if needed.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261107b_search_alert_dispatches.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261107b_search_alert_dispatches.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107b_search_alert_dispatches
--
-- Backend sheet rank 83 (Search Alerts): "search_alerts table exists; alert
-- dispatch not verified." This adds the sent-log the dispatcher
-- (src/lib/alerts/searchAlertDispatcher.ts) uses to send each (alert, job) pair
-- at most once. It does not touch public.search_alerts.
--
-- No foreign keys on purpose: the search_alerts DDL is not in this repo (owner
-- to confirm its key type), and a log row must not block deleting an alert or a
-- job. Rows are claimed with INSERT ... ON CONFLICT DO NOTHING and released on
-- send failure.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.search_alert_dispatches (
  alert_id   UUID        NOT NULL,
  job_id     UUID        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, job_id)
);

CREATE INDEX IF NOT EXISTS search_alert_dispatches_created_at_idx
  ON public.search_alert_dispatches (created_at);

ALTER TABLE public.search_alert_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.search_alert_dispatches FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.search_alert_dispatches TO service_role;

-- ============================================================================
-- ROLLBACK (run manually if this must be undone):
--   DROP INDEX IF EXISTS public.search_alert_dispatches_created_at_idx;
--   DROP TABLE IF EXISTS public.search_alert_dispatches;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261107c_outbox_queue.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261107c_outbox_queue.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107c_outbox_queue
--
-- Database rows: "SKIP LOCKED work queue" (MISSING: "No queue table yet; digest
-- queue uses status columns") and "Queue / outbox table" (PARTIAL: failed_events
-- covers retries, "no generic outbox dispatcher").
--
-- What this adds (additive; nothing enqueues or claims anything until a caller
-- is wired, which is a later, separate change):
--   public.outbox: generic at-least-once work queue. Statuses: pending,
--     processing, done, dead. A row is claimed with FOR UPDATE SKIP LOCKED, so
--     parallel workers never take the same row. A claim is a lease
--     (locked_until); a crashed worker's row becomes claimable again once the
--     lease expires.
--   outbox_enqueue / outbox_claim_batch / outbox_ack / outbox_fail:
--     SECURITY DEFINER with pinned search_path (house rule), REVOKEd from
--     PUBLIC/anon/authenticated, EXECUTE for service_role only.
--
-- No numbers are baked in: max attempts, lease seconds and retry delay are
-- required arguments with no defaults (owner to confirm values per topic).
-- Delivery is at-least-once: consumers must be idempotent (enqueue accepts a
-- dedupe_key to make producers idempotent).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.outbox (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  topic        TEXT        NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 100),
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempts     INTEGER     NOT NULL DEFAULT 0,
  max_attempts INTEGER     NOT NULL CHECK (max_attempts > 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  locked_by    TEXT,
  last_error   TEXT,
  dedupe_key   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedupe_key_uidx
  ON public.outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbox_claim_idx
  ON public.outbox (topic, available_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.outbox TO service_role;

CREATE OR REPLACE FUNCTION public.outbox_enqueue(
  p_topic        TEXT,
  p_payload      JSONB,
  p_max_attempts INTEGER,
  p_dedupe_key   TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_max_attempts IS NULL OR p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'outbox_enqueue: p_max_attempts must be > 0';
  END IF;
  INSERT INTO public.outbox (topic, payload, max_attempts, dedupe_key)
  VALUES (p_topic, COALESCE(p_payload, '{}'::jsonb), p_max_attempts, p_dedupe_key)
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL AND p_dedupe_key IS NOT NULL THEN
    SELECT id INTO v_id FROM public.outbox WHERE dedupe_key = p_dedupe_key;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.outbox_claim_batch(
  p_topic         TEXT,
  p_limit         INTEGER,
  p_lease_seconds INTEGER,
  p_worker        TEXT
)
RETURNS SETOF public.outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'outbox_claim_batch: p_limit must be > 0';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 THEN
    RAISE EXCEPTION 'outbox_claim_batch: p_lease_seconds must be > 0';
  END IF;
  IF p_worker IS NULL OR char_length(p_worker) = 0 THEN
    RAISE EXCEPTION 'outbox_claim_batch: p_worker is required';
  END IF;

  -- A lease that expired with no attempts left is finished: park it as dead.
  UPDATE public.outbox
     SET status = 'dead', locked_until = NULL, locked_by = NULL,
         last_error = COALESCE(last_error, 'lease expired after final attempt'),
         updated_at = now()
   WHERE topic = p_topic
     AND status = 'processing'
     AND locked_until < now()
     AND attempts >= max_attempts;

  RETURN QUERY
  WITH picked AS (
    SELECT o.id
      FROM public.outbox o
     WHERE o.topic = p_topic
       AND o.attempts < o.max_attempts
       AND ((o.status = 'pending' AND o.available_at <= now())
         OR (o.status = 'processing' AND o.locked_until < now()))
     ORDER BY o.available_at, o.created_at
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox o
     SET status = 'processing',
         attempts = o.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         locked_by = p_worker,
         updated_at = now()
    FROM picked
   WHERE o.id = picked.id
  RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.outbox_ack(p_id UUID, p_worker TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  UPDATE public.outbox
     SET status = 'done', locked_until = NULL, locked_by = NULL, updated_at = now()
   WHERE id = p_id AND status = 'processing' AND locked_by = p_worker;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- Returns 'retry', 'dead', or NULL when the row is not leased to p_worker.
CREATE OR REPLACE FUNCTION public.outbox_fail(
  p_id                  UUID,
  p_worker              TEXT,
  p_error               TEXT,
  p_retry_delay_seconds INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.outbox%ROWTYPE;
BEGIN
  IF p_retry_delay_seconds IS NULL OR p_retry_delay_seconds < 0 THEN
    RAISE EXCEPTION 'outbox_fail: p_retry_delay_seconds must be >= 0';
  END IF;
  SELECT * INTO v_row FROM public.outbox
   WHERE id = p_id AND status = 'processing' AND locked_by = p_worker
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_row.attempts >= v_row.max_attempts THEN
    UPDATE public.outbox
       SET status = 'dead', locked_until = NULL, locked_by = NULL,
           last_error = left(p_error, 2000), updated_at = now()
     WHERE id = p_id;
    RETURN 'dead';
  END IF;
  UPDATE public.outbox
     SET status = 'pending', locked_until = NULL, locked_by = NULL,
         available_at = now() + make_interval(secs => p_retry_delay_seconds),
         last_error = left(p_error, 2000), updated_at = now()
   WHERE id = p_id;
  RETURN 'retry';
END;
$$;

REVOKE ALL ON FUNCTION public.outbox_enqueue(TEXT, JSONB, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_claim_batch(TEXT, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_ack(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_fail(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbox_enqueue(TEXT, JSONB, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_claim_batch(TEXT, INTEGER, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_ack(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_fail(UUID, TEXT, TEXT, INTEGER) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.outbox_fail(UUID, TEXT, TEXT, INTEGER);
--   DROP FUNCTION IF EXISTS public.outbox_ack(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.outbox_claim_batch(TEXT, INTEGER, INTEGER, TEXT);
--   DROP FUNCTION IF EXISTS public.outbox_enqueue(TEXT, JSONB, INTEGER, TEXT);
--   DROP INDEX IF EXISTS public.outbox_claim_idx;
--   DROP INDEX IF EXISTS public.outbox_dedupe_key_uidx;
--   DROP TABLE IF EXISTS public.outbox;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261107d_row_version_optimistic_lock.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261107d_row_version_optimistic_lock.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107d_row_version_optimistic_lock
--
-- Database row "Optimistic Locking (version column)" (MISSING).
--
-- Tables (owner to confirm the list; user-edited, non-billing only):
--   user_preferences, resumes, applications, candidate_profiles.
--   No payments, subscriptions or entitlement tables.
--
-- What this changes once applied:
--   1. Each table gets row_version INTEGER NOT NULL DEFAULT 1 (constant default,
--      no table rewrite on current Postgres; existing rows read 1).
--   2. A BEFORE UPDATE trigger sets NEW.row_version = OLD.row_version + 1 on
--      every UPDATE, whatever the caller sends. Existing writers are unaffected:
--      they still win (last write wins) exactly as today. Only the counter moves.
--   3. Nothing rejects a write in SQL. A stale update is detected by the caller
--      adding "AND row_version = <the version it read>" to its UPDATE
--      (src/lib/db/optimisticLock.ts does this): zero rows matched = stale.
--
-- Interactions to know: the change-history trigger on user_preferences
-- (20261106c) will record row_version in its old/new images; the new column
-- appears in select("*") reads of these four tables (select-star guard tracks
-- sites, not columns).
-- ============================================================================

ALTER TABLE public.user_preferences  ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.resumes           ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.applications      ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.bump_row_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $func$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$func$;

REVOKE ALL ON FUNCTION public.bump_row_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_row_version() TO service_role;

DROP TRIGGER IF EXISTS trg_row_version_user_preferences ON public.user_preferences;
create trigger trg_row_version_user_preferences
  before update on public.user_preferences
  for each row execute function public.bump_row_version();

DROP TRIGGER IF EXISTS trg_row_version_resumes ON public.resumes;
create trigger trg_row_version_resumes
  before update on public.resumes
  for each row execute function public.bump_row_version();

DROP TRIGGER IF EXISTS trg_row_version_applications ON public.applications;
create trigger trg_row_version_applications
  before update on public.applications
  for each row execute function public.bump_row_version();

DROP TRIGGER IF EXISTS trg_row_version_candidate_profiles ON public.candidate_profiles;
create trigger trg_row_version_candidate_profiles
  before update on public.candidate_profiles
  for each row execute function public.bump_row_version();

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP TRIGGER IF EXISTS trg_row_version_candidate_profiles ON public.candidate_profiles;
--   DROP TRIGGER IF EXISTS trg_row_version_applications ON public.applications;
--   DROP TRIGGER IF EXISTS trg_row_version_resumes ON public.resumes;
--   DROP TRIGGER IF EXISTS trg_row_version_user_preferences ON public.user_preferences;
--   DROP FUNCTION IF EXISTS public.bump_row_version();
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS row_version;
--   ALTER TABLE public.applications DROP COLUMN IF EXISTS row_version;
--   ALTER TABLE public.resumes DROP COLUMN IF EXISTS row_version;
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS row_version;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261107e_outbox_fencing.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261107e_outbox_fencing.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor AFTER
-- 20261107c_outbox_queue.sql, then record:
--   node scripts/record-migration.cjs 20261107e_outbox_fencing
--
-- Follow-up to 20261107c, closing two gaps named in the Database sheet row
-- "Queue / outbox table":
--   1. "ack/fail identify worker string only (no per-claim fencing token), so
--      reused worker IDs can allow stale completion after reclaim." Every claim
--      increments outbox.attempts. outbox_ack and outbox_fail now also require
--      p_attempt = the row's current attempts, so a completion from an older
--      claim of the same row is refused even when the worker id is reused.
--   2. "Expired-final-attempt cleanup is ordinary UPDATE before SKIP LOCKED
--      selection and can block." The cleanup now selects its rows FOR UPDATE
--      SKIP LOCKED first, so it never waits on a row another worker holds.
--
-- Signature change: outbox_ack(uuid, text) and outbox_fail(uuid, text, text,
-- integer) are DROPPED and replaced. Nothing in the repo calls them besides
-- src/lib/queue/outbox.ts, updated in the same PR. Apply c and e together.
-- ============================================================================

DROP FUNCTION IF EXISTS public.outbox_ack(UUID, TEXT);
DROP FUNCTION IF EXISTS public.outbox_fail(UUID, TEXT, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.outbox_claim_batch(
  p_topic         TEXT,
  p_limit         INTEGER,
  p_lease_seconds INTEGER,
  p_worker        TEXT
)
RETURNS SETOF public.outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'outbox_claim_batch: p_limit must be > 0';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 THEN
    RAISE EXCEPTION 'outbox_claim_batch: p_lease_seconds must be > 0';
  END IF;
  IF p_worker IS NULL OR char_length(p_worker) = 0 THEN
    RAISE EXCEPTION 'outbox_claim_batch: p_worker is required';
  END IF;

  -- A lease that expired with no attempts left is finished: park it as dead.
  -- Rows locked by another transaction are skipped, never waited on.
  WITH expired AS (
    SELECT o.id
      FROM public.outbox o
     WHERE o.topic = p_topic
       AND o.status = 'processing'
       AND o.locked_until < now()
       AND o.attempts >= o.max_attempts
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox o
     SET status = 'dead', locked_until = NULL, locked_by = NULL,
         last_error = COALESCE(o.last_error, 'lease expired after final attempt'),
         updated_at = now()
    FROM expired
   WHERE o.id = expired.id;

  RETURN QUERY
  WITH picked AS (
    SELECT o.id
      FROM public.outbox o
     WHERE o.topic = p_topic
       AND o.attempts < o.max_attempts
       AND ((o.status = 'pending' AND o.available_at <= now())
         OR (o.status = 'processing' AND o.locked_until < now()))
     ORDER BY o.available_at, o.created_at
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox o
     SET status = 'processing',
         attempts = o.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         locked_by = p_worker,
         updated_at = now()
    FROM picked
   WHERE o.id = picked.id
  RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.outbox_ack(p_id UUID, p_worker TEXT, p_attempt INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  UPDATE public.outbox
     SET status = 'done', locked_until = NULL, locked_by = NULL, updated_at = now()
   WHERE id = p_id AND status = 'processing' AND locked_by = p_worker AND attempts = p_attempt;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- Returns 'retry', 'dead', or NULL when the row is not leased to this worker and attempt.
CREATE OR REPLACE FUNCTION public.outbox_fail(
  p_id                  UUID,
  p_worker              TEXT,
  p_attempt             INTEGER,
  p_error               TEXT,
  p_retry_delay_seconds INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.outbox%ROWTYPE;
BEGIN
  IF p_retry_delay_seconds IS NULL OR p_retry_delay_seconds < 0 THEN
    RAISE EXCEPTION 'outbox_fail: p_retry_delay_seconds must be >= 0';
  END IF;
  SELECT * INTO v_row FROM public.outbox
   WHERE id = p_id AND status = 'processing' AND locked_by = p_worker AND attempts = p_attempt
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_row.attempts >= v_row.max_attempts THEN
    UPDATE public.outbox
       SET status = 'dead', locked_until = NULL, locked_by = NULL,
           last_error = left(p_error, 2000), updated_at = now()
     WHERE id = p_id;
    RETURN 'dead';
  END IF;
  UPDATE public.outbox
     SET status = 'pending', locked_until = NULL, locked_by = NULL,
         available_at = now() + make_interval(secs => p_retry_delay_seconds),
         last_error = left(p_error, 2000), updated_at = now()
   WHERE id = p_id;
  RETURN 'retry';
END;
$$;

REVOKE ALL ON FUNCTION public.outbox_claim_batch(TEXT, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_ack(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_fail(UUID, TEXT, INTEGER, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbox_claim_batch(TEXT, INTEGER, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_ack(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_fail(UUID, TEXT, INTEGER, TEXT, INTEGER) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.outbox_fail(UUID, TEXT, INTEGER, TEXT, INTEGER);
--   DROP FUNCTION IF EXISTS public.outbox_ack(UUID, TEXT, INTEGER);
--   then re-run the outbox_claim_batch, outbox_ack(uuid, text) and
--   outbox_fail(uuid, text, text, integer) definitions and their REVOKE/GRANT
--   lines from 20261107c_outbox_queue.sql.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261107f_search_alert_send_windows.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261107f_search_alert_send_windows.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107f_search_alert_send_windows
--
-- Follow-up to 20261107b, closing gaps the Backend sheet names on row "Search
-- Alerts": parallel runs may send different jobs in the same interval, and a
-- markSent failure weakens the throttle. This adds a per-alert send window that
-- is claimed atomically BEFORE sending (src/lib/alerts/searchAlertDispatcher.ts,
-- claimWindowInDb / releaseWindowInDb).
--
-- claim_search_alert_window returns the claim timestamp when the window was free
-- (no row, or last_sent_at older than the interval) and NULL when another run
-- holds it. The interval is a REQUIRED argument: no number is chosen here (owner
-- to confirm the product value). release_search_alert_window gives the window
-- back after a definite send failure only; it is a no-op if a newer claim exists.
--
-- No foreign key on purpose (search_alerts DDL is not in this repo). Not
-- addressed here: a process that dies between claiming and sending still holds
-- its claims until an owner-chosen cleanup (created_at is indexed on
-- search_alert_dispatches for that).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.search_alert_windows (
  alert_id     UUID        PRIMARY KEY,
  last_sent_at TIMESTAMPTZ NOT NULL,
  prev_sent_at TIMESTAMPTZ
);

ALTER TABLE public.search_alert_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.search_alert_windows FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.search_alert_windows TO service_role;

CREATE OR REPLACE FUNCTION public.claim_search_alert_window(
  p_alert_id             UUID,
  p_min_interval_seconds INTEGER
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed TIMESTAMPTZ;
BEGIN
  IF p_min_interval_seconds IS NULL OR p_min_interval_seconds <= 0 THEN
    RAISE EXCEPTION 'claim_search_alert_window: p_min_interval_seconds must be > 0';
  END IF;

  INSERT INTO public.search_alert_windows AS w (alert_id, last_sent_at, prev_sent_at)
  VALUES (p_alert_id, clock_timestamp(), NULL)
  ON CONFLICT (alert_id) DO UPDATE
    SET prev_sent_at = w.last_sent_at,
        last_sent_at = EXCLUDED.last_sent_at
    WHERE w.last_sent_at <= EXCLUDED.last_sent_at - make_interval(secs => p_min_interval_seconds)
  RETURNING w.last_sent_at INTO v_claimed;

  RETURN v_claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_search_alert_window(
  p_alert_id   UUID,
  p_claimed_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM public.search_alert_windows
   WHERE alert_id = p_alert_id
     AND last_sent_at = p_claimed_at
     AND prev_sent_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN RETURN TRUE; END IF;

  UPDATE public.search_alert_windows
     SET last_sent_at = prev_sent_at,
         prev_sent_at = NULL
   WHERE alert_id = p_alert_id
     AND last_sent_at = p_claimed_at
     AND prev_sent_at IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_search_alert_window(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_search_alert_window(UUID, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.release_search_alert_window(UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_search_alert_window(UUID, TIMESTAMPTZ) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually if this must be undone):
--   DROP FUNCTION IF EXISTS public.release_search_alert_window(UUID, TIMESTAMPTZ);
--   DROP FUNCTION IF EXISTS public.claim_search_alert_window(UUID, INTEGER);
--   DROP TABLE IF EXISTS public.search_alert_windows;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261107g_touch_updated_at_triggers.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261107g_touch_updated_at_triggers.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107g_touch_updated_at_triggers
--
-- Database rows "Auto-touch updated_at trigger" and "updated_at maintenance
-- trigger" (PARTIAL): "other updated_at set by app/RPC code".
--
-- What this changes once applied: a BEFORE UPDATE trigger on five user-owned
-- tables sets NEW.updated_at = now() when the UPDATE did not change updated_at
-- itself. A caller that sets updated_at explicitly keeps its value, so existing
-- writers behave as today; only writers that forgot to touch it are fixed.
-- Nothing rejects a write.
--
-- Tables (owner to confirm the list). Each already has an updated_at TIMESTAMPTZ
-- column in an earlier migration: candidate_profiles, applications,
-- user_preferences, resumes, tailored_resumes.
-- Deliberately NOT included: subscriptions and anything billing (payments stay
-- off, webhook-managed), jobs and ingest tables (their timestamps describe the
-- source data, not the row edit), and tables that already manage their own.
--
-- Interactions: trg_change_history_user_preferences (AFTER) will record the
-- touched updated_at in its images; trg_row_version_* (BEFORE, 20261107d) is
-- independent of this trigger.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $func$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$func$;

REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_updated_at() TO service_role;

DROP TRIGGER IF EXISTS trg_touch_updated_at_candidate_profiles ON public.candidate_profiles;
create trigger trg_touch_updated_at_candidate_profiles
  before update on public.candidate_profiles
  for each row execute function public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at_applications ON public.applications;
create trigger trg_touch_updated_at_applications
  before update on public.applications
  for each row execute function public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at_user_preferences ON public.user_preferences;
create trigger trg_touch_updated_at_user_preferences
  before update on public.user_preferences
  for each row execute function public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at_resumes ON public.resumes;
create trigger trg_touch_updated_at_resumes
  before update on public.resumes
  for each row execute function public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at_tailored_resumes ON public.tailored_resumes;
create trigger trg_touch_updated_at_tailored_resumes
  before update on public.tailored_resumes
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP TRIGGER IF EXISTS trg_touch_updated_at_tailored_resumes ON public.tailored_resumes;
--   DROP TRIGGER IF EXISTS trg_touch_updated_at_resumes ON public.resumes;
--   DROP TRIGGER IF EXISTS trg_touch_updated_at_user_preferences ON public.user_preferences;
--   DROP TRIGGER IF EXISTS trg_touch_updated_at_applications ON public.applications;
--   DROP TRIGGER IF EXISTS trg_touch_updated_at_candidate_profiles ON public.candidate_profiles;
--   DROP FUNCTION IF EXISTS public.touch_updated_at();
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261107h_table_comments.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261107h_table_comments.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107h_table_comments
--
-- Database row "COMMENT ON documentation" (PARTIAL): "Only admin_audit_log has
-- COMMENT ON; knowledge lives in migration headers." This adds table-level
-- comments so the meaning is visible inside the database.
--
-- Every comment text is copied from docs/data-classification.md (the owner-reviewed
-- description of the table). No new claims are made here. Tables that already have
-- a COMMENT (admin_audit_log, schema_migrations) are not touched. Owner to confirm
-- the wording.
--
-- Safe to run: COMMENT ON only changes catalog metadata, no data and no lock beyond a
-- brief one. A table that does not exist in the live database is skipped (to_regclass
-- check), so a drifted environment cannot make the script fail.
-- ============================================================================

DO $do$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
    ('cron_run_logs', 'Scheduled job outcomes. 90-day retention.'),
    ('ingest_runs', 'Job-ingestion run state.'),
    ('failed_events', 'Webhook/event replay queue. Replayed/dead rows purged after 90 days.'),
    ('webhook_events', 'Provider webhook receipts (event ids, no payload PII). 90-day retention.'),
    ('rate_limits', 'Rate-limit buckets keyed by route/ip hash.'),
    ('ai_usage_quotas', 'Per-user and global AI usage accounting. User-linked but not identifying beyond the id.'),
    ('plan_usage_events', 'Per-user and global AI usage accounting. User-linked but not identifying beyond the id.'),
    ('ai_concurrency_leases', 'Per-user and global AI usage accounting. User-linked but not identifying beyond the id.'),
    ('ai_global_budget_daily', 'Per-user and global AI usage accounting. User-linked but not identifying beyond the id.'),
    ('web_vitals', 'Anonymous performance telemetry (no identifiers by design).'),
    ('company_token_registry', 'Scraper tokens for company boards. Secret-adjacent; service-role only.'),
    ('matview_refresh_log', 'Materialized-view refresh telemetry (when, duration). Service-role only'),
    ('deleted_account_tombstones', 'PII-free account-deletion audit anchor (user id, SHA-256 email hash, purge deadline). 30-day undo window, then hard-purged'),
    ('job_descriptions', 'Full job description text.'),
    ('companies', 'Company directory and ATS board config.'),
    ('company_boards', 'Company directory and ATS board config.'),
    ('plans', 'Product catalog (names, prices, quotas).'),
    ('addon_packs', 'Product catalog (names, prices, quotas).')
    ) AS v(tbl, descr)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL THEN
      EXECUTE format('COMMENT ON TABLE public.%I IS %L', r.tbl, r.descr);
    END IF;
  END LOOP;
END
$do$;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
-- NOTE: comments are catalog metadata only, nothing else changes. Undo is manual:
--   COMMENT ON TABLE public.<table> IS NULL;   -- once for each table listed above
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261108a_pg_cron_scheduled_jobs.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261108a_pg_cron_scheduled_jobs.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261108a_pg_cron_scheduled_jobs
--
-- Database row "pg_cron" (MISSING): "DB-side schedules depend on GitHub
-- Actions staying green." Every schedule today lives in GitHub Actions, so an
-- Actions outage (the 2026-11-05 billing stop silenced all crons) also stops
-- DB maintenance. This adds database-native schedules for the two jobs that
-- must keep running even when Actions is down:
--   1. weekly purge of operational log tables (retention policy)
--   2. daily refresh of public.worldwide_company_counts
--
-- Supports DB#46 (data lifecycle: the purge no longer depends solely on the
-- GitHub Actions retention cron) and DB#68 (the matview refresh gains a path
-- outside the ingest transaction).
--
-- Apply order: after 20261106a_data_retention.sql (purge function) and
-- 20261106d_matview_refresh_log.sql (refresh function). Scheduling a job whose
-- function is missing does not fail at schedule time; the run fails and shows
-- in cron.job_run_details, so order still matters.
--
-- pg_cron must be enabled for the project (Supabase Dashboard -> Database ->
-- Extensions -> pg_cron); the CREATE EXTENSION below is a no-op when it
-- already is.
--
-- Changes CREATE EXTENSION and scheduling metadata only, not product rows.
-- No product-table DDL or maintenance is executed while creating schedules. Idempotent: named cron.schedule upserts the job for the current user.
-- No unschedule is needed (it errors when the name does not exist). The GitHub
-- Actions retention-cron.yml stays in place; both call the same purge
-- function and the purge is idempotent by design.
--
-- pg_cron times are UTC. Chosen slots (IST in parentheses):
--   purge   Sun 02:15 UTC (Sun 07:45 IST), staggered from the GHA retention
--           cron (Sun 19:30 UTC / Mon 01:00 IST);
--   refresh daily 02:45 UTC (08:15 IST), after the nightly ingest.
-- ============================================================================

create extension if not exists pg_cron;

-- Named cron.schedule uses the jobname/username unique key to upsert.
-- This works both on first apply and on re-apply. Do not unschedule first: the
-- named unschedule overload raises an error when no matching job exists.
select cron.schedule(
  'purge-operational-logs-weekly',
  '15 2 * * 0',
  $cmd$select public.purge_operational_logs(false);$cmd$
);

select cron.schedule(
  'refresh-worldwide-counts-daily',
  '45 2 * * *',
  $cmd$select public.refresh_worldwide_company_counts();$cmd$
);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   select cron.unschedule('purge-operational-logs-weekly');
--   select cron.unschedule('refresh-worldwide-counts-daily');
-- NOTE: dropping the pg_cron extension itself is left to the owner - other
-- jobs may exist by then.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261108b_db_health_snapshot.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261108b_db_health_snapshot.sql
-- STATUS: NOT APPLIED - apply manually after review, then record:
--   node scripts/record-migration.cjs 20261108b_db_health_snapshot
-- Read-only, service-role-only operational metrics. No query text, user IDs,
-- error payloads, table data, schema mutation, VACUUM or index maintenance.
-- pg_stat counters are estimates since stats reset, not an index-drop decision.

CREATE OR REPLACE FUNCTION public.db_health_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '5s'
AS $function$
DECLARE
  table_metrics jsonb;
  index_metrics jsonb;
  failed_cron bigint;
  cron_available boolean;
BEGIN
  SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  INTO table_metrics
  FROM (
    SELECT relname AS name, n_live_tup AS live_tuples,
           n_dead_tup AS dead_tuples,
           pg_total_relation_size(relid) AS total_bytes
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(relid) DESC, relname
    LIMIT 100
  ) t;

  SELECT coalesce(jsonb_agg(row_to_json(i)), '[]'::jsonb)
  INTO index_metrics
  FROM (
    SELECT s.indexrelname AS name, s.idx_scan AS scans,
           pg_relation_size(s.indexrelid) AS total_bytes,
           x.indisunique AS is_unique
    FROM pg_stat_user_indexes s
    JOIN pg_index x ON x.indexrelid = s.indexrelid
    WHERE s.schemaname = 'public'
    ORDER BY pg_relation_size(s.indexrelid) DESC, s.indexrelname
    LIMIT 100
  ) i;

  cron_available := to_regclass('public.cron_run_logs') IS NOT NULL;
  IF cron_available THEN
    SELECT count(*) INTO failed_cron
    FROM public.cron_run_logs
    WHERE status = 'failed' AND started_at > now() - interval '7 days';
  END IF;

  RETURN jsonb_build_object(
    'sampled_at', now(),
    'stats_reset', (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()),
    'tables', table_metrics,
    'indexes', index_metrics,
    'table_count', (SELECT count(*) FROM pg_stat_user_tables WHERE schemaname = 'public'),
    'index_count', (SELECT count(*) FROM pg_stat_user_indexes WHERE schemaname = 'public'),
    'cron_available', cron_available,
    'failed_cron_7d', failed_cron
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.db_health_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.db_health_snapshot() TO service_role;
COMMENT ON FUNCTION public.db_health_snapshot() IS
  'Read-only DB health snapshot. Service role only. Top 100 tables/indexes by size; counters since stats reset.';

-- ROLLBACK (manual, after disabling the workflow):
-- DROP FUNCTION IF EXISTS public.db_health_snapshot();


-- ------------------------------------------------------------------------------
-- Migration: 20261112a_custom_domain_types.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261112a_custom_domain_types.sql
-- STATUS: NOT APPLIED - record-migration.cjs 20261112a_custom_domain_types
--
-- Reusable PostgreSQL DOMAIN types for CareerMonke schema integrity.
-- Audit finding: Plain text columns with duplicated, drift-prone ad hoc CHECK
-- constraints for emails, slugs, and non-empty strings.
--
-- Introduces reusable DOMAIN types in public schema:
--   1. public.cm_email: Normalized lowercase, trimmed text, valid email format
--      with no leading/trailing/consecutive dots in local part, no leading/trailing
--      hyphens or empty labels in domain, letters-only TLD, max length 254 chars.
--   2. public.cm_non_empty_text: Text requiring VALUE ~ '[^[:space:]]',
--      preventing empty strings or whitespace-only inputs (spaces, tabs, newlines).
--   3. public.cm_slug: Normalized lowercase, non-empty text matching slug
--      pattern ^[a-z0-9]+(-[a-z0-9]+)*$, max length 120 chars.
--
-- Safety & non-breaking constraints:
--   - Contains ONLY CREATE DOMAIN statements.
--   - Does NOT alter, drop, or rewrite any existing table, column, CHECK,
--     function, or data.
--   - Domain CHECK constraints evaluate to TRUE for NULL values; table columns
--     requiring non-null values must declare NOT NULL independently.
--   - Adoption into existing columns is staged and out of scope for now.
--
-- ============================================================================
-- ROLLBACK INSTRUCTIONS (manual rollback if applied)
-- ============================================================================
-- To undo this migration (safe before columns adopt these domains):
--   DROP DOMAIN IF EXISTS public.cm_slug;
--   DROP DOMAIN IF EXISTS public.cm_non_empty_text;
--   DROP DOMAIN IF EXISTS public.cm_email;
-- ============================================================================

CREATE DOMAIN public.cm_email AS text
  CHECK (
    VALUE = lower(trim(VALUE))
    AND char_length(VALUE) <= 254
    AND position('@' in VALUE) > 1
    AND VALUE ~ '^[a-z0-9_%+-]+(\.[a-z0-9_%+-]+)*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$'
  );

CREATE DOMAIN public.cm_non_empty_text AS text
  CHECK (VALUE ~ '[^[:space:]]');

CREATE DOMAIN public.cm_slug AS text
  CHECK (
    VALUE = lower(trim(VALUE))
    AND length(trim(VALUE)) > 0
    AND char_length(VALUE) <= 120
    AND VALUE ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  );


-- ------------------------------------------------------------------------------
-- Migration: 20261112b_statement_timeouts.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261112b_statement_timeouts.sql
-- Status: NOT APPLIED - record-migration.cjs 20261112b_statement_timeouts
-- Apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261112b_statement_timeouts
--
-- Purpose:
--   Establish statement_timeout discipline on heavy read, aggregate, and
--   maintenance RPCs in the public schema. Per Supabase documentation,
--   function-level ALTER FUNCTION ... SET statement_timeout is supported
--   and effective for REST RPC calls (invoked via supabase.rpc), bounding
--   execution time and preventing runaway queries from holding connection
--   pool slots indefinitely under load.
--
-- Invariants:
--   - ONLY ALTER FUNCTION ... SET statement_timeout statements with exact
--     argument signatures.
--   - ZERO ALTER ROLE statements (broad role ceilings avoid risking uninventoried
--     service-role tasks; authenticator role timeout already set in 20261105c).
--   - ZERO data modifications (no INSERT, UPDATE, DELETE).
--   - ZERO table mutations (no CREATE, DROP, ALTER TABLE).
--   - ZERO trigger or pg_cron schedule changes.
-- ============================================================================

-- 1. Materialized View & Observability Aggregations
ALTER FUNCTION public.refresh_worldwide_company_counts() SET statement_timeout = '30s';
ALTER FUNCTION public.db_health_snapshot() SET statement_timeout = '5s';
ALTER FUNCTION public.analyze_after_ingest() SET statement_timeout = '15s';

-- 2. Job Lifecycle & Deduplication Scans
ALTER FUNCTION public.dedupe_jobs_by_role(boolean) SET statement_timeout = '30s';
ALTER FUNCTION public.archive_expired_jobs(boolean, interval) SET statement_timeout = '30s';

-- 3. Maintenance & Retention Pruning (capped to Supabase REST 60s gateway bound)
ALTER FUNCTION public.reindex_bloated_indexes(integer, boolean) SET statement_timeout = '60s';
ALTER FUNCTION public.purge_operational_logs(boolean) SET statement_timeout = '30s';
ALTER FUNCTION public.purge_row_change_history(boolean) SET statement_timeout = '30s';
ALTER FUNCTION public.purge_soft_deleted_account_data(interval) SET statement_timeout = '30s';

-- 4. High-Frequency Outbox & Rate-Limiting
ALTER FUNCTION public.outbox_claim_batch(text, integer, integer, text) SET statement_timeout = '5s';
ALTER FUNCTION public.cleanup_expired_rate_limits() SET statement_timeout = '10s';
ALTER FUNCTION public.check_rate_limit(text, integer, integer) SET statement_timeout = '2s';
ALTER FUNCTION public.claim_search_alert_window(uuid, integer) SET statement_timeout = '5s';
ALTER FUNCTION public.release_search_alert_window(uuid, timestamptz) SET statement_timeout = '5s';

-- ============================================================================
-- VERIFY QUERIES (execute in Supabase SQL editor to confirm configuration):
-- ============================================================================
--
-- Verify function-level statement_timeout configurations:
-- SELECT
--   p.proname AS function_name,
--   pg_get_function_identity_arguments(p.oid) AS arguments,
--   p.proconfig AS configuration
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proconfig::text LIKE '%statement_timeout%'
-- ORDER BY p.proname;
--
-- ============================================================================
-- ROLLBACK INSTRUCTIONS (run manually in Supabase SQL editor if needed):
-- ============================================================================
-- Note: RESET statement_timeout removes the function-level proconfig override,
-- reverting execution to inherit the caller role / database default (it does
-- not guarantee an unbounded baseline). Prior to applying, capture existing
-- proconfig values via the runbook query in docs/statement-timeouts.md.
--
-- Exact restoration of repository pre-migration baselines:
--   ALTER FUNCTION public.refresh_worldwide_company_counts() RESET statement_timeout;
--   -- db_health_snapshot had statement_timeout = '5s' in 20261108b; preserve 5s, DO NOT RESET:
--   ALTER FUNCTION public.db_health_snapshot() SET statement_timeout = '5s';
--   ALTER FUNCTION public.analyze_after_ingest() RESET statement_timeout;
--   ALTER FUNCTION public.dedupe_jobs_by_role(boolean) RESET statement_timeout;
--   ALTER FUNCTION public.archive_expired_jobs(boolean, interval) RESET statement_timeout;
--   ALTER FUNCTION public.reindex_bloated_indexes(integer, boolean) RESET statement_timeout;
--   ALTER FUNCTION public.purge_operational_logs(boolean) RESET statement_timeout;
--   ALTER FUNCTION public.purge_row_change_history(boolean) RESET statement_timeout;
--   ALTER FUNCTION public.purge_soft_deleted_account_data(interval) RESET statement_timeout;
--   ALTER FUNCTION public.outbox_claim_batch(text, integer, integer, text) RESET statement_timeout;
--   ALTER FUNCTION public.cleanup_expired_rate_limits() RESET statement_timeout;
--   ALTER FUNCTION public.check_rate_limit(text, integer, integer) RESET statement_timeout;
--   ALTER FUNCTION public.claim_search_alert_window(uuid, integer) RESET statement_timeout;
--   ALTER FUNCTION public.release_search_alert_window(uuid, timestamptz) RESET statement_timeout;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261113a_addon_credit_expiry_subscription_sync.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261113a_addon_credit_expiry_subscription_sync.sql
-- Status: NOT APPLIED - record-migration.cjs 20261113a_addon_credit_expiry_subscription_sync
-- Apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261113a_addon_credit_expiry_subscription_sync
--
-- Purpose:
--   Tie add-on credit expiry directly to the user's subscription end date
--   (replacing the previous 60-day independent expiry).
--   Updates public.fulfil_payment_order(text, uuid, text) so add-on purchases
--   inherit the user's active subscription current_period_end, and subscription
--   renewals/extensions keep active add-on credits aligned.
--
-- Invariants:
--   - Security definer with search_path pinned to public, auth.
--   - Strict mode isolation ('test' vs 'live') preserved.
--   - Atomic and fail-closed: entitlement grant occurs before marking paid.
--   - Statement timeout bounded to 15s.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fulfil_payment_order(
  p_provider_order_id text,
  p_user_id uuid,
  p_expected_mode text default 'live'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_existing_sub record;
  v_existing_credit record;
  v_duration int := 30;
  v_sets int := 10;
  v_validity int := 60;
  v_sub record;
  v_credit record;
  v_base_time timestamptz;
  v_new_end timestamptz;
  v_period_start timestamptz;
BEGIN
  -- Validate expected mode parameter
  IF p_expected_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXPECTED_MODE',
      'error', 'Expected mode must be either test or live'
    );
  END IF;

  -- 1. Lock the order row for update
  SELECT * INTO v_order
  FROM public.payment_orders
  WHERE provider_order_id = p_provider_order_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF v_order IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_FOUND',
      'error', 'Payment order not found for user'
    );
  END IF;

  -- 2. Provider verification
  IF v_order.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay provider orders can be fulfilled via this function'
    );
  END IF;

  -- 3. Fail-closed Mode Check: Order mode must match expected fulfillment mode
  IF v_order.mode <> p_expected_mode THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MODE_MISMATCH',
      'error', format('Order mode (%s) does not match fulfillment mode (%s)', v_order.mode, p_expected_mode)
    );
  END IF;

  -- 4. Verify state is valid (created or paid-retry)
  IF v_order.status NOT IN ('created', 'paid') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_INVALID_STATE',
      'error', 'Payment order is not in created or paid state'
    );
  END IF;

  -- 5. TEST MODE ISOLATION: Zero real entitlements granted
  IF v_order.mode = 'test' THEN
    IF v_order.status = 'paid' THEN
      RETURN jsonb_build_object(
        'success', true,
        'test_mode', true,
        'is_pro', false,
        'already_paid', true,
        'order_id', v_order.id,
        'message', 'Test order already verified and marked as paid'
      );
    END IF;

    -- Mark test order paid, NEVER touch subscriptions or user_addon_credits
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'test_mode', true,
      'is_pro', false,
      'order_id', v_order.id,
      'already_paid', false,
      'message', 'Test payment verified; zero real entitlements granted'
    );
  END IF;

  -- 6. LIVE MODE: Idempotency check for already fulfilled live orders
  IF v_order.status = 'paid' THEN
    IF v_order.plan_code IS NOT NULL THEN
      SELECT * INTO v_existing_sub
      FROM public.subscriptions
      WHERE user_id = p_user_id;

      RETURN jsonb_build_object(
        'success', true,
        'already_paid', true,
        'is_pro', true,
        'type', 'plan',
        'plan_code', v_order.plan_code,
        'order_id', v_order.id,
        'period_end', v_existing_sub.current_period_end,
        'message', 'Order already fulfilled and marked as paid'
      );
    ELSIF v_order.addon_code IS NOT NULL THEN
      SELECT * INTO v_existing_credit
      FROM public.user_addon_credits
      WHERE order_id = v_order.id;

      RETURN jsonb_build_object(
        'success', true,
        'already_paid', true,
        'is_pro', false,
        'type', 'addon',
        'addon_code', v_order.addon_code,
        'order_id', v_order.id,
        'credit_id', v_existing_credit.id,
        'expires_at', v_existing_credit.expires_at,
        'message', 'Order already fulfilled and marked as paid'
      );
    END IF;
  END IF;

  -- 7. Live Fulfillment Path A: Subscription Plan purchase / renewal / upgrade
  IF v_order.plan_code IS NOT NULL THEN
    SELECT duration_days INTO v_duration
    FROM public.plans
    WHERE code = v_order.plan_code;

    IF v_duration IS NULL OR v_duration <= 0 THEN
      IF v_order.plan_code = 'weekly' THEN
        v_duration := 7;
      ELSIF v_order.plan_code = 'quarterly' THEN
        v_duration := 90;
      ELSE
        v_duration := 30;
      END IF;
    END IF;

    -- Look up existing subscription to calculate extension
    SELECT * INTO v_existing_sub
    FROM public.subscriptions
    WHERE user_id = p_user_id;

    IF v_existing_sub IS NOT NULL AND (v_existing_sub.status IN ('active', 'trialing')) AND v_existing_sub.current_period_end IS NOT NULL THEN
      -- User has an active plan: new period end = max(current_period_end, now) + duration
      v_base_time := greatest(v_existing_sub.current_period_end, now());
      v_new_end := v_base_time + (v_duration * interval '1 day');
      -- Never shorten existing period
      IF v_new_end < v_existing_sub.current_period_end THEN
        v_new_end := v_existing_sub.current_period_end;
      END IF;
      v_period_start := coalesce(v_existing_sub.current_period_start, now());
    ELSE
      -- Expired or no previous subscription: period end = now + duration
      v_period_start := now();
      v_new_end := now() + (v_duration * interval '1 day');
    END IF;

    -- Grant subscription entitlement FIRST
    INSERT INTO public.subscriptions (
      user_id,
      plan_id,
      provider,
      currency,
      amount,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      metadata,
      updated_at
    ) VALUES (
      p_user_id,
      v_order.plan_code,
      'razorpay',
      v_order.currency,
      v_order.amount_paise,
      'active',
      v_period_start,
      v_new_end,
      false,
      jsonb_build_object(
        'provider_order_id', p_provider_order_id,
        'payment_order_id', v_order.id,
        'mode', v_order.mode
      ),
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      plan_id = EXCLUDED.plan_id,
      currency = EXCLUDED.currency,
      amount = EXCLUDED.amount,
      status = 'active',
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      cancel_at_period_end = false,
      metadata = EXCLUDED.metadata,
      updated_at = now()
    RETURNING * INTO v_sub;

    -- Also extend active unexpired add-on credits to match newly extended subscription period
    UPDATE public.user_addon_credits
    SET expires_at = v_new_end
    WHERE user_id = p_user_id
      AND expires_at >= now()
      AND sets_remaining > 0;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'is_pro', true,
      'type', 'plan',
      'plan_code', v_order.plan_code,
      'order_id', v_order.id,
      'period_end', v_sub.current_period_end
    );
  END IF;

  -- 8. Live Fulfillment Path B: Add-on pack purchase
  IF v_order.addon_code IS NOT NULL THEN
    SELECT sets, validity_days INTO v_sets, v_validity
    FROM public.addon_packs
    WHERE code = v_order.addon_code;

    IF v_sets IS NULL OR v_sets <= 0 THEN
      IF v_order.addon_code = 'addon_30' THEN
        v_sets := 30;
      ELSIF v_order.addon_code = 'addon_60' THEN
        v_sets := 60;
      ELSE
        v_sets := 10;
      END IF;
    END IF;

    -- Look up active subscription to tie add-on expiry to subscription end date
    SELECT * INTO v_existing_sub
    FROM public.subscriptions
    WHERE user_id = p_user_id;

    IF v_existing_sub IS NULL OR v_existing_sub.status NOT IN ('active', 'trialing') OR v_existing_sub.current_period_end IS NULL OR v_existing_sub.current_period_end <= now() THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'PRO_REQUIRED',
        'error', 'Active Pro subscription required to activate add-on credits'
      );
    END IF;

    v_new_end := v_existing_sub.current_period_end;

    -- Grant add-on credit entitlement FIRST
    INSERT INTO public.user_addon_credits (
      user_id,
      pack_code,
      sets_total,
      sets_remaining,
      expires_at,
      order_id,
      created_at
    ) VALUES (
      p_user_id,
      v_order.addon_code,
      v_sets,
      v_sets,
      v_new_end,
      v_order.id,
      now()
    )
    ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_credit;

    IF v_credit IS NULL THEN
      SELECT * INTO v_credit
      FROM public.user_addon_credits
      WHERE order_id = v_order.id;
    END IF;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'is_pro', false,
      'type', 'addon',
      'addon_code', v_order.addon_code,
      'order_id', v_order.id,
      'sets_granted', v_sets,
      'credit_id', v_credit.id,
      'expires_at', v_credit.expires_at
    );
  END IF;

  RETURN jsonb_build_object(
    'success', false,
    'code', 'ORDER_ITEM_MISSING',
    'error', 'Order contains neither plan_code nor addon_code'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fulfil_payment_order(text, uuid, text) TO service_role;
ALTER FUNCTION public.fulfil_payment_order(text, uuid, text) SET search_path = public, auth;
ALTER FUNCTION public.fulfil_payment_order(text, uuid, text) SET statement_timeout = '15s';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   NOTE: replaces function public.fulfil_payment_order (defined in 20261104b_payment_order_mode_isolation.sql);
--   restore the prior definition from that file if this change must be undone.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261114a_payment_plan_stack_guard.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261114a_payment_plan_stack_guard.sql
-- Status: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261114a_payment_plan_stack_guard.sql
--
-- Purpose (audit B5):
--   public.fulfil_payment_order upserted subscriptions with
--   ON CONFLICT (user_id) DO UPDATE SET plan_id = EXCLUDED.plan_id unconditionally and locked
--   only the order row, so a late or concurrent older order could overwrite the plan label
--   written by a newer order.
--
-- Changes:
--   1. pg_advisory_xact_lock(hashtext(p_user_id::text)) before the subscription is read
--      (the order-row FOR UPDATE lock is kept; lock order is order row, then user lock).
--   2. When an active/trialing subscription exists from a different payment_order_id, the
--      period extends by this order's duration from max(current_period_end, now()), but
--      plan_id / currency / amount / metadata are written only from the NEWER order
--      (payment_orders.created_at). Missing metadata or equal timestamps keep the existing label.
--   3. An expired or missing subscription is replaced by this order, as before.
--   4. Existence of row variables is tested with FOUND, never `record IS [NOT] NULL` (which is
--      false for a real row with any NULL column and sent stacked orders down the expired branch).
--   Unchanged: already_paid short-circuit, add-on path, test mode, mode checks, ACL revokes,
--   statement_timeout. search_path is pinned to public (the function body references no auth.* objects).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fulfil_payment_order(
  p_provider_order_id text,
  p_user_id uuid,
  p_expected_mode text default 'live'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_existing_sub record;
  v_existing_credit record;
  v_duration int := 30;
  v_sets int := 10;
  v_validity int := 60;
  v_sub record;
  v_credit record;
  v_base_time timestamptz;
  v_new_end timestamptz;
  v_period_start timestamptz;
  v_prev_order_id uuid;
  v_prev_order_created timestamptz;
  v_label_plan text;
  v_label_currency text;
  v_label_amount numeric;
  v_label_meta jsonb;
  v_has_sub boolean;
BEGIN
  -- Validate expected mode parameter
  IF p_expected_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXPECTED_MODE',
      'error', 'Expected mode must be either test or live'
    );
  END IF;

  -- 1. Lock the order row for update
  SELECT * INTO v_order
  FROM public.payment_orders
  WHERE provider_order_id = p_provider_order_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_FOUND',
      'error', 'Payment order not found for user'
    );
  END IF;

  -- 2. Provider verification
  IF v_order.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay provider orders can be fulfilled via this function'
    );
  END IF;

  -- 3. Fail-closed Mode Check: Order mode must match expected fulfillment mode
  IF v_order.mode <> p_expected_mode THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MODE_MISMATCH',
      'error', format('Order mode (%s) does not match fulfillment mode (%s)', v_order.mode, p_expected_mode)
    );
  END IF;

  -- 4. Verify state is valid (created or paid-retry)
  IF v_order.status NOT IN ('created', 'paid') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_INVALID_STATE',
      'error', 'Payment order is not in created or paid state'
    );
  END IF;

  -- 5. TEST MODE ISOLATION: Zero real entitlements granted
  IF v_order.mode = 'test' THEN
    IF v_order.status = 'paid' THEN
      RETURN jsonb_build_object(
        'success', true,
        'test_mode', true,
        'is_pro', false,
        'already_paid', true,
        'order_id', v_order.id,
        'message', 'Test order already verified and marked as paid'
      );
    END IF;

    -- Mark test order paid, NEVER touch subscriptions or user_addon_credits
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'test_mode', true,
      'is_pro', false,
      'order_id', v_order.id,
      'already_paid', false,
      'message', 'Test payment verified; zero real entitlements granted'
    );
  END IF;

  -- 5b. Serialize all live fulfilments for this user (order-row lock above is kept).
  -- Lock order is always order row -> user advisory lock, so two orders cannot deadlock.
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 6. LIVE MODE: Idempotency check for already fulfilled live orders
  IF v_order.status = 'paid' THEN
    IF v_order.plan_code IS NOT NULL THEN
      SELECT * INTO v_existing_sub
      FROM public.subscriptions
      WHERE user_id = p_user_id;

      RETURN jsonb_build_object(
        'success', true,
        'already_paid', true,
        'is_pro', true,
        'type', 'plan',
        'plan_code', v_order.plan_code,
        'order_id', v_order.id,
        'period_end', v_existing_sub.current_period_end,
        'message', 'Order already fulfilled and marked as paid'
      );
    ELSIF v_order.addon_code IS NOT NULL THEN
      SELECT * INTO v_existing_credit
      FROM public.user_addon_credits
      WHERE order_id = v_order.id;

      RETURN jsonb_build_object(
        'success', true,
        'already_paid', true,
        'is_pro', false,
        'type', 'addon',
        'addon_code', v_order.addon_code,
        'order_id', v_order.id,
        'credit_id', v_existing_credit.id,
        'expires_at', v_existing_credit.expires_at,
        'message', 'Order already fulfilled and marked as paid'
      );
    END IF;
  END IF;

  -- 7. Live Fulfillment Path A: Subscription Plan purchase / renewal / upgrade
  IF v_order.plan_code IS NOT NULL THEN
    SELECT duration_days INTO v_duration
    FROM public.plans
    WHERE code = v_order.plan_code;

    IF v_duration IS NULL OR v_duration <= 0 THEN
      IF v_order.plan_code = 'weekly' THEN
        v_duration := 7;
      ELSIF v_order.plan_code = 'quarterly' THEN
        v_duration := 90;
      ELSE
        v_duration := 30;
      END IF;
    END IF;

    -- Look up existing subscription to calculate extension
    SELECT * INTO v_existing_sub
    FROM public.subscriptions
    WHERE user_id = p_user_id;
    -- record IS NULL is true only when EVERY column is null; real rows have null columns, so use FOUND.
    v_has_sub := FOUND;

    -- Default: label (plan/currency/amount/metadata) comes from this order
    v_label_plan := v_order.plan_code;
    v_label_currency := v_order.currency;
    v_label_amount := v_order.amount_paise;
    v_label_meta := jsonb_build_object(
      'provider_order_id', p_provider_order_id,
      'payment_order_id', v_order.id,
      'mode', v_order.mode
    );

    IF v_has_sub AND (v_existing_sub.status IN ('active', 'trialing')) AND v_existing_sub.current_period_end IS NOT NULL THEN
      v_period_start := coalesce(v_existing_sub.current_period_start, now());

      -- Which order produced the current label?
      v_prev_order_id := NULL;
      IF (v_existing_sub.metadata->>'payment_order_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_prev_order_id := (v_existing_sub.metadata->>'payment_order_id')::uuid;
      END IF;

      IF v_prev_order_id IS NOT NULL AND v_prev_order_id = v_order.id THEN
        -- This order already produced the current subscription state: never extend twice
        v_new_end := v_existing_sub.current_period_end;
      ELSE
        -- Different order stacked on an active plan: period extends from max(current_period_end, now)
        v_base_time := greatest(v_existing_sub.current_period_end, now());
        v_new_end := v_base_time + (v_duration * interval '1 day');
        -- Never shorten existing period
        IF v_new_end < v_existing_sub.current_period_end THEN
          v_new_end := v_existing_sub.current_period_end;
        END IF;

        -- plan_id/currency/amount/metadata are written only from the NEWER order (by created_at).
        -- Missing/unknown previous-order metadata or equal timestamps keep the existing label.
        v_prev_order_created := NULL;
        IF v_prev_order_id IS NOT NULL THEN
          SELECT created_at INTO v_prev_order_created
          FROM public.payment_orders
          WHERE id = v_prev_order_id
            AND user_id = p_user_id;
        END IF;

        IF v_prev_order_created IS NULL OR NOT (v_order.created_at > v_prev_order_created) THEN
          v_label_plan := v_existing_sub.plan_id;
          v_label_currency := v_existing_sub.currency;
          v_label_amount := v_existing_sub.amount;
          v_label_meta := v_existing_sub.metadata;
        END IF;
      END IF;
    ELSE
      -- Expired or no previous subscription: period end = now + duration, label from this order
      v_period_start := now();
      v_new_end := now() + (v_duration * interval '1 day');
    END IF;

    -- Grant subscription entitlement FIRST
    INSERT INTO public.subscriptions (
      user_id,
      plan_id,
      provider,
      currency,
      amount,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      metadata,
      updated_at
    ) VALUES (
      p_user_id,
      v_label_plan,
      'razorpay',
      v_label_currency,
      v_label_amount,
      'active',
      v_period_start,
      v_new_end,
      false,
      v_label_meta,
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      plan_id = EXCLUDED.plan_id,
      currency = EXCLUDED.currency,
      amount = EXCLUDED.amount,
      status = 'active',
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      cancel_at_period_end = false,
      metadata = EXCLUDED.metadata,
      updated_at = now()
    RETURNING * INTO v_sub;

    -- Also extend active unexpired add-on credits to match newly extended subscription period
    UPDATE public.user_addon_credits
    SET expires_at = v_new_end
    WHERE user_id = p_user_id
      AND expires_at >= now()
      AND sets_remaining > 0;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'is_pro', true,
      'type', 'plan',
      'plan_code', v_order.plan_code,
      'order_id', v_order.id,
      'period_end', v_sub.current_period_end
    );
  END IF;

  -- 8. Live Fulfillment Path B: Add-on pack purchase
  IF v_order.addon_code IS NOT NULL THEN
    SELECT sets, validity_days INTO v_sets, v_validity
    FROM public.addon_packs
    WHERE code = v_order.addon_code;

    IF v_sets IS NULL OR v_sets <= 0 THEN
      IF v_order.addon_code = 'addon_30' THEN
        v_sets := 30;
      ELSIF v_order.addon_code = 'addon_60' THEN
        v_sets := 60;
      ELSE
        v_sets := 10;
      END IF;
    END IF;

    -- Look up active subscription to tie add-on expiry to subscription end date
    SELECT * INTO v_existing_sub
    FROM public.subscriptions
    WHERE user_id = p_user_id;

    IF NOT FOUND OR v_existing_sub.status NOT IN ('active', 'trialing') OR v_existing_sub.current_period_end IS NULL OR v_existing_sub.current_period_end <= now() THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'PRO_REQUIRED',
        'error', 'Active Pro subscription required to activate add-on credits'
      );
    END IF;

    v_new_end := v_existing_sub.current_period_end;

    -- Grant add-on credit entitlement FIRST
    INSERT INTO public.user_addon_credits (
      user_id,
      pack_code,
      sets_total,
      sets_remaining,
      expires_at,
      order_id,
      created_at
    ) VALUES (
      p_user_id,
      v_order.addon_code,
      v_sets,
      v_sets,
      v_new_end,
      v_order.id,
      now()
    )
    ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_credit;

    IF NOT FOUND THEN
      SELECT * INTO v_credit
      FROM public.user_addon_credits
      WHERE order_id = v_order.id;
    END IF;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'is_pro', false,
      'type', 'addon',
      'addon_code', v_order.addon_code,
      'order_id', v_order.id,
      'sets_granted', v_sets,
      'credit_id', v_credit.id,
      'expires_at', v_credit.expires_at
    );
  END IF;

  RETURN jsonb_build_object(
    'success', false,
    'code', 'ORDER_ITEM_MISSING',
    'error', 'Order contains neither plan_code nor addon_code'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fulfil_payment_order(text, uuid, text) TO service_role;
ALTER FUNCTION public.fulfil_payment_order(text, uuid, text) SET search_path = public;
ALTER FUNCTION public.fulfil_payment_order(text, uuid, text) SET statement_timeout = '15s';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   NOTE: replaces function public.fulfil_payment_order (previously defined in
--   20261113a_addon_credit_expiry_subscription_sync.sql); restore that definition to undo.
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261114b_profiles_onboarding_completed_at.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261114b_profiles_onboarding_completed_at.sql
-- Status: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261114b_profiles_onboarding_completed_at.sql
--
-- Purpose:
--   Persist onboarding completion per account in public.profiles (onboarding_completed_at)
--   so a user sees onboarding questions exactly once.
--   Backfill existing users who already have substantive profiles or preferences.
--
-- Safety & Fail-Fast Guarantees:
--   1. Wrapped in a single atomic transaction (BEGIN ... COMMIT).
--   2. Strict pre-flight checks: validates required columns across public.profiles,
--      public.candidate_profiles, and public.user_preferences before running DDL/DML.
--   3. Asserts user_id has a PRIMARY KEY or UNIQUE constraint on public.profiles.
--   4. Asserts pg_policies checks match schemaname = 'public'.
--   5. Backfills only on substantive data: trimmed non-empty text, non-empty arrays,
--      and non-empty JSONB arrays (matching runtime helper exactly).
-- ============================================================================

BEGIN;

-- 1. Ensure public.profiles table exists and has onboarding_completed_at column
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name    TEXT,
  target_roles TEXT[],
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- 2. Fail-fast safety checks: required columns and constraint verification
DO $$
DECLARE
  missing_col TEXT;
BEGIN
  -- 2a. Check public.profiles required columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('user_id'), ('full_name'), ('target_roles'), ('created_at'), ('onboarding_completed_at')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Safety check failed: public.profiles is missing required column: %', missing_col;
  END LOOP;

  -- 2b. Check public.candidate_profiles required columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('user_id'), ('confirmed_at'), ('updated_at'), ('created_at'), ('skills'), ('raw_resume_text'), ('experience_json')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'candidate_profiles' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Safety check failed: public.candidate_profiles is missing required column: %', missing_col;
  END LOOP;

  -- 2c. Check public.user_preferences required columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('user_id'), ('onboarding_completed'), ('updated_at'), ('created_at')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'user_preferences' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Safety check failed: public.user_preferences is missing required column: %', missing_col;
  END LOOP;

  -- 2d. Check user_id unique / primary key requirement on public.profiles:
  -- Tight check: requires a valid, immediate, non-partial UNIQUE index or constraint on user_id ALONE (not composite or partial).
  IF NOT EXISTS (
    -- Unique or primary key constraint on user_id ALONE
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'public'
      AND t.relname = 'profiles'
      AND c.contype IN ('p', 'u')
      AND array_length(c.conkey, 1) = 1
      AND c.condeferrable = false
      AND a.attname = 'user_id'
  ) AND NOT EXISTS (
    -- Unique index on user_id ALONE: valid, immediate, non-partial
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON i.indrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = 'public'
      AND t.relname = 'profiles'
      AND i.indisunique = true
      AND i.indisvalid = true
      AND i.indimmediate = true
      AND i.indpred IS NULL
      AND i.indnkeyatts = 1
      AND a.attname = 'user_id'
  ) THEN
    RAISE EXCEPTION 'Safety check failed: public.profiles must have a valid, immediate, non-partial PRIMARY KEY or UNIQUE constraint on user_id alone';
  END IF;
END $$;

-- 3. Ensure RLS is enabled and policies exist on public.profiles (scoped strictly to public schema)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_owner_select'
  ) THEN
    CREATE POLICY "profiles_owner_select" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_owner_insert'
  ) THEN
    CREATE POLICY "profiles_owner_insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_owner_update'
  ) THEN
    CREATE POLICY "profiles_owner_update" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_owner_delete'
  ) THEN
    CREATE POLICY "profiles_owner_delete" ON public.profiles FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- 4. Backfill existing users on substantive data only:
-- (trimmed non-empty text, non-empty arrays, and jsonb arrays with length > 0)

-- 4a. Backfill from candidate_profiles
INSERT INTO public.profiles (user_id, onboarding_completed_at, created_at)
SELECT 
  cp.user_id,
  COALESCE(cp.confirmed_at, cp.updated_at, cp.created_at, NOW()) AS onboarding_completed_at,
  COALESCE(cp.created_at, NOW()) AS created_at
FROM public.candidate_profiles cp
WHERE (
  cp.confirmed_at IS NOT NULL
  OR (cp.skills IS NOT NULL AND array_length(cp.skills, 1) > 0)
  OR (cp.raw_resume_text IS NOT NULL AND length(trim(cp.raw_resume_text)) > 0)
  OR (
    cp.experience_json IS NOT NULL 
    AND jsonb_typeof(cp.experience_json) = 'array' 
    AND jsonb_array_length(cp.experience_json) > 0
  )
)
ON CONFLICT (user_id) DO UPDATE
SET onboarding_completed_at = COALESCE(public.profiles.onboarding_completed_at, EXCLUDED.onboarding_completed_at);

-- 4b. Backfill from user_preferences (onboarding_completed = true only; partial roles do not count)
INSERT INTO public.profiles (user_id, onboarding_completed_at, created_at)
SELECT 
  up.user_id,
  COALESCE(up.updated_at, up.created_at, NOW()) AS onboarding_completed_at,
  COALESCE(up.created_at, NOW()) AS created_at
FROM public.user_preferences up
WHERE up.onboarding_completed = true
ON CONFLICT (user_id) DO UPDATE
SET onboarding_completed_at = COALESCE(public.profiles.onboarding_completed_at, EXCLUDED.onboarding_completed_at);

-- 4c. Backfill existing profiles rows with trimmed non-empty full_name or non-empty target_roles
UPDATE public.profiles
SET onboarding_completed_at = COALESCE(onboarding_completed_at, created_at, NOW())
WHERE onboarding_completed_at IS NULL
  AND (
    (full_name IS NOT NULL AND length(trim(full_name)) > 0)
    OR (target_roles IS NOT NULL AND array_length(target_roles, 1) > 0)
  );

-- 4d. Keep user_preferences.onboarding_completed in sync for backfilled users
UPDATE public.user_preferences up
SET onboarding_completed = true
FROM public.profiles p
WHERE up.user_id = p.user_id
  AND p.onboarding_completed_at IS NOT NULL
  AND up.onboarding_completed = false;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS onboarding_completed_at;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261115a_autorenew.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261115a_autorenew.sql
-- Status: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261115a_autorenew.sql
--
-- Auto-renewal persistence: SECURITY DEFINER RPCs to fulfil subscription paid cycles
-- (activated + charged), lifecycle events, and forward-migrates fulfil_payment_order to align lock order.
-- Applies to: public.subscriptions, public.payment_orders, public.plans, public.blocked_users, public.user_addon_credits, public.webhook_events
--
-- Safety & Transactional Guarantees:
--   1. Wrapped in a single atomic transaction (BEGIN ... COMMIT).
--   2. Guarded additive DDL: ensures payment_orders.metadata exists in the real schema.
--   3. Strict pre-flight checks: validates required tables and columns before defining functions.
--   4. Deadlock prevention: enforces advisory lock on user first, then subscriptions row, then order row everywhere.
--   5. Fail-closed rebind and monotonic watermark (normalized ms, greatest()) across paid and lifecycle events.
--   6. Strict mode check: stored mode unknown fails closed against live expected mode.
--   7. Timestamp gap guard: missing/NULL event timestamp cannot bypass existing watermark.
-- ============================================================================

BEGIN;

-- 1. Guarded additive DDL: add metadata column to payment_orders if missing in baseline schema
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. Pre-flight safety check: assert required tables and columns exist
DO $$
DECLARE
  missing_tbl text;
  missing_col text;
BEGIN
  -- Verify required tables exist
  FOR missing_tbl IN
    SELECT tbl
    FROM (VALUES
      ('subscriptions'),
      ('payment_orders'),
      ('plans'),
      ('blocked_users'),
      ('user_addon_credits'),
      ('webhook_events')
    ) AS req(tbl)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = req.tbl
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: table public.% does not exist', missing_tbl;
  END LOOP;

  -- Verify public.subscriptions columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES
      ('id'), ('user_id'), ('subscription_id'), ('plan_id'), ('provider'),
      ('status'), ('current_period_start'), ('current_period_end'),
      ('cancel_at_period_end'), ('grace_period_end'), ('metadata'),
      ('currency'), ('amount'), ('updated_at')
    ) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.subscriptions.% does not exist', missing_col;
  END LOOP;

  -- Verify public.payment_orders columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES
      ('id'), ('user_id'), ('provider_order_id'), ('provider'), ('mode'),
      ('status'), ('plan_code'), ('amount_paise'), ('paid_at'), ('metadata'), ('created_at')
    ) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_orders' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.payment_orders.% does not exist', missing_col;
  END LOOP;

  -- Verify public.plans columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('code'), ('is_active'), ('price_paise'), ('duration_days')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'plans' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.plans.% does not exist', missing_col;
  END LOOP;

  -- Verify public.blocked_users columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('user_id')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'blocked_users' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.blocked_users.% does not exist', missing_col;
  END LOOP;

  -- Verify public.user_addon_credits columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('user_id'), ('expires_at'), ('sets_remaining')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'user_addon_credits' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.user_addon_credits.% does not exist', missing_col;
  END LOOP;

  -- Verify public.webhook_events columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('event_id'), ('provider'), ('event_type')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.webhook_events.% does not exist', missing_col;
  END LOOP;
END;
$$;

-- Drop previous overloaded signatures
DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text);
DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text, text);
DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text, text, numeric);
DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text, text, numeric, numeric);

CREATE OR REPLACE FUNCTION public.fulfil_subscription_renewal(
  p_razorpay_subscription_id text,
  p_payment_id text,
  p_expected_mode text DEFAULT 'live',
  p_amount_paise numeric DEFAULT NULL,
  p_event_timestamp numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
DECLARE
  v_order record;
  v_sub record;
  v_updated_sub record;
  v_plan_row record;
  v_user_id uuid;
  v_plan_code text;
  v_duration int := 30;
  v_expected_amount int;
  v_mode text;
  v_base_time timestamptz;
  v_new_end timestamptz;
  v_period_start timestamptz;
  v_processed_payments jsonb;
  v_new_meta jsonb;
  v_has_sub boolean := false;
  v_curr_order_time timestamptz;
  v_is_valid_pending boolean := false;
  v_last_event_time numeric;
  v_incoming_ms numeric;
  v_stored_ms numeric;
  v_is_older_payment boolean := false;
  v_new_status text;
  v_new_cancel boolean;
  v_new_grace timestamptz;
BEGIN
  -- 0. Validate subscription ID input
  IF p_razorpay_subscription_id IS NULL OR trim(p_razorpay_subscription_id) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_SUBSCRIPTION_ID',
      'error', 'Subscription ID is required'
    );
  END IF;

  -- 1. Validate payment ID input (reject missing payment_id for any grant)
  IF p_payment_id IS NULL OR trim(p_payment_id) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MISSING_PAYMENT_ID',
      'error', 'Payment ID is required for subscription grant'
    );
  END IF;

  p_razorpay_subscription_id := trim(p_razorpay_subscription_id);
  p_payment_id := trim(p_payment_id);

  -- 2. Validate expected mode parameter (Strict: reject NULL or unknown mode)
  IF p_expected_mode IS NULL OR p_expected_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXPECTED_MODE',
      'error', 'Expected mode must be test or live'
    );
  END IF;

  -- 3. Discover user and pending/existing order from payment_orders
  SELECT * INTO v_order
  FROM public.payment_orders
  WHERE provider_order_id = p_razorpay_subscription_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_user_id := v_order.user_id;
  ELSE
    -- Fallback: check subscriptions table
    SELECT * INTO v_sub
    FROM public.subscriptions
    WHERE subscription_id = p_razorpay_subscription_id
       OR metadata->>'razorpay_subscription_id' = p_razorpay_subscription_id
       OR metadata->>'subscription_id' = p_razorpay_subscription_id
    LIMIT 1;

    IF FOUND THEN
      v_user_id := v_sub.user_id;
    END IF;
  END IF;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'SUBSCRIPTION_NOT_FOUND',
      'error', format('Subscription order not found for identifier: %s', p_razorpay_subscription_id)
    );
  END IF;

  -- 4. Advisory xact lock on user ID FIRST (deadlock prevention across all RPCs)
  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::text));

  -- 5. Lock and load authoritative subscriptions row for this user SECOND
  SELECT * INTO v_sub
  FROM public.subscriptions
  WHERE user_id = v_user_id
  FOR UPDATE;
  v_has_sub := FOUND;

  -- Also lock the payment order if found
  IF v_order.id IS NOT NULL THEN
    SELECT * INTO v_order
    FROM public.payment_orders
    WHERE id = v_order.id
    FOR UPDATE;
  END IF;

  -- 6. Provider Verification
  IF v_order.id IS NOT NULL AND v_order.provider IS NOT NULL AND v_order.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay subscription orders can be fulfilled'
    );
  END IF;
  IF v_has_sub AND v_sub.provider IS NOT NULL AND v_sub.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay subscription orders can be fulfilled'
    );
  END IF;

  -- 7. Mode Isolation Check
  -- Gap 2: NULL stored payment mode (order mode + subscription metadata both NULL)
  -- must NOT grant a live entitlement when p_expected_mode = live. Fail closed!
  v_mode := COALESCE(v_order.mode, v_sub.metadata->>'mode');
  IF v_mode IS NULL OR trim(v_mode) = '' THEN
    IF p_expected_mode = 'live' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'MODE_UNKNOWN',
        'error', 'Stored payment mode is missing or unknown; cannot grant live entitlement'
      );
    END IF;
  ELSIF v_mode <> p_expected_mode THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MODE_MISMATCH',
      'error', format('Order mode (%s) does not match expected fulfillment mode (%s)', v_mode, p_expected_mode)
    );
  END IF;

  -- 8. Server Ban Check (Fail-closed on blocked_users)
  IF EXISTS (SELECT 1 FROM public.blocked_users WHERE user_id = v_user_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'USER_BANNED',
      'error', 'Account is suspended'
    );
  END IF;

  -- 9. Test Mode Isolation: Mark order paid if needed, never grant live entitlement
  IF p_expected_mode = 'test' OR v_mode = 'test' THEN
    IF v_order.id IS NOT NULL AND v_order.status <> 'paid' THEN
      UPDATE public.payment_orders
      SET status = 'paid', paid_at = COALESCE(paid_at, now())
      WHERE id = v_order.id;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'test_mode', true,
      'is_pro', false,
      'already_paid', (v_order.status = 'paid'),
      'message', 'Test subscription cycle processed; zero real entitlements granted'
    );
  END IF;

  -- 10. Rebind Protection (Fail CLOSED):
  -- If incoming subscription id is not the currently bound mandate, only accept if it is
  -- a strictly newer single pending created order with verified order timestamp history.
  IF v_has_sub AND v_sub.subscription_id IS NOT NULL AND v_sub.subscription_id <> p_razorpay_subscription_id THEN
    v_is_valid_pending := false;
    IF v_order.id IS NOT NULL AND v_order.status = 'created' THEN
      SELECT created_at INTO v_curr_order_time
      FROM public.payment_orders
      WHERE provider_order_id = v_sub.subscription_id
      ORDER BY created_at DESC
      LIMIT 1;

      -- Fail CLOSED: require current order timestamp to be available AND new order strictly newer
      IF v_curr_order_time IS NOT NULL AND v_order.created_at > v_curr_order_time THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.payment_orders
          WHERE user_id = v_user_id
            AND status = 'created'
            AND id <> v_order.id
            AND created_at > v_order.created_at
        ) THEN
          v_is_valid_pending := true;
        END IF;
      END IF;
    END IF;

    IF NOT v_is_valid_pending THEN
      RETURN jsonb_build_object(
        'success', true,
        'ignored', true,
        'code', 'OLD_MANDATE_IGNORED',
        'reason', 'OLD_MANDATE_IGNORED',
        'message', format('Mandate %s is not current or pending; ignored', p_razorpay_subscription_id),
        'current_mandate', v_sub.subscription_id,
        'attempted_mandate', p_razorpay_subscription_id
      );
    END IF;
  END IF;

  -- 11. Idempotency on payment_id / cycle via payment-cycle ledger
  v_processed_payments := COALESCE(v_sub.metadata->'processed_payments', '[]'::jsonb);
  IF (v_has_sub AND (
        v_processed_payments ? p_payment_id OR
        v_sub.metadata->>'initial_payment_id' = p_payment_id OR
        v_sub.metadata->>'last_payment_id' = p_payment_id OR
        v_sub.metadata->>'last_renewal_payment_id' = p_payment_id
      ))
     OR (v_order.id IS NOT NULL AND v_order.status = 'paid' AND COALESCE(v_order.metadata->>'payment_id', '') = p_payment_id)
  THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'is_pro', true,
      'subscription_id', v_sub.id,
      'razorpay_subscription_id', p_razorpay_subscription_id,
      'user_id', v_user_id,
      'plan_id', v_sub.plan_id,
      'current_period_end', v_sub.current_period_end,
      'payment_id', p_payment_id,
      'amount', v_sub.amount,
      'message', 'Payment ID already processed for this cycle; zero duplicate extension'
    );
  END IF;

  -- 12. Monotonic watermark resolution (normalized to ms)
  -- A captured payment with an UNSEEN payment id that arrives older than the watermark
  -- must NOT be discarded. We credit it via the payment-cycle ledger while keeping
  -- the watermark monotonic with greatest().
  v_last_event_time := NULL;
  v_stored_ms := NULL;
  IF v_has_sub AND v_sub.metadata ? 'last_event_time' AND (v_sub.metadata->>'last_event_time') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_last_event_time := (v_sub.metadata->>'last_event_time')::numeric;
    v_stored_ms := CASE WHEN v_last_event_time >= 1e11 THEN round(v_last_event_time) ELSE round(v_last_event_time * 1000) END;
  END IF;

  v_incoming_ms := NULL;
  IF p_event_timestamp IS NOT NULL AND p_event_timestamp > 0 THEN
    v_incoming_ms := CASE WHEN p_event_timestamp >= 1e11 THEN round(p_event_timestamp) ELSE round(p_event_timestamp * 1000) END;
  END IF;

  -- Older or untimestamped payments credit time via ledger, but must NOT reset newer lifecycle state!
  v_is_older_payment := false;
  IF v_has_sub THEN
    IF v_incoming_ms IS NULL THEN
      v_is_older_payment := true;
    ELSIF v_stored_ms IS NOT NULL AND v_incoming_ms < v_stored_ms THEN
      v_is_older_payment := true;
    END IF;
  END IF;

  -- 13. Validate plan id and amount against configured plans
  v_plan_code := COALESCE(v_order.plan_code, v_sub.plan_id);
  IF v_plan_code IS NULL OR trim(v_plan_code) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MISSING_PLAN_CODE',
      'error', 'Subscription has no associated plan code'
    );
  END IF;

  SELECT * INTO v_plan_row
  FROM public.plans
  WHERE code = v_plan_code AND is_active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PLAN_CODE',
      'error', format('Plan code %s is not a valid active plan in catalog', v_plan_code)
    );
  END IF;

  v_expected_amount := v_plan_row.price_paise;

  -- Live cycle requirement: require p_amount_paise > 0 and equal to plan price.
  -- Zero fallback to pending order amount!
  IF p_expected_mode = 'live' THEN
    IF p_amount_paise IS NULL OR p_amount_paise <= 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'INVALID_PAYMENT_AMOUNT',
        'error', 'Payment amount in paise must be positive for live cycle'
      );
    END IF;

    IF p_amount_paise <> v_expected_amount THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'PLAN_AMOUNT_MISMATCH',
        'error', format('Payment amount %s does not match plan price %s for plan %s', p_amount_paise, v_expected_amount, v_plan_code)
      );
    END IF;
  END IF;

  -- Exact duration from configured plans table (7, 30, or 90 days)
  v_duration := v_plan_row.duration_days;
  IF v_duration NOT IN (7, 30, 90) THEN
    IF v_plan_code = 'weekly' THEN v_duration := 7;
    ELSIF v_plan_code = 'quarterly' THEN v_duration := 90;
    ELSE v_duration := 30;
    END IF;
  END IF;

  -- 14. Compute Period Extension from max(current_period_end, now())
  -- Preserve owed prepaid time across active, in_grace_period, past_due, trialing, etc.
  -- Active entitlement with 20 days left + subscription.pending + 7d renewal must yield 27 days, never 7!
  IF v_has_sub AND v_sub.current_period_end IS NOT NULL THEN
    v_base_time := greatest(v_sub.current_period_end, now());
  ELSE
    v_base_time := now();
  END IF;

  v_new_end := v_base_time + (v_duration * interval '1 day');
  -- Non-shortening guard
  IF v_has_sub AND v_sub.current_period_end IS NOT NULL AND v_new_end < v_sub.current_period_end THEN
    v_new_end := v_sub.current_period_end;
  END IF;

  v_period_start := COALESCE(v_sub.current_period_start, now());

  -- 15. Build updated metadata including monotonic last_event_time (normalized to ms)
  v_new_meta := COALESCE(v_sub.metadata, '{}'::jsonb);
  v_new_meta := jsonb_set(
    v_new_meta,
    '{processed_payments}',
    v_processed_payments || jsonb_build_array(p_payment_id),
    true
  );
  v_new_meta := jsonb_set(v_new_meta, '{last_payment_id}', to_jsonb(p_payment_id), true);
  v_new_meta := jsonb_set(v_new_meta, '{last_renewal_payment_id}', to_jsonb(p_payment_id), true);
  v_new_meta := jsonb_set(v_new_meta, '{last_paid_at}', to_jsonb(now()), true);
  v_new_meta := jsonb_set(v_new_meta, '{razorpay_subscription_id}', to_jsonb(p_razorpay_subscription_id), true);
  IF NOT (v_new_meta ? 'initial_payment_id') THEN
    v_new_meta := jsonb_set(v_new_meta, '{initial_payment_id}', to_jsonb(p_payment_id), true);
  END IF;

  -- Monotonic watermark: normalize to milliseconds before greatest() storage
  IF v_stored_ms IS NOT NULL THEN
    IF v_incoming_ms IS NOT NULL THEN
      v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(greatest(v_stored_ms, v_incoming_ms)), true);
    ELSE
      v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(v_stored_ms), true);
    END IF;
  ELSIF v_incoming_ms IS NOT NULL THEN
    v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(v_incoming_ms), true);
  END IF;

  -- 16. Upsert/Update subscriptions row (Store exact paise amount integer: 69200, 149900, 399900)
  -- Older unseen payments credit time but do NOT reset newer lifecycle state
  -- (cancel_at_period_end, status, grace_period_end are preserved)
  IF v_is_older_payment THEN
    v_new_status := COALESCE(v_sub.status, 'active');
    v_new_cancel := COALESCE(v_sub.cancel_at_period_end, false);
    v_new_grace := v_sub.grace_period_end;
  ELSE
    v_new_status := 'active';
    v_new_cancel := false;
    v_new_grace := NULL;
  END IF;

  IF v_has_sub THEN
    UPDATE public.subscriptions
    SET
      subscription_id = p_razorpay_subscription_id,
      plan_id = v_plan_code,
      provider = 'razorpay',
      status = v_new_status,
      current_period_start = v_period_start,
      current_period_end = v_new_end,
      cancel_at_period_end = v_new_cancel,
      grace_period_end = v_new_grace,
      metadata = v_new_meta,
      currency = 'INR',
      amount = v_expected_amount,
      updated_at = now()
    WHERE user_id = v_user_id
    RETURNING * INTO v_updated_sub;
  ELSE
    INSERT INTO public.subscriptions (
      user_id,
      subscription_id,
      plan_id,
      provider,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      metadata,
      currency,
      amount,
      updated_at
    ) VALUES (
      v_user_id,
      p_razorpay_subscription_id,
      v_plan_code,
      'razorpay',
      'active',
      v_period_start,
      v_new_end,
      false,
      v_new_meta,
      'INR',
      v_expected_amount,
      now()
    )
    RETURNING * INTO v_updated_sub;
  END IF;

  -- 17. Mark payment_orders row as paid
  IF v_order.id IS NOT NULL THEN
    UPDATE public.payment_orders
    SET
      status = 'paid',
      paid_at = COALESCE(paid_at, now()),
      metadata = jsonb_set(COALESCE(payment_orders.metadata, '{}'::jsonb), '{payment_id}', to_jsonb(p_payment_id), true)
    WHERE id = v_order.id;
  END IF;

  -- 18. Extend active unexpired add-on credits to match newly extended subscription period
  UPDATE public.user_addon_credits
  SET expires_at = v_new_end
  WHERE user_id = v_user_id
    AND expires_at >= now()
    AND sets_remaining > 0;

  -- 19. Return success payload
  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'is_pro', true,
    'subscription_id', v_updated_sub.id,
    'razorpay_subscription_id', p_razorpay_subscription_id,
    'user_id', v_user_id,
    'plan_id', v_plan_code,
    'duration_days', v_duration,
    'current_period_end', v_updated_sub.current_period_end,
    'payment_id', p_payment_id,
    'amount', v_updated_sub.amount
  );
END;
$$;

-- Drop previous lifecycle signatures
DROP FUNCTION IF EXISTS public.handle_subscription_lifecycle_event(text, text);
DROP FUNCTION IF EXISTS public.handle_subscription_lifecycle_event(text, text, numeric);
DROP FUNCTION IF EXISTS public.handle_subscription_lifecycle_event(text, text, numeric, text);

CREATE OR REPLACE FUNCTION public.handle_subscription_lifecycle_event(
  p_razorpay_subscription_id text,
  p_event_type text,
  p_event_timestamp numeric DEFAULT NULL,
  p_expected_mode text DEFAULT 'live'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
DECLARE
  v_sub record;
  v_updated_sub record;
  v_user_id uuid;
  v_mode text;
  v_order_mode text;
  v_last_event_time numeric;
  v_new_meta jsonb;
  v_incoming_ms numeric;
  v_stored_ms numeric;
BEGIN
  -- 0. Validate subscription ID
  IF p_razorpay_subscription_id IS NULL OR trim(p_razorpay_subscription_id) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_SUBSCRIPTION_ID',
      'error', 'Subscription ID is required'
    );
  END IF;

  p_razorpay_subscription_id := trim(p_razorpay_subscription_id);

  -- 1. Validate event type
  IF p_event_type NOT IN (
    'subscription.pending',
    'subscription.halted',
    'subscription.past_due',
    'subscription.cancelled',
    'subscription.canceled',
    'subscription.completed'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EVENT_TYPE',
      'error', format('Unsupported lifecycle event type: %s', p_event_type)
    );
  END IF;

  -- 2. Validate expected mode (Strict: reject NULL or unknown mode)
  IF p_expected_mode IS NULL OR p_expected_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXPECTED_MODE',
      'error', 'Expected mode must be test or live'
    );
  END IF;

  -- 3. Discover user_id for this mandate
  SELECT user_id INTO v_user_id
  FROM public.subscriptions
  WHERE subscription_id = p_razorpay_subscription_id
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT user_id INTO v_user_id
    FROM public.payment_orders
    WHERE provider_order_id = p_razorpay_subscription_id
    LIMIT 1;
  END IF;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'ignored', true,
      'reason', 'UNBOUND_MANDATE',
      'message', format('Mandate %s is not currently bound', p_razorpay_subscription_id)
    );
  END IF;

  -- 4. Advisory xact lock on user ID FIRST (deadlock prevention matching renewal lock order)
  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::text));

  -- 5. Lock and load authoritative subscriptions row strictly matching the currently bound mandate SECOND
  SELECT * INTO v_sub
  FROM public.subscriptions
  WHERE subscription_id = p_razorpay_subscription_id
  FOR UPDATE;

  -- Old or abandoned mandates must never touch a newer or prepaid entitlement
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'ignored', true,
      'reason', 'UNBOUND_MANDATE',
      'message', format('Mandate %s is not currently bound', p_razorpay_subscription_id)
    );
  END IF;

  -- 6. Provider check
  IF v_sub.provider IS NOT NULL AND v_sub.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay subscription events can be handled'
    );
  END IF;

  -- 7. Mode isolation check
  -- Gap 2: NULL stored payment mode must NOT grant a live entitlement or process live lifecycle event. Fail closed!
  v_mode := v_sub.metadata->>'mode';
  IF v_mode IS NULL THEN
    SELECT mode INTO v_order_mode
    FROM public.payment_orders
    WHERE provider_order_id = p_razorpay_subscription_id
    ORDER BY created_at DESC
    LIMIT 1;
    v_mode := v_order_mode;
  END IF;

  IF v_mode IS NULL OR trim(v_mode) = '' THEN
    IF p_expected_mode = 'live' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'MODE_UNKNOWN',
        'error', 'Subscription mode is missing or unknown; cannot process live lifecycle event'
      );
    END IF;
  ELSIF v_mode <> p_expected_mode THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MODE_MISMATCH',
      'error', format('Subscription mode (%s) does not match expected mode (%s)', v_mode, p_expected_mode)
    );
  END IF;

  -- 8. Server ban check
  IF EXISTS (SELECT 1 FROM public.blocked_users WHERE user_id = v_sub.user_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'USER_BANNED',
      'error', 'Account is suspended'
    );
  END IF;

  -- 9. Lifecycle ordering: Durable provider last-event timestamp check
  -- Gap 1: Missing/NULL event timestamp must NOT bypass the ordering check when a newer watermark exists.
  -- Gap 3: Normalize event timestamps to milliseconds BEFORE comparison and greatest() storage.
  v_last_event_time := NULL;
  IF v_sub.metadata ? 'last_event_time' AND (v_sub.metadata->>'last_event_time') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_last_event_time := (v_sub.metadata->>'last_event_time')::numeric;
  END IF;

  IF v_last_event_time IS NOT NULL THEN
    v_stored_ms := CASE WHEN v_last_event_time >= 1e11 THEN round(v_last_event_time) ELSE round(v_last_event_time * 1000) END;

    IF p_event_timestamp IS NULL OR p_event_timestamp <= 0 THEN
      RETURN jsonb_build_object(
        'success', true,
        'ignored', true,
        'code', 'OUT_OF_ORDER_EVENT',
        'reason', 'OUT_OF_ORDER_EVENT',
        'message', format('Missing event timestamp cannot bypass existing watermark %s ms', v_stored_ms),
        'subscription_id', p_razorpay_subscription_id,
        'last_event_time', v_stored_ms,
        'event_timestamp', p_event_timestamp
      );
    END IF;

    v_incoming_ms := CASE WHEN p_event_timestamp >= 1e11 THEN round(p_event_timestamp) ELSE round(p_event_timestamp * 1000) END;

    IF v_incoming_ms < v_stored_ms THEN
      RETURN jsonb_build_object(
        'success', true,
        'ignored', true,
        'code', 'OUT_OF_ORDER_EVENT',
        'reason', 'OUT_OF_ORDER_EVENT',
        'message', format('Event timestamp %s ms is older than stored last event time %s ms', v_incoming_ms, v_stored_ms),
        'subscription_id', p_razorpay_subscription_id,
        'last_event_time', v_stored_ms,
        'event_timestamp', p_event_timestamp
      );
    END IF;
  END IF;

  -- 10. Atomic DB transition with monotonic watermark (normalized ms stored)
  v_new_meta := COALESCE(v_sub.metadata, '{}'::jsonb);
  IF p_event_timestamp IS NOT NULL AND p_event_timestamp > 0 THEN
    v_incoming_ms := CASE WHEN p_event_timestamp >= 1e11 THEN round(p_event_timestamp) ELSE round(p_event_timestamp * 1000) END;
    IF v_stored_ms IS NOT NULL THEN
      v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(greatest(v_stored_ms, v_incoming_ms)), true);
    ELSE
      v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(v_incoming_ms), true);
    END IF;
  END IF;
  v_new_meta := jsonb_set(v_new_meta, '{last_lifecycle_event}', to_jsonb(p_event_type), true);

  UPDATE public.subscriptions
  SET
    status = CASE
      WHEN p_event_type = 'subscription.pending' THEN 'in_grace_period'
      WHEN p_event_type IN ('subscription.halted', 'subscription.past_due') THEN 'past_due'
      ELSE status
    END,
    grace_period_end = CASE
      WHEN p_event_type = 'subscription.pending' THEN now() + interval '7 days'
      WHEN p_event_type IN ('subscription.halted', 'subscription.past_due') THEN NULL
      ELSE grace_period_end
    END,
    cancel_at_period_end = CASE
      WHEN p_event_type IN ('subscription.cancelled', 'subscription.canceled', 'subscription.completed') THEN true
      ELSE cancel_at_period_end
    END,
    metadata = v_new_meta,
    updated_at = now()
  WHERE id = v_sub.id
    AND subscription_id = p_razorpay_subscription_id
  RETURNING * INTO v_updated_sub;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'ignored', true,
      'reason', 'MANDATE_CHANGED',
      'message', 'Subscription mandate changed concurrently; ignored'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'applied', true,
    'event_type', p_event_type,
    'subscription_id', v_updated_sub.subscription_id,
    'status', v_updated_sub.status,
    'cancel_at_period_end', v_updated_sub.cancel_at_period_end,
    'grace_period_end', v_updated_sub.grace_period_end,
    'user_id', v_updated_sub.user_id,
    'last_event_time', v_updated_sub.metadata->'last_event_time'
  );
END;
$$;

-- Strict ACL: Revoke from public/anon/authenticated and grant only to service_role
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) FROM public;
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) TO service_role;
ALTER FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) SET search_path = public;
ALTER FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) SET statement_timeout = '15s';

REVOKE ALL ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) FROM public;
REVOKE ALL ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) FROM anon;
REVOKE ALL ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) TO service_role;
ALTER FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) SET search_path = public;
ALTER FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) SET statement_timeout = '15s';

-- ============================================================================
-- FORWARD MIGRATION: Align prepaid fulfil_payment_order lock order
-- Replaces definition from 20261114a_payment_plan_stack_guard.sql to enforce
-- the identical global lock order: (1) advisory lock on user, (2) subscriptions,
-- (3) payment_orders.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fulfil_payment_order(
  p_provider_order_id text,
  p_user_id uuid,
  p_expected_mode text DEFAULT 'live'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
DECLARE
  v_order record;
  v_existing_sub record;
  v_sub record;
  v_existing_credit record;
  v_credit record;
  v_duration int;
  v_sets int;
  v_validity int;
  v_new_end timestamptz;
  v_period_start timestamptz;
  v_base_time timestamptz;
  v_prev_order_id uuid;
  v_prev_order_created timestamptz;
  v_label_plan text;
  v_label_currency text;
  v_label_amount numeric;
  v_label_meta jsonb;
  v_has_sub boolean;
BEGIN
  -- Validate expected mode parameter
  IF p_expected_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXPECTED_MODE',
      'error', 'Expected mode must be either test or live'
    );
  END IF;

  -- 1. Advisory xact lock on user ID FIRST (deadlock prevention across all RPCs)
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 2. Lock authoritative subscriptions row for this user SECOND
  SELECT * INTO v_existing_sub
  FROM public.subscriptions
  WHERE user_id = p_user_id
  FOR UPDATE;
  v_has_sub := FOUND;

  -- 3. Lock the order row for update THIRD
  SELECT * INTO v_order
  FROM public.payment_orders
  WHERE provider_order_id = p_provider_order_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_FOUND',
      'error', 'Payment order not found for user'
    );
  END IF;

  -- 4. Provider verification
  IF v_order.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay provider orders can be fulfilled via this function'
    );
  END IF;

  -- 5. Fail-closed Mode Check: Order mode must match expected fulfillment mode
  IF v_order.mode <> p_expected_mode THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MODE_MISMATCH',
      'error', format('Order mode (%s) does not match fulfillment mode (%s)', v_order.mode, p_expected_mode)
    );
  END IF;

  -- 6. Verify state is valid (created or paid-retry)
  IF v_order.status NOT IN ('created', 'paid') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_INVALID_STATE',
      'error', 'Payment order is not in created or paid state'
    );
  END IF;

  -- 7. TEST MODE ISOLATION: Zero real entitlements granted
  IF v_order.mode = 'test' THEN
    IF v_order.status = 'paid' THEN
      RETURN jsonb_build_object(
        'success', true,
        'test_mode', true,
        'is_pro', false,
        'already_paid', true,
        'order_id', v_order.id,
        'message', 'Test order already verified and marked as paid'
      );
    END IF;

    -- Mark test order paid, NEVER touch subscriptions or user_addon_credits
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'test_mode', true,
      'is_pro', false,
      'order_id', v_order.id,
      'already_paid', false,
      'message', 'Test payment verified; zero real entitlements granted'
    );
  END IF;

  -- 8. LIVE MODE: Idempotency check for already fulfilled live orders
  IF v_order.status = 'paid' THEN
    IF v_order.plan_code IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_paid', true,
        'is_pro', true,
        'type', 'plan',
        'plan_code', v_order.plan_code,
        'order_id', v_order.id,
        'period_end', v_existing_sub.current_period_end,
        'message', 'Order already fulfilled and marked as paid'
      );
    ELSIF v_order.addon_code IS NOT NULL THEN
      SELECT * INTO v_existing_credit
      FROM public.user_addon_credits
      WHERE order_id = v_order.id;

      RETURN jsonb_build_object(
        'success', true,
        'already_paid', true,
        'is_pro', false,
        'type', 'addon',
        'addon_code', v_order.addon_code,
        'order_id', v_order.id,
        'credit_id', v_existing_credit.id,
        'expires_at', v_existing_credit.expires_at,
        'message', 'Order already fulfilled and marked as paid'
      );
    END IF;
  END IF;

  -- 9. Live Fulfillment Path A: Subscription Plan purchase / renewal / upgrade
  IF v_order.plan_code IS NOT NULL THEN
    SELECT duration_days INTO v_duration
    FROM public.plans
    WHERE code = v_order.plan_code;

    IF v_duration IS NULL OR v_duration <= 0 THEN
      IF v_order.plan_code = 'weekly' THEN
        v_duration := 7;
      ELSIF v_order.plan_code = 'quarterly' THEN
        v_duration := 90;
      ELSE
        v_duration := 30;
      END IF;
    END IF;

    -- Default: label (plan/currency/amount/metadata) comes from this order
    v_label_plan := v_order.plan_code;
    v_label_currency := v_order.currency;
    v_label_amount := v_order.amount_paise;
    v_label_meta := jsonb_build_object(
      'provider_order_id', p_provider_order_id,
      'payment_order_id', v_order.id,
      'mode', v_order.mode
    );

    IF v_has_sub AND (v_existing_sub.status IN ('active', 'trialing')) AND v_existing_sub.current_period_end IS NOT NULL THEN
      v_period_start := coalesce(v_existing_sub.current_period_start, now());

      -- Which order produced the current label?
      v_prev_order_id := NULL;
      IF (v_existing_sub.metadata->>'payment_order_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_prev_order_id := (v_existing_sub.metadata->>'payment_order_id')::uuid;
      END IF;

      IF v_prev_order_id IS NOT NULL AND v_prev_order_id = v_order.id THEN
        -- This order already produced the current subscription state: never extend twice
        v_new_end := v_existing_sub.current_period_end;
      ELSE
        -- Different order stacked on an active plan: period extends from max(current_period_end, now)
        v_base_time := greatest(v_existing_sub.current_period_end, now());
        v_new_end := v_base_time + (v_duration * interval '1 day');
        -- Never shorten existing period
        IF v_new_end < v_existing_sub.current_period_end THEN
          v_new_end := v_existing_sub.current_period_end;
        END IF;

        -- plan_id/currency/amount/metadata are written only from the NEWER order (by created_at).
        -- Missing/unknown previous-order metadata or equal timestamps keep the existing label.
        v_prev_order_created := NULL;
        IF v_prev_order_id IS NOT NULL THEN
          SELECT created_at INTO v_prev_order_created
          FROM public.payment_orders
          WHERE id = v_prev_order_id
            AND user_id = p_user_id;
        END IF;

        IF v_prev_order_created IS NULL OR NOT (v_order.created_at > v_prev_order_created) THEN
          v_label_plan := v_existing_sub.plan_id;
          v_label_currency := v_existing_sub.currency;
          v_label_amount := v_existing_sub.amount;
          v_label_meta := v_existing_sub.metadata;
        END IF;
      END IF;
    ELSE
      -- Expired or no previous subscription: period end = now + duration, label from this order
      v_period_start := now();
      v_new_end := now() + (v_duration * interval '1 day');
    END IF;

    -- Grant subscription entitlement FIRST
    INSERT INTO public.subscriptions (
      user_id,
      plan_id,
      provider,
      currency,
      amount,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      metadata,
      updated_at
    ) VALUES (
      p_user_id,
      v_label_plan,
      'razorpay',
      v_label_currency,
      v_label_amount,
      'active',
      v_period_start,
      v_new_end,
      false,
      v_label_meta,
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      plan_id = EXCLUDED.plan_id,
      currency = EXCLUDED.currency,
      amount = EXCLUDED.amount,
      status = 'active',
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      cancel_at_period_end = false,
      metadata = EXCLUDED.metadata,
      updated_at = now()
    RETURNING * INTO v_sub;

    -- Also extend active unexpired add-on credits to match newly extended subscription period
    UPDATE public.user_addon_credits
    SET expires_at = v_new_end
    WHERE user_id = p_user_id
      AND expires_at >= now()
      AND sets_remaining > 0;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'is_pro', true,
      'type', 'plan',
      'plan_code', v_order.plan_code,
      'order_id', v_order.id,
      'period_end', v_sub.current_period_end
    );
  END IF;

  -- 10. Live Fulfillment Path B: Add-on pack purchase
  IF v_order.addon_code IS NOT NULL THEN
    SELECT sets, validity_days INTO v_sets, v_validity
    FROM public.addon_packs
    WHERE code = v_order.addon_code;

    IF v_sets IS NULL OR v_sets <= 0 THEN
      IF v_order.addon_code = 'addon_30' THEN
        v_sets := 30;
      ELSIF v_order.addon_code = 'addon_60' THEN
        v_sets := 60;
      ELSE
        v_sets := 10;
      END IF;
    END IF;

    -- Active subscription check (v_existing_sub already locked at step 2)
    IF NOT v_has_sub OR v_existing_sub.status NOT IN ('active', 'trialing') OR v_existing_sub.current_period_end IS NULL OR v_existing_sub.current_period_end <= now() THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'PRO_REQUIRED',
        'error', 'Active Pro subscription required to activate add-on credits'
      );
    END IF;

    v_new_end := v_existing_sub.current_period_end;

    -- Grant add-on credit entitlement FIRST
    INSERT INTO public.user_addon_credits (
      user_id,
      pack_code,
      sets_total,
      sets_remaining,
      expires_at,
      order_id,
      created_at
    ) VALUES (
      p_user_id,
      v_order.addon_code,
      v_sets,
      v_sets,
      v_new_end,
      v_order.id,
      now()
    )
    ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_credit;

    IF NOT FOUND THEN
      SELECT * INTO v_credit
      FROM public.user_addon_credits
      WHERE order_id = v_order.id;
    END IF;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'is_pro', false,
      'type', 'addon',
      'addon_code', v_order.addon_code,
      'order_id', v_order.id,
      'sets_granted', v_sets,
      'credit_id', v_credit.id,
      'expires_at', v_credit.expires_at
    );
  END IF;

  RETURN jsonb_build_object(
    'success', false,
    'code', 'ORDER_ITEM_MISSING',
    'error', 'Order contains neither plan_code nor addon_code'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fulfil_payment_order(text, uuid, text) TO service_role;
ALTER FUNCTION public.fulfil_payment_order(text, uuid, text) SET search_path = public;
ALTER FUNCTION public.fulfil_payment_order(text, uuid, text) SET statement_timeout = '15s';

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.handle_subscription_lifecycle_event(text, text, numeric, text);
--   DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text, text, numeric, numeric);
--   Restore public.fulfil_payment_order(text, uuid, text) from 20261114a_payment_plan_stack_guard.sql
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261116b_ten_million_system_design_schema.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261116b_ten_million_system_design_schema.sql
-- STATUS: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261116b_ten_million_system_design_schema
--
-- Purpose:
--   10M System Design Database Schema (Document 1, Sections 3.1 to 3.5):
--   3.1 PostgreSQL Enums & Custom Domain Types (ingestion_source_type,
--       ingestion_status, job_posting_status, role_category_type,
--       company_category_type, search_outbox_status, user_consent_type)
--   3.2 Internal Ingestion Schema & Tables (ingestion_sources,
--       job_source_records, company_aliases, search_outbox, category_overrides)
--       STRICTLY isolated and hidden from PostgREST (anon/authenticated revoked)
--   3.3 High-Scale Data Model (companies columns, jobs columns, dedicated
--       job_postings table, job_postings_public view, expanded job_descriptions)
--   3.4 High-Throughput Feed Indexes (B-tree, composite, partial, and GIN)
--   3.5 User Accounting & Privacy Tables (saved_jobs, ai_generations,
--       consent_logs, user_age_attestations) with strict Row Level Security (RLS)
--
-- Architectural Ownership & Coordination Note:
--   PR #642 owns: scraper worker, 4-category classification endpoints, and
--                 merge_job_by_dedupe_priority() trigger on public.jobs.
--   PR #643 owns: internal_ingestion schema, dedicated public.job_postings table,
--                 public.job_postings_public view, canonical (source_id, source_job_id)
--                 identity, Section 3.1 enums, and user accounting/privacy tables.
--   Both migrations are idempotent and guarded by IF NOT EXISTS, allowing safe
--   application in either order (642 then 643, or 643 then 642).
-- ============================================================================

-- ============================================================================
-- PRE-CHECK SQL (run before applying migration to verify environment readiness)
-- ============================================================================
-- SELECT 'PostgreSQL Version' AS check_item, version() AS status
-- UNION ALL
-- SELECT 'pgcrypto Extension', CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN 'INSTALLED' ELSE 'NOT INSTALLED (will be created)' END
-- UNION ALL
-- SELECT 'internal_ingestion Schema', CASE WHEN EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'internal_ingestion') THEN 'ALREADY EXISTS' ELSE 'READY TO CREATE' END
-- UNION ALL
-- SELECT 'public.companies Table', CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'companies') THEN 'EXISTS' ELSE 'MISSING' END
-- UNION ALL
-- SELECT 'public.jobs Table', CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'jobs') THEN 'EXISTS' ELSE 'MISSING' END
-- UNION ALL
-- SELECT 'public.job_descriptions Table', CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'job_descriptions') THEN 'EXISTS' ELSE 'READY TO CREATE' END
-- UNION ALL
-- SELECT 'public.saved_jobs Table', CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'saved_jobs') THEN 'EXISTS' ELSE 'READY TO CREATE' END;
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. SECTION 3.1: ENUMS & CUSTOM TYPES
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ingestion_source_type') THEN
    CREATE TYPE ingestion_source_type AS ENUM (
      'ats',
      'aggregator',
      'board',
      'career_page',
      'api'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ingestion_status') THEN
    CREATE TYPE ingestion_status AS ENUM (
      'pending',
      'running',
      'success',
      'failed',
      'rate_limited'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_posting_status') THEN
    CREATE TYPE job_posting_status AS ENUM (
      'active',
      'expired',
      'deleted',
      'draft',
      'pending_review'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'role_category_type') THEN
    CREATE TYPE role_category_type AS ENUM (
      'SDE',
      'AI_ML',
      'CLOUD',
      'DATA',
      'OTHER'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'company_category_type') THEN
    CREATE TYPE company_category_type AS ENUM (
      'MNC_BIGTECH',
      'HIGH_PRODUCT_YC',
      'OTHER_STARTUPS',
      'INDIAN_IT_AND_OTHER'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'search_outbox_status') THEN
    CREATE TYPE search_outbox_status AS ENUM (
      'pending',
      'processing',
      'completed',
      'failed',
      'dead_letter'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_consent_type') THEN
    CREATE TYPE user_consent_type AS ENUM (
      'cookies',
      'marketing',
      'analytics',
      'data_sharing',
      'terms_of_service',
      'privacy_policy'
    );
  END IF;
END $$;

-- ============================================================================
-- 2. SECTION 3.2: INTERNAL_INGESTION SCHEMA & TABLES (POSTGREST ISOLATED)
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS internal_ingestion;

-- Ensure internal_ingestion is NEVER accessible via PostgREST / client APIs:
-- Revoke all permissions from anon, authenticated, and public roles
REVOKE ALL ON SCHEMA internal_ingestion FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA internal_ingestion REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA internal_ingestion REVOKE ALL ON ROUTINES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA internal_ingestion REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

-- Grant strictly to service_role (backend worker / internal scraper)
GRANT USAGE, CREATE ON SCHEMA internal_ingestion TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA internal_ingestion GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA internal_ingestion GRANT ALL ON ROUTINES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA internal_ingestion GRANT ALL ON SEQUENCES TO service_role;

-- 2.1 INGESTION SOURCES (Provider configs, rate limits, health)
CREATE TABLE IF NOT EXISTS internal_ingestion.ingestion_sources (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  slug                   text UNIQUE NOT NULL,
  source_type            text NOT NULL,
  base_url               text,
  rate_limit_rps         numeric(5, 2) DEFAULT 2.00 NOT NULL,
  rate_limit_rpm         integer DEFAULT 120 NOT NULL,
  concurrency_limit      integer DEFAULT 5 NOT NULL,
  is_active              boolean DEFAULT true NOT NULL,
  headers                jsonb DEFAULT '{}'::jsonb NOT NULL,
  credentials_vault_key  text,
  failure_count          integer DEFAULT 0 NOT NULL,
  last_run_at            timestamptz,
  last_success_at        timestamptz,
  status                 text DEFAULT 'idle' NOT NULL,
  metadata               jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at             timestamptz DEFAULT now() NOT NULL,
  updated_at             timestamptz DEFAULT now() NOT NULL
);

-- 2.2 RAW JOB SOURCE RECORDS (Immutable staging before deduplication)
CREATE TABLE IF NOT EXISTS internal_ingestion.job_source_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           uuid REFERENCES internal_ingestion.ingestion_sources(id) ON DELETE CASCADE,
  external_job_id     text NOT NULL,
  raw_payload         jsonb NOT NULL,
  dedupe_hash         text,
  ingestion_batch_id  text,
  fetched_at          timestamptz DEFAULT now() NOT NULL,
  processed_at        timestamptz,
  status              text DEFAULT 'pending' NOT NULL,
  error_message       text,
  created_at          timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT job_source_records_source_external_key UNIQUE (source_id, external_job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_source_records_dedupe_hash
  ON internal_ingestion.job_source_records (dedupe_hash)
  WHERE dedupe_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_job_source_records_status_fetched
  ON internal_ingestion.job_source_records (status, fetched_at);

CREATE INDEX IF NOT EXISTS idx_job_source_records_batch
  ON internal_ingestion.job_source_records (ingestion_batch_id)
  WHERE ingestion_batch_id IS NOT NULL;

-- 2.3 COMPANY ALIASES (Feed name normalization to canonical companies)
CREATE TABLE IF NOT EXISTS internal_ingestion.company_aliases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_name              text NOT NULL,
  normalized_name       text NOT NULL,
  canonical_company_id  uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  confidence_score      numeric(3, 2) DEFAULT 1.00 NOT NULL,
  source                text,
  created_at            timestamptz DEFAULT now() NOT NULL,
  updated_at            timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT company_aliases_raw_name_key UNIQUE (raw_name)
);

CREATE INDEX IF NOT EXISTS idx_company_aliases_normalized_name
  ON internal_ingestion.company_aliases (normalized_name);

CREATE INDEX IF NOT EXISTS idx_company_aliases_canonical_id
  ON internal_ingestion.company_aliases (canonical_company_id)
  WHERE canonical_company_id IS NOT NULL;

-- 2.4 SEARCH OUTBOX (CDC / Outbox table for asynchronous vector and full-text search indexing)
CREATE TABLE IF NOT EXISTS internal_ingestion.search_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  payload         jsonb NOT NULL,
  status          text DEFAULT 'pending' NOT NULL,
  retry_count     integer DEFAULT 0 NOT NULL,
  max_retries     integer DEFAULT 5 NOT NULL,
  last_error      text,
  locked_at       timestamptz,
  locked_by       text,
  processed_at    timestamptz,
  created_at      timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_outbox_pending
  ON internal_ingestion.search_outbox (status, created_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_search_outbox_aggregate
  ON internal_ingestion.search_outbox (aggregate_type, aggregate_id);

-- 2.5 CATEGORY OVERRIDES (Deterministic pattern-matching override rules)
CREATE TABLE IF NOT EXISTS internal_ingestion.category_overrides (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern               text NOT NULL,
  match_field           text DEFAULT 'title' NOT NULL,
  rule_type             text DEFAULT 'regex' NOT NULL,
  target_category       text,
  target_role_category  text,
  priority              integer DEFAULT 100 NOT NULL,
  is_active             boolean DEFAULT true NOT NULL,
  created_by            text DEFAULT 'system' NOT NULL,
  created_at            timestamptz DEFAULT now() NOT NULL,
  updated_at            timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT category_overrides_pattern_field_rule_key UNIQUE (pattern, match_field, rule_type)
);

CREATE INDEX IF NOT EXISTS idx_category_overrides_priority
  ON internal_ingestion.category_overrides (is_active, priority);

-- Enforce zero PostgREST exposure on newly created internal tables
REVOKE ALL ON ALL TABLES IN SCHEMA internal_ingestion FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA internal_ingestion TO service_role;

-- ============================================================================
-- 3. SECTION 3.3: COMPANIES, JOBS, JOB_POSTINGS & JOB_DESCRIPTIONS
-- ============================================================================

-- 3.1 PUBLIC.COMPANIES UPDATES (Preserves existing data, adds without drop)
CREATE TABLE IF NOT EXISTS public.companies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  slug             text UNIQUE NOT NULL,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS canonical_domain text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS headquarters text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS employee_count_range text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founded_year integer;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS linkedin_url text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS twitter_url text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS is_verified boolean DEFAULT false;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'companies_category_check'
      AND conrelid = 'public.companies'::regclass
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_category_check
      CHECK (category IS NULL OR category IN ('MNC_BIGTECH', 'HIGH_PRODUCT_YC', 'OTHER_STARTUPS', 'INDIAN_IT_AND_OTHER'))
      NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_slug_uniq
  ON public.companies (slug);

CREATE INDEX IF NOT EXISTS idx_companies_category
  ON public.companies (category)
  WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_canonical_domain
  ON public.companies (canonical_domain)
  WHERE canonical_domain IS NOT NULL;

-- 3.2 PUBLIC.JOBS EXPANSION
-- NOTE ON JOBS.CATEGORY:
-- Existing public.jobs.category holds job functional disciplines (e.g. 'engineering', 'ai', 'data').
-- We strictly DO NOT attach company bucket check constraints to jobs.category to prevent breaking
-- existing production data or application routes. Company buckets are placed on companies.category
-- and job_postings.company_category (or jobs.company_category).
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS role_category text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS company_category text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS top_keywords text[] DEFAULT '{}'::text[];
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS country_code text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_id uuid REFERENCES internal_ingestion.ingestion_sources(id) ON DELETE SET NULL;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_job_id text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS dedupe_hash text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS is_remote boolean DEFAULT false;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS posted_at timestamptz DEFAULT now();
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS last_seen_at timestamptz DEFAULT now();
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_priority smallint DEFAULT 2;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS workplace_type text DEFAULT 'onsite';
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS employment_type text DEFAULT 'full-time';
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS department text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS min_experience_years integer;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS max_experience_years integer;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS currency text DEFAULT 'INR';
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS salary_min numeric(12, 2);
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS salary_max numeric(12, 2);
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS salary_period text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS logo_url text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_role_category_check'
      AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_role_category_check
      CHECK (role_category IS NULL OR role_category IN ('SDE', 'AI_ML', 'CLOUD', 'DATA', 'OTHER'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_company_category_check'
      AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_company_category_check
      CHECK (company_category IS NULL OR company_category IN ('MNC_BIGTECH', 'HIGH_PRODUCT_YC', 'OTHER_STARTUPS', 'INDIAN_IT_AND_OTHER'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_source_priority_check'
      AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_source_priority_check
      CHECK (source_priority IS NULL OR source_priority IN (1, 2))
      NOT VALID;
  END IF;
END $$;

-- 3.3 HIGH-VOLUME DEDICATED JOB_POSTINGS TABLE
CREATE TABLE IF NOT EXISTS public.job_postings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             uuid REFERENCES internal_ingestion.ingestion_sources(id) ON DELETE SET NULL,
  company_id            uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  legacy_job_id         uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  title                 text NOT NULL,
  company_name          text NOT NULL,
  company_slug          text,
  role_category         text,
  company_category      text,
  category              text,
  top_keywords          text[] DEFAULT '{}'::text[],
  location              text,
  country               text,
  country_code          text,
  city                  text,
  is_remote             boolean DEFAULT false NOT NULL,
  workplace_type        text DEFAULT 'onsite',
  employment_type       text DEFAULT 'full-time',
  seniority             text,
  min_experience_years  integer,
  max_experience_years  integer,
  currency              text DEFAULT 'INR',
  salary_min            numeric(12, 2),
  salary_max            numeric(12, 2),
  salary_period         text,
  salary_text           text,
  direct_apply_url      text,
  source_url            text,
  source_type           text,
  source_priority       smallint DEFAULT 2,
  external_id           text,
  dedupe_hash           text,
  raw_payload           jsonb,
  status                text DEFAULT 'active' NOT NULL,
  is_active             boolean DEFAULT true NOT NULL,
  verified              boolean DEFAULT false NOT NULL,
  first_seen_at         timestamptz DEFAULT now() NOT NULL,
  last_seen_at          timestamptz DEFAULT now() NOT NULL,
  posted_at             timestamptz DEFAULT now() NOT NULL,
  expires_at            timestamptz,
  created_at            timestamptz DEFAULT now() NOT NULL,
  updated_at            timestamptz DEFAULT now() NOT NULL,
  deleted_at            timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'job_postings_role_category_check'
      AND conrelid = 'public.job_postings'::regclass
  ) THEN
    ALTER TABLE public.job_postings
      ADD CONSTRAINT job_postings_role_category_check
      CHECK (role_category IS NULL OR role_category IN ('SDE', 'AI_ML', 'CLOUD', 'DATA', 'OTHER'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'job_postings_company_category_check'
      AND conrelid = 'public.job_postings'::regclass
  ) THEN
    ALTER TABLE public.job_postings
      ADD CONSTRAINT job_postings_company_category_check
      CHECK (company_category IS NULL OR company_category IN ('MNC_BIGTECH', 'HIGH_PRODUCT_YC', 'OTHER_STARTUPS', 'INDIAN_IT_AND_OTHER'))
      NOT VALID;
  END IF;
END $$;

-- 3.4 JOB DESCRIPTIONS EXPANSION
CREATE TABLE IF NOT EXISTS public.job_descriptions (
  job_id           uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  description_text text,
  updated_at       timestamptz DEFAULT now()
);

ALTER TABLE public.job_descriptions ADD COLUMN IF NOT EXISTS posting_id uuid REFERENCES public.job_postings(id) ON DELETE CASCADE;
ALTER TABLE public.job_descriptions ADD COLUMN IF NOT EXISTS skills text[] DEFAULT '{}'::text[];
ALTER TABLE public.job_descriptions ADD COLUMN IF NOT EXISTS requirements text[] DEFAULT '{}'::text[];
ALTER TABLE public.job_descriptions ADD COLUMN IF NOT EXISTS responsibilities text[] DEFAULT '{}'::text[];
ALTER TABLE public.job_descriptions ADD COLUMN IF NOT EXISTS benefits text[] DEFAULT '{}'::text[];
ALTER TABLE public.job_descriptions ADD COLUMN IF NOT EXISTS clean_text text;
ALTER TABLE public.job_descriptions ADD COLUMN IF NOT EXISTS raw_html text;
ALTER TABLE public.job_descriptions ADD COLUMN IF NOT EXISTS markdown_text text;
ALTER TABLE public.job_descriptions ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_job_descriptions_posting_id
  ON public.job_descriptions (posting_id)
  WHERE posting_id IS NOT NULL;

-- ============================================================================
-- 4. SECTION 3.4: HIGH-THROUGHPUT FEED INDEXES & SAFE UNIQUE KEYS
-- ============================================================================

-- Feed partial indexes on public.jobs
CREATE INDEX IF NOT EXISTS idx_jobs_active_category
  ON public.jobs (category)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_jobs_active_role_category
  ON public.jobs (role_category)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_jobs_active_country
  ON public.jobs (country, country_code)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_jobs_active_posted_at_desc
  ON public.jobs (posted_at DESC)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_jobs_active_category_country_posted_at
  ON public.jobs (category, country, posted_at DESC)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_jobs_active_role_category_posted_at
  ON public.jobs (role_category, posted_at DESC)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_jobs_active_is_remote
  ON public.jobs (is_remote)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_jobs_top_keywords_gin
  ON public.jobs USING gin (top_keywords)
  WHERE is_active = TRUE;

-- REHEARSAL REPAIR (docs/10m-schema-step1-rehearsal.md, blocker 1):
-- idx_jobs_active_dedupe_hash_uniq is intentionally NOT created. Repair #645
-- (20261116d) drops it as a destructive index: after #645 dedupe_hash is an
-- advisory similarity hash, and the same posting may be active from two sources.
-- On the populated post-#645 rehearsal DB this CREATE UNIQUE INDEX failed
-- ("could not create unique index"), aborting the whole migration; had it
-- succeeded, it would reject legitimate cross-source rows at ingest time.

-- ----------------------------------------------------------------------------
-- CROSS-VENDOR UNIQUE CONSTRAINT SAFEGUARD (jobs table)
-- Why (source_id, source_job_id) instead of (source_type, source_job_id):
-- source_type is a generic category (e.g. 'ats', 'direct', 'aggregator').
-- Multiple distinct ATS vendors (Greenhouse, Lever, Ashby) and company boards share
-- the same source_type and generate overlapping short IDs (e.g. job ID '101'
-- exists simultaneously on multiple distinct company boards).
-- Enforcing UNIQUE (source_type, source_job_id) would drop legitimate distinct jobs.
-- Scoping uniqueness to (source_id, source_job_id) and vendor key (source, source_job_id)
-- guarantees uniqueness per ingestion source / vendor board without cross-vendor collision.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_id_source_job_id_uniq
  ON public.jobs (source_id, source_job_id)
  WHERE source_id IS NOT NULL AND source_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_vendor_source_job_id_uniq
  ON public.jobs (source, source_job_id)
  WHERE source IS NOT NULL AND source_job_id IS NOT NULL;

-- Feed indexes on dedicated public.job_postings
CREATE INDEX IF NOT EXISTS idx_job_postings_active_feed
  ON public.job_postings (role_category, company_category, posted_at DESC)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_job_postings_active_country
  ON public.job_postings (country_code, posted_at DESC)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_job_postings_active_company
  ON public.job_postings (company_id, posted_at DESC)
  WHERE is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_postings_active_dedupe_hash_uniq
  ON public.job_postings (dedupe_hash)
  WHERE is_active = TRUE AND dedupe_hash IS NOT NULL;

-- Cross-vendor unique index on job_postings:
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_postings_source_id_external_id_uniq
  ON public.job_postings (source_id, external_id)
  WHERE source_id IS NOT NULL AND external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_job_postings_top_keywords_gin
  ON public.job_postings USING gin (top_keywords)
  WHERE is_active = TRUE;

-- ============================================================================
-- 5. SECTION 3.5: USER TABLES & ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

-- 5.1 SAVED JOBS (Preserves existing table from migration 20261031)
CREATE TABLE IF NOT EXISTS public.saved_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id          uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_jobs_user_id_job_id_key UNIQUE (user_id, job_id)
);

ALTER TABLE public.saved_jobs ADD COLUMN IF NOT EXISTS job_posting_id uuid REFERENCES public.job_postings(id) ON DELETE CASCADE;
ALTER TABLE public.saved_jobs ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.saved_jobs ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.saved_jobs ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_saved_jobs_user_id
  ON public.saved_jobs (user_id);

CREATE INDEX IF NOT EXISTS idx_saved_jobs_job_posting_id
  ON public.saved_jobs (job_posting_id)
  WHERE job_posting_id IS NOT NULL;

-- 5.2 AI GENERATIONS (Accounting, token usage, auditing per user)
CREATE TABLE IF NOT EXISTS public.ai_generations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature            text NOT NULL,
  prompt_tokens      integer DEFAULT 0 NOT NULL,
  completion_tokens  integer DEFAULT 0 NOT NULL,
  total_tokens       integer DEFAULT 0 NOT NULL,
  model              text NOT NULL,
  provider           text DEFAULT 'google' NOT NULL,
  latency_ms         integer,
  status             text DEFAULT 'completed' NOT NULL,
  error_message      text,
  metadata           jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at         timestamptz DEFAULT now() NOT NULL,
  deleted_at         timestamptz,
  CONSTRAINT ai_generations_tokens_non_negative
    CHECK (prompt_tokens >= 0 AND completion_tokens >= 0 AND total_tokens >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ai_generations_user_created
  ON public.ai_generations (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_generations_feature_created
  ON public.ai_generations (feature, created_at DESC);

-- 5.3 CONSENT LOGS (DPDP / GDPR user consent audit trail)
CREATE TABLE IF NOT EXISTS public.consent_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id      text,
  consent_type    text NOT NULL,
  granted         boolean NOT NULL,
  policy_version  text DEFAULT '2026-v1' NOT NULL,
  ip_address      text,
  user_agent      text,
  metadata        jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at      timestamptz DEFAULT now() NOT NULL,
  deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_consent_logs_user_id
  ON public.consent_logs (user_id);

CREATE INDEX IF NOT EXISTS idx_consent_logs_session_id
  ON public.consent_logs (session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consent_logs_created_at
  ON public.consent_logs (created_at DESC);

-- 5.4 USER AGE ATTESTATIONS (Age verification compliance record)
CREATE TABLE IF NOT EXISTS public.user_age_attestations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attested_age_or_above  boolean DEFAULT true NOT NULL,
  min_age_requirement    integer DEFAULT 18 NOT NULL,
  ip_address             text,
  user_agent             text,
  attested_at            timestamptz DEFAULT now() NOT NULL,
  deleted_at             timestamptz,
  CONSTRAINT user_age_attestations_user_id_key UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_age_attestations_user_id
  ON public.user_age_attestations (user_id);

-- ----------------------------------------------------------------------------
-- 5.5 ROW LEVEL SECURITY (RLS) POLICIES & PERMISSIONS (SAFE ADDITIVE ORDER)
-- ----------------------------------------------------------------------------

-- A. public.saved_jobs RLS
ALTER TABLE public.saved_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.saved_jobs FROM anon;
GRANT ALL ON TABLE public.saved_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.saved_jobs TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'saved_jobs'
      AND policyname = 'Users can manage own saved_jobs'
  ) THEN
    CREATE POLICY "Users can manage own saved_jobs"
      ON public.saved_jobs
      FOR ALL
      TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'saved_jobs'
      AND policyname = 'service_role_saved_jobs_all'
  ) THEN
    CREATE POLICY "service_role_saved_jobs_all"
      ON public.saved_jobs
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- B. public.ai_generations RLS & SECURITY NOTE:
-- Client writes are strictly REVOKED. Quota, rate-limiting, and billing must NEVER trust
-- client-written rows. AI generation accounting records must be written exclusively by trusted
-- server-side execution paths using service_role. Authenticated users may read their own history.
ALTER TABLE public.ai_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_generations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_generations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ai_generations TO service_role;
GRANT SELECT ON TABLE public.ai_generations TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ai_generations'
      AND policyname = 'Users can view own ai_generations'
  ) THEN
    CREATE POLICY "Users can view own ai_generations"
      ON public.ai_generations
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ai_generations'
      AND policyname = 'service_role_ai_generations_all'
  ) THEN
    CREATE POLICY "service_role_ai_generations_all"
      ON public.ai_generations
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- C. public.consent_logs RLS & GUEST IDENTITY PROTECTION
-- Anonymous guests may ONLY insert consent records where user_id IS NULL.
-- Authenticated users may ONLY insert consent records for their own auth.uid().
-- This guarantees anonymous callers cannot forge consent entries for real user IDs.
ALTER TABLE public.consent_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consent_logs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.consent_logs FROM PUBLIC, anon;
GRANT ALL ON TABLE public.consent_logs TO service_role;
GRANT SELECT, INSERT ON TABLE public.consent_logs TO authenticated;
GRANT INSERT ON TABLE public.consent_logs TO anon;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'consent_logs'
      AND policyname = 'Users can view own consent_logs'
  ) THEN
    CREATE POLICY "Users can view own consent_logs"
      ON public.consent_logs
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'consent_logs'
      AND policyname = 'Guests can insert consent_logs'
  ) THEN
    CREATE POLICY "Guests can insert consent_logs"
      ON public.consent_logs
      FOR INSERT
      TO anon
      WITH CHECK (user_id IS NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'consent_logs'
      AND policyname = 'Users can insert own consent_logs'
  ) THEN
    CREATE POLICY "Users can insert own consent_logs"
      ON public.consent_logs
      FOR INSERT
      TO authenticated
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'consent_logs'
      AND policyname = 'service_role_consent_logs_all'
  ) THEN
    CREATE POLICY "service_role_consent_logs_all"
      ON public.consent_logs
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- D. public.user_age_attestations RLS
ALTER TABLE public.user_age_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_age_attestations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_age_attestations FROM anon;
GRANT ALL ON TABLE public.user_age_attestations TO service_role;
GRANT SELECT, INSERT ON TABLE public.user_age_attestations TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_age_attestations'
      AND policyname = 'Users can view own user_age_attestations'
  ) THEN
    CREATE POLICY "Users can view own user_age_attestations"
      ON public.user_age_attestations
      FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_age_attestations'
      AND policyname = 'Users can insert own user_age_attestations'
  ) THEN
    CREATE POLICY "Users can insert own user_age_attestations"
      ON public.user_age_attestations
      FOR INSERT
      TO authenticated
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_age_attestations'
      AND policyname = 'service_role_user_age_attestations_all'
  ) THEN
    CREATE POLICY "service_role_user_age_attestations_all"
      ON public.user_age_attestations
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- E. public.job_postings RLS & PAID-FIELD BOUNDARY ENFORCEMENT
-- The raw table public.job_postings holds sensitive paid fields (company_name, salary_min,
-- salary_max, direct_apply_url, raw_payload).
-- Direct SELECT on the raw table is strictly REVOKED from anon and authenticated.
-- Only service_role can select from or write to public.job_postings directly.
ALTER TABLE public.job_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_postings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_postings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.job_postings TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'job_postings'
      AND policyname = 'service_role_job_postings_all'
  ) THEN
    CREATE POLICY "service_role_job_postings_all"
      ON public.job_postings
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- 5.6 PUBLIC SAFE FEED VIEW (job_postings_public)
-- Masks company_name, salary, direct_apply_url and raw_payload for anon/auth callers,
-- perfectly maintaining the paid-field boundary established in 20261010_lock_paid_jobs_data.sql.
CREATE OR REPLACE VIEW public.job_postings_public AS
SELECT
  id,
  company_id,
  legacy_job_id,
  source_id,
  title,
  role_category,
  company_category,
  category,
  top_keywords,
  location,
  country,
  country_code,
  city,
  is_remote,
  workplace_type,
  employment_type,
  seniority,
  min_experience_years,
  max_experience_years,
  status,
  is_active,
  verified,
  first_seen_at,
  last_seen_at,
  posted_at,
  created_at,
  updated_at,
  -- Locked paid fields: Never served to anonymous or free users
  'Verified Employer'::text AS company_name,
  NULL::text AS company_slug,
  NULL::numeric(12, 2) AS salary_min,
  NULL::numeric(12, 2) AS salary_max,
  NULL::text AS salary_currency,
  NULL::text AS salary_period,
  NULL::text AS salary_text,
  NULL::text AS direct_apply_url,
  NULL::text AS source_url,
  NULL::jsonb AS raw_payload
FROM public.job_postings
WHERE is_active = TRUE OR status = 'active';

REVOKE ALL ON public.job_postings_public FROM PUBLIC;
GRANT SELECT ON public.job_postings_public TO anon, authenticated, service_role;

COMMIT;

-- ============================================================================
-- VERIFICATION SQL (run after applying migration to verify objects)
-- ============================================================================
-- SELECT 'internal_ingestion schema' AS object_name,
--        CASE WHEN EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'internal_ingestion') THEN 'VERIFIED' ELSE 'FAILED' END AS status
-- UNION ALL
-- SELECT 'internal_ingestion PostgREST isolation (0 anon/authenticated grants)',
--        CASE WHEN (SELECT count(*) FROM information_schema.table_privileges WHERE table_schema = 'internal_ingestion' AND grantee IN ('anon', 'authenticated')) = 0 THEN 'VERIFIED (ISOLATED)' ELSE 'FAILED (LEAKED)' END
-- UNION ALL
-- SELECT 'public.job_postings raw table locked from anon/authenticated',
--        CASE WHEN (SELECT count(*) FROM information_schema.table_privileges WHERE table_schema = 'public' AND table_name = 'job_postings' AND grantee IN ('anon', 'authenticated')) = 0 THEN 'VERIFIED (LOCKED)' ELSE 'FAILED (OPEN)' END
-- UNION ALL
-- SELECT 'public.job_postings_public view exists',
--        CASE WHEN to_regclass('public.job_postings_public') IS NOT NULL THEN 'VERIFIED' ELSE 'FAILED' END
-- UNION ALL
-- SELECT 'internal_ingestion.ingestion_sources', CASE WHEN to_regclass('internal_ingestion.ingestion_sources') IS NOT NULL THEN 'VERIFIED' ELSE 'FAILED' END
-- UNION ALL
-- SELECT 'internal_ingestion.job_source_records', CASE WHEN to_regclass('internal_ingestion.job_source_records') IS NOT NULL THEN 'VERIFIED' ELSE 'FAILED' END
-- UNION ALL
-- SELECT 'internal_ingestion.company_aliases', CASE WHEN to_regclass('internal_ingestion.company_aliases') IS NOT NULL THEN 'VERIFIED' ELSE 'FAILED' END
-- UNION ALL
-- SELECT 'internal_ingestion.search_outbox', CASE WHEN to_regclass('internal_ingestion.search_outbox') IS NOT NULL THEN 'VERIFIED' ELSE 'FAILED' END
-- UNION ALL
-- SELECT 'internal_ingestion.category_overrides', CASE WHEN to_regclass('internal_ingestion.category_overrides') IS NOT NULL THEN 'VERIFIED' ELSE 'FAILED' END
-- UNION ALL
-- SELECT 'public.job_postings table', CASE WHEN to_regclass('public.job_postings') IS NOT NULL THEN 'VERIFIED' ELSE 'FAILED' END
-- UNION ALL
-- SELECT 'public.ai_generations table (RLS enabled)',
--        CASE WHEN (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ai_generations') THEN 'VERIFIED' ELSE 'FAILED' END
-- UNION ALL
-- SELECT 'public.consent_logs table (RLS enabled)',
--        CASE WHEN (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'consent_logs') THEN 'VERIFIED' ELSE 'FAILED' END
-- UNION ALL
-- SELECT 'public.user_age_attestations table (RLS enabled)',
--        CASE WHEN (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_age_attestations') THEN 'VERIFIED' ELSE 'FAILED' END
-- UNION ALL
-- SELECT 'public.saved_jobs table (RLS enabled)',
--        CASE WHEN (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'saved_jobs') THEN 'VERIFIED' ELSE 'FAILED' END;
-- ============================================================================

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   -- 1. DROP VIEW & NEW TABLES (No CASCADE on shared production tables!)
--   DROP VIEW IF EXISTS public.job_postings_public;
--   DROP POLICY IF EXISTS "service_role_job_postings_all" ON public.job_postings;
--   DROP TABLE IF EXISTS public.user_age_attestations;
--   DROP TABLE IF EXISTS public.consent_logs;
--   DROP TABLE IF EXISTS public.ai_generations;
--   DROP TABLE IF EXISTS public.job_postings;
--
--   -- 2. REVERT ADDED COLUMNS & INDEXES ON SHARED PRE-EXISTING TABLES
--   -- (public.saved_jobs, public.companies, public.jobs, and public.job_descriptions)
--   ALTER TABLE public.saved_jobs DROP COLUMN IF EXISTS job_posting_id;
--   ALTER TABLE public.saved_jobs DROP COLUMN IF EXISTS notes;
--   DROP INDEX IF EXISTS public.idx_saved_jobs_job_posting_id;
--   DROP INDEX IF EXISTS public.idx_job_descriptions_posting_id;
--   ALTER TABLE public.job_descriptions DROP COLUMN IF EXISTS posting_id;
--
--   DROP INDEX IF EXISTS public.idx_jobs_source_vendor_source_job_id_uniq;
--   DROP INDEX IF EXISTS public.idx_jobs_source_id_source_job_id_uniq;
--   DROP INDEX IF EXISTS public.idx_jobs_active_dedupe_hash_uniq;
--   DROP INDEX IF EXISTS public.idx_jobs_top_keywords_gin;
--   DROP INDEX IF EXISTS public.idx_jobs_active_is_remote;
--   DROP INDEX IF EXISTS public.idx_jobs_active_role_category_posted_at;
--   DROP INDEX IF EXISTS public.idx_jobs_active_category_country_posted_at;
--   DROP INDEX IF EXISTS public.idx_jobs_active_posted_at_desc;
--   DROP INDEX IF EXISTS public.idx_jobs_active_country;
--   DROP INDEX IF EXISTS public.idx_jobs_active_role_category;
--   DROP INDEX IF EXISTS public.idx_jobs_active_category;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_priority_check;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_company_category_check;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_role_category_check;
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS source_id;
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS company_category;
--
--   ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_category_check;
--   DROP INDEX IF EXISTS public.idx_companies_canonical_domain;
--   DROP INDEX IF EXISTS public.idx_companies_category;
--   DROP INDEX IF EXISTS public.idx_companies_slug_uniq;
--
--   -- 3. DROP INTERNAL INGESTION SCHEMA & TABLES
--   DROP TABLE IF EXISTS internal_ingestion.category_overrides;
--   DROP TABLE IF EXISTS internal_ingestion.search_outbox;
--   DROP TABLE IF EXISTS internal_ingestion.company_aliases;
--   DROP TABLE IF EXISTS internal_ingestion.job_source_records;
--   DROP TABLE IF EXISTS internal_ingestion.ingestion_sources;
--   DROP SCHEMA IF EXISTS internal_ingestion;
--
--   -- 4. DROP SECTION 3.1 ENUMS
--   DROP TYPE IF EXISTS public.user_consent_type;
--   DROP TYPE IF EXISTS public.search_outbox_status;
--   DROP TYPE IF EXISTS public.company_category_type;
--   DROP TYPE IF EXISTS public.role_category_type;
--   DROP TYPE IF EXISTS public.job_posting_status;
--   DROP TYPE IF EXISTS public.ingestion_status;
--   DROP TYPE IF EXISTS public.ingestion_source_type;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261116c_launch_scope_coming_soon_gates.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261116c_launch_scope_coming_soon_gates.sql
-- Description: Launch scope database gates for coming-soon features
--              Blocks direct reads and writes on applications, candidate_profiles,
--              tailored_resumes, and resumes storage bucket at the DB/RLS level.
--              Preserves all existing data.
--
-- IMPORTANT SECURITY & RLS ARCHITECTURE NOTE ON APPLICATIONS DELETION:
-- Because applications_coming_soon_block_select sets FOR SELECT USING (false),
-- direct client queries executed by authenticated owners (e.g. DELETE FROM applications WHERE user_id = auth.uid())
-- match 0 rows in PostgreSQL (or return 0 rows affected via PostgREST due to disabled SELECT visibility).
-- Direct client DELETE on applications must NOT be relied upon.
-- Instead, all GDPR / account deletion workflows are executed strictly server-side
-- via the authenticated service-role route (/api/account/delete and Netlify account-delete),
-- which runs under PostgreSQL service_role (BYPASSRLS) and reliably purges application rows.
-- Status: NOT APPLIED
-- Record with: node scripts/record-migration.cjs 20261116c_launch_scope_coming_soon_gates

-- ============================================================================
-- PRE-CHECK SQL (Run independently to verify prerequisites)
-- ============================================================================
-- SELECT tablename, policyname, cmd, permissive
-- FROM pg_policies
-- WHERE tablename IN ('applications', 'candidate_profiles', 'tailored_resumes');

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. applications table: Block SELECT, INSERT, UPDATE; preserve DELETE
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "applications_owner_select" ON public.applications;
DROP POLICY IF EXISTS "applications_owner_insert" ON public.applications;
DROP POLICY IF EXISTS "applications_owner_update" ON public.applications;

DROP POLICY IF EXISTS "applications_coming_soon_block_select" ON public.applications;
CREATE POLICY "applications_coming_soon_block_select"
  ON public.applications
  FOR SELECT
  TO authenticated, anon
  USING (false);

DROP POLICY IF EXISTS "applications_coming_soon_block_insert" ON public.applications;
CREATE POLICY "applications_coming_soon_block_insert"
  ON public.applications
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "applications_coming_soon_block_update" ON public.applications;
CREATE POLICY "applications_coming_soon_block_update"
  ON public.applications
  FOR UPDATE
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- Owner delete policy retained for schema completeness, but note that direct authenticated
-- DELETE deletes 0 rows when SELECT visibility is disabled (USING false).
-- Authoritative deletion is executed via the service-role endpoint (/api/account/delete).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'applications' AND policyname = 'applications_owner_delete'
  ) THEN
    CREATE POLICY "applications_owner_delete"
      ON public.applications
      FOR DELETE
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. candidate_profiles table: Block SELECT, INSERT, UPDATE; preserve DELETE
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "candidate_profiles_owner_select" ON public.candidate_profiles;
DROP POLICY IF EXISTS "candidate_profiles_owner_insert" ON public.candidate_profiles;
DROP POLICY IF EXISTS "candidate_profiles_owner_update" ON public.candidate_profiles;

DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_select" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_coming_soon_block_select"
  ON public.candidate_profiles
  FOR SELECT
  TO authenticated, anon
  USING (false);

DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_insert" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_coming_soon_block_insert"
  ON public.candidate_profiles
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_update" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_coming_soon_block_update"
  ON public.candidate_profiles
  FOR UPDATE
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- Owner delete policy retained for schema completeness, but note that direct authenticated
-- DELETE deletes 0 rows when SELECT visibility is disabled (USING false).
-- Authoritative deletion is executed via the service-role endpoint (/api/account/delete).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'candidate_profiles' AND policyname = 'candidate_profiles_owner_delete'
  ) THEN
    CREATE POLICY "candidate_profiles_owner_delete"
      ON public.candidate_profiles
      FOR DELETE
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. tailored_resumes table: Block SELECT, INSERT, UPDATE; preserve DELETE
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "tailored_resumes_owner_select" ON public.tailored_resumes;
DROP POLICY IF EXISTS "tailored_resumes_owner_insert" ON public.tailored_resumes;
DROP POLICY IF EXISTS "tailored_resumes_owner_update" ON public.tailored_resumes;

DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_select" ON public.tailored_resumes;
CREATE POLICY "tailored_resumes_coming_soon_block_select"
  ON public.tailored_resumes
  FOR SELECT
  TO authenticated, anon
  USING (false);

DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_insert" ON public.tailored_resumes;
CREATE POLICY "tailored_resumes_coming_soon_block_insert"
  ON public.tailored_resumes
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_update" ON public.tailored_resumes;
CREATE POLICY "tailored_resumes_coming_soon_block_update"
  ON public.tailored_resumes
  FOR UPDATE
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- Owner delete policy retained for schema completeness, but note that direct authenticated
-- DELETE deletes 0 rows when SELECT visibility is disabled (USING false).
-- Authoritative deletion is executed via the service-role endpoint (/api/account/delete).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'tailored_resumes' AND policyname = 'tailored_resumes_owner_delete'
  ) THEN
    CREATE POLICY "tailored_resumes_owner_delete"
      ON public.tailored_resumes
      FOR DELETE
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. storage.objects resumes bucket: Block SELECT, INSERT, UPDATE; preserve DELETE
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Owner can select own resume files" ON storage.objects;
DROP POLICY IF EXISTS "Owner can insert own resume files" ON storage.objects;
DROP POLICY IF EXISTS "Owner can update own resume files" ON storage.objects;

DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_select" ON storage.objects;
CREATE POLICY "resumes_storage_coming_soon_block_select"
  ON storage.objects
  FOR SELECT
  TO authenticated, anon
  USING (bucket_id = 'resumes' AND false);

DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_insert" ON storage.objects;
CREATE POLICY "resumes_storage_coming_soon_block_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (bucket_id = 'resumes' AND false);

DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_update" ON storage.objects;
CREATE POLICY "resumes_storage_coming_soon_block_update"
  ON storage.objects
  FOR UPDATE
  TO authenticated, anon
  USING (bucket_id = 'resumes' AND false)
  WITH CHECK (bucket_id = 'resumes' AND false);

-- Ensure owner delete policy on storage.objects for resumes bucket remains
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Owner can delete own resume files'
  ) THEN
    CREATE POLICY "Owner can delete own resume files"
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'resumes'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY SQL (Run independently to verify correct policy application)
-- ============================================================================
-- SELECT tablename, policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE tablename IN ('applications', 'candidate_profiles', 'tailored_resumes');

-- ============================================================================
-- ROLLBACK SQL (Restore owner policies)
-- ============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS "applications_coming_soon_block_select" ON public.applications;
-- DROP POLICY IF EXISTS "applications_coming_soon_block_insert" ON public.applications;
-- DROP POLICY IF EXISTS "applications_coming_soon_block_update" ON public.applications;
-- CREATE POLICY "applications_owner_select" ON public.applications FOR SELECT USING (auth.uid() = user_id);
-- CREATE POLICY "applications_owner_insert" ON public.applications FOR INSERT WITH CHECK (auth.uid() = user_id);
-- CREATE POLICY "applications_owner_update" ON public.applications FOR UPDATE USING (auth.uid() = user_id);
--
-- DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_select" ON public.candidate_profiles;
-- DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_insert" ON public.candidate_profiles;
-- DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_update" ON public.candidate_profiles;
-- CREATE POLICY "candidate_profiles_owner_select" ON public.candidate_profiles FOR SELECT USING (auth.uid() = user_id);
-- CREATE POLICY "candidate_profiles_owner_insert" ON public.candidate_profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
-- CREATE POLICY "candidate_profiles_owner_update" ON public.candidate_profiles FOR UPDATE USING (auth.uid() = user_id);
--
-- DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_select" ON public.tailored_resumes;
-- DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_insert" ON public.tailored_resumes;
-- DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_update" ON public.tailored_resumes;
-- CREATE POLICY "tailored_resumes_owner_select" ON public.tailored_resumes FOR SELECT USING (auth.uid() = user_id);
-- CREATE POLICY "tailored_resumes_owner_insert" ON public.tailored_resumes FOR INSERT WITH CHECK (auth.uid() = user_id);
-- CREATE POLICY "tailored_resumes_owner_update" ON public.tailored_resumes FOR UPDATE USING (auth.uid() = user_id);
--
-- DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_select" ON storage.objects;
-- DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_insert" ON storage.objects;
-- DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_update" ON storage.objects;
-- CREATE POLICY "Owner can select own resume files" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text);
-- CREATE POLICY "Owner can insert own resume files" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text);
-- CREATE POLICY "Owner can update own resume files" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text) WITH CHECK (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text);
-- COMMIT;


-- ------------------------------------------------------------------------------
-- Migration: 20261116d_repair_642_identity_and_similarity_safety.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261116d_repair_642_identity_and_similarity_safety.sql
-- STATUS: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261116d_repair_642_identity_and_similarity_safety
--
-- Purpose:
--   Phase 1 of Repair PR #642: Short Additive DDL & Trigger Safety.
--   1. Strict preflight check that aborts if baseline constraints/tables differ.
--   2. Authoritative write identity separation: removes harmful triggers & destructive dedupe indexes.
--   3. Versioned similarity fingerprinting (v2): Unicode-preserving, NFKC normalized (sharp s -> ss),
--      length-framed UTF-8 serialization, SHA-256 digest (byte-for-byte with TS & Python,
--      exact normalization for Turkish 'İ', Greek 'ς'->'σ', and NEL 'U+0085').
--   4. Strictly ADVISORY similarity: No unique constraint on similarity_hash_v2,
--      no automatic trigger-driven row merging, and no cross-source row replacement.
--   5. Fixes jobs_touch_last_seen trigger so metadata/enrichment updates (source_priority,
--      is_remote, role_category, similarity_hash_v2, etc.) do NOT clobber last_seen_at.
--      Defines liveness explicitly: only caller-provided last_seen_at or explicit scraper
--      refresh session (careermonke.scraper_refresh = 'on') updates it.
--   6. Preserves incident recovery tables (public.recovery_642_restore48_20261116) untouched.
--   7. Updates jobs_public view using CREATE OR REPLACE VIEW (never DROP VIEW),
--      preserving owner, permissions/grants, RLS, and column order.
--   8. Uses built-in pg_catalog.sha256 (no CREATE EXTENSION).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PREFLIGHT INTEGRITY & SAFETY CHECK (Aborts transaction if baseline differs)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_dup_source_keys integer := 0;
BEGIN
  -- 1. Check required baseline tables exist
  IF to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'Preflight check failed: public.jobs table does not exist';
  END IF;
  IF to_regclass('public.companies') IS NULL THEN
    RAISE EXCEPTION 'Preflight check failed: public.companies table does not exist';
  END IF;

  -- 2. Verify expected primary key constraint on public.jobs
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.jobs'::regclass
      AND conname = 'jobs_pkey'
      AND contype = 'p'
  ) THEN
    RAISE EXCEPTION 'Preflight check failed: expected primary key constraint jobs_pkey on public.jobs missing or definition differs';
  END IF;

  -- 3. Verify expected primary key constraint on public.companies
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.companies'::regclass
      AND conname = 'companies_pkey'
      AND contype = 'p'
  ) THEN
    RAISE EXCEPTION 'Preflight check failed: expected primary key constraint companies_pkey on public.companies missing or definition differs';
  END IF;

  -- 4. Verify expected source uniqueness constraint on public.jobs
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.jobs'::regclass
      AND conname IN ('jobs_source_source_job_id_unique', 'jobs_source_source_job_id_key')
      AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'Preflight check failed: expected unique constraint on (source, source_job_id) missing or definition differs';
  END IF;

  -- 5. Verify expected baseline trigger jobs_touch_last_seen on public.jobs
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.jobs'::regclass
      AND tgname = 'jobs_touch_last_seen'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Preflight check failed: expected trigger jobs_touch_last_seen on public.jobs missing or definition differs';
  END IF;

  -- 6. Verify incident recovery table is present and uncorrupted if it exists
  IF to_regclass('public.recovery_642_restore48_20261116') IS NOT NULL THEN
    RAISE NOTICE 'Preflight: incident recovery table verified intact.';
  END IF;

  -- 7. Check for existing duplicate (source_id, source_job_id) pairs if column already exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'source_id'
  ) THEN
    SELECT count(*) INTO v_dup_source_keys FROM (
      SELECT source_id, source_job_id
      FROM public.jobs
      WHERE source_id IS NOT NULL AND source_job_id IS NOT NULL
      GROUP BY source_id, source_job_id
      HAVING count(*) > 1
    ) dups;

    IF v_dup_source_keys > 0 THEN
      RAISE EXCEPTION 'Preflight check failed: found % duplicate (source_id, source_job_id) pairs in public.jobs', v_dup_source_keys;
    END IF;
  END IF;

  RAISE NOTICE 'Preflight checks passed: baseline tables, constraints, triggers, and source key integrity verified.';
END $$;

BEGIN;

-- Lock and statement execution budgets for zero-downtime additive DDL
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

-- ----------------------------------------------------------------------------
-- 1. CONTAINMENT: PERMANENTLY REMOVE HARMFUL TRIGGERS & DESTRUCTIVE INDEXES
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_jobs_merge_dedupe_priority ON public.jobs;
DROP FUNCTION IF EXISTS public.merge_job_by_dedupe_priority();
DROP INDEX IF EXISTS public.idx_jobs_active_dedupe_hash_uniq;

-- ----------------------------------------------------------------------------
-- 2. REPAIR jobs_touch_last_seen TRIGGER (EXPLICIT LIVENESS CONTRACT)
-- ----------------------------------------------------------------------------
-- The legacy trigger unconditionally set NEW.last_seen_at := now() on EVERY update.
-- This clobbered ranking order during metadata backfills and reversed dry-run winners.
-- Liveness is now defined explicitly:
-- 1) If careermonke.skip_touch_last_seen = 'on' -> preserve OLD.last_seen_at.
-- 2) If caller explicitly provides a distinct last_seen_at -> keep NEW.last_seen_at.
-- 3) If explicit scraper refresh setting careermonke.scraper_refresh = 'on' -> set now().
-- 4) All other updates (source_priority, is_remote, role_category, similarity_hash_v2,
--    top_keywords, backfills, tags, etc.) preserve OLD.last_seen_at.
CREATE OR REPLACE FUNCTION public.touch_job_last_seen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1. Explicit caller update: caller passed a distinct last_seen_at
  IF NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at THEN
    RETURN NEW;
  END IF;

  -- 2. Explicit skip setting (maintenance or ingestion session)
  IF current_setting('careermonke.skip_touch_last_seen', true) = 'on' THEN
    NEW.last_seen_at := OLD.last_seen_at;
    RETURN NEW;
  END IF;

  -- 3. Explicit scraper refresh session setting
  IF current_setting('careermonke.scraper_refresh', true) = 'on' THEN
    NEW.last_seen_at := now();
    RETURN NEW;
  END IF;

  -- 4. Default: all metadata updates (source_priority, is_remote, role_category,
  --    similarity_hash_v2, top_keywords, etc.) preserve OLD.last_seen_at.
  NEW.last_seen_at := OLD.last_seen_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jobs_touch_last_seen ON public.jobs;
CREATE TRIGGER jobs_touch_last_seen
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_job_last_seen();

-- ----------------------------------------------------------------------------
-- 3. VERSIONED SIMILARITY HASH FUNCTION (v2 LENGTH-FRAMED UTF-8 SHA-256)
-- ----------------------------------------------------------------------------
-- Immutable, deterministic hash function shared with Python and TypeScript.
-- Preserves all Unicode letters (Japanese, Cyrillic, accented Latin).
-- Normalization contract matches TS & Python byte-for-byte:
--   - Turkish 'İ' (U+0130) and 'i\u0307' -> 'i' (U+0069)
--   - Greek final sigma 'ς' (U+03C2 / chr(962)) -> 'σ' (U+03C3 / chr(963))
--   - Next Line 'U+0085' (chr(133)) -> ' '
-- Serializes using length-framed UTF-8 octets:
--   v2|c:{len}:{comp}|t:{len}:{title}|co:{len}:{co}|loc:{len}:{loc}
-- Uses built-in pg_catalog.sha256 to avoid search_path or extension resolution bugs.
CREATE OR REPLACE FUNCTION public.compute_job_similarity_hash_v2(
  p_company text,
  p_title text,
  p_country text,
  p_location text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_company text;
  v_title text;
  v_country text;
  v_location text;
  v_c_len integer;
  v_t_len integer;
  v_co_len integer;
  v_loc_len integer;
  v_payload text;
BEGIN
  -- 1. Normalize company: NFKC, sharp s -> ss, lowercase, edge characters, strip legal suffixes, collapse whitespace
  v_company := lower(COALESCE(normalize(p_company, NFKC), ''));
  v_company := replace(replace(replace(replace(replace(v_company, 'İ', 'i'), 'i' || chr(775), 'i'), chr(133), ' '), chr(962), chr(963)), chr(223), 'ss');
  v_company := regexp_replace(v_company, '\y(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\y\.?', ' ', 'gi');
  v_company := trim(regexp_replace(v_company, '[ \t\n\r\f\v\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g'));

  -- 2. Normalize title: NFKC, sharp s -> ss, lowercase, edge characters, collapse whitespace (preserves Unicode & punctuation)
  v_title := lower(COALESCE(normalize(p_title, NFKC), ''));
  v_title := replace(replace(replace(replace(replace(v_title, 'İ', 'i'), 'i' || chr(775), 'i'), chr(133), ' '), chr(962), chr(963)), chr(223), 'ss');
  v_title := trim(regexp_replace(v_title, '[ \t\n\r\f\v\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g'));

  -- 3. Normalize country: NFKC, sharp s -> ss, lowercase, edge characters, collapse whitespace
  v_country := lower(COALESCE(normalize(p_country, NFKC), ''));
  v_country := replace(replace(replace(replace(replace(v_country, 'İ', 'i'), 'i' || chr(775), 'i'), chr(133), ' '), chr(962), chr(963)), chr(223), 'ss');
  v_country := trim(regexp_replace(v_country, '[ \t\n\r\f\v\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g'));

  -- 4. Normalize location: primary city/territory before comma, NFKC, sharp s -> ss, lowercase, edge characters, collapse whitespace
  v_location := lower(COALESCE(normalize(p_location, NFKC), ''));
  v_location := replace(replace(replace(replace(replace(v_location, 'İ', 'i'), 'i' || chr(775), 'i'), chr(133), ' '), chr(962), chr(963)), chr(223), 'ss');
  v_location := split_part(v_location, ',', 1);
  v_location := trim(regexp_replace(v_location, '[ \t\n\r\f\v\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g'));

  -- 5. Length framing in UTF-8 octets
  v_c_len := octet_length(convert_to(v_company, 'UTF8'));
  v_t_len := octet_length(convert_to(v_title, 'UTF8'));
  v_co_len := octet_length(convert_to(v_country, 'UTF8'));
  v_loc_len := octet_length(convert_to(v_location, 'UTF8'));

  v_payload := 'v2|c:' || v_c_len || ':' || v_company ||
               '|t:' || v_t_len || ':' || v_title ||
               '|co:' || v_co_len || ':' || v_country ||
               '|loc:' || v_loc_len || ':' || v_location;

  RETURN encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload, 'UTF8')), 'hex');
END;
$$;

-- Replace legacy compute_job_dedupe_hash to delegate to compute_job_similarity_hash_v2
CREATE OR REPLACE FUNCTION public.compute_job_dedupe_hash(
  p_company text,
  p_title text,
  p_country text,
  p_location text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT public.compute_job_similarity_hash_v2(p_company, p_title, p_country, p_location);
$$;

-- ----------------------------------------------------------------------------
-- 4. ADDITIVE SCHEMA COLUMNS ON jobs AND companies
-- ----------------------------------------------------------------------------
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS canonical_domain text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS role_category text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS top_keywords text[] DEFAULT '{}'::text[];
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS dedupe_hash text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS similarity_hash_v2 text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS is_remote boolean;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_priority smallint DEFAULT 2;

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS canonical_domain text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS logo_url text;

-- ----------------------------------------------------------------------------
-- 5. SAFE CHECK CONSTRAINTS (NOT VALID FOR ZERO TABLE-LOCK DOWNTIME)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_role_category_check') THEN
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_role_category_check
      CHECK (role_category IN ('SDE', 'AI_ML', 'CLOUD', 'DATA', 'OTHER')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_source_priority_check') THEN
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_source_priority_check
      CHECK (source_priority IN (1, 2)) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_category_check') THEN
    ALTER TABLE public.companies ADD CONSTRAINT companies_category_check
      CHECK (category IN ('MNC_BIGTECH', 'HIGH_PRODUCT_YC', 'OTHER_STARTUPS', 'INDIAN_IT_AND_OTHER')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_source_type_check'
  ) THEN
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_source_type_check
      CHECK (source_type IN (
        'ats', 'api', 'feed', 'direct',
        'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday',
        'amazon', 'microsoft', 'jobspy', 'arbeitnow', 'adzuna'
      )) NOT VALID;
  ELSE
    ALTER TABLE public.jobs DROP CONSTRAINT jobs_source_type_check;
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_source_type_check
      CHECK (source_type IN (
        'ats', 'api', 'feed', 'direct',
        'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday',
        'amazon', 'microsoft', 'jobspy', 'arbeitnow', 'adzuna'
      )) NOT VALID;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6. TRANSACTIONAL jobs_public VIEW UPDATE (CREATE OR REPLACE VIEW)
-- ----------------------------------------------------------------------------
-- Preserves view owner, grants, RLS, and column order. NEVER DROP VIEW.
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
  -- Locked fields: Strictly masked from anon and authenticated non-Pro users
  'Verified Employer'::text AS company,
  NULL::text AS salary_text,
  NULL::text AS description,
  NULL::text AS apply_url,
  '{}'::text[] AS skills,
  -- Appended Phase 3 high-volume fields (non-breaking column order)
  role_category,
  COALESCE(top_keywords, '{}'::text[]) AS top_keywords,
  COALESCE(is_remote, remote, false) AS is_remote
FROM public.jobs
WHERE is_active = true OR status = 'active';

GRANT SELECT ON public.jobs_public TO anon, authenticated, service_role;

COMMIT;

-- ============================================================================
-- ROLLBACK (Run manually in the Supabase SQL editor if this must be undone):
--   NON-DESTRUCTIVE ROLLBACK POLICY:
--   - Restores legacy function definitions without dangling dropped references.
--   - Uses CREATE OR REPLACE VIEW public.jobs_public (never DROP VIEW).
--   - Does NOT drop pre-existing source-key unique index (jobs_source_source_job_id_unique).
--   - Keeps additive columns (jobs.source_id, similarity_hash_v2, etc.) to prevent data loss.
--   - Does NOT touch incident recovery tables (public.recovery_642_restore48_20261116).
--
--   -- 1. Restore ORIGINAL compute_job_dedupe_hash definition from #642
--   CREATE OR REPLACE FUNCTION public.compute_job_dedupe_hash(
--     p_company text,
--     p_title text,
--     p_country text,
--     p_location text
--   )
--   RETURNS text
--   LANGUAGE plpgsql
--   IMMUTABLE
--   SET search_path = public
--   AS $$
--   DECLARE
--     v_company text;
--     v_title text;
--     v_country text;
--     v_city text;
--     v_payload text;
--   BEGIN
--     v_company := lower(trim(COALESCE(p_company, '')));
--     v_company := regexp_replace(v_company, '\m(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\M\.?', '', 'gi');
--     v_company := trim(regexp_replace(v_company, '[^a-z0-9]+', ' ', 'g'));
--
--     v_title := lower(trim(COALESCE(p_title, '')));
--     v_title := trim(regexp_replace(v_title, '[^a-z0-9]+', ' ', 'g'));
--
--     v_country := lower(trim(COALESCE(NULLIF(trim(p_country), ''), 'any')));
--     v_country := trim(regexp_replace(v_country, '[^a-z0-9]+', ' ', 'g'));
--
--     v_city := lower(trim(split_part(COALESCE(p_location, ''), ',', 1)));
--     v_city := trim(regexp_replace(v_city, '[^a-z0-9]+', ' ', 'g'));
--     IF v_city = '' THEN
--       v_city := 'any';
--     END IF;
--
--     v_payload := v_company || '|' || v_title || '|' || v_country || '|' || v_city;
--     RETURN encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload, 'UTF8')), 'hex');
--   END;
--   $$;
--
--   -- 2. Drop similarity_hash_v2 function created by this migration
--   DROP FUNCTION IF EXISTS public.compute_job_similarity_hash_v2(text, text, text, text);
--
--   -- 3. Restore touch_job_last_seen function to baseline behavior
--   CREATE OR REPLACE FUNCTION public.touch_job_last_seen()
--   RETURNS trigger
--   LANGUAGE plpgsql
--   AS $$
--   BEGIN
--     NEW.last_seen_at := now();
--     RETURN NEW;
--   END;
--   $$;
--
--   -- 4. Restore legacy jobs_public view using CREATE OR REPLACE VIEW (never DROP VIEW)
--   CREATE OR REPLACE VIEW public.jobs_public AS
--   SELECT
--     id, title, location, remote, remote_scope, remote_eligibility,
--     job_type, category, country, country_code, seniority, verified,
--     source_type, first_seen_at, last_seen_at, discovered_at, posted_at,
--     created_at, status, is_active,
--     'Verified Employer'::text AS company,
--     NULL::text AS salary_text,
--     NULL::text AS description,
--     NULL::text AS apply_url,
--     '{}'::text[] AS skills,
--     NULL::text AS role_category,
--     '{}'::text[] AS top_keywords,
--     COALESCE(remote, false) AS is_remote
--   FROM public.jobs
--   WHERE is_active = true OR status = 'active';
--   GRANT SELECT ON public.jobs_public TO anon, authenticated, service_role;
--
--   -- 5. Drop indexes created by 20261116e (DO NOT drop pre-existing jobs_source_source_job_id_unique!)
--   DROP INDEX IF EXISTS public.idx_jobs_source_id_source_job_id_uniq;
--   DROP INDEX IF EXISTS public.idx_jobs_active_similarity_hash_v2;
--   DROP INDEX IF EXISTS public.idx_jobs_active_role_category;
--   DROP INDEX IF EXISTS public.idx_jobs_active_category;
--   DROP INDEX IF EXISTS public.idx_companies_category;
--   DROP INDEX IF EXISTS public.idx_companies_slug_uniq;
--
--   -- 6. Drop check constraints added by this migration
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_priority_check;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_role_category_check;
--   ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_category_check;
--
--   -- 7. Preserve compatible expanded CHECK on jobs.source_type
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_type_check;
--   ALTER TABLE public.jobs ADD CONSTRAINT jobs_source_type_check
--     CHECK (source_type IN (
--       'ats', 'api', 'feed', 'direct',
--       'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday',
--       'amazon', 'microsoft', 'jobspy', 'arbeitnow', 'adzuna'
--     )) NOT VALID;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261116d_resumes_block_direct_writes.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261116d_resumes_block_direct_writes.sql
-- Description: Close the direct-INSERT path on public.resumes.
--
-- Problem: 20261031_account_delete_and_private_resumes.sql created ONE policy,
-- "Users can manage own resumes" (FOR ALL TO authenticated, USING/WITH CHECK auth.uid() = user_id).
-- FOR ALL includes INSERT, so any signed-in user could insert rows with the Supabase client
-- (anon key + user JWT), bypassing any server-side resume gate. 20261116c gated applications,
-- candidate_profiles, tailored_resumes and the storage bucket but missed this table.
--
-- Chosen fix (option A): no code path in this repo inserts into public.resumes (resume files go to
-- the private storage bucket and candidate_profiles, both already gated). So the safest fix is to
-- remove client INSERT entirely:
--   * drop every policy that permits INSERT (FOR ALL or FOR INSERT), whatever it is named in an
--     environment, then recreate owner-only SELECT / UPDATE / DELETE policies;
--   * REVOKE INSERT from authenticated, anon and PUBLIC (this also blocks INSERT ... ON CONFLICT
--     upsert, which needs INSERT privilege);
--   * the UPDATE policy keeps WITH CHECK (auth.uid() = user_id), so user_id cannot be re-pointed.
-- Future resume creation must go through a gated server route using the service role (BYPASSRLS),
-- setting user_id from the verified session. A count-in-RLS gate is deliberately not used (racy).
--
-- Idempotent: safe to run twice. Status: NOT APPLIED
-- Record with: node scripts/record-migration.cjs 20261116d_resumes_block_direct_writes

-- ============================================================================
-- PRE-CHECK SQL (Run independently)
-- ============================================================================
-- SELECT policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies WHERE schemaname = 'public' AND tablename = 'resumes';
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND table_name = 'resumes';

BEGIN;

ALTER TABLE public.resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resumes FORCE ROW LEVEL SECURITY;

-- 1. Drop every policy that allows INSERT (exact names differ between environments).
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'resumes' AND cmd IN ('ALL', 'INSERT')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.resumes', p.policyname);
  END LOOP;
END $$;

-- 2. Owner-only SELECT / UPDATE / DELETE (same visibility as before, minus INSERT).
DROP POLICY IF EXISTS "resumes_owner_select" ON public.resumes;
CREATE POLICY "resumes_owner_select" ON public.resumes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "resumes_owner_update" ON public.resumes;
CREATE POLICY "resumes_owner_update" ON public.resumes
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "resumes_owner_delete" ON public.resumes;
CREATE POLICY "resumes_owner_delete" ON public.resumes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 3. Privilege layer: no client INSERT (also blocks upsert-as-insert).
REVOKE INSERT ON TABLE public.resumes FROM authenticated, anon, PUBLIC;

COMMIT;

-- ============================================================================
-- VERIFY SQL (Run independently)
-- ============================================================================
-- SELECT policyname, cmd, qual, with_check FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'resumes';   -- expect select/update/delete only
-- SELECT has_table_privilege('authenticated', 'public.resumes', 'INSERT');  -- expect false

-- ============================================================================
-- ROLLBACK SQL (Restores the previous FOR ALL policy, i.e. re-opens direct INSERT)
-- ============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS "resumes_owner_select" ON public.resumes;
-- DROP POLICY IF EXISTS "resumes_owner_update" ON public.resumes;
-- DROP POLICY IF EXISTS "resumes_owner_delete" ON public.resumes;
-- GRANT INSERT ON TABLE public.resumes TO authenticated;
-- CREATE POLICY "Users can manage own resumes" ON public.resumes
--   FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
-- COMMIT;


-- ------------------------------------------------------------------------------
-- Migration: 20261116e_repair_642_concurrent_indexes.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261116e_repair_642_concurrent_indexes.sql
-- STATUS: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261116e_repair_642_concurrent_indexes
--
-- Purpose:
--   Phase 2 of Repair PR #642: CREATE INDEX CONCURRENTLY.
--   Must be executed OUTSIDE of a transaction block (do NOT wrap in BEGIN / COMMIT),
--   one statement at a time.
--   Builds indexes concurrently without table locks:
--   1. Authoritative write identity unique partial index (board-scoped source_id + requisition source_job_id).
--   2. Advisory similarity index (STANDARD INDEX - NOT UNIQUE! NO TRIGGER MERGING!).
--   3. Category and taxonomy filter indexes.
--
-- Repair safety (CREATE INDEX ... IF NOT EXISTS only checks the NAME):
--   a. Preflight fails loudly when duplicate authoritative keys exist (the unique build would fail anyway).
--   b. A same-name index that is invalid, not ready (left by a failed CONCURRENTLY build) or has a
--      different definition (e.g. non-unique) is renamed to <name>_broken and dropped concurrently,
--      so the CREATE below rebuilds it. The rename takes only a SHARE UPDATE EXCLUSIVE lock.
--   c. Postflight fails loudly unless every index exists, is valid and ready, with the exact definition.
-- ============================================================================

-- Expected indexes and their exact pg_get_indexdef() text (dropped again at the end).
CREATE OR REPLACE FUNCTION public.repair_645_expected_indexes()
RETURNS TABLE (index_name text, index_def text)
LANGUAGE sql IMMUTABLE
AS $$
  VALUES
    ('idx_jobs_source_id_source_job_id_uniq',
     'CREATE UNIQUE INDEX idx_jobs_source_id_source_job_id_uniq ON public.jobs USING btree (source_id, source_job_id) WHERE ((source_id IS NOT NULL) AND (source_job_id IS NOT NULL))'),
    ('idx_jobs_active_similarity_hash_v2',
     'CREATE INDEX idx_jobs_active_similarity_hash_v2 ON public.jobs USING btree (similarity_hash_v2) WHERE (is_active = true)'),
    ('idx_jobs_active_role_category',
     'CREATE INDEX idx_jobs_active_role_category ON public.jobs USING btree (role_category) WHERE (is_active = true)'),
    ('idx_jobs_active_category',
     'CREATE INDEX idx_jobs_active_category ON public.jobs USING btree (category) WHERE (is_active = true)'),
    ('idx_companies_category',
     'CREATE INDEX idx_companies_category ON public.companies USING btree (category)'),
    ('idx_companies_slug_uniq',
     'CREATE UNIQUE INDEX idx_companies_slug_uniq ON public.companies USING btree (slug)')
$$;
REVOKE ALL ON FUNCTION public.repair_645_expected_indexes() FROM PUBLIC, anon, authenticated;

-- 0. Leftovers from an earlier interrupted repair run
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_source_id_source_job_id_uniq_broken;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_similarity_hash_v2_broken;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_role_category_broken;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_category_broken;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_companies_category_broken;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_companies_slug_uniq_broken;

-- a + b. Preflight: duplicate authoritative keys, then move aside any wrong same-name index
DO $$
DECLARE
  v_dups bigint;
  r record;
  v_def text;
  v_valid boolean;
  v_ready boolean;
BEGIN
  SELECT count(*) INTO v_dups FROM (
    SELECT 1 FROM public.jobs
    WHERE source_id IS NOT NULL AND source_job_id IS NOT NULL
    GROUP BY source_id, source_job_id HAVING count(*) > 1
  ) d;
  IF v_dups > 0 THEN
    RAISE EXCEPTION 'Index repair aborted: % duplicate (source_id, source_job_id) keys in public.jobs. Resolve them before building idx_jobs_source_id_source_job_id_uniq.', v_dups;
  END IF;

  SELECT count(*) INTO v_dups FROM (
    SELECT 1 FROM public.companies WHERE slug IS NOT NULL GROUP BY slug HAVING count(*) > 1
  ) d;
  IF v_dups > 0 THEN
    RAISE EXCEPTION 'Index repair aborted: % duplicate slugs in public.companies. Resolve them before building idx_companies_slug_uniq.', v_dups;
  END IF;

  FOR r IN SELECT * FROM public.repair_645_expected_indexes() LOOP
    SELECT pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready
      INTO v_def, v_valid, v_ready
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = r.index_name;

    IF FOUND AND NOT (v_valid AND v_ready AND v_def = r.index_def) THEN
      RAISE WARNING 'Index public.% is invalid/not ready or has a wrong definition (valid=%, ready=%, def=%). Moving it aside for rebuild.',
        r.index_name, v_valid, v_ready, v_def;
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', r.index_name, r.index_name || '_broken');
    END IF;
  END LOOP;
END $$;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_source_id_source_job_id_uniq_broken;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_similarity_hash_v2_broken;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_role_category_broken;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_category_broken;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_companies_category_broken;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_companies_slug_uniq_broken;

-- 1. Authoritative write identity unique partial index
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_source_id_source_job_id_uniq
ON public.jobs (source_id, source_job_id)
WHERE source_id IS NOT NULL AND source_job_id IS NOT NULL;

-- 2. Advisory similarity index (STANDARD INDEX - NOT UNIQUE!)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_active_similarity_hash_v2
ON public.jobs (similarity_hash_v2)
WHERE is_active = TRUE;

-- 3. Taxonomy & Filtering Indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_active_role_category
ON public.jobs (role_category)
WHERE is_active = TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_active_category
ON public.jobs (category)
WHERE is_active = TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_companies_category
ON public.companies (category);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_companies_slug_uniq
ON public.companies (slug);

-- c. Postflight: every index exists, is valid and ready, with the exact expected definition
DO $$
DECLARE
  r record;
  v_def text;
  v_valid boolean;
  v_ready boolean;
BEGIN
  FOR r IN SELECT * FROM public.repair_645_expected_indexes() LOOP
    SELECT pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready
      INTO v_def, v_valid, v_ready
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = r.index_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Index repair failed: public.% does not exist as an index.', r.index_name;
    END IF;
    IF NOT (v_valid AND v_ready AND v_def = r.index_def) THEN
      RAISE EXCEPTION 'Index repair failed: public.% (valid=%, ready=%) has definition % but expected %. Re-run this migration.',
        r.index_name, v_valid, v_ready, v_def, r.index_def;
    END IF;
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.repair_645_expected_indexes();

-- ============================================================================
-- ROLLBACK (Run manually outside transaction if indexes must be undone):
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_source_id_source_job_id_uniq;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_similarity_hash_v2;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_role_category;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_category;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_companies_category;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_companies_slug_uniq;
--   DROP FUNCTION IF EXISTS public.repair_645_expected_indexes();
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261116f_repair_642_batch_backfill.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261116f_repair_642_batch_backfill.sql
-- STATUS: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261116f_repair_642_batch_backfill
--
-- Purpose:
--   Phase 3 of Repair PR #642: Bounded, Resumable Batch Backfill.
--   - Bounded, resumable batch processing committing after EACH batch (no single DO transaction).
--   - LIMIT 500 loop per batch with FOR UPDATE SKIP LOCKED.
--   - Batched updates for all three target fields:
--       1) public.companies.canonical_domain
--       2) public.jobs.source_priority
--       3) public.jobs.similarity_hash_v2
--   - Tracks progress in public.repair_645_backfill_progress so a rerun resumes automatically.
--   - Sets careermonke.skip_touch_last_seen = 'on' to preserve last_seen_at.
-- ============================================================================

-- 1. Create progress tracking table if it does not already exist
CREATE TABLE IF NOT EXISTS public.repair_645_backfill_progress (
  phase text PRIMARY KEY,
  total_rows_updated integer NOT NULL DEFAULT 0,
  last_batch_rows integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Define resumable batch coordinator procedure
CREATE OR REPLACE PROCEDURE public.repair_645_run_resumable_backfill(p_batch_size integer DEFAULT 500)
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_count integer := 0;
  v_phase_total integer := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 5000 THEN
    RAISE EXCEPTION 'repair_645_run_resumable_backfill: p_batch_size must be between 1 and 5000, got %', p_batch_size;
  END IF;

  SET careermonke.skip_touch_last_seen = 'on';

  -- Phase 1: Bounded batched backfill of companies.canonical_domain
  LOOP
    WITH batch AS (
      SELECT id, lower(trim(domain)) AS new_canon
      FROM public.companies
      WHERE canonical_domain IS NULL AND domain IS NOT NULL
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.companies c
    SET canonical_domain = b.new_canon
    FROM batch b
    WHERE c.id = b.id;

    GET DIAGNOSTICS v_batch_count = ROW_COUNT;
    EXIT WHEN v_batch_count = 0;

    v_phase_total := v_phase_total + v_batch_count;
    INSERT INTO public.repair_645_backfill_progress (phase, total_rows_updated, last_batch_rows, updated_at)
    VALUES ('companies_canonical_domain', v_phase_total, v_batch_count, now())
    ON CONFLICT (phase) DO UPDATE
    SET total_rows_updated = repair_645_backfill_progress.total_rows_updated + EXCLUDED.last_batch_rows,
        last_batch_rows = EXCLUDED.last_batch_rows,
        updated_at = EXCLUDED.updated_at;

    COMMIT;
  END LOOP;

  -- Phase 2: Bounded batched backfill of jobs.source_priority.
  -- 20261116d adds the column with DEFAULT 2, so existing ATS rows already read 2 (not NULL):
  -- also pick up ATS rows not yet at 1. Only ever upgrades to 1; never downgrades a row.
  v_phase_total := 0;
  LOOP
    WITH batch AS (
      SELECT j.id, p.new_priority
      FROM public.jobs j
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN j.source_type IN ('ats', 'direct', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'amazon', 'microsoft')
            OR lower(COALESCE(j.source, '')) IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable', 'breezy', 'teamtailor', 'personio', 'bamboohr', 'join')
          THEN 1
          ELSE 2
        END AS new_priority
      ) p
      WHERE j.source_priority IS NULL OR (p.new_priority = 1 AND j.source_priority <> 1)
      LIMIT p_batch_size
      FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE public.jobs j
    SET source_priority = b.new_priority
    FROM batch b
    WHERE j.id = b.id;

    GET DIAGNOSTICS v_batch_count = ROW_COUNT;
    EXIT WHEN v_batch_count = 0;

    v_phase_total := v_phase_total + v_batch_count;
    INSERT INTO public.repair_645_backfill_progress (phase, total_rows_updated, last_batch_rows, updated_at)
    VALUES ('jobs_source_priority', v_phase_total, v_batch_count, now())
    ON CONFLICT (phase) DO UPDATE
    SET total_rows_updated = repair_645_backfill_progress.total_rows_updated + EXCLUDED.last_batch_rows,
        last_batch_rows = EXCLUDED.last_batch_rows,
        updated_at = EXCLUDED.updated_at;

    COMMIT;
  END LOOP;

  -- Phase 3: Bounded batched backfill of jobs.similarity_hash_v2
  v_phase_total := 0;
  LOOP
    WITH batch AS (
      SELECT id,
        public.compute_job_similarity_hash_v2(
          company,
          title,
          COALESCE(country_code, country),
          location
        ) AS new_hash
      FROM public.jobs
      WHERE is_active = TRUE AND similarity_hash_v2 IS NULL
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.jobs j
    SET similarity_hash_v2 = b.new_hash
    FROM batch b
    WHERE j.id = b.id;

    GET DIAGNOSTICS v_batch_count = ROW_COUNT;
    EXIT WHEN v_batch_count = 0;

    v_phase_total := v_phase_total + v_batch_count;
    INSERT INTO public.repair_645_backfill_progress (phase, total_rows_updated, last_batch_rows, updated_at)
    VALUES ('jobs_similarity_hash_v2', v_phase_total, v_batch_count, now())
    ON CONFLICT (phase) DO UPDATE
    SET total_rows_updated = repair_645_backfill_progress.total_rows_updated + EXCLUDED.last_batch_rows,
        last_batch_rows = EXCLUDED.last_batch_rows,
        updated_at = EXCLUDED.updated_at;

    COMMIT;
  END LOOP;

  RESET careermonke.skip_touch_last_seen;
END;
$$;

-- 3. Execute batch backfill in bounded chunks of 500 rows with per-batch commits
CALL public.repair_645_run_resumable_backfill(500);

-- ============================================================================
-- ROLLBACK (Run manually if batch backfill data or tracking must be reset):
--   DROP PROCEDURE IF EXISTS public.repair_645_run_resumable_backfill(integer);
--   DROP TABLE IF EXISTS public.repair_645_backfill_progress;
--   -- NOTE: Backfilled columns (canonical_domain, source_priority, similarity_hash_v2)
--   -- are non-destructive and can safely remain populated. To reset if desired:
--   -- UPDATE public.jobs SET similarity_hash_v2 = NULL;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261117_user_preferences_country.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: Add country and country_code to user_preferences
-- Description: Supports explicit user country persistence from mobile onboarding.
-- ============================================================================

ALTER TABLE public.user_preferences
ADD COLUMN IF NOT EXISTS country TEXT,
ADD COLUMN IF NOT EXISTS country_code VARCHAR(2);

-- ============================================================================
-- ROLLBACK:
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS country_code;
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS country;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261117a_update_plan_prices_399_499_2199.sql
-- ------------------------------------------------------------------------------
-- Migration: 20261117a_update_plan_prices_399_499_2199.sql
-- Description: Update public.plans table to server-authoritative prepaid price points:
--   1. weekly: Rs 399 (39900 paise), 7 days access
--   2. monthly: Rs 499 (49900 paise), 30 days access
--   3. quarterly: Rs 2,199 (219900 paise), 90 days access

BEGIN;

SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '5s';

-- Preflight: verify that all three required plan rows (weekly, monthly, quarterly) exist before applying updates
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.plans
  WHERE code IN ('weekly', 'monthly', 'quarterly');

  IF v_count < 3 THEN
    RAISE EXCEPTION 'Preflight failed: public.plans must contain weekly, monthly, and quarterly rows before price update (found %)', v_count;
  END IF;
END $$;

UPDATE public.plans SET price_paise = 39900, duration_days = 7 WHERE code = 'weekly';
UPDATE public.plans SET price_paise = 49900, duration_days = 30 WHERE code = 'monthly';
UPDATE public.plans SET price_paise = 219900, duration_days = 90 WHERE code = 'quarterly';

COMMIT;

-- Post-apply verification query:
-- SELECT code, name, price_paise, duration_days FROM public.plans WHERE code IN ('weekly', 'monthly', 'quarterly') ORDER BY duration_days;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
-- NOTE: Manual restore instructions to re-apply previous price points (69200, 149900, 399900 paise):
--   BEGIN;
--   SET LOCAL statement_timeout = '10s';
--   SET LOCAL lock_timeout = '5s';
--   UPDATE public.plans SET price_paise = 69200, duration_days = 7 WHERE code = 'weekly';
--   UPDATE public.plans SET price_paise = 149900, duration_days = 30 WHERE code = 'monthly';
--   UPDATE public.plans SET price_paise = 399900, duration_days = 90 WHERE code = 'quarterly';
--   COMMIT;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261118_onboarding_resume_uploads.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261118_onboarding_resume_uploads.sql
-- Description: Pointer table + orphan finder for the onboarding resume upload (PR #655).
--   * Additive only. Does NOT modify the existing private `resumes` bucket row
--     (size limit / allowed MIME types), its storage.objects policies, or any object.
--   * The 5 MB, PDF/DOCX-only rule is enforced by /api/onboarding/resume.
--   * Uploads run server-side with the service role; clients get no write path.
--   * Rate limiting reuses public.check_rate_limit (20261020).
--   * Objects this migration creates are stamped with the marker comment
--     'created-by:20261118_onboarding_resume_uploads'; the rollback only touches
--     objects carrying that marker.
-- Transactional: preflight + DDL + post-checks run in one transaction; any
-- failure rolls everything back. Idempotent: safe to re-run.
-- Status: NOT APPLIED. Record with:
--   node scripts/record-migration.cjs 20261118_onboarding_resume_uploads
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- PREFLIGHT (read-only). Any RAISE EXCEPTION aborts and rolls back everything.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_marker   constant text := 'created-by:20261118_onboarding_resume_uploads';
  v_table    regclass := to_regclass('public.onboarding_resume_uploads');
  v_cols     text;
  v_expected constant text :=
    'file_name:text:NO,mime_type:text:NO,size_bytes:integer:NO,storage_path:text:NO,'
    || 'uploaded_at:timestamp with time zone:NO,user_id:uuid:NO';
  v_bad      text;
  v_pol      record;
  v_exprs    text[];
  v_expr     text;
  v_queue    text[];
  v_parts    text[];
  v_part     text;
  v_ch       text;
  v_excluded boolean;
  v_inq      boolean;
  v_has_or   boolean;
  v_depth    integer;
  v_close    integer;
  v_start    integer;
  v_i        integer;
  v_old_path text;
BEGIN
  -- 1. Bucket prerequisites (read only; never modified here).
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'resumes') THEN
    RAISE EXCEPTION 'preflight: storage bucket "resumes" does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'resumes' AND public IS DISTINCT FROM false) THEN
    RAISE EXCEPTION 'preflight: storage bucket "resumes" is not private';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'resumes'
             AND file_size_limit IS NOT NULL AND file_size_limit < 5242880) THEN
    RAISE EXCEPTION 'preflight: "resumes" size limit is below 5 MB';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'resumes'
             AND allowed_mime_types IS NOT NULL
             AND NOT allowed_mime_types @> ARRAY[
               'application/pdf',
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) THEN
    RAISE EXCEPTION 'preflight: "resumes" does not allow both PDF and DOCX';
  END IF;
  IF to_regprocedure('public.check_rate_limit(text,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'preflight: public.check_rate_limit(text,integer,integer) is missing';
  END IF;

  -- 2. Refuse if ANY effective client write path on storage.objects can reach
  --    resumes/<uid>/onboarding/... (second path segment = 'onboarding', the same
  --    rule as the table CHECK and the orphan finder). No allow-listing by name.
  --    * If RLS is off on storage.objects, any INSERT/UPDATE grant to anon or
  --      authenticated is a write path: refuse.
  --    * Every PERMISSIVE INSERT/UPDATE/ALL policy whose roles reach anon or
  --      authenticated (PUBLIC, the role itself, or any role either one inherits)
  --      must PROVABLY exclude the prefix. Each expression Postgres evaluates for
  --      the command (INSERT: WITH CHECK; UPDATE: USING and WITH CHECK; a missing
  --      WITH CHECK falls back to USING; a missing expression means "true") needs
  --      a top-level AND conjunct that is one of:
  --        false
  --        bucket_id = '<a bucket other than resumes>'
  --        (storage.foldername(name))[2] <> 'onboarding'
  --        (storage.foldername(name))[2] IS DISTINCT FROM 'onboarding'
  --      Anything else (a top-level OR, other functions, NOT, ...) counts as
  --      reaching the prefix. Restrictive policies cannot grant access and are
  --      not credited as exclusions.
  --    search_path is pinned so pg_get_expr deparses schema-qualified names.
  v_old_path := current_setting('search_path');
  PERFORM set_config('search_path', 'pg_catalog', true);

  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'storage.objects'::regclass)
     AND (   has_table_privilege('anon', 'storage.objects', 'INSERT')
          OR has_table_privilege('anon', 'storage.objects', 'UPDATE')
          OR has_table_privilege('authenticated', 'storage.objects', 'INSERT')
          OR has_table_privilege('authenticated', 'storage.objects', 'UPDATE')) THEN
    RAISE EXCEPTION 'preflight: storage.objects has RLS disabled while anon/authenticated can INSERT or UPDATE it';
  END IF;

  v_bad := NULL;
  FOR v_pol IN
    SELECT pol.polname::text AS polname,
           pol.polcmd,
           pg_get_expr(pol.polqual, pol.polrelid)      AS qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS wcheck
      FROM pg_policy pol
     WHERE pol.polrelid = 'storage.objects'::regclass
       AND pol.polpermissive
       AND pol.polcmd IN ('a', 'w', '*')
       AND EXISTS (
             SELECT 1 FROM unnest(pol.polroles) AS r(roid)
              WHERE CASE WHEN r.roid = 0 THEN true
                         ELSE pg_has_role('anon', r.roid, 'MEMBER')
                           OR pg_has_role('authenticated', r.roid, 'MEMBER') END)
     ORDER BY pol.polname
  LOOP
    v_exprs := CASE WHEN v_pol.polcmd = 'a'
                    THEN ARRAY[coalesce(v_pol.wcheck, v_pol.qual, 'true')]
                    ELSE ARRAY[coalesce(v_pol.qual, 'true'),
                               coalesce(v_pol.wcheck, v_pol.qual, 'true')] END;
    FOREACH v_expr IN ARRAY v_exprs LOOP
      v_excluded := false;
      v_queue := ARRAY[v_expr];
      WHILE NOT v_excluded AND cardinality(v_queue) > 0 LOOP
        v_part := btrim(v_queue[1]);
        v_queue := v_queue[2:];

        -- Strip outer parentheses that wrap the whole expression.
        LOOP
          EXIT WHEN left(v_part, 1) <> '(' OR right(v_part, 1) <> ')';
          v_depth := 0; v_inq := false; v_close := 0;
          FOR v_i IN 1..length(v_part) LOOP
            v_ch := substr(v_part, v_i, 1);
            IF v_ch = '''' THEN v_inq := NOT v_inq;
            ELSIF NOT v_inq AND v_ch = '(' THEN v_depth := v_depth + 1;
            ELSIF NOT v_inq AND v_ch = ')' THEN
              v_depth := v_depth - 1;
              IF v_depth = 0 THEN v_close := v_i; EXIT; END IF;
            END IF;
          END LOOP;
          EXIT WHEN v_close <> length(v_part);
          v_part := btrim(substr(v_part, 2, length(v_part) - 2));
        END LOOP;

        -- Split on top-level AND; a top-level OR proves nothing.
        v_parts := ARRAY[]::text[]; v_depth := 0; v_inq := false; v_start := 1; v_has_or := false;
        v_i := 1;
        WHILE v_i <= length(v_part) LOOP
          v_ch := substr(v_part, v_i, 1);
          IF v_ch = '''' THEN v_inq := NOT v_inq;
          ELSIF NOT v_inq AND v_ch = '(' THEN v_depth := v_depth + 1;
          ELSIF NOT v_inq AND v_ch = ')' THEN v_depth := v_depth - 1;
          ELSIF NOT v_inq AND v_depth = 0 AND substr(v_part, v_i, 4) = ' OR ' THEN v_has_or := true;
          ELSIF NOT v_inq AND v_depth = 0 AND substr(v_part, v_i, 5) = ' AND ' THEN
            v_parts := v_parts || substr(v_part, v_start, v_i - v_start);
            v_start := v_i + 5;
            v_i := v_i + 4;
          END IF;
          v_i := v_i + 1;
        END LOOP;
        CONTINUE WHEN v_has_or;
        IF cardinality(v_parts) > 0 THEN
          v_queue := v_queue || v_parts || substr(v_part, v_start);
          CONTINUE;
        END IF;

        -- Atomic conjunct: is it one of the proven exclusions?
        v_part := regexp_replace(v_part, '\s+', ' ', 'g');
        IF v_part = 'false'
           OR (v_part ~ '^bucket_id = ''[^'']*''::text$' AND v_part <> 'bucket_id = ''resumes''::text')
           OR v_part IN ('(storage.foldername(name))[2] <> ''onboarding''::text',
                         '(storage.foldername(name))[2] IS DISTINCT FROM ''onboarding''::text') THEN
          v_excluded := true;
        END IF;
      END LOOP;

      IF NOT v_excluded THEN
        v_bad := concat_ws('; ', v_bad,
                   format('%s [%s] using=%s check=%s', v_pol.polname,
                          CASE v_pol.polcmd WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' ELSE 'ALL' END,
                          coalesce(v_pol.qual, '-'), coalesce(v_pol.wcheck, '-')));
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'preflight: unexpected client write policy on storage.objects can reach resumes/<uid>/onboarding/: %', v_bad
      USING HINT = 'Each such policy must provably exclude the onboarding/ prefix; this migration does not change storage policies.';
  END IF;
  PERFORM set_config('search_path', v_old_path, true);

  -- 3. Refuse an incompatible or foreign pre-existing table.
  IF v_table IS NOT NULL THEN
    IF obj_description(v_table, 'pg_class') IS DISTINCT FROM v_marker THEN
      RAISE EXCEPTION 'preflight: public.onboarding_resume_uploads exists but was not created by this migration';
    END IF;
    SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name)
      INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'onboarding_resume_uploads';
    IF v_cols IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'preflight: public.onboarding_resume_uploads has incompatible columns: % (expected %)',
        v_cols, v_expected;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = v_table AND i.indisprimary AND a.attname = 'user_id' AND i.indnatts = 1
    ) THEN
      RAISE EXCEPTION 'preflight: public.onboarding_resume_uploads primary key is not (user_id)';
    END IF;
  END IF;

  -- 4. Refuse an incompatible or foreign pre-existing function of the same name.
  SELECT string_agg(format('%s(%s) -> %s [%s]', p.proname,
                           pg_get_function_identity_arguments(p.oid),
                           pg_get_function_result(p.oid),
                           coalesce(obj_description(p.oid, 'pg_proc'), 'no marker')), '; ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'list_onboarding_resume_orphans'
     AND (   pg_get_function_identity_arguments(p.oid) <> 'p_older_than interval, p_limit integer'
          OR pg_get_function_result(p.oid) <> 'TABLE(object_name text)'
          OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM v_marker);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'preflight: incompatible or foreign public.list_onboarding_resume_orphans: %', v_bad;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. Additive table: one current onboarding resume per user (pointer to the private object).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.onboarding_resume_uploads (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path text NOT NULL UNIQUE
               CHECK (storage_path LIKE user_id::text || '/onboarding/%'),
  file_name    text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  mime_type    text NOT NULL CHECK (mime_type IN (
                 'application/pdf',
                 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes   integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.onboarding_resume_uploads IS 'created-by:20261118_onboarding_resume_uploads';

-- 2. Owner may read own row; writes are service_role only.
ALTER TABLE public.onboarding_resume_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_resume_uploads FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.onboarding_resume_uploads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.onboarding_resume_uploads TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.onboarding_resume_uploads TO service_role;

DROP POLICY IF EXISTS "onboarding_resume_uploads_owner_select" ON public.onboarding_resume_uploads;
CREATE POLICY "onboarding_resume_uploads_owner_select"
  ON public.onboarding_resume_uploads
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 3. Orphan finder: onboarding objects older than N with no pointer row.
--    Only LISTS names; deletion goes through the Storage API so blobs are really removed.
CREATE OR REPLACE FUNCTION public.list_onboarding_resume_orphans(
  p_older_than interval DEFAULT interval '1 hour',
  p_limit      integer  DEFAULT 500
)
RETURNS TABLE (object_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.name
  FROM storage.objects o
  WHERE o.bucket_id = 'resumes'
    AND (storage.foldername(o.name))[2] = 'onboarding'
    AND o.created_at < now() - p_older_than
    AND NOT EXISTS (
      SELECT 1 FROM public.onboarding_resume_uploads u WHERE u.storage_path = o.name
    )
  ORDER BY o.created_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
$$;
COMMENT ON FUNCTION public.list_onboarding_resume_orphans(interval, integer)
  IS 'created-by:20261118_onboarding_resume_uploads';
ALTER FUNCTION public.list_onboarding_resume_orphans(interval, integer) SET statement_timeout = '5s';
REVOKE ALL ON FUNCTION public.list_onboarding_resume_orphans(interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_onboarding_resume_orphans(interval, integer) TO service_role;

-- ----------------------------------------------------------------------------
-- POST-CHECK (inside the transaction): clients cannot write, service_role can.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r text;
  p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.onboarding_resume_uploads', p) THEN
        RAISE EXCEPTION 'post-check: role % still holds % on public.onboarding_resume_uploads', r, p;
      END IF;
    END LOOP;
    IF has_function_privilege(r, 'public.list_onboarding_resume_orphans(interval,integer)', 'EXECUTE') THEN
      RAISE EXCEPTION 'post-check: role % can EXECUTE public.list_onboarding_resume_orphans', r;
    END IF;
  END LOOP;
  -- Every ACL entry: PUBLIC and anon hold nothing; authenticated holds SELECT only.
  IF EXISTS (
    SELECT 1
      FROM pg_class c
     CROSS JOIN LATERAL aclexplode(c.relacl) AS a
      LEFT JOIN pg_roles g ON g.oid = a.grantee
     WHERE c.oid = 'public.onboarding_resume_uploads'::regclass
       AND (a.grantee = 0 OR g.rolname IN ('anon', 'authenticated'))
       AND NOT (g.rolname = 'authenticated' AND a.privilege_type = 'SELECT')
  ) THEN
    RAISE EXCEPTION 'post-check: PUBLIC/anon/authenticated hold a privilege beyond owner SELECT on public.onboarding_resume_uploads';
  END IF;
  IF has_table_privilege('anon', 'public.onboarding_resume_uploads', 'SELECT') THEN
    RAISE EXCEPTION 'post-check: anon can SELECT public.onboarding_resume_uploads';
  END IF;
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.onboarding_resume_uploads', p) THEN
      RAISE EXCEPTION 'post-check: service_role lacks % on public.onboarding_resume_uploads', p;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.list_onboarding_resume_orphans(interval,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: service_role cannot EXECUTE public.list_onboarding_resume_orphans';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY (run separately after applying):
-- -- Bucket unchanged:
-- SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'resumes';
-- -- Client write is false (expect every column false):
-- SELECT r AS role,
--        has_table_privilege(r, 'public.onboarding_resume_uploads', 'INSERT') AS can_insert,
--        has_table_privilege(r, 'public.onboarding_resume_uploads', 'UPDATE') AS can_update,
--        has_table_privilege(r, 'public.onboarding_resume_uploads', 'DELETE') AS can_delete,
--        has_function_privilege(r, 'public.list_onboarding_resume_orphans(interval,integer)', 'EXECUTE') AS can_exec
--   FROM unnest(ARRAY['anon', 'authenticated']) AS r;
-- -- Service write is true (expect every column true):
-- SELECT has_table_privilege('service_role', 'public.onboarding_resume_uploads', 'INSERT') AS can_insert,
--        has_table_privilege('service_role', 'public.onboarding_resume_uploads', 'UPDATE') AS can_update,
--        has_table_privilege('service_role', 'public.onboarding_resume_uploads', 'DELETE') AS can_delete,
--        has_function_privilege('service_role', 'public.list_onboarding_resume_orphans(interval,integer)', 'EXECUTE') AS can_exec;
-- -- Only the owner-select policy on the new table:
-- SELECT policyname, cmd, roles FROM pg_policies WHERE tablename = 'onboarding_resume_uploads';
-- ============================================================================
-- ROLLBACK (guarded, non-destructive). Acts only on objects carrying this
-- migration's marker comment; keeps every row and every storage object; never
-- touches the bucket or storage policies.
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- SET LOCAL statement_timeout = '60s';
-- DO $$
-- DECLARE
--   v_marker constant text := 'created-by:20261118_onboarding_resume_uploads';
--   v_fn regprocedure := to_regprocedure('public.list_onboarding_resume_orphans(interval,integer)');
--   v_tb regclass := to_regclass('public.onboarding_resume_uploads');
-- BEGIN
--   IF v_fn IS NOT NULL AND obj_description(v_fn, 'pg_proc') = v_marker THEN
--     DROP FUNCTION public.list_onboarding_resume_orphans(interval, integer);
--   ELSE
--     RAISE NOTICE 'rollback: skipping list_onboarding_resume_orphans (absent or not created by this migration)';
--   END IF;
--   IF v_tb IS NOT NULL AND obj_description(v_tb, 'pg_class') = v_marker THEN
--     REVOKE SELECT ON TABLE public.onboarding_resume_uploads FROM authenticated;
--     ALTER TABLE public.onboarding_resume_uploads RENAME TO onboarding_resume_uploads_rolled_back_20261118;
--   ELSE
--     RAISE NOTICE 'rollback: skipping onboarding_resume_uploads (absent or not created by this migration)';
--   END IF;
-- END $$;
-- COMMIT;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261119_onboarding_resume_profiles.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261119_onboarding_resume_profiles.sql
-- Description: Private store for the structured profile parsed from a user's
--   onboarding resume (or LinkedIn "Save to PDF" export) so /api/jobs/recommended
--   can use it for ranking.
--   * Additive only. Depends on 20261118_onboarding_resume_uploads (one row per
--     user there; this row is deleted with it, and with the account).
--   * Stores parsed fields only (job titles, skills, years of experience,
--     education, location, preferred roles). No raw resume text, no contact data.
--   * Writes are service_role only (POST /api/onboarding/resume). The owner may
--     read their own row; nobody else can.
--   * Objects this migration creates carry the marker comment
--     'created-by:20261119_onboarding_resume_profiles'; the rollback only touches
--     objects carrying that marker.
-- Transactional: preflight + DDL + post-checks run in one transaction; any
-- failure rolls everything back. Idempotent: safe to re-run.
-- Status: NOT APPLIED. Record with:
--   node scripts/record-migration.cjs 20261119_onboarding_resume_profiles
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- PREFLIGHT (read-only). Any RAISE EXCEPTION aborts and rolls back everything.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_marker   constant text := 'created-by:20261119_onboarding_resume_profiles';
  v_parent   regclass := to_regclass('public.onboarding_resume_uploads');
  v_table    regclass := to_regclass('public.onboarding_resume_profiles');
  v_cols     text;
  v_expected constant text :=
    'failure_reason:text:YES,parse_source:text:YES,parse_status:text:NO,parsed_at:timestamp with time zone:NO,'
    || 'profile:jsonb:NO,source_storage_path:text:NO,user_id:uuid:NO';
BEGIN
  -- 1. Parent table from 20261118 must exist and be the one that migration created.
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'preflight: public.onboarding_resume_uploads is missing (apply 20261118_onboarding_resume_uploads first)';
  END IF;
  IF obj_description(v_parent, 'pg_class') IS DISTINCT FROM 'created-by:20261118_onboarding_resume_uploads' THEN
    RAISE EXCEPTION 'preflight: public.onboarding_resume_uploads was not created by 20261118_onboarding_resume_uploads';
  END IF;

  -- 2. Refuse an incompatible or foreign pre-existing table.
  IF v_table IS NOT NULL THEN
    IF obj_description(v_table, 'pg_class') IS DISTINCT FROM v_marker THEN
      RAISE EXCEPTION 'preflight: public.onboarding_resume_profiles exists but was not created by this migration';
    END IF;
    SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name)
      INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'onboarding_resume_profiles';
    IF v_cols IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'preflight: public.onboarding_resume_profiles has incompatible columns: % (expected %)',
        v_cols, v_expected;
    END IF;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. Additive table: one parsed profile per user, tied to the current upload.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.onboarding_resume_profiles (
  user_id             uuid PRIMARY KEY
                      REFERENCES public.onboarding_resume_uploads(user_id) ON DELETE CASCADE,
  -- The upload this profile was parsed from. Readers ignore the row when it no
  -- longer matches onboarding_resume_uploads.storage_path (a newer upload).
  source_storage_path text NOT NULL
                      CHECK (source_storage_path LIKE user_id::text || '/onboarding/%'),
  parse_status        text NOT NULL CHECK (parse_status IN ('parsed', 'failed')),
  parse_source        text CHECK (parse_source IN ('ai', 'rules')),
  failure_reason      text CHECK (failure_reason IN ('no_text', 'scanned_pdf', 'parse_error')),
  profile             jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(profile) = 'object' AND octet_length(profile::text) <= 32768),
  parsed_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((parse_status = 'parsed' AND parse_source IS NOT NULL AND failure_reason IS NULL)
      OR (parse_status = 'failed' AND failure_reason IS NOT NULL))
);
COMMENT ON TABLE public.onboarding_resume_profiles IS 'created-by:20261119_onboarding_resume_profiles';

-- 2. Owner may read own row; writes are service_role only.
ALTER TABLE public.onboarding_resume_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_resume_profiles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.onboarding_resume_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.onboarding_resume_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.onboarding_resume_profiles TO service_role;

DROP POLICY IF EXISTS "onboarding_resume_profiles_owner_select" ON public.onboarding_resume_profiles;
CREATE POLICY "onboarding_resume_profiles_owner_select"
  ON public.onboarding_resume_profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 3. Atomic conditional save: locks the pointer row so a newer upload wins atomically.
CREATE OR REPLACE FUNCTION public.save_onboarding_resume_profile(
  p_user_id             uuid,
  p_storage_path        text,
  p_parse_status        text,
  p_parse_source        text,
  p_failure_reason      text,
  p_profile             jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_path text;
BEGIN
  -- Lock the pointer row to serialize saves for this user
  SELECT storage_path INTO v_current_path
    FROM public.onboarding_resume_uploads
   WHERE user_id = p_user_id
     FOR UPDATE;

  -- Stale save: pointer moved or does not exist
  IF v_current_path IS DISTINCT FROM p_storage_path THEN
    RETURN false;
  END IF;

  INSERT INTO public.onboarding_resume_profiles (
    user_id, source_storage_path, parse_status, parse_source, failure_reason, profile, parsed_at
  ) VALUES (
    p_user_id, p_storage_path, p_parse_status, p_parse_source, p_failure_reason, p_profile, now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    source_storage_path = excluded.source_storage_path,
    parse_status        = excluded.parse_status,
    parse_source        = excluded.parse_source,
    failure_reason      = excluded.failure_reason,
    profile             = excluded.profile,
    parsed_at           = excluded.parsed_at;

  RETURN true;
END;
$$;
COMMENT ON FUNCTION public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb)
  IS 'created-by:20261119_onboarding_resume_profiles';
REVOKE ALL ON FUNCTION public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb) TO service_role;

-- ----------------------------------------------------------------------------
-- POST-CHECK (inside the transaction): clients cannot write, service_role can.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r text;
  p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH p IN ARRAY ARRAY['TRUNCATE', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.onboarding_resume_profiles', p) THEN
        RAISE EXCEPTION 'post-check: role % still holds % on public.onboarding_resume_profiles', r, p;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (
    SELECT 1
      FROM pg_class c
     CROSS JOIN LATERAL aclexplode(c.relacl) AS a
      LEFT JOIN pg_roles g ON g.oid = a.grantee
     WHERE c.oid = 'public.onboarding_resume_profiles'::regclass
       AND (a.grantee = 0 OR g.rolname IN ('anon', 'authenticated'))
       AND NOT (g.rolname = 'authenticated' AND a.privilege_type = 'SELECT')
  ) THEN
    RAISE EXCEPTION 'post-check: PUBLIC/anon/authenticated hold a privilege beyond owner SELECT on public.onboarding_resume_profiles';
  END IF;
  IF has_table_privilege('anon', 'public.onboarding_resume_profiles', 'SELECT') THEN
    RAISE EXCEPTION 'post-check: anon can SELECT public.onboarding_resume_profiles';
  END IF;
  IF has_table_privilege('public', 'public.onboarding_resume_profiles', 'SELECT') THEN
    RAISE EXCEPTION 'post-check: public can SELECT public.onboarding_resume_profiles';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy pol
     WHERE pol.polrelid = 'public.onboarding_resume_profiles'::regclass
       AND pol.polname <> 'onboarding_resume_profiles_owner_select'
  ) THEN
    RAISE EXCEPTION 'post-check: unexpected extra policy on public.onboarding_resume_profiles';
  END IF;
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.onboarding_resume_profiles', p) THEN
      RAISE EXCEPTION 'post-check: service_role lacks % on public.onboarding_resume_profiles', p;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: anon can EXECUTE save_onboarding_resume_profile';
  END IF;
  IF has_function_privilege('authenticated', 'public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: authenticated can EXECUTE save_onboarding_resume_profile';
  END IF;
  IF has_function_privilege('public', 'public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: public can EXECUTE save_onboarding_resume_profile';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: service_role lacks EXECUTE on save_onboarding_resume_profile';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY (run separately after applying):
-- -- Client write is false (expect every column false):
-- SELECT r AS role,
--        has_table_privilege(r, 'public.onboarding_resume_profiles', 'INSERT') AS can_insert,
--        has_table_privilege(r, 'public.onboarding_resume_profiles', 'UPDATE') AS can_update,
--        has_table_privilege(r, 'public.onboarding_resume_profiles', 'DELETE') AS can_delete,
--        has_table_privilege(r, 'public.onboarding_resume_profiles', 'TRUNCATE') AS can_truncate
--   FROM unnest(ARRAY['anon', 'authenticated', 'public']) AS r;
-- -- anon cannot read (expect false):
-- SELECT has_table_privilege('anon', 'public.onboarding_resume_profiles', 'SELECT') AS anon_can_select;
-- -- Service write is true (expect every column true):
-- SELECT has_table_privilege('service_role', 'public.onboarding_resume_profiles', 'INSERT') AS can_insert,
--        has_table_privilege('service_role', 'public.onboarding_resume_profiles', 'UPDATE') AS can_update,
--        has_table_privilege('service_role', 'public.onboarding_resume_profiles', 'DELETE') AS can_delete,
--        has_table_privilege('service_role', 'public.onboarding_resume_profiles', 'TRUNCATE') AS can_truncate;
-- -- Only the owner-select policy:
-- SELECT policyname, cmd, roles, qual FROM pg_policies WHERE tablename = 'onboarding_resume_profiles';
-- ============================================================================
-- ROLLBACK (guarded). Acts only on the table carrying this migration's marker.
-- Keeps the rows (renames the table); never touches onboarding_resume_uploads.
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- SET LOCAL statement_timeout = '60s';
-- DO $$
-- DECLARE
--   v_marker constant text := 'created-by:20261119_onboarding_resume_profiles';
--   v_tb regclass := to_regclass('public.onboarding_resume_profiles');
-- BEGIN
--   DROP FUNCTION IF EXISTS public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb);
--   IF v_tb IS NOT NULL AND obj_description(v_tb, 'pg_class') = v_marker THEN
--     REVOKE SELECT ON TABLE public.onboarding_resume_profiles FROM authenticated;
--     ALTER TABLE public.onboarding_resume_profiles RENAME TO onboarding_resume_profiles_rolled_back_20261119;
--   ELSE
--     RAISE NOTICE 'rollback: skipping onboarding_resume_profiles (absent or not created by this migration)';
--   END IF;
-- END $$;
-- COMMIT;
-- ============================================================================


-- ------------------------------------------------------------------------------
-- Migration: 20261120a_restore_tracker_profile_owner_policies.sql
-- ------------------------------------------------------------------------------
-- ============================================================================
-- Migration: 20261120a_restore_tracker_profile_owner_policies.sql
-- STATUS: NOT APPLIED - owner reviews and applies manually in the Supabase SQL editor, then records:
--   node scripts/record-migration.cjs 20261120a_restore_tracker_profile_owner_policies
--
-- Why: the product restore (Tracker, Resume confirm, Profile save, Jobs save/applied and match
-- scores) needs owner-only client access to public.applications and public.candidate_profiles.
-- 20261116c_launch_scope_coming_soon_gates.sql (if applied) dropped the owner SELECT/INSERT/UPDATE
-- policies on those tables and left only USING(false) "coming soon" policies.
--
-- Scope (forward-only, additive in effect, data-preserving):
--   * public.applications, public.candidate_profiles: owner-only SELECT / INSERT / UPDATE for
--     `authenticated` (auth.uid() = user_id); UPDATE also has WITH CHECK so user_id cannot be
--     re-pointed. The existing owner DELETE policies are left as they are.
--   * The matching *_coming_soon_block_* policies on these two tables are dropped (they would be
--     no-ops next to the owner policies because permissive policies are OR-ed).
-- NOT changed (intentionally):
--   * public.tailored_resumes and the private `resumes` storage bucket stay blocked: no reachable
--     product path uses them after AI tool entry points were removed. No owner-folder storage write
--     is re-opened, so resumes/<uid>/onboarding/ isolation (#655) is untouched.
--   * public.resumes (20261116d: no client INSERT) is untouched.
--   * #660 onboarding_resume_profiles / its atomic save RPC are untouched.
-- No rows are read, written or deleted. Transactional and idempotent: safe to run twice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- READ-ONLY PRECHECKS (run first, independently)
-- ----------------------------------------------------------------------------
-- -- Current policies on the two tables:
-- SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
--   FROM pg_policies
--  WHERE schemaname = 'public' AND tablename IN ('applications', 'candidate_profiles')
--  ORDER BY tablename, policyname;
-- -- RLS must be enabled on both:
-- SELECT relname, relrowsecurity, relforcerowsecurity
--   FROM pg_class WHERE oid IN ('public.applications'::regclass, 'public.candidate_profiles'::regclass);
-- -- Effective role ACLs (table privileges must exist for policies to matter):
-- SELECT t, p, has_table_privilege('authenticated', t, p) AS authenticated_has,
--        has_table_privilege('anon', t, p) AS anon_has
--   FROM unnest(ARRAY['public.applications', 'public.candidate_profiles']) AS t,
--        unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ----------------------------------------------------------------------------
-- Effective-policy guard (pre and post): every PERMISSIVE policy on the two tables that reaches
-- PUBLIC, anon, authenticated, or any role they inherit (pg_has_role USAGE) must have each
-- expression (USING and WITH CHECK) be exactly an owner key (auth.uid() = user_id, either order,
-- incl. the (SELECT auth.uid()) form) or false. Anything else (USING (true), OR-ed conditions,
-- user_id IS NOT NULL, ...) could let a non-owner read or write rows, so the migration fails.
-- Session-temporary; dropped before COMMIT.
-- ----------------------------------------------------------------------------
CREATE FUNCTION pg_temp.cm_20261120a_assert_owner_only(p_phase text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  r record;
  v_uid  constant text := '(\(\s*SELECT auth\.uid\(\) AS uid\)|auth\.uid\(\))';
  v_ok   constant text[] := ARRAY[
    '^\(*\s*' || v_uid || '\s*=\s*user_id\s*\)*$',
    '^\(*\s*user_id\s*=\s*' || v_uid || '\s*\)*$',
    '^\(*\s*false\s*\)*$'
  ];
BEGIN
  FOR r IN
    SELECT p.tablename, p.policyname, p.cmd, p.roles, e.expr
      FROM pg_policies p
      CROSS JOIN LATERAL (VALUES (p.qual), (p.with_check)) AS e(expr)
     WHERE p.schemaname = 'public'
       AND p.tablename IN ('applications', 'candidate_profiles')
       AND p.permissive = 'PERMISSIVE'
       AND e.expr IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM unnest(p.roles) AS pr(role_name)
          WHERE CASE WHEN pr.role_name = 'public' THEN true
                     ELSE pg_has_role('anon', pr.role_name, 'USAGE')
                       OR pg_has_role('authenticated', pr.role_name, 'USAGE')
                END)
       AND NOT (e.expr ~* v_ok[1] OR e.expr ~* v_ok[2] OR e.expr ~* v_ok[3])
  LOOP
    RAISE EXCEPTION '%: permissive policy public.%.% (% TO %) can let a non-owner reach rows: %',
      p_phase, r.tablename, r.policyname, r.cmd, r.roles, r.expr;
  END LOOP;
END
$fn$;

-- ----------------------------------------------------------------------------
-- PREFLIGHT: abort (and roll back) if the baseline is not what this migration expects.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['applications', 'candidate_profiles'] LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE EXCEPTION 'preflight: public.% does not exist', v_tbl;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_tbl)::regclass) THEN
      RAISE EXCEPTION 'preflight: RLS is disabled on public.%; refusing to change policies', v_tbl;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_tbl
         AND column_name = 'user_id' AND data_type = 'uuid'
    ) THEN
      RAISE EXCEPTION 'preflight: public.%.user_id (uuid) is missing', v_tbl;
    END IF;
  END LOOP;
  PERFORM pg_temp.cm_20261120a_assert_owner_only('preflight');
END $$;

-- ----------------------------------------------------------------------------
-- public.applications
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "applications_coming_soon_block_select" ON public.applications;
DROP POLICY IF EXISTS "applications_coming_soon_block_insert" ON public.applications;
DROP POLICY IF EXISTS "applications_coming_soon_block_update" ON public.applications;

DROP POLICY IF EXISTS "applications_owner_select" ON public.applications;
CREATE POLICY "applications_owner_select" ON public.applications
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "applications_owner_insert" ON public.applications;
CREATE POLICY "applications_owner_insert" ON public.applications
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "applications_owner_update" ON public.applications;
CREATE POLICY "applications_owner_update" ON public.applications
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- public.candidate_profiles
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_select" ON public.candidate_profiles;
DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_insert" ON public.candidate_profiles;
DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_update" ON public.candidate_profiles;

DROP POLICY IF EXISTS "candidate_profiles_owner_select" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_owner_select" ON public.candidate_profiles
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "candidate_profiles_owner_insert" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_owner_insert" ON public.candidate_profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "candidate_profiles_owner_update" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_owner_update" ON public.candidate_profiles
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- POST-CHECK inside the transaction: owner policies present, no non-owner reach for any client role.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename IN ('applications', 'candidate_profiles')
         AND policyname ~ '_owner_(select|insert|update)$') <> 6 THEN
    RAISE EXCEPTION 'postcheck: expected 6 owner select/insert/update policies';
  END IF;
  PERFORM pg_temp.cm_20261120a_assert_owner_only('postcheck');
END $$;

DROP FUNCTION pg_temp.cm_20261120a_assert_owner_only(text);

COMMIT;

-- ============================================================================
-- VERIFY (run independently after applying)
-- ============================================================================
-- SELECT tablename, policyname, roles, cmd, qual, with_check FROM pg_policies
--  WHERE schemaname = 'public' AND tablename IN ('applications', 'candidate_profiles')
--  ORDER BY tablename, policyname;
--   -- expect *_owner_select / *_owner_insert / *_owner_update / *_owner_delete, TO authenticated,
--   -- all keyed on auth.uid() = user_id; no *_coming_soon_block_* rows.
-- -- Cross-user check with two test accounts (A and B), as each user's JWT via the client:
-- --   A: insert into applications/candidate_profiles with user_id = A  -> succeeds
-- --   A: insert with user_id = B                                         -> rejected (RLS)
-- --   A: select ... where user_id = B                                    -> 0 rows
-- --   A: update own row set user_id = B                                  -> rejected (WITH CHECK)

-- ============================================================================
-- ROLLBACK (data-preserving: policies only, no rows touched)
-- ============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS "applications_owner_select" ON public.applications;
-- DROP POLICY IF EXISTS "applications_owner_insert" ON public.applications;
-- DROP POLICY IF EXISTS "applications_owner_update" ON public.applications;
-- CREATE POLICY "applications_coming_soon_block_select" ON public.applications FOR SELECT TO authenticated, anon USING (false);
-- CREATE POLICY "applications_coming_soon_block_insert" ON public.applications FOR INSERT TO authenticated, anon WITH CHECK (false);
-- CREATE POLICY "applications_coming_soon_block_update" ON public.applications FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
-- DROP POLICY IF EXISTS "candidate_profiles_owner_select" ON public.candidate_profiles;
-- DROP POLICY IF EXISTS "candidate_profiles_owner_insert" ON public.candidate_profiles;
-- DROP POLICY IF EXISTS "candidate_profiles_owner_update" ON public.candidate_profiles;
-- CREATE POLICY "candidate_profiles_coming_soon_block_select" ON public.candidate_profiles FOR SELECT TO authenticated, anon USING (false);
-- CREATE POLICY "candidate_profiles_coming_soon_block_insert" ON public.candidate_profiles FOR INSERT TO authenticated, anon WITH CHECK (false);
-- CREATE POLICY "candidate_profiles_coming_soon_block_update" ON public.candidate_profiles FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
-- COMMIT;

