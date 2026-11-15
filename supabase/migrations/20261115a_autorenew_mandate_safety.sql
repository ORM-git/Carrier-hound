-- ==============================================================================
-- Migration: 20261115a_autorenew_mandate_safety.sql
-- Status: PENDING APPLICATION
--
-- Purpose:
--   Durable mandate safety for auto-renew subscriptions.
--   Enforces that at most one pending subscription order can exist per user
--   across any plan in payment_orders table.
-- ==============================================================================

-- 1. Partial unique index ensuring at most one pending subscription order per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_user_pending_sub
  ON public.payment_orders (user_id)
  WHERE status = 'created' AND provider = 'razorpay' AND plan_code IS NOT NULL;

-- 2. Index to accelerate authoritative pending subscription lookup by user + mode + plan
CREATE INDEX IF NOT EXISTS idx_payment_orders_pending_lookup
  ON public.payment_orders (user_id, provider, mode, plan_code, status, created_at)
  WHERE status = 'created';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_payment_orders_user_pending_sub;
--   DROP INDEX IF EXISTS public.idx_payment_orders_pending_lookup;
-- ============================================================================
