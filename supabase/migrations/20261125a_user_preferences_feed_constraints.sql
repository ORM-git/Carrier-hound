-- ============================================================================
-- Migration: saved feed constraints on user_preferences (Preferences sheet)
-- Description: Columns the Preferences sheet persists beyond the original contract.
--   work_models          multi-select Onsite/Hybrid/Remote. remote_preference stays the
--                        legacy single value (the one selection, or 'any' for 0 or 2+).
--   date_posted          saved recency window for the recommended feed.
--   excluded_titles      case-insensitive title substrings hidden from the recommended feed.
--   included_companies   company names (case-insensitive exact) the recommended feed is limited to.
--   excluded_companies   company names (case-insensitive exact) hidden; exclusion wins a conflict.
-- NULL means "never saved" (legacy rows); readers fall back to remote_preference for work_models.
-- Owner-applied. Until applied, the app reads without these columns and shows the
-- affected controls as unavailable; saves that set them fail loudly.
-- ============================================================================

ALTER TABLE public.user_preferences
ADD COLUMN IF NOT EXISTS work_models TEXT[],
ADD COLUMN IF NOT EXISTS date_posted TEXT,
ADD COLUMN IF NOT EXISTS excluded_titles TEXT[],
ADD COLUMN IF NOT EXISTS included_companies TEXT[],
ADD COLUMN IF NOT EXISTS excluded_companies TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_date_posted_check') THEN
    ALTER TABLE public.user_preferences
      ADD CONSTRAINT user_preferences_date_posted_check
      CHECK (date_posted IS NULL OR date_posted IN ('24h', '3d', '7d', '30d'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_work_models_check') THEN
    ALTER TABLE public.user_preferences
      ADD CONSTRAINT user_preferences_work_models_check
      CHECK (work_models IS NULL OR work_models <@ ARRAY['onsite', 'hybrid', 'remote']::text[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_constraint_list_sizes_check') THEN
    ALTER TABLE public.user_preferences
      ADD CONSTRAINT user_preferences_constraint_list_sizes_check
      CHECK (
        coalesce(cardinality(excluded_titles), 0) <= 50
        AND coalesce(cardinality(included_companies), 0) <= 50
        AND coalesce(cardinality(excluded_companies), 0) <= 50
      );
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK:
--   ALTER TABLE public.user_preferences DROP CONSTRAINT IF EXISTS user_preferences_constraint_list_sizes_check;
--   ALTER TABLE public.user_preferences DROP CONSTRAINT IF EXISTS user_preferences_work_models_check;
--   ALTER TABLE public.user_preferences DROP CONSTRAINT IF EXISTS user_preferences_date_posted_check;
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS excluded_companies;
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS included_companies;
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS excluded_titles;
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS date_posted;
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS work_models;
-- ============================================================================
