-- ============================================================================
-- Migration: 20261120b_autorenew_paused_resumed.sql
-- Status: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261120b_autorenew_paused_resumed.sql
--
-- Auto-renew for weekly (Rs 399) and quarterly (Rs 2,199): lifecycle handling for
-- subscription.paused and subscription.resumed. Replaces only
-- public.handle_subscription_lifecycle_event from 20261115a_autorenew.sql; same signature,
-- same locks, watermark and mode/ban checks. Two changes:
--   - paused:  cancel_at_period_end = true  (no new charges; paid time runs to current_period_end)
--   - resumed: cancel_at_period_end = false (renewal back on; next charged event extends the period)
-- Paid cycles for every plan still go through fulfil_subscription_renewal, which already reads
-- price and duration (7 / 30 / 90 days) from public.plans, so it is unchanged.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Pre-flight: the 20261115a function must exist with this exact signature
DO $$
BEGIN
  IF to_regprocedure('public.handle_subscription_lifecycle_event(text, text, numeric, text)') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: apply 20261115a_autorenew.sql first';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_subscription_lifecycle_event(
  p_razorpay_subscription_id text,
  p_event_type text,
  p_event_timestamp numeric DEFAULT NULL,
  p_expected_mode text DEFAULT 'live'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
DECLARE
  v_sub record;
  v_updated_sub record;
  v_user_id uuid;
  v_mode text;
  v_order_mode text;
  v_last_event_time numeric;
  v_new_meta jsonb;
  v_incoming_ms numeric;
  v_stored_ms numeric;
