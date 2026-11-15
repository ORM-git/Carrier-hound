-- ============================================================================
-- Migration: 20261115a_autorenew.sql
-- Status: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261115a_autorenew.sql
--
-- Auto-renewal persistence: SECURITY DEFINER RPCs to fulfil subscription paid cycles
-- (activated + charged), lifecycle events, and forward-migrates fulfil_payment_order to align lock order.
-- Applies to: public.subscriptions, public.payment_orders, public.plans, public.blocked_users, public.user_addon_credits, public.webhook_events
--
-- Safety & Transactional Guarantees:
--   1. Wrapped in a single atomic transaction (BEGIN ... COMMIT).
--   2. Guarded additive DDL: ensures payment_orders.metadata exists in the real schema.
--   3. Strict pre-flight checks: validates required tables and columns before defining functions.
--   4. Deadlock prevention: enforces advisory lock on user first, then subscriptions row, then order row everywhere.
--   5. Fail-closed rebind and monotonic watermark (normalized ms, greatest()) across paid and lifecycle events.
--   6. Strict mode check: stored mode unknown fails closed against live expected mode.
--   7. Timestamp gap guard: missing/NULL event timestamp cannot bypass existing watermark.
-- ============================================================================

BEGIN;

-- 1. Guarded additive DDL: add metadata column to payment_orders if missing in baseline schema
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. Pre-flight safety check: assert required tables and columns exist
DO $$
DECLARE
  missing_tbl text;
  missing_col text;
BEGIN
  -- Verify required tables exist
  FOR missing_tbl IN
    SELECT tbl
    FROM (VALUES
      ('subscriptions'),
      ('payment_orders'),
      ('plans'),
      ('blocked_users'),
      ('user_addon_credits'),
      ('webhook_events')
    ) AS req(tbl)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = req.tbl
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: table public.% does not exist', missing_tbl;
  END LOOP;

  -- Verify public.subscriptions columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES
      ('id'), ('user_id'), ('subscription_id'), ('plan_id'), ('provider'),
      ('status'), ('current_period_start'), ('current_period_end'),
      ('cancel_at_period_end'), ('grace_period_end'), ('metadata'),
      ('currency'), ('amount'), ('updated_at')
    ) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.subscriptions.% does not exist', missing_col;
  END LOOP;

  -- Verify public.payment_orders columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES
      ('id'), ('user_id'), ('provider_order_id'), ('provider'), ('mode'),
      ('status'), ('plan_code'), ('amount_paise'), ('paid_at'), ('metadata'), ('created_at')
    ) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_orders' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.payment_orders.% does not exist', missing_col;
  END LOOP;

  -- Verify public.plans columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('code'), ('is_active'), ('price_paise'), ('duration_days')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'plans' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.plans.% does not exist', missing_col;
  END LOOP;

  -- Verify public.blocked_users columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('user_id')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'blocked_users' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.blocked_users.% does not exist', missing_col;
  END LOOP;

  -- Verify public.user_addon_credits columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('user_id'), ('expires_at'), ('sets_remaining')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'user_addon_credits' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.user_addon_credits.% does not exist', missing_col;
  END LOOP;

  -- Verify public.webhook_events columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('event_id'), ('provider'), ('event_type')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'webhook_events' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.webhook_events.% does not exist', missing_col;
  END LOOP;
END;
$$;

-- Drop previous overloaded signatures
DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text);
DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text, text);
DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text, text, numeric);
DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text, text, numeric, numeric);

