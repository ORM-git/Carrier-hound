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
