-- ============================================================================
-- Migration: 20261112b_statement_timeouts.sql
-- Status: NOT APPLIED - record-migration.cjs 20261112b_statement_timeouts
-- Apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261112b_statement_timeouts
--
-- Purpose:
--   Establish statement_timeout discipline for PostgreSQL roles and heavy
--   RPCs in the public schema. In PostgreSQL, statement_timeout starts at
--   the client command boundary. Unbounded connection defaults allow stalled
--   queries to hold connection pool slots indefinitely under load.
--
-- Mechanism:
--   1. Role-level defaults: Enforce sane connection ceilings on client roles
--      (authenticator at 15s, service_role at 60s).
--   2. Heavy RPC safeguards: Configure catalog-level statement_timeouts
--      with exact argument signatures on heavy SECURITY DEFINER and
--      maintenance functions as defense-in-depth boundaries.
--   3. Maintenance sizing: Maintenance loops (reindex_bloated_indexes) receive
--      a larger maintenance budget (300s) to accommodate multi-index passes.
--
-- Invariants:
--   - ONLY ALTER ROLE and ALTER FUNCTION statements.
--   - ZERO data modifications (no INSERT, UPDATE, DELETE).
--   - ZERO table schema changes (no CREATE, DROP, ALTER TABLE).
--   - ZERO trigger or pg_cron schedule modifications.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Role-Level Timeout Defaults (Enforcement at connection/caller boundary)
-- ----------------------------------------------------------------------------
-- PostgREST API pooler connection role (matches 20261105c baseline)
ALTER ROLE authenticator SET statement_timeout = '15s';

-- Backend scripts, background workers, and admin service connections
ALTER ROLE service_role SET statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- 2. Heavy RPC Catalog Safeguards (with exact argument signatures)
-- ----------------------------------------------------------------------------

-- Materialized View & Observability Aggregations
ALTER FUNCTION public.refresh_worldwide_company_counts() SET statement_timeout = '30s';
ALTER FUNCTION public.db_health_snapshot() SET statement_timeout = '5s';
ALTER FUNCTION public.analyze_after_ingest() SET statement_timeout = '15s';

-- Job Lifecycle & Deduplication Scans
ALTER FUNCTION public.dedupe_jobs_by_role(boolean) SET statement_timeout = '30s';
ALTER FUNCTION public.archive_expired_jobs(boolean, interval) SET statement_timeout = '30s';

-- Maintenance & Retention Pruning (reindex receives 300s maintenance budget)
ALTER FUNCTION public.reindex_bloated_indexes(integer, boolean) SET statement_timeout = '300s';
ALTER FUNCTION public.purge_operational_logs(boolean) SET statement_timeout = '30s';
ALTER FUNCTION public.purge_row_change_history(boolean) SET statement_timeout = '30s';
ALTER FUNCTION public.purge_soft_deleted_account_data(interval) SET statement_timeout = '30s';

-- High-Frequency Outbox & Rate-Limiting
ALTER FUNCTION public.outbox_claim_batch(text, integer, integer, text) SET statement_timeout = '5s';
ALTER FUNCTION public.cleanup_expired_rate_limits() SET statement_timeout = '10s';
ALTER FUNCTION public.check_rate_limit(text, integer, integer) SET statement_timeout = '2s';
ALTER FUNCTION public.claim_search_alert_window(uuid, integer) SET statement_timeout = '5s';
ALTER FUNCTION public.release_search_alert_window(uuid, timestamptz) SET statement_timeout = '5s';

-- ============================================================================
-- VERIFY QUERIES (execute in Supabase SQL editor to confirm configuration):
-- ============================================================================
--
-- 1. Verify role-level timeout configurations:
--    SELECT r.rolname, s.setconfig
--    FROM pg_roles r
--    LEFT JOIN pg_db_role_setting s ON s.setrole = r.oid
--    WHERE r.rolname IN ('authenticator', 'service_role')
--    ORDER BY r.rolname;
--
-- 2. Verify function-level statement_timeout configurations:
--    SELECT
--      p.proname AS function_name,
--      pg_get_function_identity_arguments(p.oid) AS arguments,
--      p.proconfig AS configuration
--    FROM pg_proc p
--    JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proconfig::text LIKE '%statement_timeout%'
--    ORDER BY p.proname;
--
-- ============================================================================
-- ROLLBACK INSTRUCTIONS (run manually in Supabase SQL editor if needed):
-- ============================================================================
-- 1. Restore role-level timeouts to pre-migration baselines:
--    ALTER ROLE authenticator SET statement_timeout = '15s';
--    ALTER ROLE service_role RESET statement_timeout;
--
-- 2. Restore function-level configurations (exact previous proconfig values):
--    ALTER FUNCTION public.refresh_worldwide_company_counts() RESET statement_timeout;
--    ALTER FUNCTION public.db_health_snapshot() SET statement_timeout = '5s';
--    ALTER FUNCTION public.analyze_after_ingest() RESET statement_timeout;
--    ALTER FUNCTION public.dedupe_jobs_by_role(boolean) RESET statement_timeout;
--    ALTER FUNCTION public.archive_expired_jobs(boolean, interval) RESET statement_timeout;
--    ALTER FUNCTION public.reindex_bloated_indexes(integer, boolean) RESET statement_timeout;
--    ALTER FUNCTION public.purge_operational_logs(boolean) RESET statement_timeout;
--    ALTER FUNCTION public.purge_row_change_history(boolean) RESET statement_timeout;
--    ALTER FUNCTION public.purge_soft_deleted_account_data(interval) RESET statement_timeout;
--    ALTER FUNCTION public.outbox_claim_batch(text, integer, integer, text) RESET statement_timeout;
--    ALTER FUNCTION public.cleanup_expired_rate_limits() RESET statement_timeout;
--    ALTER FUNCTION public.check_rate_limit(text, integer, integer) RESET statement_timeout;
--    ALTER FUNCTION public.claim_search_alert_window(uuid, integer) RESET statement_timeout;
--    ALTER FUNCTION public.release_search_alert_window(uuid, timestamptz) RESET statement_timeout;
-- ============================================================================
