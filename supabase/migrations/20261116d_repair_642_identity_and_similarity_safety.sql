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