CREATE OR REPLACE FUNCTION public.fulfil_subscription_renewal(
  p_razorpay_subscription_id text,
  p_payment_id text,
  p_expected_mode text DEFAULT 'live',
  p_amount_paise numeric DEFAULT NULL,
  p_event_timestamp numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
DECLARE
  v_order record;
  v_sub record;
  v_updated_sub record;
  v_plan_row record;
  v_user_id uuid;
  v_plan_code text;
  v_duration int := 30;
  v_expected_amount int;
  v_mode text;
  v_base_time timestamptz;
  v_new_end timestamptz;
  v_period_start timestamptz;
  v_processed_payments jsonb;
  v_new_meta jsonb;
  v_has_sub boolean := false;
  v_curr_order_time timestamptz;
  v_is_valid_pending boolean := false;
  v_last_event_time numeric;
  v_incoming_ms numeric;
  v_stored_ms numeric;
  v_is_older_payment boolean := false;
  v_new_status text;
  v_new_cancel boolean;
  v_new_grace timestamptz;
BEGIN
  -- 0. Validate subscription ID input
  IF p_razorpay_subscription_id IS NULL OR trim(p_razorpay_subscription_id) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_SUBSCRIPTION_ID',
      'error', 'Subscription ID is required'
    );
  END IF;

  -- 1. Validate payment ID input (reject missing payment_id for any grant)
  IF p_payment_id IS NULL OR trim(p_payment_id) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MISSING_PAYMENT_ID',
      'error', 'Payment ID is required for subscription grant'
    );
  END IF;

  p_razorpay_subscription_id := trim(p_razorpay_subscription_id);
  p_payment_id := trim(p_payment_id);

  -- 2. Validate expected mode parameter (Strict: reject NULL or unknown mode)
  IF p_expected_mode IS NULL OR p_expected_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXPECTED_MODE',
      'error', 'Expected mode must be test or live'
    );
  END IF;

  -- 3. Discover user and pending/existing order from payment_orders
  SELECT * INTO v_order
  FROM public.payment_orders
  WHERE provider_order_id = p_razorpay_subscription_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_user_id := v_order.user_id;
  ELSE
    -- Fallback: check subscriptions table
    SELECT * INTO v_sub
    FROM public.subscriptions
    WHERE subscription_id = p_razorpay_subscription_id
       OR metadata->>'razorpay_subscription_id' = p_razorpay_subscription_id
       OR metadata->>'subscription_id' = p_razorpay_subscription_id
    LIMIT 1;

    IF FOUND THEN
      v_user_id := v_sub.user_id;
    END IF;
  END IF;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'SUBSCRIPTION_NOT_FOUND',
      'error', format('Subscription order not found for identifier: %s', p_razorpay_subscription_id)
    );
  END IF;

  -- 4. Advisory xact lock on user ID FIRST (deadlock prevention across all RPCs)
  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::text));

  -- 5. Lock and load authoritative subscriptions row for this user SECOND
  SELECT * INTO v_sub
  FROM public.subscriptions
  WHERE user_id = v_user_id
  FOR UPDATE;
  v_has_sub := FOUND;

  -- Also lock the payment order if found
  IF v_order.id IS NOT NULL THEN
    SELECT * INTO v_order
    FROM public.payment_orders
    WHERE id = v_order.id
    FOR UPDATE;
  END IF;

  -- 6. Provider Verification
  IF v_order.id IS NOT NULL AND v_order.provider IS NOT NULL AND v_order.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay subscription orders can be fulfilled'
    );
  END IF;
  IF v_has_sub AND v_sub.provider IS NOT NULL AND v_sub.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay subscription orders can be fulfilled'
    );
  END IF;

  -- 7. Mode Isolation Check
  -- Gap 2: NULL stored payment mode (order mode + subscription metadata both NULL)
  -- must NOT grant a live entitlement when p_expected_mode = live. Fail closed!
  v_mode := COALESCE(v_order.mode, v_sub.metadata->>'mode');
  IF v_mode IS NULL OR trim(v_mode) = '' THEN
    IF p_expected_mode = 'live' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'MODE_UNKNOWN',
        'error', 'Stored payment mode is missing or unknown; cannot grant live entitlement'
      );
    END IF;
  ELSIF v_mode <> p_expected_mode THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MODE_MISMATCH',
      'error', format('Order mode (%s) does not match expected fulfillment mode (%s)', v_mode, p_expected_mode)
    );
  END IF;

  -- 8. Server Ban Check (Fail-closed on blocked_users)
  IF EXISTS (SELECT 1 FROM public.blocked_users WHERE user_id = v_user_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'USER_BANNED',
      'error', 'Account is suspended'
    );
  END IF;

  -- 9. Test Mode Isolation: Mark order paid if needed, never grant live entitlement
  IF p_expected_mode = 'test' OR v_mode = 'test' THEN
    IF v_order.id IS NOT NULL AND v_order.status <> 'paid' THEN
      UPDATE public.payment_orders
      SET status = 'paid', paid_at = COALESCE(paid_at, now())
      WHERE id = v_order.id;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'test_mode', true,
      'is_pro', false,
      'already_paid', (v_order.status = 'paid'),
      'message', 'Test subscription cycle processed; zero real entitlements granted'
    );
  END IF;

  -- 10. Rebind Protection (Fail CLOSED):
  -- If incoming subscription id is not the currently bound mandate, only accept if it is
  -- a strictly newer single pending created order with verified order timestamp history.
  IF v_has_sub AND v_sub.subscription_id IS NOT NULL AND v_sub.subscription_id <> p_razorpay_subscription_id THEN
    v_is_valid_pending := false;
    IF v_order.id IS NOT NULL AND v_order.status = 'created' THEN
      SELECT created_at INTO v_curr_order_time
      FROM public.payment_orders
      WHERE provider_order_id = v_sub.subscription_id
      ORDER BY created_at DESC
      LIMIT 1;

      -- Fail CLOSED: require current order timestamp to be available AND new order strictly newer
      IF v_curr_order_time IS NOT NULL AND v_order.created_at > v_curr_order_time THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.payment_orders
          WHERE user_id = v_user_id
            AND status = 'created'
            AND id <> v_order.id
            AND created_at > v_order.created_at
        ) THEN
          v_is_valid_pending := true;
        END IF;
      END IF;
    END IF;

    IF NOT v_is_valid_pending THEN
      RETURN jsonb_build_object(
        'success', true,
        'ignored', true,
        'code', 'OLD_MANDATE_IGNORED',
        'reason', 'OLD_MANDATE_IGNORED',
        'message', format('Mandate %s is not current or pending; ignored', p_razorpay_subscription_id),
        'current_mandate', v_sub.subscription_id,
        'attempted_mandate', p_razorpay_subscription_id
      );
    END IF;
  END IF;

  -- 11. Idempotency on payment_id / cycle via payment-cycle ledger
  v_processed_payments := COALESCE(v_sub.metadata->'processed_payments', '[]'::jsonb);
  IF (v_has_sub AND (
        v_processed_payments ? p_payment_id OR
        v_sub.metadata->>'initial_payment_id' = p_payment_id OR
        v_sub.metadata->>'last_payment_id' = p_payment_id OR
        v_sub.metadata->>'last_renewal_payment_id' = p_payment_id
      ))
     OR (v_order.id IS NOT NULL AND v_order.status = 'paid' AND COALESCE(v_order.metadata->>'payment_id', '') = p_payment_id)
  THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'is_pro', true,
      'subscription_id', v_sub.id,
      'razorpay_subscription_id', p_razorpay_subscription_id,
      'user_id', v_user_id,
      'plan_id', v_sub.plan_id,
      'current_period_end', v_sub.current_period_end,
      'payment_id', p_payment_id,
      'amount', v_sub.amount,
      'message', 'Payment ID already processed for this cycle; zero duplicate extension'
    );
  END IF;

  -- 12. Monotonic watermark resolution (normalized to ms)
  -- A captured payment with an UNSEEN payment id that arrives older than the watermark
  -- must NOT be discarded. We credit it via the payment-cycle ledger while keeping
  -- the watermark monotonic with greatest().
  v_last_event_time := NULL;
  v_stored_ms := NULL;
  IF v_has_sub AND v_sub.metadata ? 'last_event_time' AND (v_sub.metadata->>'last_event_time') ~ '^[0-9]+(\.[0-9]+)?$' THEN
    v_last_event_time := (v_sub.metadata->>'last_event_time')::numeric;
    v_stored_ms := CASE WHEN v_last_event_time >= 1e11 THEN round(v_last_event_time) ELSE round(v_last_event_time * 1000) END;
  END IF;

  v_incoming_ms := NULL;
  IF p_event_timestamp IS NOT NULL AND p_event_timestamp > 0 THEN
    v_incoming_ms := CASE WHEN p_event_timestamp >= 1e11 THEN round(p_event_timestamp) ELSE round(p_event_timestamp * 1000) END;
  END IF;

  -- Older or untimestamped payments credit time via ledger, but must NOT reset newer lifecycle state!
  v_is_older_payment := false;
  IF v_has_sub THEN
    IF v_incoming_ms IS NULL THEN
      v_is_older_payment := true;
    ELSIF v_stored_ms IS NOT NULL AND v_incoming_ms < v_stored_ms THEN
      v_is_older_payment := true;
    END IF;
  END IF;

  -- 13. Validate plan id and amount against configured plans
  v_plan_code := COALESCE(v_order.plan_code, v_sub.plan_id);
  IF v_plan_code IS NULL OR trim(v_plan_code) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MISSING_PLAN_CODE',
      'error', 'Subscription has no associated plan code'
    );
  END IF;

  SELECT * INTO v_plan_row
  FROM public.plans
  WHERE code = v_plan_code AND is_active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PLAN_CODE',
      'error', format('Plan code %s is not a valid active plan in catalog', v_plan_code)
    );
  END IF;

  v_expected_amount := v_plan_row.price_paise;

  -- Live cycle requirement: require p_amount_paise > 0 and equal to plan price.
  -- Zero fallback to pending order amount!
  IF p_expected_mode = 'live' THEN
    IF p_amount_paise IS NULL OR p_amount_paise <= 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'INVALID_PAYMENT_AMOUNT',
        'error', 'Payment amount in paise must be positive for live cycle'
      );
    END IF;

    IF p_amount_paise <> v_expected_amount THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'PLAN_AMOUNT_MISMATCH',
        'error', format('Payment amount %s does not match plan price %s for plan %s', p_amount_paise, v_expected_amount, v_plan_code)
      );
    END IF;
  END IF;

  -- Exact duration from configured plans table (7, 30, or 90 days)
  v_duration := v_plan_row.duration_days;
  IF v_duration NOT IN (7, 30, 90) THEN
    IF v_plan_code = 'weekly' THEN v_duration := 7;
    ELSIF v_plan_code = 'quarterly' THEN v_duration := 90;
    ELSE v_duration := 30;
    END IF;
  END IF;

  -- 14. Compute Period Extension from max(current_period_end, now())
  -- Preserve owed prepaid time across active, in_grace_period, past_due, trialing, etc.
  -- Active entitlement with 20 days left + subscription.pending + 7d renewal must yield 27 days, never 7!
  IF v_has_sub AND v_sub.current_period_end IS NOT NULL THEN
    v_base_time := greatest(v_sub.current_period_end, now());
  ELSE
    v_base_time := now();
  END IF;

  v_new_end := v_base_time + (v_duration * interval '1 day');
  -- Non-shortening guard
  IF v_has_sub AND v_sub.current_period_end IS NOT NULL AND v_new_end < v_sub.current_period_end THEN
    v_new_end := v_sub.current_period_end;
  END IF;

  v_period_start := COALESCE(v_sub.current_period_start, now());

  -- 15. Build updated metadata including monotonic last_event_time (normalized to ms)
  v_new_meta := COALESCE(v_sub.metadata, '{}'::jsonb);
  v_new_meta := jsonb_set(
    v_new_meta,
    '{processed_payments}',
    v_processed_payments || jsonb_build_array(p_payment_id),
    true
  );
  v_new_meta := jsonb_set(v_new_meta, '{last_payment_id}', to_jsonb(p_payment_id), true);
  v_new_meta := jsonb_set(v_new_meta, '{last_renewal_payment_id}', to_jsonb(p_payment_id), true);
  v_new_meta := jsonb_set(v_new_meta, '{last_paid_at}', to_jsonb(now()), true);
  v_new_meta := jsonb_set(v_new_meta, '{razorpay_subscription_id}', to_jsonb(p_razorpay_subscription_id), true);
  IF NOT (v_new_meta ? 'initial_payment_id') THEN
    v_new_meta := jsonb_set(v_new_meta, '{initial_payment_id}', to_jsonb(p_payment_id), true);
  END IF;

  -- Monotonic watermark: normalize to milliseconds before greatest() storage
  IF v_stored_ms IS NOT NULL THEN
    IF v_incoming_ms IS NOT NULL THEN
      v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(greatest(v_stored_ms, v_incoming_ms)), true);
    ELSE
      v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(v_stored_ms), true);
    END IF;
  ELSIF v_incoming_ms IS NOT NULL THEN
    v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(v_incoming_ms), true);
  END IF;

  -- 16. Upsert/Update subscriptions row (Store exact paise amount integer: 69200, 149900, 399900)
  -- Older unseen payments credit time but do NOT reset newer lifecycle state
  -- (cancel_at_period_end, status, grace_period_end are preserved)
  IF v_is_older_payment THEN
    v_new_status := COALESCE(v_sub.status, 'active');
    v_new_cancel := COALESCE(v_sub.cancel_at_period_end, false);
    v_new_grace := v_sub.grace_period_end;
  ELSE
    v_new_status := 'active';
    v_new_cancel := false;
    v_new_grace := NULL;
  END IF;

  IF v_has_sub THEN
    UPDATE public.subscriptions
    SET
      subscription_id = p_razorpay_subscription_id,
      plan_id = v_plan_code,
      provider = 'razorpay',
      status = v_new_status,
      current_period_start = v_period_start,
      current_period_end = v_new_end,
      cancel_at_period_end = v_new_cancel,
      grace_period_end = v_new_grace,
      metadata = v_new_meta,
      currency = 'INR',
      amount = v_expected_amount,
      updated_at = now()
    WHERE user_id = v_user_id
    RETURNING * INTO v_updated_sub;
  ELSE
    INSERT INTO public.subscriptions (
      user_id,
      subscription_id,
      plan_id,
      provider,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      metadata,
      currency,
      amount,
      updated_at
    ) VALUES (
      v_user_id,
      p_razorpay_subscription_id,
      v_plan_code,
      'razorpay',
      'active',
      v_period_start,
      v_new_end,
      false,
      v_new_meta,
      'INR',
      v_expected_amount,
      now()
    )
    RETURNING * INTO v_updated_sub;
  END IF;

  -- 17. Mark payment_orders row as paid
  IF v_order.id IS NOT NULL THEN
    UPDATE public.payment_orders
    SET
      status = 'paid',
      paid_at = COALESCE(paid_at, now()),
      metadata = jsonb_set(COALESCE(payment_orders.metadata, '{}'::jsonb), '{payment_id}', to_jsonb(p_payment_id), true)
    WHERE id = v_order.id;
  END IF;

  -- 18. Extend active unexpired add-on credits to match newly extended subscription period
  UPDATE public.user_addon_credits
  SET expires_at = v_new_end
  WHERE user_id = v_user_id
    AND expires_at >= now()
    AND sets_remaining > 0;

  -- 19. Return success payload
  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'is_pro', true,
    'subscription_id', v_updated_sub.id,
    'razorpay_subscription_id', p_razorpay_subscription_id,
    'user_id', v_user_id,
    'plan_id', v_plan_code,
    'duration_days', v_duration,
    'current_period_end', v_updated_sub.current_period_end,
    'payment_id', p_payment_id,
    'amount', v_updated_sub.amount
  );
