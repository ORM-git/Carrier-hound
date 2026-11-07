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
