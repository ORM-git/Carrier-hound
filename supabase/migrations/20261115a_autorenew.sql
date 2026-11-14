-- ============================================================================
-- Migration: 20261115a_autorenew.sql
-- Status: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261115a_autorenew.sql
--
-- Auto-renewal persistence: SECURITY DEFINER RPC to fulfil subscription paid cycles (activated + charged) atomically.
-- Applies to: public.subscriptions, public.payment_orders, public.user_addon_credits
--
-- Verification queries (run via service_role):
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'fulfil_subscription_renewal';
--   SELECT public.fulfil_subscription_renewal('sub_test_nonexistent', 'pay_test_nonexistent');
--
-- ============================================================================

DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text);
DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text, text, numeric);

CREATE OR REPLACE FUNCTION public.fulfil_subscription_renewal(
  p_razorpay_subscription_id text,
  p_payment_id text,
  p_expected_mode text DEFAULT 'live',
  p_amount_paise numeric DEFAULT NULL
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
  IF v_order.id IS NOT NULL AND v_order.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay subscription orders can be fulfilled'
    );
  END IF;

  -- 7. Mode Isolation Check
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

  -- 10. Idempotency on payment_id / cycle (Requirement 3 & 4)
  -- The first grant binds the subscription and records initial_payment_id.
  -- Subsequent events with the same payment_id (e.g. subscription.activated + subscription.charged)
  -- are acknowledged as already processed with ZERO additional extension.
  v_processed_payments := COALESCE(v_sub.metadata->'processed_payments', '[]'::jsonb);
  IF (v_has_sub AND (
        v_processed_payments ? p_payment_id OR
        v_sub.metadata->>'initial_payment_id' = p_payment_id OR
        v_sub.metadata->>'last_payment_id' = p_payment_id OR
        v_sub.metadata->>'last_renewal_payment_id' = p_payment_id
      ))
     OR (v_order.id IS NOT NULL AND v_order.status = 'paid' AND v_order.metadata->>'payment_id' = p_payment_id)
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

  -- 11. Validate plan id and amount against configured plans (Requirement 6)
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
  ELSIF v_order.amount_paise IS NOT NULL AND v_order.amount_paise > 0 THEN
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

  -- 12. Compute Period Extension from max(current_period_end, now())
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

  -- 13. Build updated metadata including payment_id and mandate tracking
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

  -- 14. Upsert/Update subscriptions row (Requirement 3: Binds subscription_id on the first grant)
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

  -- 15. Mark payment_orders row as paid
  IF v_order.id IS NOT NULL THEN
    UPDATE public.payment_orders
    SET
      status = 'paid',
      paid_at = COALESCE(paid_at, now()),
      metadata = jsonb_set(COALESCE(payment_orders.metadata, '{}'::jsonb), '{payment_id}', to_jsonb(p_payment_id), true)
    WHERE id = v_order.id;
  END IF;

  -- 16. Extend active unexpired add-on credits to match newly extended subscription period
  UPDATE public.user_addon_credits
  SET expires_at = v_new_end
  WHERE user_id = v_user_id
    AND expires_at >= now()
    AND sets_remaining > 0;

  -- 17. Return success payload
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

-- Strict ACL: Revoke from public/anon/authenticated and grant only to service_role
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric) FROM public;
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric) TO service_role;
ALTER FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric) SET search_path = public;
ALTER FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric) SET statement_timeout = '15s';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text, text, numeric);
-- ============================================================================
