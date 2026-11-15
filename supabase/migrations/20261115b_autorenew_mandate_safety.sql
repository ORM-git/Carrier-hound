-- ==============================================================================
-- Migration: 20261115b_autorenew_mandate_safety.sql
-- Status: PENDING APPLICATION
--
-- Apply via psql/Supabase SQL Editor, then record:
--   node scripts/record-migration.cjs 20261115b_autorenew_mandate_safety
--
-- Purpose:
--   Durable mandate safety for auto-renew recurring subscriptions.
--   Enforces at most one active reservation/creation order per user, provider, and mode
--   specifically for recurring mandates, keyed by recurring_kind column.
--   Adds updated_at to payment_orders if missing.
--   Provides transactional JSON metadata merging and durable reconciliation tracking.
--   Prepaid orders (order_*) are completely unaffected and never blocked.
-- ==============================================================================

BEGIN;

-- 1. Read-Only Relation-Scoped Preflight Conflict Check
-- Checks for existing duplicate active recurring mandate rows for the same user, provider, and mode.
-- If any duplicate exists, ABORTS the transaction immediately (RAISE EXCEPTION).
DO $$
DECLARE
  conflict_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment_orders' AND column_name = 'recurring_kind'
  ) THEN
    SELECT count(*)
    INTO conflict_count
    FROM (
      SELECT user_id, provider, mode, count(*)
      FROM public.payment_orders
      WHERE recurring_kind = 'recurring'
        AND status IN ('reserved', 'created', 'unknown')
      GROUP BY user_id, provider, mode
      HAVING count(*) > 1
    ) conflicts;
  ELSE
    SELECT count(*)
    INTO conflict_count
    FROM (
      SELECT user_id, provider, mode, count(*)
      FROM public.payment_orders
      WHERE provider_order_id LIKE 'sub_%'
        AND status IN ('reserved', 'created', 'unknown')
      GROUP BY user_id, provider, mode
      HAVING count(*) > 1
    ) conflicts;
  END IF;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Preflight check failed: % conflict groups found with multiple active recurring mandates for the same user/provider/mode. Aborting migration.', conflict_count;
  END IF;
END $$;

-- 2. Add recurring_kind and updated_at columns to payment_orders
ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS recurring_kind text NOT NULL DEFAULT 'none';

ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill recurring_kind for existing recurring mandate orders
UPDATE public.payment_orders
SET recurring_kind = 'recurring'
WHERE provider_order_id LIKE 'sub_%';

-- Normalize or reject NULL/unknown mode before creating the unique index
UPDATE public.payment_orders
SET mode = 'live'
WHERE mode IS NULL OR mode NOT IN ('test', 'live');

-- Reviewer 7: add a NOT NULL / valid-mode constraint for mode
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'check_payment_orders_mode_valid'
      AND conrelid = 'public.payment_orders'::regclass
  ) THEN
    ALTER TABLE public.payment_orders DROP CONSTRAINT check_payment_orders_mode_valid;
  END IF;
END $$;

ALTER TABLE public.payment_orders
  ADD CONSTRAINT check_payment_orders_mode_valid
  CHECK (mode IN ('test', 'live'));

ALTER TABLE public.payment_orders
  ALTER COLUMN mode SET NOT NULL;

-- 3. Ensure payment_orders.status accepts 'reserved', 'created', 'unknown', 'paid', 'failed', 'cancelled', 'expired'
-- Scoped strictly to the target relation public.payment_orders
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_orders_status_check'
      AND conrelid = 'public.payment_orders'::regclass
  ) THEN
    ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_status_check;
  END IF;
END $$;

ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_status_check
  CHECK (status IN ('reserved', 'created', 'unknown', 'paid', 'failed', 'cancelled', 'expired'));

-- 4. Durable Partial Unique Index Keyed by recurring_kind column
-- Covers active recurring mandate rows ('reserved', 'created', 'unknown') per user, provider, and mode.
-- Completely excludes prepaid orders (recurring_kind = 'none'), never blocking multiple prepaid orders.
DROP INDEX IF EXISTS public.idx_payment_orders_pending_mandate_unique;
DROP INDEX IF EXISTS public.idx_payment_orders_user_pending_sub;

CREATE UNIQUE INDEX idx_payment_orders_pending_mandate_unique
  ON public.payment_orders (user_id, provider, mode)
  WHERE recurring_kind = 'recurring' AND status IN ('reserved', 'created', 'unknown');