BEGIN
  -- 0. Validate subscription ID
  IF p_razorpay_subscription_id IS NULL OR trim(p_razorpay_subscription_id) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_SUBSCRIPTION_ID',
      'error', 'Subscription ID is required'
    );
  END IF;

  p_razorpay_subscription_id := trim(p_razorpay_subscription_id);

  -- 1. Validate event type
  IF p_event_type NOT IN (
    'subscription.pending',
    'subscription.halted',
    'subscription.past_due',
    'subscription.cancelled',
    'subscription.canceled',
    'subscription.completed',
    'subscription.paused',
    'subscription.resumed'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EVENT_TYPE',
      'error', format('Unsupported lifecycle event type: %s', p_event_type)
    );
  END IF;

  -- 2. Validate expected mode (Strict: reject NULL or unknown mode)
  IF p_expected_mode IS NULL OR p_expected_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXPECTED_MODE',
      'error', 'Expected mode must be test or live'
    );
  END IF;

  -- 3. Discover user_id for this mandate
  SELECT user_id INTO v_user_id
  FROM public.subscriptions
  WHERE subscription_id = p_razorpay_subscription_id
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT user_id INTO v_user_id
    FROM public.payment_orders
    WHERE provider_order_id = p_razorpay_subscription_id
    LIMIT 1;
  END IF;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'ignored', true,
      'reason', 'UNBOUND_MANDATE',
      'message', format('Mandate %s is not currently bound', p_razorpay_subscription_id)
    );
  END IF;

  -- 4. Advisory xact lock on user ID FIRST (deadlock prevention matching renewal lock order)
  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::text));

  -- 5. Lock and load authoritative subscriptions row strictly matching the currently bound mandate SECOND
  SELECT * INTO v_sub
  FROM public.subscriptions
  WHERE subscription_id = p_razorpay_subscription_id
  FOR UPDATE;

  -- Old or abandoned mandates must never touch a newer or prepaid entitlement
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'ignored', true,
      'reason', 'UNBOUND_MANDATE',
      'message', format('Mandate %s is not currently bound', p_razorpay_subscription_id)
    );
  END IF;

  -- 6. Provider check
  IF v_sub.provider IS NOT NULL AND v_sub.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay subscription events can be handled'
    );
  END IF;

  -- 7. Mode isolation check
  -- Gap 2: NULL stored payment mode must NOT grant a live entitlement or process live lifecycle event. Fail closed!
  v_mode := v_sub.metadata->>'mode';
  IF v_mode IS NULL THEN
    SELECT mode INTO v_order_mode
    FROM public.payment_orders
    WHERE provider_order_id = p_razorpay_subscription_id
    ORDER BY created_at DESC
    LIMIT 1;
    v_mode := v_order_mode;
  END IF;

  IF v_mode IS NULL OR trim(v_mode) = '' THEN
    IF p_expected_mode = 'live' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'MODE_UNKNOWN',
        'error', 'Subscription mode is missing or unknown; cannot process live lifecycle event'
      );
    END IF;
  ELSIF v_mode <> p_expected_mode THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MODE_MISMATCH',
      'error', format('Subscription mode (%s) does not match expected mode (%s)', v_mode, p_expected_mode)
    );
  END IF;

  -- 8. Server ban check
  IF EXISTS (SELECT 1 FROM public.blocked_users WHERE user_id = v_sub.user_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'USER_BANNED',
      'error', 'Account is suspended'
    );
  END IF;

  -- 9. Lifecycle ordering: Durable provider last-event timestamp check
  -- Gap 1: Missing/NULL event timestamp must NOT bypass the ordering check when a newer watermark exists.
  -- Gap 3: Normalize event timestamps to milliseconds BEFORE comparison and greatest() storage.
  v_last_event_time := NULL;
  IF v_sub.metadata ? 'last_event_time' AND (v_sub.metadata->>'last_event_time') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_last_event_time := (v_sub.metadata->>'last_event_time')::numeric;
  END IF;

  IF v_last_event_time IS NOT NULL THEN
    v_stored_ms := CASE WHEN v_last_event_time >= 1e11 THEN round(v_last_event_time) ELSE round(v_last_event_time * 1000) END;

    IF p_event_timestamp IS NULL OR p_event_timestamp <= 0 THEN
      RETURN jsonb_build_object(
        'success', true,
        'ignored', true,
        'code', 'OUT_OF_ORDER_EVENT',
        'reason', 'OUT_OF_ORDER_EVENT',
        'message', format('Missing event timestamp cannot bypass existing watermark %s ms', v_stored_ms),
        'subscription_id', p_razorpay_subscription_id,
        'last_event_time', v_stored_ms,
        'event_timestamp', p_event_timestamp
      );
    END IF;

    v_incoming_ms := CASE WHEN p_event_timestamp >= 1e11 THEN round(p_event_timestamp) ELSE round(p_event_timestamp * 1000) END;

    IF v_incoming_ms < v_stored_ms THEN
      RETURN jsonb_build_object(
        'success', true,
        'ignored', true,
        'code', 'OUT_OF_ORDER_EVENT',
        'reason', 'OUT_OF_ORDER_EVENT',
        'message', format('Event timestamp %s ms is older than stored last event time %s ms', v_incoming_ms, v_stored_ms),
        'subscription_id', p_razorpay_subscription_id,
        'last_event_time', v_stored_ms,
        'event_timestamp', p_event_timestamp
      );
    END IF;
  END IF;

  -- 10. Atomic DB transition with monotonic watermark (normalized ms stored)
  v_new_meta := COALESCE(v_sub.metadata, '{}'::jsonb);
  IF p_event_timestamp IS NOT NULL AND p_event_timestamp > 0 THEN
    v_incoming_ms := CASE WHEN p_event_timestamp >= 1e11 THEN round(p_event_timestamp) ELSE round(p_event_timestamp * 1000) END;
    IF v_stored_ms IS NOT NULL THEN
      v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(greatest(v_stored_ms, v_incoming_ms)), true);
    ELSE
      v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(v_incoming_ms), true);
    END IF;
  END IF;
  v_new_meta := jsonb_set(v_new_meta, '{last_lifecycle_event}', to_jsonb(p_event_type), true);

  UPDATE public.subscriptions
  SET
    status = CASE
      WHEN p_event_type = 'subscription.pending' THEN 'in_grace_period'
      WHEN p_event_type IN ('subscription.halted', 'subscription.past_due') THEN 'past_due'
      ELSE status
    END,
    grace_period_end = CASE
      WHEN p_event_type = 'subscription.pending' THEN now() + interval '7 days'
      WHEN p_event_type IN ('subscription.halted', 'subscription.past_due') THEN NULL
      ELSE grace_period_end
    END,
    cancel_at_period_end = CASE
      WHEN p_event_type IN ('subscription.cancelled', 'subscription.canceled', 'subscription.completed', 'subscription.paused') THEN true
      WHEN p_event_type = 'subscription.resumed' THEN false
      ELSE cancel_at_period_end
    END,
    metadata = v_new_meta,
    updated_at = now()
  WHERE id = v_sub.id
    AND subscription_id = p_razorpay_subscription_id
  RETURNING * INTO v_updated_sub;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'ignored', true,
      'reason', 'MANDATE_CHANGED',
      'message', 'Subscription mandate changed concurrently; ignored'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'applied', true,
    'event_type', p_event_type,
    'subscription_id', v_updated_sub.subscription_id,
    'status', v_updated_sub.status,
    'cancel_at_period_end', v_updated_sub.cancel_at_period_end,
    'grace_period_end', v_updated_sub.grace_period_end,
    'user_id', v_updated_sub.user_id,
    'last_event_time', v_updated_sub.metadata->'last_event_time'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) FROM public;
REVOKE ALL ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) FROM anon;
REVOKE ALL ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) TO service_role;
ALTER FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) SET search_path = public;
ALTER FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) SET statement_timeout = '15s';

COMMIT;

-- Verify (expect true, true):
--   SELECT pg_get_functiondef('public.handle_subscription_lifecycle_event(text, text, numeric, text)'::regprocedure) LIKE '%subscription.paused%',
--          pg_get_functiondef('public.handle_subscription_lifecycle_event(text, text, numeric, text)'::regprocedure) LIKE '%subscription.resumed%';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   Re-run the handle_subscription_lifecycle_event definition and its ACL block from
--   20261115a_autorenew.sql. paused/resumed events then return INVALID_EVENT_TYPE again.
-- ============================================================================
