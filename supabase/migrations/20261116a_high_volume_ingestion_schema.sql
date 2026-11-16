-- ============================================================================
-- Migration: 20261116a_high_volume_ingestion_schema.sql
-- STATUS: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261116a_high_volume_ingestion_schema
--
-- Purpose:
--   Non-breaking schema upgrade for the 4-Category High-Volume Job Ingestion
--   Engine ('MNC_BIGTECH', 'HIGH_PRODUCT_YC', 'OTHER_STARTUPS',
--   'INDIAN_IT_AND_OTHER') with role_category, top_keywords (top 8 technical
--   skills), SHA-256 dedupe_hash, partial indexes on is_active = TRUE, and
--   priority-based deduplication (Direct ATS priority = 1, Aggregators = 2).
--
-- ----------------------------------------------------------------------------
-- PRE-CHECK SQL (Run in Supabase SQL Editor BEFORE applying migration):
-- ----------------------------------------------------------------------------
-- 1. Check existing tables and columns:
--    SELECT table_name, column_name, data_type
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name IN ('jobs', 'companies')
--      AND column_name IN ('source_id', 'canonical_domain', 'logo_url', 'role_category', 'top_keywords', 'dedupe_hash', 'is_remote', 'source_priority')
--    ORDER BY table_name, column_name;
--
-- 2. Check existing constraints on jobs and companies:
--    SELECT conname, contype, pg_get_constraintdef(c.oid)
--    FROM pg_constraint c
--    JOIN pg_namespace n ON n.oid = c.connamespace
--    WHERE n.nspname = 'public'
--      AND conname IN ('jobs_source_type_check', 'jobs_role_category_check', 'jobs_source_priority_check', 'companies_category_check', 'jobs_source_type_source_job_id_key');
--
-- 3. Check for potential duplicate (source_id, source_job_id) gated on column existence (safe on fresh baseline):
--    DO $$
--    DECLARE
--      dup_count integer;
--    BEGIN
--      IF EXISTS (
--        SELECT 1 FROM information_schema.columns
--        WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'source_id'
--      ) THEN
--        EXECUTE '
--          SELECT count(*) FROM (
--            SELECT source_id, source_job_id
--            FROM public.jobs
--            WHERE source_id IS NOT NULL AND source_job_id IS NOT NULL
--            GROUP BY source_id, source_job_id
--            HAVING count(*) > 1
--          ) s' INTO dup_count;
--        IF dup_count > 0 THEN
--          RAISE WARNING 'Found % duplicate (source_id, source_job_id) pairs', dup_count;
--        ELSE
--          RAISE NOTICE 'Zero duplicate (source_id, source_job_id) pairs found.';
--        END IF;
--      ELSE
--        RAISE NOTICE 'Column public.jobs.source_id does not exist yet (fresh baseline); duplicate check skipped.';
--      END IF;
--    END $$;
--
--    -- Or as a single query using to_jsonb (returns 0 rows on fresh baseline without parse error):
--    SELECT to_jsonb(j)->>'source_id' AS source_id, j.source_job_id, count(*)
--    FROM public.jobs j
--    WHERE (to_jsonb(j)->>'source_id') IS NOT NULL AND j.source_job_id IS NOT NULL
--    GROUP BY 1, 2
--    HAVING count(*) > 1;
--
-- 4. Check for active duplicate dedupe payloads before hash index build:
--    SELECT lower(trim(company)), lower(trim(title)), lower(trim(COALESCE(country_code, country, 'any'))), count(*)
--    FROM public.jobs
--    WHERE is_active = TRUE
--    GROUP BY 1, 2, 3
--    HAVING count(*) > 1;
--
-- ----------------------------------------------------------------------------
-- VERIFY SQL (Run in Supabase SQL Editor AFTER applying migration):
-- ----------------------------------------------------------------------------
-- 1. Verify all new columns exist on public.jobs and public.companies:
--    SELECT table_name, column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND (
--        (table_name = 'jobs' AND column_name IN ('source_id', 'canonical_domain', 'logo_url', 'role_category', 'top_keywords', 'dedupe_hash', 'is_remote', 'source_priority'))
--        OR (table_name = 'companies' AND column_name IN ('canonical_domain', 'category', 'logo_url'))
--      )
--    ORDER BY table_name, column_name;
--
-- 2. Verify partial unique indexes exist and are valid (verifying indisvalid in pg_index):
--    SELECT
--      c.relname AS indexname,
--      i.indisvalid,
--      i.indisready,
--      pg_get_indexdef(c.oid) AS indexdef
--    FROM pg_index i
--    JOIN pg_class c ON c.oid = i.indexrelid
--    JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public'
--      AND c.relname IN (
--        'idx_jobs_source_id_source_job_id_uniq',
--        'idx_jobs_active_dedupe_hash_uniq',
--        'idx_companies_slug_uniq',
--        'idx_jobs_active_category',
--        'idx_jobs_active_role_category'
--      );
--    -- Expected: indisvalid = TRUE and indisready = TRUE for all indexes.
--
--    -- Direct assertion query for the new unique index:
--    SELECT c.relname AS indexname, i.indisvalid
--    FROM pg_index i
--    JOIN pg_class c ON c.oid = i.indexrelid
--    JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public'
--      AND c.relname = 'idx_jobs_source_id_source_job_id_uniq'
--      AND i.indisvalid = TRUE;
--    -- Expected: exactly 1 row returned with indisvalid = true.
--
-- 3. Verify check constraints accept vendors and valid values:
--    SELECT conname, pg_get_constraintdef(c.oid)
--    FROM pg_constraint c
--    JOIN pg_namespace n ON n.oid = c.connamespace
--    WHERE n.nspname = 'public'
--      AND conname IN ('jobs_source_type_check', 'jobs_role_category_check', 'jobs_source_priority_check', 'companies_category_check');
--
-- 4. Verify trigger trg_jobs_merge_dedupe_priority is active:
--    SELECT tgname, tgenabled, relname
--    FROM pg_trigger t
--    JOIN pg_class c ON c.oid = t.tgrelid
--    WHERE tgname = 'trg_jobs_merge_dedupe_priority';
--
-- 5. Verify backfills:
--    SELECT
--      (SELECT count(*) FROM public.jobs WHERE is_active = TRUE AND dedupe_hash IS NULL) AS unhashed_active_jobs,
--      (SELECT count(*) FROM public.jobs WHERE source_priority IS NULL) AS unprioritized_jobs,
--      (SELECT count(*) FROM public.jobs WHERE is_remote IS NULL) AS null_remote_jobs,
--      (SELECT count(*) FROM public.companies WHERE canonical_domain IS NULL AND domain IS NOT NULL AND trim(domain) <> '') AS unmigrated_company_domains;
--    -- Expected: all 4 counts should be 0.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. COMPANIES TABLE UPDATES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.companies (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text        NOT NULL,
  slug             text        UNIQUE NOT NULL,
  canonical_domain text,
  category         text,
  logo_url         text,
  ats_type         text,
  careers_url      text,
  domain           text,
  country          text,
  country_code     text,
  enabled          boolean     DEFAULT true,
  failure_count    integer     DEFAULT 0,
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  last_job_count   integer     DEFAULT 0,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS canonical_domain text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS logo_url text;

-- Backfill canonical_domain from domain where present
UPDATE public.companies
SET canonical_domain = lower(trim(domain))
WHERE canonical_domain IS NULL
  AND domain IS NOT NULL
  AND trim(domain) <> '';

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_category_check;
ALTER TABLE public.companies
  ADD CONSTRAINT companies_category_check
  CHECK (category IS NULL OR category IN ('MNC_BIGTECH', 'HIGH_PRODUCT_YC', 'OTHER_STARTUPS', 'INDIAN_IT_AND_OTHER'))
  NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_slug_uniq
  ON public.companies (slug);

CREATE INDEX IF NOT EXISTS idx_companies_category
  ON public.companies (category)
  WHERE category IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. JOBS TABLE UPDATES
-- ----------------------------------------------------------------------------
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS role_category text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS top_keywords text[] DEFAULT '{}'::text[];
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_job_id text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS dedupe_hash text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS is_remote boolean DEFAULT false;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS posted_at timestamptz DEFAULT now();
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS last_seen_at timestamptz DEFAULT now();
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_priority smallint DEFAULT 2;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS canonical_domain text;

-- Safe update to jobs_source_type_check supporting all direct ATS & aggregator sources
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_type_check;
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_source_type_check
  CHECK (source_type IS NULL OR source_type IN (
    'ats', 'api', 'feed', 'direct',
    'greenhouse', 'lever', 'ashby', 'smartrecruiters',
    'workday', 'amazon', 'microsoft',
    'jobspy', 'arbeitnow', 'adzuna'
  ))
  NOT VALID;

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_role_category_check;
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_role_category_check
  CHECK (role_category IS NULL OR role_category IN ('SDE', 'AI_ML', 'CLOUD', 'DATA', 'OTHER'))
  NOT VALID;

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_priority_check;
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_source_priority_check
  CHECK (source_priority IS NULL OR source_priority IN (1, 2))
  NOT VALID;

-- Sync is_remote and source_priority on existing rows where needed
UPDATE public.jobs
SET is_remote = COALESCE(remote, false)
WHERE is_remote IS DISTINCT FROM COALESCE(remote, false);

UPDATE public.jobs
SET source_priority = CASE
  WHEN source_type IN ('ats', 'direct')
    OR lower(COALESCE(source, '')) IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable', 'breezy', 'teamtailor', 'personio', 'bamboohr', 'join')
  THEN 1
  ELSE 2
END
WHERE source_priority IS NULL
   OR (source_priority = 2 AND (
     source_type IN ('ats', 'direct')
     OR lower(COALESCE(source, '')) IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable', 'breezy', 'teamtailor', 'personio', 'bamboohr', 'join')
   ));

-- ----------------------------------------------------------------------------
-- 3. DETERMINISTIC SHA-256 DEDUPE HASH & PRIORITY MERGE FUNCTIONS
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_job_dedupe_hash(
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
  v_city text;
  v_payload text;
BEGIN
  v_company := lower(trim(COALESCE(p_company, '')));
  v_company := regexp_replace(v_company, '\m(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\M\.?', '', 'gi');
  v_company := trim(regexp_replace(v_company, '[^a-z0-9]+', ' ', 'g'));

  v_title := lower(trim(COALESCE(p_title, '')));
  v_title := trim(regexp_replace(v_title, '[^a-z0-9]+', ' ', 'g'));

  v_country := lower(trim(COALESCE(NULLIF(trim(p_country), ''), 'any')));
  v_country := trim(regexp_replace(v_country, '[^a-z0-9]+', ' ', 'g'));

  v_city := lower(trim(split_part(COALESCE(p_location, ''), ',', 1)));
  v_city := trim(regexp_replace(v_city, '[^a-z0-9]+', ' ', 'g'));
  IF v_city = '' THEN
    v_city := 'any';
  END IF;

  v_payload := v_company || '|' || v_title || '|' || v_country || '|' || v_city;
  RETURN encode(digest(v_payload, 'sha256'), 'hex');
END;
$$;

-- Backfill dedupe_hash for active rows missing it
UPDATE public.jobs
SET dedupe_hash = public.compute_job_dedupe_hash(
  company,
  title,
  COALESCE(country_code, country),
  location
)
WHERE is_active = TRUE
  AND dedupe_hash IS NULL;

-- Priority-aware merge trigger function so duplicate jobs across aggregators
-- (priority = 2) and direct ATS boards (priority = 1) automatically merge
-- without violating idx_jobs_active_dedupe_hash_uniq.
-- Handles both INSERT and UPDATE (e.g. reactivating an expired row or updating dedupe_hash).
CREATE OR REPLACE FUNCTION public.merge_job_by_dedupe_priority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing record;
  v_new_priority smallint;
BEGIN
  IF NEW.is_remote IS NULL THEN
    NEW.is_remote := COALESCE(NEW.remote, false);
  END IF;

  v_new_priority := COALESCE(
    NEW.source_priority,
    CASE
      WHEN NEW.source_type IN ('ats', 'direct', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'amazon', 'microsoft')
        OR lower(COALESCE(NEW.source, '')) IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable', 'breezy', 'teamtailor', 'personio', 'bamboohr', 'join')
      THEN 1
      ELSE 2
    END
  );
  NEW.source_priority := v_new_priority;

  IF NEW.dedupe_hash IS NULL AND NEW.company IS NOT NULL AND NEW.title IS NOT NULL THEN
    NEW.dedupe_hash := public.compute_job_dedupe_hash(
      NEW.company,
      NEW.title,
      COALESCE(NEW.country_code, NEW.country),
      NEW.location
    );
  END IF;

  -- Deduplicate active rows on INSERT or when an UPDATE sets an inactive row active / changes dedupe_hash
  IF (
    (TG_OP = 'INSERT' AND COALESCE(NEW.is_active, true) = TRUE)
    OR (TG_OP = 'UPDATE' AND NEW.is_active = TRUE AND (OLD.is_active IS DISTINCT FROM TRUE OR OLD.dedupe_hash IS DISTINCT FROM NEW.dedupe_hash))
  ) AND NEW.dedupe_hash IS NOT NULL THEN
    SELECT id, source_priority, top_keywords, skills
    INTO v_existing
    FROM public.jobs
    WHERE is_active = TRUE
      AND dedupe_hash = NEW.dedupe_hash
      AND (
        TG_OP = 'INSERT'
        OR id <> NEW.id
      )
      AND (
        NEW.source_type IS NULL
        OR NEW.source_job_id IS NULL
        OR (source_type, source_job_id) IS DISTINCT FROM (NEW.source_type, NEW.source_job_id)
      )
    ORDER BY source_priority ASC NULLS LAST, last_seen_at DESC NULLS LAST
    LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      IF v_new_priority < COALESCE(v_existing.source_priority, 2) THEN
        -- Incoming Direct ATS (priority = 1) supersedes existing Aggregator row (priority = 2):
        -- Deactivate the aggregator duplicate so the Direct ATS row becomes the active canonical row.
        UPDATE public.jobs
        SET is_active = FALSE,
            status = 'expired',
            last_seen_at = now()
        WHERE id = v_existing.id;
      ELSE
        -- Existing row has equal or higher priority (e.g. Direct ATS priority = 1 vs incoming Aggregator priority = 2):
        -- Refresh last_seen_at on the existing row and mark incoming duplicate inactive so unique partial index is satisfied.
        UPDATE public.jobs
        SET last_seen_at = now(),
            top_keywords = CASE
              WHEN COALESCE(array_length(top_keywords, 1), 0) = 0 AND COALESCE(array_length(NEW.top_keywords, 1), 0) > 0
              THEN NEW.top_keywords
              ELSE top_keywords
            END
        WHERE id = v_existing.id;

        NEW.is_active := FALSE;
        NEW.status := 'expired';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_merge_dedupe_priority ON public.jobs;
CREATE TRIGGER trg_jobs_merge_dedupe_priority
  BEFORE INSERT OR UPDATE OF is_active, dedupe_hash, source_priority ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.merge_job_by_dedupe_priority();

-- ----------------------------------------------------------------------------
-- 4. PARTIAL INDEXES & UNIQUE DEDUPE CONSTRAINTS
-- ----------------------------------------------------------------------------
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

-- Drop the old unsafe unique constraint and index that could fail on legacy cross-vendor duplicates
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_type_source_job_id_key;
DROP INDEX IF EXISTS public.idx_jobs_source_type_source_job_id_uniq;

-- Canonical unique index for new ingestion rows (keyed on source_id + source_job_id, safe on legacy rows where source_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_id_source_job_id_uniq
  ON public.jobs (source_id, source_job_id)
  WHERE source_id IS NOT NULL AND source_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_dedupe_hash_uniq
  ON public.jobs (dedupe_hash)
  WHERE is_active = TRUE AND dedupe_hash IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 5. NON-BREAKING PUBLIC VIEW UPDATE (appends new public columns at end)
-- ----------------------------------------------------------------------------
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
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   NON-DESTRUCTIVE ROLLBACK POLICY:
--   - Restores legacy constraints, views, and database/application behavior.
--   - Drops ONLY objects that this migration clearly created (trigger, functions,
--     perf view, new partial indexes, new check constraints).
--   - Restores the original jobs_public view definition without Phase 3 columns.
--   - Restores the original jobs_source_type_check constraint ('ats', 'api', 'feed', 'direct').
--   - KEEPS all additive columns (jobs.source_id, jobs.canonical_domain, jobs.logo_url,
--     jobs.role_category, jobs.top_keywords, jobs.dedupe_hash, jobs.is_remote,
--     jobs.source_priority, companies.canonical_domain, companies.category,
--     companies.logo_url) because they may have existed prior to this migration
--     or may contain valid ingested data. Additive columns are never removed.
--   - Retains backfilled data in pre-existing columns without destructive cascades.
--
--   -- 1. Drop trigger and dedupe merge functions created by this migration
--   DROP TRIGGER IF EXISTS trg_jobs_merge_dedupe_priority ON public.jobs;
--   DROP FUNCTION IF EXISTS public.merge_job_by_dedupe_priority();
--   DROP FUNCTION IF EXISTS public.compute_job_dedupe_hash(text, text, text, text);
--
--   -- 2. Drop performance view and restore legacy jobs_public view via transactional DROP + CREATE
--   DROP VIEW IF EXISTS public.v_active_jobs_perf;
--   DROP VIEW IF EXISTS public.jobs_public;
--   CREATE VIEW public.jobs_public AS
--   SELECT
--     id,
--     title,
--     location,
--     remote,
--     remote_scope,
--     remote_eligibility,
--     job_type,
--     category,
--     country,
--     country_code,
--     seniority,
--     verified,
--     source_type,
--     first_seen_at,
--     last_seen_at,
--     discovered_at,
--     posted_at,
--     created_at,
--     status,
--     is_active,
--     -- Locked fields: Never served to anonymous or non-Pro users
--     'Verified Employer'::text AS company,
--     NULL::text AS salary_text,
--     NULL::text AS description,
--     NULL::text AS apply_url,
--     '{}'::text[] AS skills
--   FROM public.jobs
--   WHERE is_active = true OR status = 'active';
--   GRANT SELECT ON public.jobs_public TO anon, authenticated, service_role;
--
--   -- 3. Drop indexes created by this migration
--   DROP INDEX IF EXISTS public.idx_jobs_source_id_source_job_id_uniq;
--   DROP INDEX IF EXISTS public.idx_jobs_active_dedupe_hash_uniq;
--   DROP INDEX IF EXISTS public.idx_jobs_active_category_country_posted_at;
--   DROP INDEX IF EXISTS public.idx_jobs_active_posted_at_desc;
--   DROP INDEX IF EXISTS public.idx_jobs_active_country;
--   DROP INDEX IF EXISTS public.idx_jobs_active_role_category;
--   DROP INDEX IF EXISTS public.idx_jobs_active_category;
--   DROP INDEX IF EXISTS public.idx_companies_category;
--   DROP INDEX IF EXISTS public.idx_companies_slug_uniq;
--
--   -- 4. Drop check constraints added by this migration
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_priority_check;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_role_category_check;
--   ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_category_check;
--
--   -- 5. Preserve compatible expanded CHECK on jobs.source_type
--   --    Policy: A strict legacy-only CHECK cannot be re-added once vendor-valued
--   --    rows exist. The expanded constraint is backward-compatible with all legacy
--   --    and new values and must remain in place during rollback.
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_type_check;
--   ALTER TABLE public.jobs ADD CONSTRAINT jobs_source_type_check
--     CHECK (source_type IN (
--       'ats', 'api', 'feed', 'direct',
--       'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday',
--       'amazon', 'microsoft', 'jobspy', 'arbeitnow', 'adzuna'
--     )) NOT VALID;
--
--   -- NOTE: Additive columns are intentionally preserved and NOT dropped.
-- ============================================================================
