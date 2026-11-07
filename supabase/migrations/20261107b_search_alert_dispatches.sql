-- ============================================================================
-- Migration: 20261107b_search_alert_dispatches.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107b_search_alert_dispatches
--
-- Backend sheet rank 83 (Search Alerts): "search_alerts table exists; alert
-- dispatch not verified." This adds the sent-log the dispatcher
-- (src/lib/alerts/searchAlertDispatcher.ts) uses to send each (alert, job) pair
-- at most once. It does not touch public.search_alerts.
--
-- No foreign keys on purpose: the search_alerts DDL is not in this repo (owner
-- to confirm its key type), and a log row must not block deleting an alert or a
-- job. Rows are claimed with INSERT ... ON CONFLICT DO NOTHING and released on
-- send failure.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.search_alert_dispatches (
  alert_id   UUID        NOT NULL,
  job_id     UUID        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, job_id)
);

CREATE INDEX IF NOT EXISTS search_alert_dispatches_created_at_idx
  ON public.search_alert_dispatches (created_at);

ALTER TABLE public.search_alert_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.search_alert_dispatches FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.search_alert_dispatches TO service_role;

-- ============================================================================
-- ROLLBACK (run manually if this must be undone):
--   DROP INDEX IF EXISTS public.search_alert_dispatches_created_at_idx;
--   DROP TABLE IF EXISTS public.search_alert_dispatches;
-- ============================================================================
