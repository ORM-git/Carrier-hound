-- ============================================================================
-- Migration: 20261107f_search_alert_send_windows.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107f_search_alert_send_windows
--
-- Follow-up to 20261107b, closing gaps the Backend sheet names on row "Search
-- Alerts": parallel runs may send different jobs in the same interval, and a
-- markSent failure weakens the throttle. This adds a per-alert send window that
-- is claimed atomically BEFORE sending (src/lib/alerts/searchAlertDispatcher.ts,
-- claimWindowInDb / releaseWindowInDb).
--
-- claim_search_alert_window returns the claim timestamp when the window was free
-- (no row, or last_sent_at older than the interval) and NULL when another run
-- holds it. The interval is a REQUIRED argument: no number is chosen here (owner
-- to confirm the product value). release_search_alert_window gives the window
-- back after a definite send failure only; it is a no-op if a newer claim exists.
--
-- No foreign key on purpose (search_alerts DDL is not in this repo). Not
-- addressed here: a process that dies between claiming and sending still holds
-- its claims until an owner-chosen cleanup (created_at is indexed on
-- search_alert_dispatches for that).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.search_alert_windows (
  alert_id     UUID        PRIMARY KEY,
  last_sent_at TIMESTAMPTZ NOT NULL,
  prev_sent_at TIMESTAMPTZ
);

ALTER TABLE public.search_alert_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.search_alert_windows FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.search_alert_windows TO service_role;

CREATE OR REPLACE FUNCTION public.claim_search_alert_window(
  p_alert_id             UUID,
  p_min_interval_seconds INTEGER
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed TIMESTAMPTZ;
BEGIN
  IF p_min_interval_seconds IS NULL OR p_min_interval_seconds <= 0 THEN
    RAISE EXCEPTION 'claim_search_alert_window: p_min_interval_seconds must be > 0';
  END IF;

  INSERT INTO public.search_alert_windows AS w (alert_id, last_sent_at, prev_sent_at)
  VALUES (p_alert_id, clock_timestamp(), NULL)
  ON CONFLICT (alert_id) DO UPDATE
    SET prev_sent_at = w.last_sent_at,
        last_sent_at = EXCLUDED.last_sent_at
    WHERE w.last_sent_at <= EXCLUDED.last_sent_at - make_interval(secs => p_min_interval_seconds)
  RETURNING w.last_sent_at INTO v_claimed;

  RETURN v_claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_search_alert_window(
  p_alert_id   UUID,
  p_claimed_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM public.search_alert_windows
   WHERE alert_id = p_alert_id
     AND last_sent_at = p_claimed_at
     AND prev_sent_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN RETURN TRUE; END IF;

  UPDATE public.search_alert_windows
     SET last_sent_at = prev_sent_at,
         prev_sent_at = NULL
   WHERE alert_id = p_alert_id
     AND last_sent_at = p_claimed_at
     AND prev_sent_at IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_search_alert_window(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_search_alert_window(UUID, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.release_search_alert_window(UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_search_alert_window(UUID, TIMESTAMPTZ) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually if this must be undone):
--   DROP FUNCTION IF EXISTS public.release_search_alert_window(UUID, TIMESTAMPTZ);
--   DROP FUNCTION IF EXISTS public.claim_search_alert_window(UUID, INTEGER);
--   DROP TABLE IF EXISTS public.search_alert_windows;
-- ============================================================================
