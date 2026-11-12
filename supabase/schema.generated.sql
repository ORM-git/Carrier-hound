-- ==============================================================================
-- CareerMonke Schema Representation (Generated from Migrations)
-- Freshness Header: Generated on 2026-11-12
-- Migrations Count: 72
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

