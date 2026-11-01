-- ============================================================================
-- Migration: Add eligibility_filter to user_preferences
-- Description: Supports country eligibility auto-filtering with user opt-out.
-- ============================================================================

ALTER TABLE public.user_preferences
ADD COLUMN IF NOT EXISTS eligibility_filter boolean DEFAULT true;

-- Backfill existing rows to true (default ON)
UPDATE public.user_preferences
SET eligibility_filter = true
WHERE eligibility_filter IS NULL;
