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
