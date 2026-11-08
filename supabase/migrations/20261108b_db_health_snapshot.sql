-- Migration: 20261108b_db_health_snapshot.sql
-- STATUS: NOT APPLIED - apply manually after review, then record:
--   node scripts/record-migration.cjs 20261108b_db_health_snapshot
-- Read-only, service-role-only operational metrics. No query text, user IDs,
-- error payloads, table data, schema mutation, VACUUM or index maintenance.
-- pg_stat counters are estimates since stats reset, not an index-drop decision.

CREATE OR REPLACE FUNCTION public.db_health_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '5s'
AS $function$
DECLARE
  table_metrics jsonb;
  index_metrics jsonb;
  failed_cron bigint;
  cron_available boolean;
BEGIN
  SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  INTO table_metrics
  FROM (
    SELECT relname AS name, n_live_tup AS live_tuples,
           n_dead_tup AS dead_tuples,
           pg_total_relation_size(relid) AS total_bytes
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(relid) DESC, relname
    LIMIT 100
  ) t;

  SELECT coalesce(jsonb_agg(row_to_json(i)), '[]'::jsonb)
  INTO index_metrics
  FROM (
    SELECT s.indexrelname AS name, s.idx_scan AS scans,
           pg_relation_size(s.indexrelid) AS total_bytes,
           x.indisunique AS is_unique
    FROM pg_stat_user_indexes s
    JOIN pg_index x ON x.indexrelid = s.indexrelid
    WHERE s.schemaname = 'public'
    ORDER BY pg_relation_size(s.indexrelid) DESC, s.indexrelname
    LIMIT 100
  ) i;

  cron_available := to_regclass('public.cron_run_logs') IS NOT NULL;
  IF cron_available THEN
    SELECT count(*) INTO failed_cron
    FROM public.cron_run_logs
    WHERE status = 'failed' AND started_at > now() - interval '7 days';
  END IF;

  RETURN jsonb_build_object(
    'sampled_at', now(),
    'stats_reset', (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()),
    'tables', table_metrics,
    'indexes', index_metrics,
    'table_count', (SELECT count(*) FROM pg_stat_user_tables WHERE schemaname = 'public'),
    'index_count', (SELECT count(*) FROM pg_stat_user_indexes WHERE schemaname = 'public'),
    'cron_available', cron_available,
    'failed_cron_7d', failed_cron
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.db_health_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.db_health_snapshot() TO service_role;
COMMENT ON FUNCTION public.db_health_snapshot() IS
  'Read-only DB health snapshot. Service role only. Top 100 tables/indexes by size; counters since stats reset.';

-- ROLLBACK (manual, after disabling the workflow):
-- DROP FUNCTION IF EXISTS public.db_health_snapshot();
