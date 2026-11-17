-- Migration: 20261117a_update_plan_prices_399_499_2199.sql
-- Description: Update public.plans table to server-authoritative prepaid price points:
--   1. weekly: Rs 399 (39900 paise), 7 days access
--   2. monthly: Rs 499 (49900 paise intro/first purchase), 30 days access (repeat is Rs 799 / 79900 paise computed server-side)
--   3. quarterly: Rs 2,199 (219900 paise), 90 days access

update public.plans set price_paise = 39900, duration_days = 7 where code = 'weekly';
update public.plans set price_paise = 49900, duration_days = 30 where code = 'monthly';
update public.plans set price_paise = 219900, duration_days = 90 where code = 'quarterly';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   update public.plans set price_paise = 69200, duration_days = 7 where code = 'weekly';
--   update public.plans set price_paise = 149900, duration_days = 30 where code = 'monthly';
--   update public.plans set price_paise = 399900, duration_days = 90 where code = 'quarterly';
-- ============================================================================
