# PostgreSQL Rollback Runbook & Migration Reversal Procedures (Database Sheet: Rollback Sections)

This document provides the authoritative rollback runbook, reversal SQL statements, and safety pre-checks for all 32 pending/active migrations across CareerMonke PostgreSQL schema (`supabase/migrations/`). Guarded offline by `scripts/test-db-rollback-runbook.ts`.

---

## 1. Core Rollback Principles

When rolling back a database migration in PostgreSQL:
1. **Never Drop Data in Flight**: If an application version is currently running in production that reads a column or table, that column or table **must not be dropped** until the application code has been rolled back and verified.
2. **Concurrent Index Removal**: Never execute a blocking `DROP INDEX` on hot production tables (`jobs`, `applications`, `page_views`). Always use `DROP INDEX CONCURRENTLY IF EXISTS` in an autocommit-capable session.
3. **Trigger-Function Dependency Hierarchy**: When reversing a trigger-backed feature, always drop the `TRIGGER` first before dropping the underlying `FUNCTION` to avoid `23503` dependency deadlocks.
4. **Ledger Synchronization**: Whenever a migration is reversed, the corresponding row in `public.schema_migrations` must be removed so the migration ledger accurately reflects database state:
   ```sql
   DELETE FROM public.schema_migrations WHERE migration_name = '<migration_name>';
   ```

---

## 2. Reversal Catalog for Pending Migrations