-- 5. Accelerated Authoritative Lookup Index
DROP INDEX IF EXISTS public.idx_payment_orders_pending_lookup;

CREATE INDEX idx_payment_orders_pending_lookup
  ON public.payment_orders (user_id, provider, mode, plan_code, status, created_at)
  WHERE recurring_kind = 'recurring' AND status IN ('reserved', 'created', 'unknown');

-- 5b. Subscription Provider Mandate ID Uniqueness Constraint & Customer ID Column Guarantee
-- Guarantees that a provider subscription_id can never be attached to more than one user account.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS customer_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_subscription_id_unique
  ON public.subscriptions (subscription_id)
  WHERE subscription_id IS NOT NULL;

-- 6. Atomic CAS Cancellation Procedure with Strict Ownership & Lock Order
-- Global lock order aligned with billed RPCs: (1) advisory lock on user, (2) subscriptions row lock, (3) order row lock.
-- Matches the current mandate independently; an old pending cancel only touches its own order,
-- and never marks a newer bound subscription as canceled.
CREATE OR REPLACE FUNCTION public.cancel_autorenew_subscription(
  p_user_id uuid,
  p_mandate_id text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '15s'
AS $$
DECLARE
  v_sub_id uuid;
  v_order_id uuid;
  v_sanitized_metadata jsonb := '{}'::jsonb;
  v_updated boolean := false;
BEGIN
  -- 1. Input validation
  IF p_user_id IS NULL OR p_mandate_id IS NULL OR trim(p_mandate_id) = '' THEN
    RETURN false;
  END IF;

  -- 2. Auth / Ownership validation: mandate must not belong to another user
  IF EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE (
      subscription_id = p_mandate_id
      OR metadata->>'provider_subscription_id' = p_mandate_id
    )
    AND user_id <> p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.payment_orders
    WHERE provider_order_id = p_mandate_id
      AND user_id <> p_user_id
  ) THEN
    RAISE EXCEPTION 'Mandate % does not belong to user %', p_mandate_id, p_user_id;
  END IF;

  -- 3. Lock order: (1) Advisory xact lock on user ID first (deadlock prevention across all billing RPCs)
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 4. Lock order: (2) Subscriptions row lock second
  -- Only match if p_mandate_id is the currently bound subscription mandate.
  -- An old pending cancel only touches its own order, never cancelling a newer bound subscription!
  SELECT id INTO v_sub_id
  FROM public.subscriptions
  WHERE user_id = p_user_id
    AND (
      subscription_id = p_mandate_id
      OR metadata->>'provider_subscription_id' = p_mandate_id
    )
  FOR UPDATE;

  -- 5. Lock order: (3) Payment orders row lock third
  SELECT id INTO v_order_id
  FROM public.payment_orders
  WHERE user_id = p_user_id
    AND provider_order_id = p_mandate_id
    AND status IN ('reserved', 'created', 'unknown')
  FOR UPDATE;

  -- 6. Constrain allowed metadata keys (only permitted cancellation fields, never clobbering processed_payments)
  SELECT coalesce(
    jsonb_object_agg(key, value),
    '{}'::jsonb
  )
  INTO v_sanitized_metadata
  FROM jsonb_each(coalesce(p_metadata, '{}'::jsonb))
  WHERE key IN (
    'cancel_at_period_end',
    'canceled_at',
    'canceled_by',
    'provider_mandate_id',
    'reason',
    'cancel_reason',
    'source',
    'scheduled_at'
  );

  -- 7. Perform atomic compare-and-set updates
  IF v_sub_id IS NOT NULL THEN
    UPDATE public.subscriptions
    SET
      cancel_at_period_end = true,
      updated_at = now(),
      metadata = coalesce(metadata, '{}'::jsonb) || v_sanitized_metadata
    WHERE id = v_sub_id;
    v_updated := true;
  END IF;

  IF v_order_id IS NOT NULL THEN
    UPDATE public.payment_orders
    SET
      status = 'cancelled',
      updated_at = now()
    WHERE id = v_order_id;
    v_updated := true;
  END IF;

  RETURN v_updated;
END;
$$;

