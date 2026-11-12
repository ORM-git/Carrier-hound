-- ============================================================================
-- Migration: 20261112b_statement_timeouts.sql
-- Status: NOT APPLIED - record-migration.cjs 20261112b_statement_timeouts
-- Apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261112b_statement_timeouts
--
-- Purpose:
--   Establish statement_timeout discipline on heavy read, aggregate, and
--   maintenance RPCs in the public schema. Per Supabase documentation,
--   function-level ALTER FUNCTION ... SET statement_timeout is supported
--   and effective for REST RPC calls (invoked via supabase.rpc), bounding
--   execution time and preventing runaway queries from holding connection
--   pool slots indefinitely under load.
--
-- Invariants:
--   - ONLY ALTER FUNCTION ... SET statement_timeout statements with exact
--     argument signatures.
--   - ZERO ALTER ROLE statements (broad role ceilings avoid risking uninventoried
--     service-role tasks; authenticator role timeout already set in 20261105c).
--   - ZERO data modifications (no INSERT, UPDATE, DELETE).
--   - ZERO table mutations (no CREATE, DROP, ALTER TABLE).
--   - ZERO trigger or pg_cron schedule changes.
-- ============================================================================

-- 1. Materialized View & Observability Aggregations
ALTER FUNCTION public.refresh_worldwide_company_counts() SET statement_timeout = '30s';
ALTER FUNCTION public.db_health_snapshot() SET statement_timeout = '5s';
ALTER FUNCTION public.analyze_after_ingest() SET statement_timeout = '15s';

-- 2. Job Lifecycle & Deduplication Scans
ALTER FUNCTION public.dedupe_jobs_by_role(boolean) SET statement_timeout = '30s';
ALTER FUNCTION public.archive_expired_jobs(boolean, interval) SET statement_timeout = '30s';

-- 3. Maintenance & Retention Pruning (capped to Supabase REST 60s gateway bound)
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
-- VERIFY QUERIES (execute in Supabase SQL editor to confirm configuration):
-- ============================================================================
--
-- Verify function-level statement_timeout configurations:
-- SELECT
--   p.proname AS function_name,
--   pg_get_function_identity_arguments(p.oid) AS arguments,
--   p.proconfig AS configuration
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proconfig::text LIKE '%statement_timeout%'
-- ORDER BY p.proname;
--
-- ============================================================================
-- ROLLBACK INSTRUCTIONS (run manually in Supabase SQL editor if needed):
-- ============================================================================
-- Note: RESET statement_timeout removes the function-level proconfig override,
-- reverting execution to inherit the caller role / database default (it does
-- not guarantee an unbounded baseline). Prior to applying, capture existing
-- proconfig values via the runbook query in docs/statement-timeouts.md.
--
-- Exact restoration of repository pre-migration baselines:
--   ALTER FUNCTION public.refresh_worldwide_company_counts() RESET statement_timeout;
--   -- db_health_snapshot had statement_timeout = '5s' in 20261108b; preserve 5s, DO NOT RESET:
--   ALTER FUNCTION public.db_health_snapshot() SET statement_timeout = '5s';
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
