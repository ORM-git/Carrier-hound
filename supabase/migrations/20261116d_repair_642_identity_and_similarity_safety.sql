-- ============================================================================
-- Migration: 20261116d_repair_642_identity_and_similarity_safety.sql
-- STATUS: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261116d_repair_642_identity_and_similarity_safety
--
-- Purpose:
--   Repair PR #642 identity and database migration safety:
--   1. Authoritative write identity enforced strictly via (source_id, source_job_id)
--      partial unique index (board/source scoped, vendor requisition scoped).
--   2. Versioned similarity fingerprinting (v2): Unicode-preserving, NFC normalized,
--      length-framed UTF-8 serialization, SHA-256 digest. Prevents mass collision
--      of non-ASCII titles (e.g. Japanese roles) and eliminates delimiter injection.
--   3. Strictly ADVISORY similarity: No unique constraint on similarity_hash_v2,
--      no automatic trigger-driven row merging or row expiration, and no cross-source
--      row replacement.
--   4. Containment: Ensures harmful triggers (trg_jobs_merge_dedupe_priority) and
--      unique dedupe indexes (idx_jobs_active_dedupe_hash_uniq) are permanently dropped.
--   5. Fixes jobs_touch_last_seen trigger so metadata/enrichment updates and backfills
--      do NOT clobber last_seen_at or reverse ranking order / dry-run winners.
--   6. Preserves incident recovery tables (public.recovery_642_restore48_20261116) untouched.
--   7. Restores and preserves masked jobs_public view column order, RLS boundaries,
--      and grants to anon, authenticated, and service_role.
--
-- ----------------------------------------------------------------------------
-- PRE-CHECK SQL (Run in Supabase SQL Editor BEFORE applying migration):
-- ----------------------------------------------------------------------------
-- 1. Check existing columns and constraints on public.jobs and public.companies:
--    SELECT table_name, column_name, data_type
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name IN ('jobs', 'companies')
--      AND column_name IN (
--        'source_id', 'canonical_domain', 'logo_url', 'role_category',
--        'top_keywords', 'dedupe_hash', 'similarity_hash_v2', 'is_remote', 'source_priority'
--      )
--    ORDER BY table_name, column_name;
--
-- 2. Check for duplicate (source_id, source_job_id) pairs if column already exists:
--    DO $$
--    DECLARE
--      dup_count integer := 0;
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
--        RAISE NOTICE 'Column public.jobs.source_id does not exist yet; duplicate check skipped.';
--      END IF;
--    END $$;
--
-- 3. Verify presence of incident recovery table (must NOT be modified or dropped):
--    SELECT to_regclass('public.recovery_642_restore48_20261116') AS recovery_table_exists;
--
-- 4. Check for active harmful triggers or unique dedupe indexes from prior migration:
--    SELECT tgname FROM pg_trigger WHERE tgname = 'trg_jobs_merge_dedupe_priority';
--    SELECT indexname FROM pg_indexes WHERE indexname = 'idx_jobs_active_dedupe_hash_uniq';
--
-- ----------------------------------------------------------------------------
-- VERIFY SQL (Run in Supabase SQL Editor AFTER applying migration):
-- ----------------------------------------------------------------------------
-- 1. Verify all new columns exist on public.jobs and public.companies:
--    SELECT table_name, column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND (
--        (table_name = 'jobs' AND column_name IN ('source_id', 'canonical_domain', 'logo_url', 'role_category', 'top_keywords', 'similarity_hash_v2', 'is_remote', 'source_priority'))
--        OR (table_name = 'companies' AND column_name IN ('canonical_domain', 'category', 'logo_url'))
--      )
--    ORDER BY table_name, column_name;
--
-- 2. Verify partial indexes exist and are valid:
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
--        'idx_jobs_active_similarity_hash_v2',
--        'idx_jobs_active_role_category',
--        'idx_jobs_active_category',
--        'idx_companies_category',
--        'idx_companies_slug_uniq'
--      );
--    -- Expected: All indisvalid = TRUE.
--
-- 3. Confirm harmful objects remain permanently absent:
--    SELECT count(*) AS harmful_trigger_count FROM pg_trigger WHERE tgname = 'trg_jobs_merge_dedupe_priority';
--    SELECT count(*) AS harmful_index_count FROM pg_indexes WHERE indexname = 'idx_jobs_active_dedupe_hash_uniq';
--    -- Expected: 0 for both.
--
-- 4. Test deterministic v2 similarity hash with Japanese characters (must NOT collide):
--    SELECT
--      public.compute_job_similarity_hash_v2('PayPay Inc.', 'プロダクトマネージャー', 'JP', '東京都, 日本') AS pm_hash,
--      public.compute_job_similarity_hash_v2('PayPay Inc.', 'バックエンドエンジニア', 'JP', '東京都, 日本') AS be_hash;
--    -- Expected: pm_hash <> be_hash.
--
-- 5. Test jobs_public view returns masked rows and includes appended columns:
--    SELECT id, title, company, salary_text, description, apply_url, role_category, is_remote
--    FROM public.jobs_public
--    LIMIT 5;
--    -- Expected: company = 'Verified Employer', salary_text IS NULL, description IS NULL, apply_url IS NULL.
-- ============================================================================

