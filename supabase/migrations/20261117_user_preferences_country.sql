-- ============================================================================
-- Migration: Add country and country_code to user_preferences
-- Description: Supports explicit user country persistence from mobile onboarding.
-- ============================================================================

ALTER TABLE public.user_preferences
ADD COLUMN IF NOT EXISTS country TEXT,
ADD COLUMN IF NOT EXISTS country_code VARCHAR(2);

-- ============================================================================
-- ROLLBACK:
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS country_code;
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS country;
-- ============================================================================
