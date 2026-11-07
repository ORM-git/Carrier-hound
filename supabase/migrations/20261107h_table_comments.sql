-- ============================================================================
-- Migration: 20261107h_table_comments.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107h_table_comments
--
-- Database row "COMMENT ON documentation" (PARTIAL): "Only admin_audit_log has
-- COMMENT ON; knowledge lives in migration headers." This adds table-level
-- comments so the meaning is visible inside the database.
--
-- Every comment text is copied from docs/data-classification.md (the owner-reviewed
-- description of the table). No new claims are made here. Tables that already have
-- a COMMENT (admin_audit_log, schema_migrations) are not touched. Owner to confirm
-- the wording.
--
-- Safe to run: COMMENT ON only changes catalog metadata, no data and no lock beyond a
-- brief one. A table that does not exist in the live database is skipped (to_regclass
-- check), so a drifted environment cannot make the script fail.
-- ============================================================================

DO $do$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
    ('cron_run_logs', 'Scheduled job outcomes. 90-day retention.'),
    ('ingest_runs', 'Job-ingestion run state.'),
    ('failed_events', 'Webhook/event replay queue. Replayed/dead rows purged after 90 days.'),
    ('webhook_events', 'Provider webhook receipts (event ids, no payload PII). 90-day retention.'),
    ('rate_limits', 'Rate-limit buckets keyed by route/ip hash.'),
    ('ai_usage_quotas', 'Per-user and global AI usage accounting. User-linked but not identifying beyond the id.'),
    ('plan_usage_events', 'Per-user and global AI usage accounting. User-linked but not identifying beyond the id.'),
    ('ai_concurrency_leases', 'Per-user and global AI usage accounting. User-linked but not identifying beyond the id.'),
    ('ai_global_budget_daily', 'Per-user and global AI usage accounting. User-linked but not identifying beyond the id.'),
    ('web_vitals', 'Anonymous performance telemetry (no identifiers by design).'),
    ('company_token_registry', 'Scraper tokens for company boards. Secret-adjacent; service-role only.'),
    ('matview_refresh_log', 'Materialized-view refresh telemetry (when, duration). Service-role only'),
    ('deleted_account_tombstones', 'PII-free account-deletion audit anchor (user id, SHA-256 email hash, purge deadline). 30-day undo window, then hard-purged'),
    ('job_descriptions', 'Full job description text.'),
    ('companies', 'Company directory and ATS board config.'),
    ('company_boards', 'Company directory and ATS board config.'),
    ('plans', 'Product catalog (names, prices, quotas).'),
    ('addon_packs', 'Product catalog (names, prices, quotas).')
    ) AS v(tbl, descr)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL THEN
      EXECUTE format('COMMENT ON TABLE public.%I IS %L', r.tbl, r.descr);
    END IF;
  END LOOP;
END
$do$;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
-- NOTE: comments are catalog metadata only, nothing else changes. Undo is manual:
--   COMMENT ON TABLE public.<table> IS NULL;   -- once for each table listed above
-- ============================================================================