END;
$$;

-- Drop previous lifecycle signatures
DROP FUNCTION IF EXISTS public.handle_subscription_lifecycle_event(text, text);
DROP FUNCTION IF EXISTS public.handle_subscription_lifecycle_event(text, text, numeric);
DROP FUNCTION IF EXISTS public.handle_subscription_lifecycle_event(text, text, numeric, text);

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
    'subscription.completed'
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
      WHEN p_event_type IN ('subscription.cancelled', 'subscription.canceled', 'subscription.completed') THEN true
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

-- Strict ACL: Revoke from public/anon/authenticated and grant only to service_role
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) FROM public;
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) TO service_role;
ALTER FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) SET search_path = public;
ALTER FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) SET statement_timeout = '15s';

REVOKE ALL ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) FROM public;
REVOKE ALL ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) FROM anon;
REVOKE ALL ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) TO service_role;
ALTER FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) SET search_path = public;
ALTER FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) SET statement_timeout = '15s';

-- ============================================================================
-- FORWARD MIGRATION: Align prepaid fulfil_payment_order lock order
-- Replaces definition from 20261114a_payment_plan_stack_guard.sql to enforce
-- the identical global lock order: (1) advisory lock on user, (2) subscriptions,
-- (3) payment_orders.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fulfil_payment_order(
  p_provider_order_id text,
  p_user_id uuid,
  p_expected_mode text DEFAULT 'live'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
DECLARE
  v_order record;
  v_existing_sub record;
  v_sub record;
  v_existing_credit record;
  v_credit record;
  v_duration int;
  v_sets int;
  v_validity int;
  v_new_end timestamptz;
  v_period_start timestamptz;
  v_base_time timestamptz;
  v_prev_order_id uuid;
  v_prev_order_created timestamptz;
  v_label_plan text;
  v_label_currency text;
  v_label_amount numeric;
  v_label_meta jsonb;
  v_has_sub boolean;
BEGIN
  -- Validate expected mode parameter
  IF p_expected_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXPECTED_MODE',
      'error', 'Expected mode must be either test or live'
    );
  END IF;

  -- 1. Advisory xact lock on user ID FIRST (deadlock prevention across all RPCs)
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 2. Lock authoritative subscriptions row for this user SECOND
  SELECT * INTO v_existing_sub
  FROM public.subscriptions
  WHERE user_id = p_user_id
  FOR UPDATE;
  v_has_sub := FOUND;

  -- 3. Lock the order row for update THIRD
  SELECT * INTO v_order
  FROM public.payment_orders
  WHERE provider_order_id = p_provider_order_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_FOUND',
      'error', 'Payment order not found for user'
    );
  END IF;

  -- 4. Provider verification
  IF v_order.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay provider orders can be fulfilled via this function'
    );
  END IF;

  -- 5. Fail-closed Mode Check: Order mode must match expected fulfillment mode
  IF v_order.mode <> p_expected_mode THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MODE_MISMATCH',
      'error', format('Order mode (%s) does not match fulfillment mode (%s)', v_order.mode, p_expected_mode)
    );
  END IF;

  -- 6. Verify state is valid (created or paid-retry)
  IF v_order.status NOT IN ('created', 'paid') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_INVALID_STATE',
      'error', 'Payment order is not in created or paid state'
    );
  END IF;

  -- 7. TEST MODE ISOLATION: Zero real entitlements granted
  IF v_order.mode = 'test' THEN
    IF v_order.status = 'paid' THEN
      RETURN jsonb_build_object(
        'success', true,
        'test_mode', true,
        'is_pro', false,
        'already_paid', true,
        'order_id', v_order.id,
        'message', 'Test order already verified and marked as paid'
      );
    END IF;

    -- Mark test order paid, NEVER touch subscriptions or user_addon_credits
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'test_mode', true,
      'is_pro', false,
      'order_id', v_order.id,
      'already_paid', false,
      'message', 'Test payment verified; zero real entitlements granted'
    );
  END IF;

  -- 8. LIVE MODE: Idempotency check for already fulfilled live orders
  IF v_order.status = 'paid' THEN
    IF v_order.plan_code IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_paid', true,
        'is_pro', true,
        'type', 'plan',
        'plan_code', v_order.plan_code,
        'order_id', v_order.id,
        'period_end', v_existing_sub.current_period_end,
        'message', 'Order already fulfilled and marked as paid'
      );
    ELSIF v_order.addon_code IS NOT NULL THEN
      SELECT * INTO v_existing_credit
      FROM public.user_addon_credits
      WHERE order_id = v_order.id;

      RETURN jsonb_build_object(
        'success', true,
        'already_paid', true,
        'is_pro', false,
        'type', 'addon',
        'addon_code', v_order.addon_code,
        'order_id', v_order.id,
        'credit_id', v_existing_credit.id,
        'expires_at', v_existing_credit.expires_at,
        'message', 'Order already fulfilled and marked as paid'
      );
    END IF;
  END IF;

  -- 9. Live Fulfillment Path A: Subscription Plan purchase / renewal / upgrade
  IF v_order.plan_code IS NOT NULL THEN
    SELECT duration_days INTO v_duration
    FROM public.plans
    WHERE code = v_order.plan_code;

    IF v_duration IS NULL OR v_duration <= 0 THEN
      IF v_order.plan_code = 'weekly' THEN
        v_duration := 7;
      ELSIF v_order.plan_code = 'quarterly' THEN
        v_duration := 90;
      ELSE
        v_duration := 30;
      END IF;
    END IF;

    -- Default: label (plan/currency/amount/metadata) comes from this order
    v_label_plan := v_order.plan_code;
    v_label_currency := v_order.currency;
    v_label_amount := v_order.amount_paise;
    v_label_meta := jsonb_build_object(
      'provider_order_id', p_provider_order_id,
      'payment_order_id', v_order.id,
      'mode', v_order.mode
    );

    IF v_has_sub AND (v_existing_sub.status IN ('active', 'trialing')) AND v_existing_sub.current_period_end IS NOT NULL THEN
      v_period_start := coalesce(v_existing_sub.current_period_start, now());

      -- Which order produced the current label?
      v_prev_order_id := NULL;
      IF (v_existing_sub.metadata->>'payment_order_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_prev_order_id := (v_existing_sub.metadata->>'payment_order_id')::uuid;
      END IF;

      IF v_prev_order_id IS NOT NULL AND v_prev_order_id = v_order.id THEN
        -- This order already produced the current subscription state: never extend twice
        v_new_end := v_existing_sub.current_period_end;
      ELSE
        -- Different order stacked on an active plan: period extends from max(current_period_end, now)
        v_base_time := greatest(v_existing_sub.current_period_end, now());
        v_new_end := v_base_time + (v_duration * interval '1 day');
        -- Never shorten existing period
        IF v_new_end < v_existing_sub.current_period_end THEN
          v_new_end := v_existing_sub.current_period_end;
        END IF;

        -- plan_id/currency/amount/metadata are written only from the NEWER order (by created_at).
        -- Missing/unknown previous-order metadata or equal timestamps keep the existing label.
        v_prev_order_created := NULL;
        IF v_prev_order_id IS NOT NULL THEN
          SELECT created_at INTO v_prev_order_created
          FROM public.payment_orders
          WHERE id = v_prev_order_id
            AND user_id = p_user_id;
        END IF;

        IF v_prev_order_created IS NULL OR NOT (v_order.created_at > v_prev_order_created) THEN
          v_label_plan := v_existing_sub.plan_id;
          v_label_currency := v_existing_sub.currency;
          v_label_amount := v_existing_sub.amount;
          v_label_meta := v_existing_sub.metadata;
        END IF;
      END IF;
    ELSE
      -- Expired or no previous subscription: period end = now + duration, label from this order
      v_period_start := now();
      v_new_end := now() + (v_duration * interval '1 day');
    END IF;

    -- Grant subscription entitlement FIRST
    INSERT INTO public.subscriptions (
      user_id,
      plan_id,
      provider,
      currency,
      amount,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      metadata,
      updated_at
    ) VALUES (
      p_user_id,
      v_label_plan,
      'razorpay',
      v_label_currency,
      v_label_amount,
      'active',
      v_period_start,
      v_new_end,
      false,
      v_label_meta,
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      plan_id = EXCLUDED.plan_id,
      currency = EXCLUDED.currency,
      amount = EXCLUDED.amount,
      status = 'active',
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      cancel_at_period_end = false,
      metadata = EXCLUDED.metadata,
      updated_at = now()
    RETURNING * INTO v_sub;

    -- Also extend active unexpired add-on credits to match newly extended subscription period
    UPDATE public.user_addon_credits
    SET expires_at = v_new_end
    WHERE user_id = p_user_id
      AND expires_at >= now()
      AND sets_remaining > 0;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'is_pro', true,
      'type', 'plan',
      'plan_code', v_order.plan_code,
      'order_id', v_order.id,
      'period_end', v_sub.current_period_end
    );
  END IF;

  -- 10. Live Fulfillment Path B: Add-on pack purchase
  IF v_order.addon_code IS NOT NULL THEN
    SELECT sets, validity_days INTO v_sets, v_validity
    FROM public.addon_packs
    WHERE code = v_order.addon_code;

    IF v_sets IS NULL OR v_sets <= 0 THEN
      IF v_order.addon_code = 'addon_30' THEN
        v_sets := 30;
      ELSIF v_order.addon_code = 'addon_60' THEN
        v_sets := 60;
      ELSE
        v_sets := 10;
      END IF;
    END IF;

    -- Active subscription check (v_existing_sub already locked at step 2)
    IF NOT v_has_sub OR v_existing_sub.status NOT IN ('active', 'trialing') OR v_existing_sub.current_period_end IS NULL OR v_existing_sub.current_period_end <= now() THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'PRO_REQUIRED',
        'error', 'Active Pro subscription required to activate add-on credits'
      );
    END IF;

    v_new_end := v_existing_sub.current_period_end;

    -- Grant add-on credit entitlement FIRST
    INSERT INTO public.user_addon_credits (
      user_id,
      pack_code,
      sets_total,
      sets_remaining,
      expires_at,
      order_id,
      created_at
    ) VALUES (
      p_user_id,
      v_order.addon_code,
      v_sets,
      v_sets,
      v_new_end,
      v_order.id,
      now()
    )
    ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_credit;

    IF NOT FOUND THEN
      SELECT * INTO v_credit
      FROM public.user_addon_credits
      WHERE order_id = v_order.id;
    END IF;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    UPDATE public.payment_orders
    SET status = 'paid',
        paid_at = coalesce(paid_at, now())
    WHERE id = v_order.id
    RETURNING * INTO v_order;

    RETURN jsonb_build_object(
      'success', true,
      'is_pro', false,
      'type', 'addon',
      'addon_code', v_order.addon_code,
      'order_id', v_order.id,
      'sets_granted', v_sets,
      'credit_id', v_credit.id,
      'expires_at', v_credit.expires_at
    );
  END IF;

  RETURN jsonb_build_object(
    'success', false,
    'code', 'ORDER_ITEM_MISSING',
    'error', 'Order contains neither plan_code nor addon_code'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.fulfil_payment_order(text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fulfil_payment_order(text, uuid, text) TO service_role;
ALTER FUNCTION public.fulfil_payment_order(text, uuid, text) SET search_path = public;
ALTER FUNCTION public.fulfil_payment_order(text, uuid, text) SET statement_timeout = '15s';

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.handle_subscription_lifecycle_event(text, text, numeric, text);
--   DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text, text, numeric, numeric);
--   Restore public.fulfil_payment_order(text, uuid, text) from 20261114a_payment_plan_stack_guard.sql
-- ============================================================================
