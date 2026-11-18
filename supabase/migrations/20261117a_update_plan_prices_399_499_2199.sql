-- Migration: 20261117a_update_plan_prices_399_499_2199.sql
-- Description: Update public.plans table to server-authoritative prepaid price points:
--   1. weekly: Rs 399 (39900 paise), 7 days access
--   2. monthly: Rs 499 (49900 paise), 30 days access
--   3. quarterly: Rs 2,199 (219900 paise), 90 days access

BEGIN;

SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '5s';

-- Preflight: verify that all three required plan rows (weekly, monthly, quarterly) exist before applying updates
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.plans
  WHERE code IN ('weekly', 'monthly', 'quarterly');

  IF v_count < 3 THEN
    RAISE EXCEPTION 'Preflight failed: public.plans must contain weekly, monthly, and quarterly rows before price update (found %)', v_count;
  END IF;
END $$;

UPDATE public.plans SET price_paise = 39900, duration_days = 7 WHERE code = 'weekly';
UPDATE public.plans SET price_paise = 49900, duration_days = 30 WHERE code = 'monthly';
UPDATE public.plans SET price_paise = 219900, duration_days = 90 WHERE code = 'quarterly';

COMMIT;

-- Post-apply verification query:
-- SELECT code, name, price_paise, duration_days FROM public.plans WHERE code IN ('weekly', 'monthly', 'quarterly') ORDER BY duration_days;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
-- NOTE: Manual restore instructions to re-apply previous price points (69200, 149900, 399900 paise):
--   BEGIN;
--   SET LOCAL statement_timeout = '10s';
--   SET LOCAL lock_timeout = '5s';
--   UPDATE public.plans SET price_paise = 69200, duration_days = 7 WHERE code = 'weekly';
--   UPDATE public.plans SET price_paise = 149900, duration_days = 30 WHERE code = 'monthly';
--   UPDATE public.plans SET price_paise = 399900, duration_days = 90 WHERE code = 'quarterly';
--   COMMIT;
-- ============================================================================
