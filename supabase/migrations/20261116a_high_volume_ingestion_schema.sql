-- ============================================================================
-- Migration: 20261116a_high_volume_ingestion_schema.sql
-- STATUS: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261116a_high_volume_ingestion_schema
--
-- Purpose (repair-aware target delta for #642):
--   Production already carries #645 (20261116d/e/f, full or scoped) and the merged #643 (20261116b),
--   which own every constraint, index, view, grant, function and backfill this PR relies on. This file
--   therefore ONLY adds the columns the #642 ingestion code writes, when they are missing. On the
--   owner-reported scoped #645 state the effective change is one column: public.jobs.canonical_domain.
--
--   It deliberately does NOT:
--     - create or replace any function (compute_job_dedupe_hash keeps its #645 delegation to
--       compute_job_similarity_hash_v2; no v1 hash is (re)introduced)
--     - drop, replace or re-add any constraint (validated #643/#645 CHECKs stay validated)
--     - create, drop or rebuild any index (canonical idx_jobs_source_id_source_job_id_uniq and the live
--       partial idx_companies_category stay exactly as they are)
--     - replace public.jobs_public or touch any grant (views, grants and freshness stay as they are)
--     - UPDATE any row (backfills are owned by 20261116f; last_seen_at / freshness never move)
--     - add a dedupe_hash unique index or a merge trigger (dedupe_hash is advisory, #643 contract)
--
--   Columns it adds are marked with COMMENT 'added by 20261116a' so the rollback can tell them apart
--   from columns #645/#643 created. Columns that already existed are left byte-for-byte untouched.
--
--   Lock: ADD COLUMN takes a brief ACCESS EXCLUSIVE lock (metadata only, no rewrite: no volatile
--   defaults). lock_timeout = 3s; on a lock-timeout abort nothing changes, retry.
--
-- PRE-CHECK SQL (read-only):
--   SELECT table_name, column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name IN ('jobs', 'companies')
--      AND column_name IN ('source_id', 'source_type', 'source_job_id', 'canonical_domain', 'logo_url',
--                          'role_category', 'top_keywords', 'dedupe_hash', 'is_remote', 'source_priority',
--                          'category', 'slug', 'name')
--    ORDER BY 1, 2;
--
-- VERIFY SQL (after applying):
--   -- every column present (expected: true)
--   SELECT count(*) = 13 AS ok FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND ((table_name = 'jobs' AND column_name IN ('category', 'role_category', 'top_keywords', 'source_type',
--             'source_id', 'source_job_id', 'dedupe_hash', 'is_remote', 'source_priority', 'logo_url', 'canonical_domain'))
--        OR (table_name = 'companies' AND column_name IN ('canonical_domain', 'category')));
--   -- which columns this migration added
--   SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
--    WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('jobs', 'companies')
--      AND col_description(a.attrelid, a.attnum) = 'added by 20261116a';
--   -- #645 hash delegation still in place (expected: true)
--   SELECT pg_get_functiondef('public.compute_job_dedupe_hash(text,text,text,text)'::regprocedure)
--          LIKE '%compute_job_similarity_hash_v2%' AS v2_delegation_intact;
--
-- ROLLBACK (data-preserving; tested by scripts/test-16a-repair-aware.ts):
--   psql -v ON_ERROR_STOP=1 -f supabase/scripts/rollback-20261116a.sql
--   Drops ONLY columns marked 'added by 20261116a' that hold no data (every value NULL / the column
--   default) and that nothing depends on. Any other column, and every row, is kept. Re-apply to undo.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF to_regclass('public.jobs') IS NULL OR to_regclass('public.companies') IS NULL THEN
    RAISE EXCEPTION '20261116a preflight: public.jobs and public.companies must exist';
  END IF;
END $$;

CREATE TEMP TABLE _m16a_before ON COMMIT DROP AS
  SELECT table_name::text AS t, column_name::text AS c
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('jobs', 'companies');

-- companies
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS canonical_domain text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS logo_url text;

-- jobs (is_remote has no default: NULL falls back to remote via COALESCE(is_remote, remote))
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS role_category text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS top_keywords text[] DEFAULT '{}'::text[];
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_job_id text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS dedupe_hash text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS is_remote boolean;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_priority smallint DEFAULT 2;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS canonical_domain text;

-- Mark exactly the columns this run added (the rollback only ever considers these)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name::text AS t, column_name::text AS c FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN ('jobs', 'companies')
    EXCEPT SELECT t, c FROM _m16a_before
  LOOP
    EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L', r.t, r.c, 'added by 20261116a');
  END LOOP;
END $$;

COMMIT;
