-- ============================================================================
-- Migration: 20261108a_pg_cron_scheduled_jobs.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261108a_pg_cron_scheduled_jobs
--
-- Database row "pg_cron" (MISSING): "DB-side schedules depend on GitHub
-- Actions staying green." Every schedule today lives in GitHub Actions, so an
-- Actions outage (the 2026-11-05 billing stop silenced all crons) also stops
-- DB maintenance. This adds database-native schedules for the two jobs that
-- must keep running even when Actions is down:
--   1. weekly purge of operational log tables (retention policy)
--   2. daily refresh of public.worldwide_company_counts
--
-- Supports DB#46 (data lifecycle: the purge no longer depends solely on the
-- GitHub Actions retention cron) and DB#68 (the matview refresh gains a path
-- outside the ingest transaction).
--
-- Apply order: after 20261106a_data_retention.sql (purge function) and
-- 20261106d_matview_refresh_log.sql (refresh function). Scheduling a job whose
-- function is missing does not fail at schedule time; the run fails and shows
-- in cron.job_run_details, so order still matters.
--
-- pg_cron must be enabled for the project (Supabase Dashboard -> Database ->
-- Extensions -> pg_cron); the CREATE EXTENSION below is a no-op when it
-- already is.
--
-- Safe to run: CREATE EXTENSION and two cron.schedule calls only - no table
-- DDL, no data change. Idempotent: re-applying replaces each schedule instead
-- of duplicating it (unschedule by jobname, then schedule again). The GitHub
-- Actions retention-cron.yml stays in place; both call the same purge
-- function and the purge is idempotent by design.
--
-- pg_cron times are UTC. Chosen slots (IST in parentheses):
--   purge   Sun 02:15 UTC (Sun 07:45 IST), staggered from the GHA retention
--           cron (Sun 19:30 UTC / Mon 01:00 IST);
--   refresh daily 02:45 UTC (08:15 IST), after the nightly ingest.
-- ============================================================================

create extension if not exists pg_cron;

-- Replace-then-schedule keeps re-application idempotent: cron.unschedule by
-- jobname returns false (no error) when the job does not exist yet.
select cron.unschedule('purge-operational-logs-weekly');
select cron.schedule(
  'purge-operational-logs-weekly',
  '15 2 * * 0',
  $cmd$select public.purge_operational_logs(false);$cmd$
);

select cron.unschedule('refresh-worldwide-counts-daily');
select cron.schedule(
  'refresh-worldwide-counts-daily',
  '45 2 * * *',
  $cmd$select public.refresh_worldwide_company_counts();$cmd$
);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   select cron.unschedule('purge-operational-logs-weekly');
--   select cron.unschedule('refresh-worldwide-counts-daily');
-- NOTE: dropping the pg_cron extension itself is left to the owner - other
-- jobs may exist by then.
-- ============================================================================
