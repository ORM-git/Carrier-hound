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

-- 2. Add recurring_kind column to payment_orders
ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS recurring_kind text NOT NULL DEFAULT 'none';

-- Backfill recurring_kind for existing recurring mandate orders
UPDATE public.payment_orders
SET recurring_kind = 'recurring'
WHERE provider_order_id LIKE 'sub_%';

-- 3. Ensure payment_orders.status accepts 'reserved', 'created', 'unknown', 'paid', 'failed', 'cancelled', 'expired'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_orders_status_check'
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

-- 6. Atomic CAS Cancellation Procedure with Strict Ownership & Lock Order
-- Global lock order aligned with billed RPCs: (1) advisory lock on user, (2) subscriptions row lock, (3) order row lock.
-- Constrains metadata keys to prevent ledger or attribute overwrite.
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
      OR metadata->>'pending_subscription_id' = p_mandate_id
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
  SELECT id INTO v_sub_id
  FROM public.subscriptions
  WHERE user_id = p_user_id
    AND (
      subscription_id = p_mandate_id
      OR metadata->>'provider_subscription_id' = p_mandate_id
      OR metadata->>'pending_subscription_id' = p_mandate_id
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

-- 7. ACL Hardening: Only service_role may execute cancel_autorenew_subscription
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

REVOKE ALL ON FUNCTION public.cancel_autorenew_subscription(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_autorenew_subscription(uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_autorenew_subscription(uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_autorenew_subscription(uuid, text, jsonb) TO service_role;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.cancel_autorenew_subscription(uuid, text, jsonb);
--   DROP INDEX IF EXISTS public.idx_payment_orders_pending_mandate_unique;
--   DROP INDEX IF EXISTS public.idx_payment_orders_pending_lookup;
--   ALTER TABLE public.payment_orders DROP COLUMN IF EXISTS recurring_kind;
-- ============================================================================
