-- ============================================================================
-- Migration: 20261120c_payment_orders_one_pending_mandate.sql
-- Status: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261120c_payment_orders_one_pending_mandate.sql
--
-- One pending recurring checkout per user, enforced by the database across all server instances.
-- A partial unique index allows at most one public.payment_orders row per user with
-- status = 'created' and a Razorpay subscription id (provider_order_id starting 'sub_').
-- One-time orders (order_...), paid, failed and expired rows are not affected.
-- The subscription route treats a 23505 on this index as "another plan's checkout is pending" (409)
-- and only returns the existing mandate when plan, mode and provider all match.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Pre-flight: required columns exist, and no user already has more than one pending sub_ order
DO $$
DECLARE
  missing_col text;
  dup_users int;
BEGIN
  FOR missing_col IN
    SELECT col FROM (VALUES ('user_id'), ('status'), ('provider_order_id')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_orders' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Precondition failed: column public.payment_orders.% does not exist', missing_col;
  END LOOP;

  SELECT count(*) INTO dup_users
  FROM (
    SELECT user_id
    FROM public.payment_orders
    WHERE status = 'created' AND left(provider_order_id, 4) = 'sub_'
    GROUP BY user_id
    HAVING count(*) > 1
  ) d;

  IF dup_users > 0 THEN
    RAISE EXCEPTION 'Precondition failed: % user(s) have more than one pending sub_ order; expire the older ones first', dup_users;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_one_pending_mandate_per_user
  ON public.payment_orders (user_id)
  WHERE status = 'created' AND left(provider_order_id, 4) = 'sub_';

COMMIT;

-- Verify (expect one row, indisunique = true):
--   SELECT indexrelid::regclass, indisunique, pg_get_indexdef(indexrelid)
--   FROM pg_index WHERE indexrelid = 'public.payment_orders_one_pending_mandate_per_user'::regclass;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.payment_orders_one_pending_mandate_per_user;
-- ============================================================================