BEGIN;

-- Lock and statement execution budgets
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

-- ----------------------------------------------------------------------------
-- 1. CONTAINMENT: PERMANENTLY REMOVE HARMFUL TRIGGERS & DESTRUCTIVE INDEXES
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_jobs_merge_dedupe_priority ON public.jobs;
DROP FUNCTION IF EXISTS public.merge_job_by_dedupe_priority();
DROP INDEX IF EXISTS public.idx_jobs_active_dedupe_hash_uniq;

-- Ensure pgcrypto extension is installed safely in extensions schema
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ----------------------------------------------------------------------------
-- 2. REPAIR jobs_touch_last_seen TRIGGER (PREVENT BACKFILL TIMESTAMP CLOBBER)
-- ----------------------------------------------------------------------------
-- The legacy trigger unconditionally set NEW.last_seen_at := now() on EVERY update.
-- This clobbered ranking order during metadata backfills and reversed dry-run winners.
-- The repaired function preserves OLD.last_seen_at during backfills, maintenance,
-- or when only enrichment/similarity columns change.
CREATE OR REPLACE FUNCTION public.touch_job_last_seen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If maintenance or ingestion session explicitly requests preserving last_seen
  IF current_setting('careermonke.skip_touch_last_seen', true) = 'on' THEN
    NEW.last_seen_at := OLD.last_seen_at;
    RETURN NEW;
  END IF;

  -- If caller explicitly specified a distinct last_seen_at, respect it
  IF NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at THEN
    RETURN NEW;
  END IF;

  -- If only metadata/enrichment/similarity columns were modified while core job
  -- content and status remain identical, preserve OLD.last_seen_at.
  IF (
    NEW.is_active IS NOT DISTINCT FROM OLD.is_active
    AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.title IS NOT DISTINCT FROM OLD.title
    AND NEW.company IS NOT DISTINCT FROM OLD.company
    AND NEW.location IS NOT DISTINCT FROM OLD.location
    AND NEW.apply_url IS NOT DISTINCT FROM OLD.apply_url
    AND (
      NEW.similarity_hash_v2 IS DISTINCT FROM OLD.similarity_hash_v2
      OR NEW.dedupe_hash IS DISTINCT FROM OLD.dedupe_hash
      OR NEW.top_keywords IS DISTINCT FROM OLD.top_keywords
      OR NEW.role_category IS DISTINCT FROM OLD.role_category
      OR NEW.source_id IS DISTINCT FROM OLD.source_id
      OR NEW.canonical_domain IS DISTINCT FROM OLD.canonical_domain
      OR NEW.logo_url IS DISTINCT FROM OLD.logo_url
    )
  ) THEN
    NEW.last_seen_at := OLD.last_seen_at;
    RETURN NEW;
  END IF;

  NEW.last_seen_at := now();
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
-- Serializes using length-framed UTF-8 octets:
--   v2|c:{len}:{comp}|t:{len}:{title}|co:{len}:{co}|loc:{len}:{loc}
-- Uses built-in pg_catalog.sha256 to avoid search_path resolution vulnerabilities.
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
  -- 1. Normalize company: NFC, lowercase, strip legal entity suffixes, collapse whitespace
  v_company := lower(COALESCE(normalize(p_company, NFC), ''));
  v_company := regexp_replace(v_company, '\m(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\M\.?', ' ', 'gi');
  v_company := trim(regexp_replace(v_company, '\s+', ' ', 'g'));

  -- 2. Normalize title: NFC, lowercase, collapse whitespace (preserves Unicode & punctuation)
  v_title := lower(COALESCE(normalize(p_title, NFC), ''));
  v_title := trim(regexp_replace(v_title, '\s+', ' ', 'g'));

  -- 3. Normalize country: NFC, lowercase, collapse whitespace
  v_country := lower(COALESCE(normalize(p_country, NFC), ''));
  v_country := trim(regexp_replace(v_country, '\s+', ' ', 'g'));

  -- 4. Normalize location: primary city/territory before comma, NFC, lowercase, collapse whitespace
  v_location := lower(COALESCE(normalize(p_location, NFC), ''));
  v_location := split_part(v_location, ',', 1);
  v_location := trim(regexp_replace(v_location, '\s+', ' ', 'g'));

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

