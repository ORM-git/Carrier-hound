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

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS eligibility_filter;
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================
