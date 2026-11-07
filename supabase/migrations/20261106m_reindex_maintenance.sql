-- ============================================================================
-- Migration: 20261106m_reindex_maintenance.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106m_reindex_maintenance
--
-- Database row #11 (REINDEX maintenance).
--
-- What this does:
--   Creates public.reindex_bloated_indexes(min_size_mb, dry_run): lists
--   public-schema indexes whose on-disk size exceeds min_size_mb and, when
--   dry_run is false, rebuilds them one by one with REINDEX INDEX. Index
--   bloat otherwise accumulates silently - autovacuum does not rebuild
--   indexes (Database row #11 evidence: "No reindex schedule").
--
-- Why plain REINDEX, not CONCURRENTLY: REINDEX (CONCURRENTLY) cannot run
--   inside a function's transaction block. Plain REINDEX INDEX takes a
--   short write lock on one index at a time; the weekly caller (retention
--   cron, Sunday 19:30 UTC = 01:00 IST Monday) runs off-peak and only
--   indexes above the size threshold are touched, so the lock window is
--   small. A failing index does not abort the run: its row is reported
--   with action 'failed' and the loop continues.
--
-- Size threshold: 50 MB (chosen default, not a measured value - small
--   indexes reindex in milliseconds and are not worth the lock; tune by
--   passing a different min_size_mb). dry_run DEFAULTS TO TRUE (reviewer
--   precedent, 20261106a): a bare call only reports candidates.
--
-- Scheduling: wired into the weekly retention cron runner
-- (scripts/retention-cron.ts, .github/workflows/retention-cron.yml), which
-- skips the reindex step with a warning until this migration is applied.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reindex_bloated_indexes(
  min_size_mb INTEGER DEFAULT 50,
  dry_run BOOLEAN DEFAULT TRUE
)
RETURNS TABLE(
  schema_name NAME,
  table_name NAME,
  index_name NAME,
  size_bytes BIGINT,
  size_pretty TEXT,
  action TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name,
           t.relname AS table_name,
           i.relname AS index_name,
           pg_relation_size(i.oid) AS size_bytes,
           pg_size_pretty(pg_relation_size(i.oid)) AS size_pretty
    FROM pg_class i
    JOIN pg_index x ON x.indexrelid = i.oid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    WHERE i.relkind = 'i'
      AND n.nspname = 'public'
      AND t.relkind IN ('r', 'm')
      AND pg_relation_size(i.oid) >= min_size_mb * 1024 * 1024
    ORDER BY pg_relation_size(i.oid) DESC
  LOOP
    schema_name := r.schema_name;
    table_name := r.table_name;
    index_name := r.index_name;
    size_bytes := r.size_bytes;
    size_pretty := r.size_pretty;
    IF dry_run THEN
      action := 'would_reindex';
    ELSE
      BEGIN
        EXECUTE format('REINDEX INDEX %I.%I', r.schema_name, r.index_name);
        action := 'reindexed';
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'REINDEX %.% failed: %', r.schema_name, r.index_name, SQLERRM;
        action := 'failed';
      END;
    END IF;
    RETURN NEXT;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'reindex_bloated_indexes failed: %', SQLERRM;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.reindex_bloated_indexes(INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reindex_bloated_indexes(INTEGER, BOOLEAN) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.reindex_bloated_indexes(INTEGER, BOOLEAN);
-- ============================================================================
