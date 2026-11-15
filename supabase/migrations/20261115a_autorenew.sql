-- ============================================================================
-- Migration: 20261115a_autorenew.sql
-- Status: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261115a_autorenew.sql
--
-- Auto-renewal persistence: SECURITY DEFINER RPCs to fulfil subscription paid cycles
-- (activated + charged) and lifecycle events (pending, halted, past_due, cancelled, completed) atomically.
-- Applies to: public.subscriptions, public.payment_orders, public.plans, public.blocked_users, public.user_addon_credits, public.webhook_events
--
-- Safety & Transactional Guarantees:
--   1. Wrapped in a single atomic transaction (BEGIN ... COMMIT).
--   2. Strict pre-flight checks: validates required tables and columns before defining functions.
--   3. Fail-fast error reporting if any required schema dependency is missing.
-- ============================================================================

BEGIN;

-- Pre-flight safety check: assert required tables and columns exist
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

  -- 2. Validate expected mode parameter
  IF p_expected_mode NOT IN ('test', 'live') THEN
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
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    v_user_id := v_order.user_id;
  ELSE
    -- Fallback: check subscriptions table
    SELECT * INTO v_sub
    FROM public.subscriptions
    WHERE subscription_id = p_razorpay_subscription_id
       OR metadata->>'razorpay_subscription_id' = p_razorpay_subscription_id
       OR metadata->>'subscription_id' = p_razorpay_subscription_id
    LIMIT 1
    FOR UPDATE;

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

  -- 4. Advisory xact lock on user ID to serialize activations and renewals
  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::text));

  -- 5. Lock and load authoritative subscriptions row for this user
  SELECT * INTO v_sub
  FROM public.subscriptions
  WHERE user_id = v_user_id
  FOR UPDATE;
  v_has_sub := FOUND;

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

  -- 7. Mode Isolation Check (Probe 3: NULL mode defaults to live cleanly)
  v_mode := COALESCE(v_order.mode, v_sub.metadata->>'mode', 'live');
  IF v_mode <> p_expected_mode THEN
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

  -- 10. Rebind Protection (Blocker 4 / Probe 4):
  -- An old or abandoned mandate must not overwrite an active mandate.
  -- Reject (ignored) events for cancelled/completed/expired/abandoned old mandates
  -- and late charged events that do not match the current or pending mandate.
  IF v_has_sub AND v_sub.subscription_id IS NOT NULL AND v_sub.subscription_id <> p_razorpay_subscription_id THEN
    v_is_valid_pending := false;
    IF v_order.id IS NOT NULL AND v_order.status = 'created' THEN
      SELECT created_at INTO v_curr_order_time
      FROM public.payment_orders
      WHERE provider_order_id = v_sub.subscription_id
      ORDER BY created_at DESC
      LIMIT 1;

      IF v_curr_order_time IS NULL OR v_order.created_at > v_curr_order_time THEN
        v_is_valid_pending := true;
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

  -- 11. Idempotency on payment_id / cycle
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
      'message', 'Payment ID already processed for this cycle; zero duplicate extension'
    );
  END IF;

  -- 12. Validate plan id and amount against configured plans (Probe 2: paise amount validation)
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
  IF p_amount_paise IS NOT NULL AND p_amount_paise > 0 THEN
    IF p_amount_paise <> v_expected_amount THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'PLAN_AMOUNT_MISMATCH',
        'error', format('Payment amount %s does not match plan price %s for plan %s', p_amount_paise, v_expected_amount, v_plan_code)
      );
    END IF;
  ELSIF v_order.id IS NOT NULL AND v_order.amount_paise IS NOT NULL AND v_order.amount_paise > 0 THEN
    IF v_order.amount_paise <> v_expected_amount THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'PLAN_AMOUNT_MISMATCH',
        'error', format('Order amount %s does not match plan price %s for plan %s', v_order.amount_paise, v_expected_amount, v_plan_code)
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

  -- 13. Compute Period Extension from max(current_period_end, now())
  IF v_has_sub AND v_sub.current_period_end IS NOT NULL AND v_sub.status IN ('active', 'trialing') THEN
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

  -- 14. Build updated metadata including payment_id and durable last_event_time
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
  IF p_event_timestamp IS NOT NULL AND p_event_timestamp > 0 THEN
    v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(p_event_timestamp), true);
  END IF;

  -- 15. Upsert/Update subscriptions row (Binds subscription_id on the first grant)
  IF v_has_sub THEN
    UPDATE public.subscriptions
    SET
      subscription_id = p_razorpay_subscription_id,
      plan_id = v_plan_code,
      provider = 'razorpay',
      status = 'active',
      current_period_start = v_period_start,
      current_period_end = v_new_end,
      cancel_at_period_end = false,
      grace_period_end = NULL,
      metadata = v_new_meta,
      currency = 'INR',
      amount = round(v_expected_amount / 100),
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
      round(v_expected_amount / 100),
      now()
    )
    RETURNING * INTO v_updated_sub;
  END IF;

  -- 16. Mark payment_orders row as paid (Probe 1: COALESCE handles null metadata safely)
  IF v_order.id IS NOT NULL THEN
    UPDATE public.payment_orders
    SET
      status = 'paid',
      paid_at = COALESCE(paid_at, now()),
      metadata = jsonb_set(COALESCE(payment_orders.metadata, '{}'::jsonb), '{payment_id}', to_jsonb(p_payment_id), true)
    WHERE id = v_order.id;
  END IF;

  -- 17. Extend active unexpired add-on credits to match newly extended subscription period
  UPDATE public.user_addon_credits
  SET expires_at = v_new_end
  WHERE user_id = v_user_id
    AND expires_at >= now()
    AND sets_remaining > 0;

  -- 18. Return success payload
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
    'payment_id', p_payment_id
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

  -- 2. Validate expected mode
  IF p_expected_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXPECTED_MODE',
      'error', 'Expected mode must be test or live'
    );
  END IF;

  -- 3. Lock and load authoritative subscriptions row strictly matching the currently bound mandate
  SELECT * INTO v_sub
  FROM public.subscriptions
  WHERE subscription_id = p_razorpay_subscription_id
  FOR UPDATE;

  -- Requirement 5: Old or abandoned mandates must never touch a newer or prepaid entitlement
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'ignored', true,
      'reason', 'UNBOUND_MANDATE',
      'message', format('Mandate %s is not currently bound', p_razorpay_subscription_id)
    );
  END IF;

  -- 4. Advisory xact lock on user ID to serialize transitions
  PERFORM pg_advisory_xact_lock(hashtext(v_sub.user_id::text));

  -- 5. Provider check
  IF v_sub.provider IS NOT NULL AND v_sub.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay subscription events can be handled'
    );
  END IF;

  -- 6. Mode isolation check (Probe 3: NULL mode defaults to live cleanly)
  v_mode := v_sub.metadata->>'mode';
  IF v_mode IS NULL THEN
    SELECT mode INTO v_order_mode
    FROM public.payment_orders
    WHERE provider_order_id = p_razorpay_subscription_id
    ORDER BY created_at DESC
    LIMIT 1;
    v_mode := COALESCE(v_order_mode, 'live');
  END IF;

  IF v_mode <> p_expected_mode THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MODE_MISMATCH',
      'error', format('Subscription mode (%s) does not match expected mode (%s)', v_mode, p_expected_mode)
    );
  END IF;

  -- 7. Server ban check
  IF EXISTS (SELECT 1 FROM public.blocked_users WHERE user_id = v_sub.user_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'USER_BANNED',
      'error', 'Account is suspended'
    );
  END IF;

  -- 8. Lifecycle ordering (Blocker 5 / Probe 5): Durable provider last-event timestamp check
  -- Do NOT compare to local updated_at or created_at!
  IF p_event_timestamp IS NOT NULL AND p_event_timestamp > 0 THEN
    v_last_event_time := NULL;
    IF v_sub.metadata ? 'last_event_time' AND (v_sub.metadata->>'last_event_time') ~ '^[0-9]+(\.[0-9]+)?$' THEN
      v_last_event_time := (v_sub.metadata->>'last_event_time')::numeric;
    END IF;

    IF v_last_event_time IS NOT NULL THEN
      v_incoming_ms := CASE WHEN p_event_timestamp > 1e11 THEN p_event_timestamp ELSE p_event_timestamp * 1000 END;
      v_stored_ms := CASE WHEN v_last_event_time > 1e11 THEN v_last_event_time ELSE v_last_event_time * 1000 END;

      IF v_incoming_ms < v_stored_ms THEN
        RETURN jsonb_build_object(
          'success', true,
          'ignored', true,
          'reason', 'OUT_OF_ORDER_EVENT',
          'message', format('Event timestamp %s is older than stored last event time %s', p_event_timestamp, v_last_event_time),
          'subscription_id', p_razorpay_subscription_id,
          'last_event_time', v_last_event_time,
          'event_timestamp', p_event_timestamp
        );
      END IF;
    END IF;
  END IF;

  -- 9. Atomic DB transition with expected-mandate condition
  v_new_meta := COALESCE(v_sub.metadata, '{}'::jsonb);
  IF p_event_timestamp IS NOT NULL AND p_event_timestamp > 0 THEN
    v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(p_event_timestamp), true);
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
    'last_event_time', p_event_timestamp
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

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.handle_subscription_lifecycle_event(text, text, numeric, text);
--   DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text, text, numeric, numeric);
-- ============================================================================
