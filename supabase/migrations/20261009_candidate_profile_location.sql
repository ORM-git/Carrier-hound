-- ============================================================
-- Migration: Add location column to candidate_profiles table
-- ============================================================

ALTER TABLE public.candidate_profiles
  ADD COLUMN IF NOT EXISTS location TEXT;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS location;
-- ============================================================================
