-- ============================================================================
-- Migration: 20261114b_profiles_onboarding_completed_at.sql
-- Status: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261114b_profiles_onboarding_completed_at.sql
--
-- Purpose:
--   Persist onboarding completion per account in public.profiles (onboarding_completed_at)
--   so a user sees onboarding questions exactly once.
--   Backfill existing users who already have a saved profile or preferences as completed.
-- ============================================================================

-- 1. Ensure public.profiles table exists and has onboarding_completed_at column
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name    TEXT,
  target_roles TEXT[],
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- 2. Ensure RLS is enabled and policies exist on public.profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'profiles_owner_select') THEN
    CREATE POLICY "profiles_owner_select" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'profiles_owner_insert') THEN
    CREATE POLICY "profiles_owner_insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'profiles_owner_update') THEN
    CREATE POLICY "profiles_owner_update" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'profiles_owner_delete') THEN
    CREATE POLICY "profiles_owner_delete" ON public.profiles FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- 3. Backfill existing users:
-- Existing users who already have a saved profile or preferences must be treated as completed.

-- 3a. Backfill from candidate_profiles (users who confirmed a resume or have parsed skills/experience)
INSERT INTO public.profiles (user_id, onboarding_completed_at, created_at)
SELECT 
  cp.user_id,
  COALESCE(cp.confirmed_at, cp.updated_at, cp.created_at, NOW()) AS onboarding_completed_at,
  COALESCE(cp.created_at, NOW()) AS created_at
FROM public.candidate_profiles cp
WHERE (
  cp.confirmed_at IS NOT NULL
  OR array_length(cp.skills, 1) > 0
  OR cp.raw_resume_text IS NOT NULL
  OR (cp.experience_json IS NOT NULL AND cp.experience_json::text <> '[]')
)
ON CONFLICT (user_id) DO UPDATE
SET onboarding_completed_at = COALESCE(public.profiles.onboarding_completed_at, EXCLUDED.onboarding_completed_at);

-- 3b. Backfill from user_preferences (users with onboarding_completed=true or saved roles)
INSERT INTO public.profiles (user_id, onboarding_completed_at, created_at)
SELECT 
  up.user_id,
  COALESCE(up.updated_at, up.created_at, NOW()) AS onboarding_completed_at,
  COALESCE(up.created_at, NOW()) AS created_at
FROM public.user_preferences up
WHERE (
  up.onboarding_completed = true
  OR array_length(up.roles, 1) > 0
)
ON CONFLICT (user_id) DO UPDATE
SET onboarding_completed_at = COALESCE(public.profiles.onboarding_completed_at, EXCLUDED.onboarding_completed_at);

-- 3c. Backfill existing profiles rows with full_name or target_roles
UPDATE public.profiles
SET onboarding_completed_at = COALESCE(onboarding_completed_at, created_at, NOW())
WHERE onboarding_completed_at IS NULL
  AND (full_name IS NOT NULL OR array_length(target_roles, 1) > 0);

-- 3d. Keep user_preferences.onboarding_completed in sync for backfilled users
UPDATE public.user_preferences up
SET onboarding_completed = true
FROM public.profiles p
WHERE up.user_id = p.user_id
  AND p.onboarding_completed_at IS NOT NULL
  AND up.onboarding_completed = false;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS onboarding_completed_at;
-- ============================================================================