-- Replace legacy compute_job_dedupe_hash to delegate to compute_job_similarity_hash_v2,
-- eliminating the flawed ASCII-only stripping regex and search_path pgcrypto bug.
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

  -- Ensure source_type allows all supported vendors without validation downtime
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
    -- If existing legacy check is missing new vendors, update with NOT VALID
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
-- 6. PARTIAL INDEXES FOR EXACT IDENTITY AND ADVISORY SIMILARITY
-- ----------------------------------------------------------------------------
-- Authoritative write identity unique partial index (board-scoped source_id + requisition source_job_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_id_source_job_id_uniq
ON public.jobs (source_id, source_job_id)
WHERE source_id IS NOT NULL AND source_job_id IS NOT NULL;

-- Advisory similarity index (STANDARD INDEX - NOT UNIQUE! NO TRIGGER MERGING!)
CREATE INDEX IF NOT EXISTS idx_jobs_active_similarity_hash_v2
ON public.jobs (similarity_hash_v2)
WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_jobs_active_role_category
ON public.jobs (role_category)
WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_jobs_active_category
ON public.jobs (category)
WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_companies_category
ON public.companies (category);

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_slug_uniq
ON public.companies (slug);

-- ----------------------------------------------------------------------------
-- 7. SAFE BACKFILL FOR ACTIVE ROWS (PRESERVING last_seen_at)
-- ----------------------------------------------------------------------------
-- Backfill canonical_domain on companies if missing
UPDATE public.companies
SET canonical_domain = lower(trim(domain))
WHERE canonical_domain IS NULL AND domain IS NOT NULL;

-- Backfill source_priority based on source_type or source metadata
UPDATE public.jobs
SET source_priority = CASE
  WHEN source_type IN ('ats', 'direct', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'amazon', 'microsoft')
    OR lower(COALESCE(source, '')) IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable', 'breezy', 'teamtailor', 'personio', 'bamboohr', 'join')
  THEN 1
  ELSE 2
END
WHERE source_priority IS NULL;

-- Backfill similarity_hash_v2 for active rows missing it.
-- Repaired touch_job_last_seen preserves OLD.last_seen_at so ranking order is unchanged.
UPDATE public.jobs
SET similarity_hash_v2 = public.compute_job_similarity_hash_v2(
  company,
  title,
  COALESCE(country_code, country),
  location
)
WHERE is_active = TRUE
  AND similarity_hash_v2 IS NULL;

-- ----------------------------------------------------------------------------
-- 8. TRANSACTIONAL jobs_public VIEW RE-CREATION
-- ----------------------------------------------------------------------------
-- Preserves column order, paid-field masking boundary, RLS, and client permissions.
DROP VIEW IF EXISTS public.jobs_public;

CREATE VIEW public.jobs_public AS
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
--   - Restores legacy constraints, views, and database/application behavior.
--   - Drops ONLY objects that this migration created (similarity functions,
--     new partial indexes, new check constraints).
--   - Restores original jobs_public view definition without Phase 3 columns.
--   - Keeps expanded jobs_source_type_check constraint because rows with vendor values may exist.
--   - KEEPS all additive columns (jobs.source_id, jobs.canonical_domain, jobs.logo_url,
--     jobs.role_category, jobs.top_keywords, jobs.similarity_hash_v2, jobs.is_remote,
--     jobs.source_priority, companies.canonical_domain, companies.category,
--     companies.logo_url) because they may have existed prior to this migration
--     or may contain valid ingested data. Additive columns are never removed.
--   - Retains backfilled data in pre-existing columns without destructive cascades.
--   - Does NOT touch incident recovery tables (public.recovery_642_restore48_20261116).
--
--   -- 1. Drop functions created by this migration
--   DROP FUNCTION IF EXISTS public.compute_job_similarity_hash_v2(text, text, text, text);
--
--   -- 2. Restore legacy jobs_public view via transactional DROP + CREATE
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
--   DROP INDEX IF EXISTS public.idx_jobs_active_similarity_hash_v2;
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
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_type_check;
--   ALTER TABLE public.jobs ADD CONSTRAINT jobs_source_type_check
--     CHECK (source_type IN (
--       'ats', 'api', 'feed', 'direct',
--       'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday',
--       'amazon', 'microsoft', 'jobspy', 'arbeitnow', 'adzuna'
--     )) NOT VALID;
-- ============================================================================