-- 7. Durable Subscription Reconciliation Table & Function (Reviewer 5)
CREATE TABLE IF NOT EXISTS public.subscription_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'razorpay',
  provider_subscription_id text,
  reservation_order_id text,
  reconciliation_state text NOT NULL CHECK (reconciliation_state IN ('pending', 'resolved', 'failed', 'unknown')),
  failure_reason text,
  recovery_outcome text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.subscription_reconciliations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.record_subscription_reconciliation(
  p_user_id uuid,
  p_provider_subscription_id text,
  p_reservation_order_id text,
  p_reconciliation_state text,
  p_failure_reason text DEFAULT NULL,
  p_recovery_outcome text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.subscription_reconciliations (
    user_id,
    provider,
    provider_subscription_id,
    reservation_order_id,
    reconciliation_state,
    failure_reason,
    recovery_outcome,
    metadata,
    created_at,
    updated_at
  ) VALUES (
    p_user_id,
    'razorpay',
    p_provider_subscription_id,
    p_reservation_order_id,
    p_reconciliation_state,
    p_failure_reason,
    p_recovery_outcome,
    coalesce(p_metadata, '{}'::jsonb),
    now(),
    now()
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 8. Transactional JSON Merge for Subscription Metadata (Reviewer 6)
-- Replaces JS-merged existingSub.metadata write with an atomic jsonb || in SQL
CREATE OR REPLACE FUNCTION public.merge_subscription_metadata(
  p_user_id uuid,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '15s'
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));
  UPDATE public.subscriptions
  SET
    metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    updated_at = now()
  WHERE user_id = p_user_id;
  RETURN FOUND;
END;
$$;

-- 9. Forward Update: fulfil_subscription_renewal consumes provider period bounds from order metadata (Reviewer 7)
-- Reconciles calendar months/quarters with the fixed 7/30/90-day rule (keep exact 7/30/90 days).
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

  -- 5b. Ownership Check: Ensure this mandate is not already attached to another user
  IF EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE (
      subscription_id = p_razorpay_subscription_id
      OR metadata->>'razorpay_subscription_id' = p_razorpay_subscription_id
      OR metadata->>'subscription_id' = p_razorpay_subscription_id
    )
    AND user_id <> v_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.payment_orders
    WHERE provider_order_id = p_razorpay_subscription_id
      AND user_id <> v_user_id
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MANDATE_ATTACHED_TO_ANOTHER_USER',
      'error', format('Mandate %s is attached to another user account', p_razorpay_subscription_id)
    );
  END IF;

  -- 5c. Customer Ownership Check: Ensure customer_id is not already attached to another user
  IF v_order.metadata ? 'provider_customer_id' AND v_order.metadata->>'provider_customer_id' IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.subscriptions
      WHERE customer_id = (v_order.metadata->>'provider_customer_id')
        AND user_id <> v_user_id
    ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'CUSTOMER_OWNERSHIP_MISMATCH',
        'error', 'Mandate customer belongs to another user account'
      );
    END IF;

    IF v_has_sub AND v_sub.customer_id IS NOT NULL AND v_sub.customer_id <> (v_order.metadata->>'provider_customer_id') THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'CUSTOMER_OWNERSHIP_MISMATCH',
        'error', 'Mandate customer mismatch for user account'
      );
    END IF;
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

  -- 9. Check for duplicate payment_id processing (Idempotency Ledger)
  v_processed_payments := COALESCE(v_sub.metadata->'processed_payments', '[]'::jsonb);
  IF v_processed_payments ? p_payment_id THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'is_pro', true,
      'subscription_id', v_sub.id,
      'payment_id', p_payment_id,
      'current_period_end', v_sub.current_period_end
    );
  END IF;

  -- 10. Old-Mandate Rebind Guard (Fail CLOSED)
  IF v_has_sub AND v_sub.subscription_id IS NOT NULL AND v_sub.subscription_id <> p_razorpay_subscription_id THEN
    v_is_valid_pending := false;
    IF v_sub.metadata->>'pending_subscription_id' = p_razorpay_subscription_id THEN
      v_is_valid_pending := true;
    ELSIF v_order.id IS NOT NULL AND v_order.created_at IS NOT NULL THEN
      SELECT created_at INTO v_curr_order_time
      FROM public.payment_orders
      WHERE provider_order_id = v_sub.subscription_id
        AND user_id = v_user_id
      ORDER BY created_at DESC
      LIMIT 1;

      IF v_curr_order_time IS NOT NULL AND v_order.created_at > v_curr_order_time THEN
        v_is_valid_pending := true;
      END IF;
    END IF;

    IF NOT v_is_valid_pending THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'OLD_MANDATE_IGNORED',
        'error', format('Incoming mandate %s is not the currently bound (%s) or valid pending mandate; ignored', p_razorpay_subscription_id, v_sub.subscription_id)
      );
    END IF;
  END IF;

  -- 11. Normalize Watermark and Event Timestamps to Milliseconds
  v_incoming_ms := NULL;
  IF p_event_timestamp IS NOT NULL THEN
    IF p_event_timestamp < 10000000000 THEN
      v_incoming_ms := p_event_timestamp * 1000;
    ELSE
      v_incoming_ms := p_event_timestamp;
    END IF;
  END IF;

  v_stored_ms := NULL;
  IF v_has_sub AND (v_sub.metadata ? 'last_event_time') THEN
    v_last_event_time := (v_sub.metadata->>'last_event_time')::numeric;
    IF v_last_event_time IS NOT NULL THEN
      IF v_last_event_time < 10000000000 THEN
        v_stored_ms := v_last_event_time * 1000;
      ELSE
        v_stored_ms := v_last_event_time;
      END IF;
    END IF;
  END IF;

  IF v_stored_ms IS NOT NULL THEN
    IF v_incoming_ms IS NULL THEN
      v_is_older_payment := true;
    ELSIF v_incoming_ms <= v_stored_ms THEN
      -- Item 4: an equal-timestamp (or older) paid event must NOT reset cancel_at_period_end to false
      v_is_older_payment := true;
    END IF;
  END IF;

  -- 12. Resolve Plan Code
  v_plan_code := COALESCE(v_order.plan_code, v_sub.plan_id);
  IF v_plan_code IS NULL THEN
    v_plan_code := 'monthly';
  END IF;

  SELECT * INTO v_plan_row
  FROM public.plans
  WHERE code = v_plan_code;

  IF NOT FOUND THEN
    v_plan_code := 'monthly';
    SELECT * INTO v_plan_row
    FROM public.plans
    WHERE code = 'monthly';
  END IF;

  v_expected_amount := v_plan_row.price_paise;

  -- 13. Live cycle amount check
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

  -- Exact duration from configured plans table: strict 7, 30, or 90 days rule
  v_duration := v_plan_row.duration_days;
  IF v_duration NOT IN (7, 30, 90) THEN
    IF v_plan_code = 'weekly' THEN v_duration := 7;
    ELSIF v_plan_code = 'quarterly' THEN v_duration := 90;
    ELSE v_duration := 30;
    END IF;
  END IF;

  -- 14. Compute Period Extension from max(current_period_end, now())
  -- Preserve owed prepaid time across active, in_grace_period, past_due, trialing, etc.
  IF v_has_sub AND v_sub.current_period_end IS NOT NULL THEN
    v_base_time := greatest(v_sub.current_period_end, now());
  ELSE
    v_base_time := now();
  END IF;

  -- Exact 7/30/90 days extension
  v_new_end := v_base_time + (v_duration * interval '1 day');
  IF v_has_sub AND v_sub.current_period_end IS NOT NULL AND v_new_end < v_sub.current_period_end THEN
    v_new_end := v_sub.current_period_end;
  END IF;

  -- Entitlement access boundary reconciliation (Reviewer 8):
  -- Calendar months vary (February has 28/29 days, April has 30, March has 31).
  -- Our billing architecture enforces a deterministic 7/30/90-day floor rule:
  -- users paying for a monthly cycle are guaranteed at least 30 full days of paid access
  -- regardless of shorter calendar months (e.g. Feb 28 days -> user receives 30 days).
  -- If the provider's current_end exceeds this 30-day floor (e.g. 31-day calendar month or leap period),
  -- we honor the later provider boundary so the customer always gets the maximum access boundary.
  IF (v_order.metadata ? 'provider_current_end') THEN
    IF (v_order.metadata->>'provider_current_end')::timestamptz > v_new_end THEN
      v_new_end := (v_order.metadata->>'provider_current_end')::timestamptz;
    END IF;
  ELSIF (v_sub.metadata ? 'provider_current_end') THEN
    IF (v_sub.metadata->>'provider_current_end')::timestamptz > v_new_end THEN
      v_new_end := (v_sub.metadata->>'provider_current_end')::timestamptz;
    END IF;
  END IF;

  -- Consume provider period bounds from order metadata (Reviewer 7)
  v_period_start := COALESCE(
    (v_order.metadata->>'provider_current_start')::timestamptz,
    (v_sub.metadata->>'provider_current_start')::timestamptz,
    v_sub.current_period_start,
    now()
  );

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

  -- Consume and persist provider period bounds from order metadata
  IF v_order.metadata ? 'provider_current_start' THEN
    v_new_meta := jsonb_set(v_new_meta, '{provider_current_start}', v_order.metadata->'provider_current_start', true);
  END IF;
  IF v_order.metadata ? 'provider_current_end' THEN
    v_new_meta := jsonb_set(v_new_meta, '{provider_current_end}', v_order.metadata->'provider_current_end', true);
  END IF;
  IF v_order.metadata ? 'provider_charge_at' THEN
    v_new_meta := jsonb_set(v_new_meta, '{provider_charge_at}', v_order.metadata->'provider_charge_at', true);
  END IF;

  -- Monotonic watermark
  IF v_stored_ms IS NOT NULL THEN
    IF v_incoming_ms IS NOT NULL THEN
      v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(greatest(v_stored_ms, v_incoming_ms)), true);
    ELSE
      v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(v_stored_ms), true);
    END IF;
  ELSIF v_incoming_ms IS NOT NULL THEN
    v_new_meta := jsonb_set(v_new_meta, '{last_event_time}', to_jsonb(v_incoming_ms), true);
  END IF;

  -- 16. Upsert/Update subscriptions row
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
      customer_id = COALESCE(v_order.metadata->>'provider_customer_id', customer_id),
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
      customer_id,
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
      v_order.metadata->>'provider_customer_id',
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
      updated_at = now(),
      metadata = jsonb_set(COALESCE(payment_orders.metadata, '{}'::jsonb), '{payment_id}', to_jsonb(p_payment_id), true)
    WHERE id = v_order.id;
  END IF;

  -- 18. Extend active unexpired add-on credits
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

