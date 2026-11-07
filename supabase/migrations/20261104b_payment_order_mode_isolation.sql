-- ==============================================================================
-- Migration: 20261104b_payment_order_mode_isolation.sql
-- Fix Audit F01: Razorpay test-mode payments must never grant real Pro access or add-on credits.
--
-- Core Security Controls:
-- 1. Adds mode column ('test' | 'live') to public.payment_orders with CHECK constraint.
-- 2. Updates fulfil_payment_order to accept p_expected_mode (default 'live').
-- 3. Fail-Closed Mode Check: Rejects with MODE_MISMATCH if v_order.mode <> p_expected_mode.
-- 4. In test mode: Marks payment_orders status = 'paid', returns is_pro = false,
--    and strictly NEVER touches public.subscriptions or public.user_addon_credits.
-- 5. In live mode: Atomically grants subscription or add-on credits before marking paid.
-- ==============================================================================

-- 1. Add mode column to payment_orders table
ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live'
  CHECK (mode IN ('test', 'live'));

CREATE INDEX IF NOT EXISTS idx_payment_orders_mode
  ON public.payment_orders(mode);

-- Backfill existing orders: test IDs or fake IDs to 'test'
UPDATE public.payment_orders
SET mode = 'test'
WHERE provider_order_id LIKE 'order_test_%'
   OR provider_order_id LIKE 'fake_%'
   OR provider_order_id LIKE 'test_%';

-- 2. Replace fulfil_payment_order with mode isolation support
DROP FUNCTION IF EXISTS public.fulfil_payment_order(text, uuid);

CREATE OR REPLACE FUNCTION public.fulfil_payment_order(
  p_provider_order_id text,
  p_user_id uuid,
  p_expected_mode text default 'live'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order record;
  v_existing_sub record;
  v_existing_credit record;
  v_duration int := 30;
  v_sets int := 10;
  v_validity int := 60;
  v_sub record;
  v_credit record;
  v_base_time timestamptz;
  v_new_end timestamptz;
  v_period_start timestamptz;
BEGIN
  -- Validate expected mode parameter
  IF p_expected_mode NOT IN ('test', 'live') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXPECTED_MODE',
      'error', 'Expected mode must be either test or live'
    );
  END IF;

  -- 1. Lock the order row for update
  SELECT * INTO v_order
  FROM public.payment_orders
  WHERE provider_order_id = p_provider_order_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF v_order IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_FOUND',
      'error', 'Payment order not found for user'
    );
  END IF;

  -- 2. Provider verification
  IF v_order.provider <> 'razorpay' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_PROVIDER',
      'error', 'Only razorpay provider orders can be fulfilled via this function'
    );
  END IF;

  -- 3. Fail-closed Mode Check: Order mode must match expected fulfillment mode
  IF v_order.mode <> p_expected_mode THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MODE_MISMATCH',
      'error', format('Order mode (%s) does not match fulfillment mode (%s)', v_order.mode, p_expected_mode)
    );
  END IF;

  -- 4. Verify state is valid (created or paid-retry)
  IF v_order.status NOT IN ('created', 'paid') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ORDER_INVALID_STATE',
      'error', 'Payment order is not in created or paid state'
    );
  END IF;

  -- 5. TEST MODE ISOLATION: Zero real entitlements granted
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

  -- 6. LIVE MODE: Idempotency check for already fulfilled live orders
  IF v_order.status = 'paid' THEN
    IF v_order.plan_code IS NOT NULL THEN
      SELECT * INTO v_existing_sub
      FROM public.subscriptions
      WHERE user_id = p_user_id;

      IF v_existing_sub IS NOT NULL AND (
        (v_existing_sub.metadata->>'payment_order_id' = v_order.id::text) OR
        (v_existing_sub.metadata->>'provider_order_id' = p_provider_order_id)
      ) THEN
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
      END IF;
      -- If subscription grant missing, proceed below to re-attempt grant!
    ELSIF v_order.addon_code IS NOT NULL THEN
      SELECT * INTO v_existing_credit
      FROM public.user_addon_credits
      WHERE order_id = v_order.id;

      IF v_existing_credit IS NOT NULL THEN
        RETURN jsonb_build_object(
          'success', true,
          'already_paid', true,
          'is_pro', false,
          'type', 'addon',
          'addon_code', v_order.addon_code,
          'order_id', v_order.id,
          'credit_id', v_existing_credit.id,
          'message', 'Order already fulfilled and marked as paid'
        );
      END IF;
      -- If add-on grant missing, proceed below to re-attempt grant!
    END IF;
  END IF;

  -- 7. Live Fulfillment Path A: Subscription Plan purchase / renewal / upgrade
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

    -- Look up existing subscription to calculate extension
    SELECT * INTO v_existing_sub
    FROM public.subscriptions
    WHERE user_id = p_user_id;

    IF v_existing_sub IS NOT NULL AND (v_existing_sub.status IN ('active', 'trialing')) AND v_existing_sub.current_period_end IS NOT NULL THEN
      -- User has an active plan: new period end = max(current_period_end, now) + duration
      v_base_time := greatest(v_existing_sub.current_period_end, now());
      v_new_end := v_base_time + (v_duration * interval '1 day');
      -- Never shorten existing period
      IF v_new_end < v_existing_sub.current_period_end THEN
        v_new_end := v_existing_sub.current_period_end;
      END IF;
      v_period_start := coalesce(v_existing_sub.current_period_start, now());
    ELSE
      -- Expired or no previous subscription: period end = now + duration
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
      v_order.plan_code,
      'razorpay',
      v_order.currency,
      v_order.amount_paise,
      'active',
      v_period_start,
      v_new_end,
      false,
      jsonb_build_object(
        'provider_order_id', p_provider_order_id,
        'payment_order_id', v_order.id,
        'mode', 'live',
        'verified_at', now()
      ),
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      plan_id = excluded.plan_id,
      status = 'active',
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = false,
      metadata = excluded.metadata,
      updated_at = now()
    RETURNING * INTO v_sub;

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

  -- 8. Live Fulfillment Path B: Add-on pack purchase
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

    IF v_validity IS NULL OR v_validity <= 0 THEN
      v_validity := 60;
    END IF;

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
      now() + (v_validity * interval '1 day'),
      v_order.id,
      now()
    )
    ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_credit;

    IF v_credit IS NULL THEN
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
GRANT EXECUTE ON FUNCTION public.fulfil_payment_order(text, uuid, text) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_payment_orders_mode;
--   ALTER TABLE public.payment_orders DROP COLUMN IF EXISTS mode;
--   NOTE: replaces function public.fulfil_payment_order (first defined in 20261103c_fulfil_payment_fn.sql); restore the prior definition from that file if this change must be undone.
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================
