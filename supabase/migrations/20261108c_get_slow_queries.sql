-- Migration: 20261108c_get_slow_queries.sql
-- STATUS: NOT APPLIED - apply manually after review, then record:
--   node scripts/record-migration.cjs 20261108c_get_slow_queries
-- Read-only, service-role-only operational metrics from pg_stat_statements.
-- Excludes internal pg_stat_statements monitoring queries.
-- Returns top 20 queries by total execution time. No parameters/PII returned.

CREATE OR REPLACE FUNCTION public.get_slow_queries()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET statement_timeout = '5s'
AS $function$
DECLARE
  slow_queries jsonb;
  has_pg_stat boolean;
BEGIN
  -- Check if pg_stat_statements extension/view is installed
  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
  ) INTO has_pg_stat;

  IF NOT has_pg_stat THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT coalesce(jsonb_agg(row_to_json(q)), '[]'::jsonb)
  INTO slow_queries
  FROM (
    SELECT
      query,
      calls,
      total_exec_time AS total_ms,
      mean_exec_time AS mean_ms,
      max_exec_time AS max_ms
    FROM pg_stat_statements
    WHERE query NOT ILIKE '%pg_stat_statements%'
    ORDER BY total_exec_time DESC
    LIMIT 20
  ) q;

  RETURN slow_queries;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_slow_queries() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_slow_queries() TO service_role;
COMMENT ON FUNCTION public.get_slow_queries() IS
  'Read-only slow query statistics from pg_stat_statements. Service role only. Top 20 by total execution time.';

-- ROLLBACK:
-- DROP FUNCTION IF EXISTS public.get_slow_queries();
