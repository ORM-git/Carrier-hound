-- ============================================================================
-- Migration: 20261114b_profiles_onboarding_completed_at.sql
-- Status: NOT APPLIED
-- Record after applying manually in the Supabase SQL editor:
--   node scripts/record-migration.cjs 20261114b_profiles_onboarding_completed_at.sql
--
-- Purpose:
--   Persist onboarding completion per account in public.profiles (onboarding_completed_at)
--   so a user sees onboarding questions exactly once.
--   Backfill existing users who already have substantive profiles or preferences.
--
-- Safety & Fail-Fast Guarantees:
--   1. Wrapped in a single atomic transaction (BEGIN ... COMMIT).
--   2. Strict pre-flight checks: validates required columns across public.profiles,
--      public.candidate_profiles, and public.user_preferences before running DDL/DML.
--   3. Asserts user_id has a PRIMARY KEY or UNIQUE constraint on public.profiles.
--   4. Asserts pg_policies checks match schemaname = 'public'.
--   5. Backfills only on substantive data: trimmed non-empty text, non-empty arrays,
--      and non-empty JSONB arrays (matching runtime helper exactly).
-- ============================================================================

BEGIN;

-- 1. Ensure public.profiles table exists and has onboarding_completed_at column
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name    TEXT,
  target_roles TEXT[],
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- 2. Fail-fast safety checks: required columns and constraint verification
DO $$
DECLARE
  missing_col TEXT;
BEGIN
  -- 2a. Check public.profiles required columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('user_id'), ('full_name'), ('target_roles'), ('created_at'), ('onboarding_completed_at')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Safety check failed: public.profiles is missing required column: %', missing_col;
  END LOOP;

  -- 2b. Check public.candidate_profiles required columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('user_id'), ('confirmed_at'), ('updated_at'), ('created_at'), ('skills'), ('raw_resume_text'), ('experience_json')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'candidate_profiles' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Safety check failed: public.candidate_profiles is missing required column: %', missing_col;
  END LOOP;

  -- 2c. Check public.user_preferences required columns
  FOR missing_col IN
    SELECT col
    FROM (VALUES ('user_id'), ('onboarding_completed'), ('updated_at'), ('created_at')) AS req(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'user_preferences' AND column_name = req.col
    )
  LOOP
    RAISE EXCEPTION 'Safety check failed: public.user_preferences is missing required column: %', missing_col;
  END LOOP;

  -- 2d. Check user_id unique / primary key requirement on public.profiles:
  -- Tight check: requires a valid, immediate, non-partial UNIQUE index or constraint on user_id ALONE (not composite or partial).
  IF NOT EXISTS (
    -- Unique or primary key constraint on user_id ALONE
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'public'
      AND t.relname = 'profiles'
      AND c.contype IN ('p', 'u')
      AND array_length(c.conkey, 1) = 1
      AND c.condeferrable = false
      AND a.attname = 'user_id'
  ) AND NOT EXISTS (
    -- Unique index on user_id ALONE: valid, immediate, non-partial
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON i.indrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = 'public'
      AND t.relname = 'profiles'
      AND i.indisunique = true
      AND i.indisvalid = true
      AND i.indimmediate = true
      AND i.indpred IS NULL
      AND i.indnkeyatts = 1
      AND a.attname = 'user_id'
  ) THEN
    RAISE EXCEPTION 'Safety check failed: public.profiles must have a valid, immediate, non-partial PRIMARY KEY or UNIQUE constraint on user_id alone';
  END IF;
END $$;

-- 3. Ensure RLS is enabled and policies exist on public.profiles (scoped strictly to public schema)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_owner_select'
  ) THEN
    CREATE POLICY "profiles_owner_select" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_owner_insert'
  ) THEN
    CREATE POLICY "profiles_owner_insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_owner_update'
  ) THEN
    CREATE POLICY "profiles_owner_update" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_owner_delete'
  ) THEN
    CREATE POLICY "profiles_owner_delete" ON public.profiles FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- 4. Backfill existing users on substantive data only:
-- (trimmed non-empty text, non-empty arrays, and jsonb arrays with length > 0)

-- 4a. Backfill from candidate_profiles
INSERT INTO public.profiles (user_id, onboarding_completed_at, created_at)
SELECT 
  cp.user_id,
  COALESCE(cp.confirmed_at, cp.updated_at, cp.created_at, NOW()) AS onboarding_completed_at,
  COALESCE(cp.created_at, NOW()) AS created_at
FROM public.candidate_profiles cp
WHERE (
  cp.confirmed_at IS NOT NULL
  OR (cp.skills IS NOT NULL AND array_length(cp.skills, 1) > 0)
  OR (cp.raw_resume_text IS NOT NULL AND length(trim(cp.raw_resume_text)) > 0)
  OR (
    cp.experience_json IS NOT NULL 
    AND jsonb_typeof(cp.experience_json) = 'array' 
    AND jsonb_array_length(cp.experience_json) > 0
  )
)
ON CONFLICT (user_id) DO UPDATE
SET onboarding_completed_at = COALESCE(public.profiles.onboarding_completed_at, EXCLUDED.onboarding_completed_at);

-- 4b. Backfill from user_preferences (onboarding_completed = true only; partial roles do not count)
INSERT INTO public.profiles (user_id, onboarding_completed_at, created_at)
SELECT 
  up.user_id,
  COALESCE(up.updated_at, up.created_at, NOW()) AS onboarding_completed_at,
  COALESCE(up.created_at, NOW()) AS created_at
FROM public.user_preferences up
WHERE up.onboarding_completed = true
ON CONFLICT (user_id) DO UPDATE
SET onboarding_completed_at = COALESCE(public.profiles.onboarding_completed_at, EXCLUDED.onboarding_completed_at);

-- 4c. Backfill existing profiles rows with trimmed non-empty full_name or non-empty target_roles
UPDATE public.profiles
SET onboarding_completed_at = COALESCE(onboarding_completed_at, created_at, NOW())
WHERE onboarding_completed_at IS NULL
  AND (
    (full_name IS NOT NULL AND length(trim(full_name)) > 0)
    OR (target_roles IS NOT NULL AND array_length(target_roles, 1) > 0)
  );

-- 4d. Keep user_preferences.onboarding_completed in sync for backfilled users
UPDATE public.user_preferences up
SET onboarding_completed = true
FROM public.profiles p
WHERE up.user_id = p.user_id
  AND p.onboarding_completed_at IS NOT NULL
  AND up.onboarding_completed = false;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS onboarding_completed_at;
-- ============================================================================
