-- ============================================================================
-- Migration: 20261112b_statement_timeouts.sql
-- Status: NOT APPLIED - record-migration.cjs 20261112b_statement_timeouts
-- Apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261112b_statement_timeouts
--
-- Purpose:
--   Per-function statement_timeout discipline for heavy read, aggregate,
--   and maintenance RPCs in public schema. Unbounded SECURITY DEFINER RPCs
--   can hold connection pool slots indefinitely under load. Setting explicit
--   timeouts guarantees fast failure and connection release.
--
-- Invariants:
--   - ONLY ALTER FUNCTION ... SET statement_timeout statements.
--   - ZERO data modifications.
--   - ZERO new tables or schema changes.
--   - ZERO trigger or pg_cron modifications.
-- ============================================================================

-- 1. Materialized View & Observability Aggregations
ALTER FUNCTION public.refresh_worldwide_company_counts() SET statement_timeout = '30s';
ALTER FUNCTION public.db_health_snapshot() SET statement_timeout = '5s';
ALTER FUNCTION public.analyze_after_ingest() SET statement_timeout = '15s';

-- 2. Job Lifecycle & Deduplication Scans
ALTER FUNCTION public.dedupe_jobs_by_role(boolean) SET statement_timeout = '30s';
ALTER FUNCTION public.archive_expired_jobs(boolean, interval) SET statement_timeout = '30s';

-- 3. Maintenance & Retention Pruning
ALTER FUNCTION public.reindex_bloated_indexes(integer, boolean) SET statement_timeout = '60s';
ALTER FUNCTION public.purge_operational_logs(boolean) SET statement_timeout = '30s';
ALTER FUNCTION public.purge_row_change_history(boolean) SET statement_timeout = '30s';
ALTER FUNCTION public.purge_soft_deleted_account_data(interval) SET statement_timeout = '30s';

-- 4. High-Frequency Outbox & Rate-Limiting
ALTER FUNCTION public.outbox_claim_batch(text, integer, integer, text) SET statement_timeout = '5s';
ALTER FUNCTION public.cleanup_expired_rate_limits() SET statement_timeout = '10s';
ALTER FUNCTION public.check_rate_limit(text, integer, integer) SET statement_timeout = '2s';
ALTER FUNCTION public.claim_search_alert_window(uuid, integer) SET statement_timeout = '5s';
ALTER FUNCTION public.release_search_alert_window(uuid, timestamptz) SET statement_timeout = '5s';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER FUNCTION public.refresh_worldwide_company_counts() RESET statement_timeout;
--   ALTER FUNCTION public.db_health_snapshot() RESET statement_timeout;
--   ALTER FUNCTION public.analyze_after_ingest() RESET statement_timeout;
--   ALTER FUNCTION public.dedupe_jobs_by_role(boolean) RESET statement_timeout;
--   ALTER FUNCTION public.archive_expired_jobs(boolean, interval) RESET statement_timeout;
--   ALTER FUNCTION public.reindex_bloated_indexes(integer, boolean) RESET statement_timeout;
--   ALTER FUNCTION public.purge_operational_logs(boolean) RESET statement_timeout;
--   ALTER FUNCTION public.purge_row_change_history(boolean) RESET statement_timeout;
--   ALTER FUNCTION public.purge_soft_deleted_account_data(interval) RESET statement_timeout;
--   ALTER FUNCTION public.outbox_claim_batch(text, integer, integer, text) RESET statement_timeout;
--   ALTER FUNCTION public.cleanup_expired_rate_limits() RESET statement_timeout;
--   ALTER FUNCTION public.check_rate_limit(text, integer, integer) RESET statement_timeout;
--   ALTER FUNCTION public.claim_search_alert_window(uuid, integer) RESET statement_timeout;
--   ALTER FUNCTION public.release_search_alert_window(uuid, timestamptz) RESET statement_timeout;
-- ============================================================================
