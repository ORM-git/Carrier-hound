-- ============================================================================
-- Migration: 20261107c_outbox_queue.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107c_outbox_queue
--
-- Database rows: "SKIP LOCKED work queue" (MISSING: "No queue table yet; digest
-- queue uses status columns") and "Queue / outbox table" (PARTIAL: failed_events
-- covers retries, "no generic outbox dispatcher").
--
-- What this adds (additive; nothing enqueues or claims anything until a caller
-- is wired, which is a later, separate change):
--   public.outbox: generic at-least-once work queue. Statuses: pending,
--     processing, done, dead. A row is claimed with FOR UPDATE SKIP LOCKED, so
--     parallel workers never take the same row. A claim is a lease
--     (locked_until); a crashed worker's row becomes claimable again once the
--     lease expires.
--   outbox_enqueue / outbox_claim_batch / outbox_ack / outbox_fail:
--     SECURITY DEFINER with pinned search_path (house rule), REVOKEd from
--     PUBLIC/anon/authenticated, EXECUTE for service_role only.
--
-- No numbers are baked in: max attempts, lease seconds and retry delay are
-- required arguments with no defaults (owner to confirm values per topic).
-- Delivery is at-least-once: consumers must be idempotent (enqueue accepts a
-- dedupe_key to make producers idempotent).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.outbox (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  topic        TEXT        NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 100),
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempts     INTEGER     NOT NULL DEFAULT 0,
  max_attempts INTEGER     NOT NULL CHECK (max_attempts > 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  locked_by    TEXT,
  last_error   TEXT,
  dedupe_key   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedupe_key_uidx
  ON public.outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbox_claim_idx
  ON public.outbox (topic, available_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.outbox TO service_role;

CREATE OR REPLACE FUNCTION public.outbox_enqueue(
  p_topic        TEXT,
  p_payload      JSONB,
  p_max_attempts INTEGER,
  p_dedupe_key   TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_max_attempts IS NULL OR p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'outbox_enqueue: p_max_attempts must be > 0';
  END IF;
  INSERT INTO public.outbox (topic, payload, max_attempts, dedupe_key)
  VALUES (p_topic, COALESCE(p_payload, '{}'::jsonb), p_max_attempts, p_dedupe_key)
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL AND p_dedupe_key IS NOT NULL THEN
    SELECT id INTO v_id FROM public.outbox WHERE dedupe_key = p_dedupe_key;
  END IF;
  RETURN v_id;
END;
$$;

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
  UPDATE public.outbox
     SET status = 'dead', locked_until = NULL, locked_by = NULL,
         last_error = COALESCE(last_error, 'lease expired after final attempt'),
         updated_at = now()
   WHERE topic = p_topic
     AND status = 'processing'
     AND locked_until < now()
     AND attempts >= max_attempts;

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

CREATE OR REPLACE FUNCTION public.outbox_ack(p_id UUID, p_worker TEXT)
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
   WHERE id = p_id AND status = 'processing' AND locked_by = p_worker;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

-- Returns 'retry', 'dead', or NULL when the row is not leased to p_worker.
CREATE OR REPLACE FUNCTION public.outbox_fail(
  p_id                  UUID,
  p_worker              TEXT,
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
   WHERE id = p_id AND status = 'processing' AND locked_by = p_worker
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

REVOKE ALL ON FUNCTION public.outbox_enqueue(TEXT, JSONB, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_claim_batch(TEXT, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_ack(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbox_fail(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbox_enqueue(TEXT, JSONB, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_claim_batch(TEXT, INTEGER, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_ack(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbox_fail(UUID, TEXT, TEXT, INTEGER) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.outbox_fail(UUID, TEXT, TEXT, INTEGER);
--   DROP FUNCTION IF EXISTS public.outbox_ack(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.outbox_claim_batch(TEXT, INTEGER, INTEGER, TEXT);
--   DROP FUNCTION IF EXISTS public.outbox_enqueue(TEXT, JSONB, INTEGER, TEXT);
--   DROP INDEX IF EXISTS public.outbox_claim_idx;
--   DROP INDEX IF EXISTS public.outbox_dedupe_key_uidx;
--   DROP TABLE IF EXISTS public.outbox;
-- ============================================================================
