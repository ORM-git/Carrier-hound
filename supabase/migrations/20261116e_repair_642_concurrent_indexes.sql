-- ============================================================================
-- Migration: 20261116e_repair_642_concurrent_indexes.sql
-- STATUS: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261116e_repair_642_concurrent_indexes
--
-- Purpose:
--   Phase 2 of Repair PR #642: CREATE INDEX CONCURRENTLY.
--   Must be executed OUTSIDE of a transaction block (do NOT wrap in BEGIN / COMMIT).
--   Builds indexes concurrently without table locks:
--   1. Authoritative write identity unique partial index (board-scoped source_id + requisition source_job_id).
--   2. Advisory similarity index (STANDARD INDEX - NOT UNIQUE! NO TRIGGER MERGING!).
--   3. Category and taxonomy filter indexes.
-- ============================================================================

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

-- ============================================================================
-- ROLLBACK (Run manually outside transaction if indexes must be undone):
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_source_id_source_job_id_uniq;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_similarity_hash_v2;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_role_category;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_active_category;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_companies_category;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_companies_slug_uniq;
-- ============================================================================
