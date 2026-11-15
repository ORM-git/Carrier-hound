-- ==============================================================================
-- Migration: 20261115b_autorenew_mandate_safety.sql
-- Status: PENDING APPLICATION
--
-- Purpose:
--   Durable mandate safety for auto-renew recurring subscriptions.
--   Enforces at most one active reservation/creation order per user and mode
--   specifically for recurring mandates (provider_order_id LIKE 'sub_pending_%').
--   Prepaid orders (order_*) are completely unaffected and never blocked.
-- ==============================================================================

-- 1. Read-Only Preflight Conflict Query (Requirement 7)
-- Lists any conflicting recurring mandate reservation rows without deleting any data.
DO $$
DECLARE
  conflict_count integer;
BEGIN
  SELECT count(*)
  INTO conflict_count
  FROM (
    SELECT user_id, mode, count(*)
    FROM public.payment_orders
    WHERE provider_order_id LIKE 'sub_pending_%'
      AND status IN ('reserved', 'created')
    GROUP BY user_id, mode
    HAVING count(*) > 1
  ) conflicts;

  IF conflict_count > 0 THEN
    RAISE NOTICE 'Preflight check found % user/mode conflict groups for pending auto-renew mandates', conflict_count;
  ELSE
    RAISE NOTICE 'Preflight check passed: zero conflicts for pending auto-renew mandates';
  END IF;
END $$;

-- 2. Ensure payment_orders.status accepts 'reserved', 'created', 'paid', 'failed', 'cancelled', 'expired'
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
  CHECK (status IN ('reserved', 'created', 'paid', 'failed', 'cancelled', 'expired'));

-- 3. Partial Unique Index (Requirement 7)
-- Covers ONLY recurring-mandate reservation rows (provider_order_id LIKE 'sub_pending_%')
-- per user and per mode for active reservation/creation attempts ('reserved', 'created').
-- This NEVER blocks prepaid orders (prefix 'order_') and never fails migration on existing prepaid orders.
DROP INDEX IF EXISTS public.idx_payment_orders_user_pending_sub;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_pending_mandate_unique
  ON public.payment_orders (user_id, mode)
  WHERE provider_order_id LIKE 'sub_pending_%' AND status IN ('reserved', 'created');

-- 4. Accelerated Authoritative Lookup Index (Requirement 5)
DROP INDEX IF EXISTS public.idx_payment_orders_pending_lookup;

CREATE INDEX IF NOT EXISTS idx_payment_orders_pending_lookup
  ON public.payment_orders (user_id, provider, mode, plan_code, status, created_at)
  WHERE status IN ('reserved', 'created');

-- 5. Atomic CAS Cancellation Procedure (Requirement 4)
-- Compare-and-set DB update on the same mandate id with atomic JSONB merge.
-- Ensures concurrent renewal webhooks or metadata writes are never clobbered.
CREATE OR REPLACE FUNCTION public.cancel_autorenew_subscription(
  p_user_id uuid,
  p_mandate_id text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated boolean := false;
BEGIN
  -- Atomic JSONB merge and cancel flag on subscriptions matching mandate ID
  UPDATE public.subscriptions
  SET
    cancel_at_period_end = true,
    updated_at = now(),
    metadata = coalesce(metadata, '{}'::jsonb) || p_metadata
  WHERE user_id = p_user_id
    AND (
      subscription_id = p_mandate_id
      OR metadata->>'provider_subscription_id' = p_mandate_id
      OR metadata->>'pending_subscription_id' = p_mandate_id
    );

  IF FOUND THEN
    v_updated := true;
  END IF;

  -- Also cancel matching payment_orders for this mandate
  UPDATE public.payment_orders
  SET status = 'cancelled'
  WHERE user_id = p_user_id
    AND provider_order_id = p_mandate_id
    AND status IN ('reserved', 'created');

  RETURN v_updated;
END;
$$;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.cancel_autorenew_subscription(uuid, text, jsonb);
--   DROP INDEX IF EXISTS public.idx_payment_orders_pending_mandate_unique;
--   DROP INDEX IF EXISTS public.idx_payment_orders_pending_lookup;
-- ============================================================================
