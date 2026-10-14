-- ==============================================================================
-- DO NOT APPLY / REVIEW PENDING — PHASE A: RECONCILED SCHEMA DDL
-- CareerMonke (Carrier-hound) — Database Migration Staged Deployment: Phase A
-- File: supabase/scripts/phase-a-schema.sql
-- Status: UNDER REVIEW — DO NOT RUN ON LIVE PRODUCTION DATABASE
--
-- RECONCILIATION SUMMARY (BASED ON LIVE SUPABASE VERIFIED FACTS):
-- 1. PostgreSQL Version: 17.6
-- 2. Extensions: pg_trgm and unaccent are available but NOT installed.
--    Created with: WITH SCHEMA extensions.
--    OPERATOR-CLASS / SEARCH_PATH IMPACT:
--    - When pg_trgm is in schema 'extensions', its operator classes (gin_trgm_ops)
--      and functions reside in 'extensions'.
--    - Indexes using trigram ops in Phase C should use 'extensions.gin_trgm_ops'
--      or ensure 'extensions' is in the session search_path.
-- 3. Existing Columns on public.jobs (DO NOT RE-ADD):
--    id, company, title, location, remote_scope, job_type, salary_text, description,
--    skills, apply_url, source_url, first_seen_at, last_seen_at, status, category,
--    country, date, remote, source, source_job_id, salary_min, salary_max, currency,
--    posted_at, expires_at, is_active, created_at, company_id, verified, verified_at,
--    source_type, discovered_at, country_code, remote_eligibility, seniority, salary_period.
-- 4. Reusing salary_period (DO NOT ADD duplicate 'period' column):
--    - Live DB already has 'salary_period' with CHECK (salary_period IN ('yearly', 'monthly', 'hourly')).
--    - 17,423 live rows already populated with 'salary_period'.
--    - Adding another column 'period' with ('year', 'month', 'hour') would cause duplicate
--      columns, schema confusion, data sync drift, and dual-column indexing overhead.
-- 5. Missing Columns to Add (TRULY MISSING ONLY):
--    - categories TEXT[] DEFAULT '{}'
--    - eligible_countries TEXT[] DEFAULT '{}'
-- 6. Missing Tables to Create:
--    - public.tailored_resumes
--    - public.ai_usage_quotas
-- 7. Security & Grants Decoupled:
--    - All GRANT / REVOKE / POLICY / RPC drop statements removed to security-review.sql.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. EXTENSIONS (INSTALLED INTO extensions SCHEMA PER SUPABASE STANDARD)
-- ------------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- ------------------------------------------------------------------------------
-- 2. ADD TRULY MISSING COLUMNS TO public.jobs
-- ------------------------------------------------------------------------------
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS categories TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS eligible_countries TEXT[] DEFAULT '{}';

-- ------------------------------------------------------------------------------
-- 3. CREATE MISSING TABLE: public.tailored_resumes
-- ------------------------------------------------------------------------------
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

-- ------------------------------------------------------------------------------
-- 4. CREATE MISSING TABLE: public.ai_usage_quotas
-- ------------------------------------------------------------------------------
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

COMMIT;

-- ------------------------------------------------------------------------------
-- 5. PHASE A VERIFICATION SELECT
-- ------------------------------------------------------------------------------
SELECT
  -- Extensions check
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS has_ext_pg_trgm,
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') AS has_ext_unaccent,
  -- Columns check
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'categories') AS has_col_categories,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'eligible_countries') AS has_col_eligible_countries,
  -- Tables check
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tailored_resumes') AS has_table_tailored_resumes,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_usage_quotas') AS has_table_ai_usage_quotas;