-- 10. Forward Update: handle_subscription_lifecycle_event with State-Machine Guard (Reviewer Blockers)
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

  -- State-machine guard: active subscriptions cannot downgrade to pending / in_grace_period
  IF v_sub.status = 'active' AND p_event_type = 'subscription.pending' THEN
    RETURN jsonb_build_object(
      'success', true,
      'ignored', true,
      'reason', 'ACTIVE_CANNOT_DOWNGRADE_TO_PENDING',
      'message', 'Subscription is currently active; cannot downgrade to pending',
      'subscription_id', p_razorpay_subscription_id,
      'status', v_sub.status
    );
  END IF;

  -- 9. Lifecycle ordering: Durable provider last-event timestamp check
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
      WHEN p_event_type = 'subscription.pending' AND v_sub.status <> 'active' THEN 'in_grace_period'
      WHEN p_event_type IN ('subscription.halted', 'subscription.past_due') THEN 'past_due'
      ELSE status
    END,
    grace_period_end = CASE
      WHEN p_event_type = 'subscription.pending' AND v_sub.status <> 'active' THEN now() + interval '7 days'
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

-- 11. ACL Hardening: Only service_role may execute functions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
EXCEPTION
  WHEN duplicate_object OR insufficient_privilege THEN
    NULL;
