-- Migration: 20261115a_autorenew.sql
-- Auto-renewal persistence: SECURITY DEFINER RPC to fulfil subscription renewals atomically.
-- Applies to: public.subscriptions, public.user_addon_credits
--
-- Verification queries (run via service_role):
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'fulfil_subscription_renewal';
--   SELECT public.fulfil_subscription_renewal('sub_test_nonexistent', 'pay_test_nonexistent');
--
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fulfil_subscription_renewal(
  p_razorpay_subscription_id text,
  p_payment_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
DECLARE
  v_sub record;
  v_order record;
  v_updated_sub record;
  v_duration int := 30;
  v_plan_duration int;
  v_base_time timestamptz;
  v_new_end timestamptz;
  v_processed_payments jsonb;
  v_new_meta jsonb;
BEGIN
  -- 0. Validate subscription ID input
  IF p_razorpay_subscription_id IS NULL OR trim(p_razorpay_subscription_id) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_SUBSCRIPTION_ID',
      'error', 'Subscription ID is required'
    );
  END IF;

  p_razorpay_subscription_id := trim(p_razorpay_subscription_id);
  IF p_payment_id IS NOT NULL THEN
    p_payment_id := trim(p_payment_id);
  END IF;

  -- 1. Find the target row: check subscriptions table first
  SELECT * INTO v_sub
  FROM public.subscriptions
  WHERE subscription_id = p_razorpay_subscription_id
     OR metadata->>'razorpay_subscription_id' = p_razorpay_subscription_id
     OR metadata->>'subscription_id' = p_razorpay_subscription_id
  FOR UPDATE;

  -- 2. If not found in subscriptions, check payment_orders
  IF NOT FOUND THEN
    SELECT * INTO v_order
    FROM public.payment_orders
    WHERE provider_order_id = p_razorpay_subscription_id
    ORDER BY created_at DESC
    LIMIT 1;

    IF FOUND THEN
      SELECT * INTO v_sub
      FROM public.subscriptions
      WHERE user_id = v_order.user_id
      FOR UPDATE;
    END IF;
  END IF;

  -- 3. If still not found, return SUBSCRIPTION_NOT_FOUND error
  IF v_sub.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'SUBSCRIPTION_NOT_FOUND',
      'error', format('Subscription not found for identifier: %s', p_razorpay_subscription_id)
    );
  END IF;

  -- 4. Advisory xact lock on user ID to prevent concurrent mutations
  PERFORM pg_advisory_xact_lock(hashtext(v_sub.user_id::text));

  -- 5. Idempotency check on p_payment_id
  v_processed_payments := COALESCE(v_sub.metadata->'processed_renewal_payments', '[]'::jsonb);
  IF p_payment_id IS NOT NULL AND p_payment_id <> '' THEN
    IF v_processed_payments ? p_payment_id OR v_sub.metadata->>'last_renewal_payment_id' = p_payment_id THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_processed', true,
        'subscription_id', v_sub.id,
        'user_id', v_sub.user_id,
        'plan_id', v_sub.plan_id,
        'current_period_end', v_sub.current_period_end
      );
    END IF;
  END IF;

  -- 6. Resolve plan duration_days (weekly 7 / monthly 30 / quarterly 90, from PLAN_DEFINITIONS)
  SELECT duration_days INTO v_plan_duration
  FROM public.plans
  WHERE code = v_sub.plan_id;

  IF FOUND AND v_plan_duration IS NOT NULL AND v_plan_duration > 0 THEN
    v_duration := v_plan_duration;
  ELSIF v_sub.plan_id ILIKE '%week%' THEN
    v_duration := 7;
  ELSIF v_sub.plan_id ILIKE '%quarter%' THEN
    v_duration := 90;
  ELSE
    v_duration := 30;
  END IF;

  -- 7. Compute new current_period_end from greatest(current_period_end, now()) + duration
  v_base_time := greatest(COALESCE(v_sub.current_period_end, now()), now());
  v_new_end := v_base_time + (v_duration * interval '1 day');

  -- 8. Build updated metadata including payment_id tracking
  v_new_meta := COALESCE(v_sub.metadata, '{}'::jsonb);
  IF p_payment_id IS NOT NULL AND p_payment_id <> '' THEN
    v_new_meta := jsonb_set(
      v_new_meta,
      '{processed_renewal_payments}',
      v_processed_payments || jsonb_build_array(p_payment_id),
      true
    );
    v_new_meta := jsonb_set(
      v_new_meta,
      '{last_renewal_payment_id}',
      to_jsonb(p_payment_id),
      true
    );
  END IF;
  v_new_meta := jsonb_set(
    v_new_meta,
    '{last_renewal_at}',
    to_jsonb(now()),
    true
  );
  IF v_sub.subscription_id IS NULL OR v_sub.subscription_id = '' THEN
    v_new_meta := jsonb_set(
      v_new_meta,
      '{razorpay_subscription_id}',
      to_jsonb(p_razorpay_subscription_id),
      true
    );
  END IF;

  -- 9. Update subscriptions row
  UPDATE public.subscriptions
  SET
    current_period_end = v_new_end,
    status = 'active',
    cancel_at_period_end = false,
    grace_period_end = NULL,
    metadata = v_new_meta,
    subscription_id = COALESCE(subscriptions.subscription_id, p_razorpay_subscription_id),
    updated_at = now()
  WHERE id = v_sub.id
  RETURNING * INTO v_updated_sub;

  -- 10. Extend active unexpired add-on credits to match newly extended subscription period
  UPDATE public.user_addon_credits
  SET expires_at = v_new_end
  WHERE user_id = v_sub.user_id
    AND expires_at >= now()
    AND sets_remaining > 0;

  -- 11. Return success payload
  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'subscription_id', v_updated_sub.id,
    'user_id', v_updated_sub.user_id,
    'plan_id', v_updated_sub.plan_id,
    'duration_days', v_duration,
    'current_period_end', v_updated_sub.current_period_end
  );
END;
$$;

-- Strict ACL: Revoke from public/anon/authenticated and grant only to service_role
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text) FROM public;
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fulfil_subscription_renewal(text, text) TO service_role;
ALTER FUNCTION public.fulfil_subscription_renewal(text, text) SET search_path = public;
ALTER FUNCTION public.fulfil_subscription_renewal(text, text) SET statement_timeout = '15s';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.fulfil_subscription_renewal(text, text);
-- ============================================================================