| Migration | Rollback Primitive / Statement | Pre-Check Query | Risk Rating |
| --- | --- | --- | --- |
| `20261016_lock_job_descriptions` | `REVOKE SELECT ON public.job_descriptions FROM anon, authenticated;` | `SELECT has_table_privilege('anon', 'public.job_descriptions', 'SELECT');` | Low |
| `20261016_worldwide_company_counts` | `DROP MATERIALIZED VIEW IF EXISTS public.mv_worldwide_company_counts;` | `SELECT to_regclass('public.mv_worldwide_company_counts');` | Low |
| `20261101_lock_page_views_insert` | `DROP POLICY IF EXISTS "allow_anon_insert_page_views" ON public.page_views;` | `SELECT policyname FROM pg_policies WHERE tablename = 'page_views';` | Low |
| `20261101_lock_scraper_metadata` | `REVOKE ALL ON public.companies, public.ingest_runs FROM anon, authenticated;` | `SELECT has_table_privilege('anon', 'public.companies', 'SELECT');` | Low |
| `20261106a_data_retention` | `DROP FUNCTION IF EXISTS public.purge_operational_logs(boolean);` | `SELECT to_regproc('public.purge_operational_logs(boolean)');` | Low |
| `20261106b_early_access_attribution` | `ALTER TABLE public.early_access_emails DROP COLUMN IF EXISTS utm_source, DROP COLUMN IF EXISTS utm_medium, DROP COLUMN IF EXISTS utm_campaign, DROP COLUMN IF EXISTS utm_term, DROP COLUMN IF EXISTS utm_content, DROP COLUMN IF EXISTS referrer, DROP COLUMN IF EXISTS landing_page;` | `SELECT column_name FROM information_schema.columns WHERE table_name = 'early_access_emails' AND column_name = 'utm_source';` | Medium (Column Drop) |
| `20261106c_change_history_triggers` | `DROP TRIGGER IF EXISTS trg_change_history_subscriptions ON public.subscriptions; DROP TRIGGER IF EXISTS trg_change_history_payment_orders ON public.payment_orders; DROP TRIGGER IF EXISTS trg_change_history_user_addon_credits ON public.user_addon_credits; DROP TRIGGER IF EXISTS trg_change_history_user_preferences ON public.user_preferences; DROP FUNCTION IF EXISTS public.log_row_change(); DROP TABLE IF EXISTS public.row_change_history;` | `SELECT trigger_name FROM information_schema.triggers WHERE trigger_name = 'trg_change_history_subscriptions';` | Low (Audit Only) |
| `20261106d_matview_refresh_log` | `DROP TABLE IF EXISTS public.matview_refresh_log;` | `SELECT to_regclass('public.matview_refresh_log');` | Low |
| `20261106e_funnel_events` | `DROP TABLE IF EXISTS public.funnel_events;` | `SELECT to_regclass('public.funnel_events');` | Low |
| `20261106f_funnel_events_retention` | `DROP FUNCTION IF EXISTS public.purge_operational_logs(boolean);` | `SELECT to_regproc('public.purge_operational_logs(boolean)');` | Low |
| `20261106g_drop_redundant_subscriptions_index` | `CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);` | `SELECT to_regclass('public.idx_subscriptions_user_id');` | Low |
| `20261106h_soft_delete_tombstones` | `DROP TABLE IF EXISTS public.deleted_account_tombstones;` | `SELECT to_regclass('public.deleted_account_tombstones');` | Low |
| `20261106i_push_subscriptions` | `DROP TABLE IF EXISTS public.push_subscriptions;` | `SELECT to_regclass('public.push_subscriptions');` | Low |
| `20261106j_inbound_replies` | `DROP TABLE IF EXISTS public.inbound_replies;` | `SELECT to_regclass('public.inbound_replies');` | Low |
| `20261106k_autocomplete_pg_trgm` | `DROP INDEX CONCURRENTLY IF EXISTS public.idx_companies_name_trgm;` | `SELECT to_regclass('public.idx_companies_name_trgm');` | Low |
| `20261106l_job_archival` | `DROP FUNCTION IF EXISTS public.archive_stale_jobs(interval, integer); DROP TABLE IF EXISTS public.jobs_archive;` | `SELECT to_regproc('public.archive_stale_jobs');` | Low |
| `20261106m_reindex_maintenance` | `DROP FUNCTION IF EXISTS public.run_reindex_maintenance();` | `SELECT to_regproc('public.run_reindex_maintenance');` | Low |
| `20261106n_covering_index_jobs_list` | `DROP INDEX CONCURRENTLY IF EXISTS public.jobs_active_list_covering_idx;` | `SELECT to_regclass('public.jobs_active_list_covering_idx');` | Low |
| `20261106o_not_valid_validate_pattern` | `ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS chk_jobs_salary_bounds;` | `SELECT conname FROM pg_constraint WHERE conname = 'chk_jobs_salary_bounds';` | Low |
| `20261106p_security_definer_search_path` | `ALTER FUNCTION public.refresh_worldwide_company_counts() RESET search_path;` | `SELECT proname, proconfig FROM pg_proc WHERE proname = 'refresh_worldwide_company_counts';` | Low |
| `20261106q_analyze_after_ingest` | `DROP FUNCTION IF EXISTS public.analyze_jobs_after_ingest();` | `SELECT to_regproc('public.analyze_jobs_after_ingest');` | Low |
| `20261106s_resume_bucket_limits` | `DROP POLICY IF EXISTS "resumes_upload_limit" ON storage.objects;` | `SELECT policyname FROM pg_policies WHERE policyname = 'resumes_upload_limit';` | Low |
| `20261107a_jobs_role_dedupe` | `DROP INDEX CONCURRENTLY IF EXISTS public.idx_jobs_role_dedupe;` | `SELECT to_regclass('public.idx_jobs_role_dedupe');` | Low |
| `20261107b_search_alert_dispatches` | `DROP TABLE IF EXISTS public.search_alert_dispatches;` | `SELECT to_regclass('public.search_alert_dispatches');` | Low |
| `20261107c_outbox_queue` | `DROP TABLE IF EXISTS public.outbox;` | `SELECT to_regclass('public.outbox');` | Low |
| `20261107d_row_version_optimistic_lock` | `DROP TRIGGER IF EXISTS trg_row_version_user_preferences ON public.user_preferences; DROP TRIGGER IF EXISTS trg_row_version_resumes ON public.resumes; DROP TRIGGER IF EXISTS trg_row_version_applications ON public.applications; DROP TRIGGER IF EXISTS trg_row_version_candidate_profiles ON public.candidate_profiles; DROP FUNCTION IF EXISTS public.bump_row_version();` | `SELECT trigger_name FROM information_schema.triggers WHERE trigger_name = 'trg_row_version_resumes';` | Low |
| `20261107e_outbox_fencing` | `DROP FUNCTION IF EXISTS public.claim_outbox_batch(integer, interval);` | `SELECT to_regproc('public.claim_outbox_batch');` | Low |
| `20261107f_search_alert_send_windows` | `DROP FUNCTION IF EXISTS public.claim_search_alert_window(uuid, interval); DROP FUNCTION IF EXISTS public.release_search_alert_window(uuid, timestamptz); DROP TABLE IF EXISTS public.search_alert_windows;` | `SELECT to_regclass('public.search_alert_windows');` | Low |
| `20261107g_touch_updated_at_triggers` | `DROP TRIGGER IF EXISTS trg_touch_updated_at_candidate_profiles ON public.candidate_profiles; DROP TRIGGER IF EXISTS trg_touch_updated_at_applications ON public.applications; DROP TRIGGER IF EXISTS trg_touch_updated_at_user_preferences ON public.user_preferences; DROP TRIGGER IF EXISTS trg_touch_updated_at_resumes ON public.resumes; DROP TRIGGER IF EXISTS trg_touch_updated_at_tailored_resumes ON public.tailored_resumes; DROP FUNCTION IF EXISTS public.touch_updated_at();` | `SELECT trigger_name FROM information_schema.triggers WHERE trigger_name = 'trg_touch_updated_at_candidate_profiles';` | Low |
| `20261107h_table_comments` | `COMMENT ON TABLE public.jobs IS NULL;` | `SELECT obj_description('public.jobs'::regclass);` | Low |
| `20261108a_pg_cron_scheduled_jobs` | `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('purge-soft-deleted-accounts-daily', 'refresh-matviews-hourly');` | `SELECT * FROM cron.job;` | Low |
| `20261108b_db_health_snapshot` | `DROP FUNCTION IF EXISTS public.get_db_health_snapshot();` | `SELECT to_regproc('public.get_db_health_snapshot');` | Low |

---

## 3. Rollback Drill Verification Procedure

Before initiating any rollback on production:
1. Verify database connectivity and current ledger:
   ```sql
   SELECT migration_name, applied_at, sha256_checksum FROM public.schema_migrations ORDER BY applied_at DESC;
   ```
2. Execute the pre-check query from the table above to verify object presence.
3. Execute the rollback statement within psql or Supabase SQL Editor.
4. Execute the ledger removal statement:
   ```sql
   DELETE FROM public.schema_migrations WHERE migration_name = '<name>';
   ```
5. Re-run verification query to confirm cleanly uninstalled state.
