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
