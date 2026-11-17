-- Migration: 20261117a_update_plan_prices_399_499_2199.sql
-- Description: Update public.plans table to server-authoritative prepaid price points:
--   1. weekly: Rs 399 (39900 paise), 7 days access
--   2. monthly: Rs 499 (49900 paise intro/first purchase), 30 days access (repeat is Rs 799 / 79900 paise computed server-side)
--   3. quarterly: Rs 2,199 (219900 paise), 90 days access
--   4. Creates intro_promo_reservations table for atomic per-user intro pricing reservation

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

-- Intro promo reservations: atomic reservation table to prevent race conditions on introductory Rs 499 price
CREATE TABLE IF NOT EXISTS public.intro_promo_reservations (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id UUID,
  provider_order_id TEXT,
  amount_paise INT NOT NULL DEFAULT 49900,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes')
);

CREATE INDEX IF NOT EXISTS idx_intro_promo_reservations_status_expires
  ON public.intro_promo_reservations(status, expires_at);

ALTER TABLE public.intro_promo_reservations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'intro_promo_reservations' AND policyname = 'users_read_own_intro_reservations'
  ) THEN
    CREATE POLICY "users_read_own_intro_reservations"
      ON public.intro_promo_reservations
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- Post-apply verification queries:
-- SELECT code, name, price_paise, duration_days FROM public.plans WHERE code IN ('weekly', 'monthly', 'quarterly') ORDER BY duration_days;
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'intro_promo_reservations';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP TABLE IF EXISTS public.intro_promo_reservations CASCADE;
--   UPDATE public.plans SET price_paise = 69200, duration_days = 7 WHERE code = 'weekly';
--   UPDATE public.plans SET price_paise = 149900, duration_days = 30 WHERE code = 'monthly';
--   UPDATE public.plans SET price_paise = 399900, duration_days = 90 WHERE code = 'quarterly';
-- ============================================================================