END $$;

REVOKE ALL ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) TO service_role;
ALTER FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) SET search_path = public;
ALTER FUNCTION public.handle_subscription_lifecycle_event(text, text, numeric, text) SET statement_timeout = '15s';

REVOKE ALL ON FUNCTION public.cancel_autorenew_subscription(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_autorenew_subscription(uuid, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.record_subscription_reconciliation(uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_subscription_reconciliation(uuid, text, text, text, text, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.merge_subscription_metadata(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_subscription_metadata(uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fulfil_subscription_renewal(text, text, text, numeric, numeric) TO service_role;

REVOKE ALL ON TABLE public.subscription_reconciliations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.subscription_reconciliations TO service_role;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.payment_orders DROP CONSTRAINT IF EXISTS check_payment_orders_mode_valid;
--   ALTER TABLE public.payment_orders ALTER COLUMN mode DROP NOT NULL;
--   DROP FUNCTION IF EXISTS public.cancel_autorenew_subscription(uuid, text, jsonb);
--   DROP FUNCTION IF EXISTS public.record_subscription_reconciliation(uuid, text, text, text, text, text, jsonb);
--   DROP FUNCTION IF EXISTS public.merge_subscription_metadata(uuid, jsonb);
--   DROP TABLE IF EXISTS public.subscription_reconciliations;
--   DROP INDEX IF EXISTS public.idx_payment_orders_pending_mandate_unique;
--   DROP INDEX IF EXISTS public.idx_payment_orders_pending_lookup;
--   ALTER TABLE public.payment_orders DROP COLUMN IF EXISTS recurring_kind;
-- ============================================================================
