-- ============================================================================
-- Migration: 20261107e_outbox_fencing.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor AFTER
-- 20261107c_outbox_queue.sql, then record:
--   node scripts/record-migration.cjs 20261107e_outbox_fencing
--
-- Follow-up to 20261107c, closing two gaps named in the Database sheet row
-- "Queue / outbox table":
--   1. "ack/fail identify worker string only (no per-claim fencing token), so
--      reused worker IDs can allow stale completion after reclaim." Every claim
--      increments outbox.attempts. outbox_ack and outbox_fail now also require
--      p_attempt = the row's current attempts, so a completion from an older
--      claim of the same row is refused even when the worker id is reused.
--   2. "Expired-final-attempt cleanup is ordinary UPDATE before SKIP LOCKED
--      selection and can block." The cleanup now selects its rows FOR UPDATE
--      SKIP LOCKED first, so it never waits on a row another worker holds.
--
-- Signature change: outbox_ack(uuid, text) and outbox_fail(uuid, text, text,
-- integer) are DROPPED and replaced. Nothing in the repo calls them besides
-- src/lib/queue/outbox.ts, updated in the same PR. Apply c and e together.
-- ============================================================================

DROP FUNCTION IF EXISTS public.outbox_ack(UUID, TEXT);
DROP FUNCTION IF EXISTS public.outbox_fail(UUID, TEXT, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.outbox_claim_batch(
  p_topic         TEXT,
  p_limit         INTEGER,
  p_lease_seconds INTEGER,
  p_worker        TEXT
)
RETURNS SETOF public.outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 THEN
    RAISE EXCEPTION 'outbox_claim_batch: p_limit must be > 0';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 THEN
    RAISE EXCEPTION 'outbox_claim_batch: p_lease_seconds must be > 0';
  END IF;
  IF p_worker IS NULL OR char_length(p_worker) = 0 THEN
    RAISE EXCEPTION 'outbox_claim_batch: p_worker is required';
  END IF;

  -- A lease that expired with no attempts left is finished: park it as dead.
  -- Rows locked by another transaction are skipped, never waited on.
  WITH expired AS (
    SELECT o.id
      FROM public.outbox o
     WHERE o.topic = p_topic
       AND o.status = 'processing'
       AND o.locked_until < now()
       AND o.attempts >= o.max_attempts
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox o
     SET status = 'dead', locked_until = NULL, locked_by = NULL,
         last_error = COALESCE(o.last_error, 'lease expired after final attempt'),
         updated_at = now()
    FROM expired
   WHERE o.id = expired.id;

  RETURN QUERY
  WITH picked AS (
    SELECT o.id
      FROM public.outbox o
     WHERE o.topic = p_topic
       AND o.attempts < o.max_attempts
       AND ((o.status = 'pending' AND o.available_at <= now())
         OR (o.status = 'processing' AND o.locked_until < now()))
     ORDER BY o.available_at, o.created_at
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox o
     SET status = 'processing',
         attempts = o.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         locked_by = p_worker,
         updated_at = now()
    FROM picked
   WHERE o.id = picked.id
  RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.outbox_ack(p_id UUID, p_worker TEXT, p_attempt INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  UPDATE public.outbox
     SET status = 'done', locked_until = NULL, locked_by = NULL, updated_at = now()
   WHERE id = p_id AND status = 'processing' AND locked_by = p_worker AND attempts = p_attempt;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- Returns 'retry', 'dead', or NULL when the row is not leased to this worker and attempt.
CREATE OR REPLACE FUNCTION public.outbox_fail(
  p_id                  UUID,
  p_worker              TEXT,
  p_attempt             INTEGER,
  p_error               TEXT,
  p_retry_delay_seconds INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.outbox%ROWTYPE;
BEGIN
  IF p_retry_delay_seconds IS NULL OR p_retry_delay_seconds < 0 THEN
    RAISE EXCEPTION 'outbox_fail: p_retry_delay_seconds must be >= 0';
  END IF;
  SELECT * INTO v_row FROM public.outbox
   WHERE id = p_id AND status = 'processing' AND locked_by = p_worker AND attempts = p_attempt
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_row.attempts >= v_row.max_attempts THEN
    UPDATE public.outbox
       SET status = 'dead', locked_until = NULL, locked_by = NULL,
           last_error = left(p_error, 2000), updated_at = now()
     WHERE id = p_id;
    RETURN 'dead';
  END IF;
  UPDATE public.outbox
     SET status = 'pending', locked_until = NULL, locked_by = NULL,
         available_at = now() + make_interval(secs => p_retry_delay_seconds),
         last_error = left(p_error, 2000), updated_at = now()
   WHERE id = p_id;
  RETURN 'retry';
END;
$$;

REVOKE ALL ON FUNCTION public.outbox_claim_batch(TEXT, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_ack(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_fail(UUID, TEXT, INTEGER, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbox_claim_batch(TEXT, INTEGER, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_ack(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_fail(UUID, TEXT, INTEGER, TEXT, INTEGER) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.outbox_fail(UUID, TEXT, INTEGER, TEXT, INTEGER);
--   DROP FUNCTION IF EXISTS public.outbox_ack(UUID, TEXT, INTEGER);
--   then re-run the outbox_claim_batch, outbox_ack(uuid, text) and
--   outbox_fail(uuid, text, text, integer) definitions and their REVOKE/GRANT
--   lines from 20261107c_outbox_queue.sql.
-- ============================================================================
