-- ============================================================================
-- Migration: 20261106q_analyze_after_ingest.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106q_analyze_after_ingest
--
-- Database row #73 (ANALYZE after bulk load).
--
-- Why: ingestion (scripts/ingest.ts, .github/workflows/ingest.yml) bulk
-- upserts jobs / job_descriptions / companies, but statistics refresh is
-- left to autovacuum (sheet evidence: "Relies on autovacuum; no manual
-- ANALYZE in ingestion scripts"). Stale stats right after a big load are
-- when bad plans appear (wrong join order on the freshly-rewritten hot
-- table). Plain ANALYZE is legal inside a function (only VACUUM is barred
-- from transaction blocks) and takes only a SHARE UPDATE EXCLUSIVE lock,
-- so reads and writes continue.
--
-- What this does:
--   public.analyze_after_ingest(): runs ANALYZE on the three tables the
--   ingestion pipeline rewrites. SECURITY DEFINER with pinned search_path
--   (house rule since 20261106p); service_role only. Fail-open per
--   audit/history convention: on error it raises a WARNING instead of
--   aborting the caller - a stats refresh must never fail an ingest run.
--
-- Caller: scripts/ingest.ts calls it once at the end of a live run
-- (skipped on --dry), and skips cleanly with a warning until this
-- migration is applied.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.analyze_after_ingest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  ANALYZE public.jobs;
  ANALYZE public.job_descriptions;
  ANALYZE public.companies;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'analyze_after_ingest failed: %', SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.analyze_after_ingest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analyze_after_ingest() TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.analyze_after_ingest();
-- ============================================================================
