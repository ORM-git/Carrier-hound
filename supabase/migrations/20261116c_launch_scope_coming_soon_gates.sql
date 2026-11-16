-- Migration: 20261116c_launch_scope_coming_soon_gates.sql
-- Description: Launch scope database gates for coming-soon features
--              Blocks direct reads and writes on applications, candidate_profiles,
--              tailored_resumes, and resumes storage bucket at the DB/RLS level.
--              Preserves DELETE policies for account deletion and preserves all existing data.
-- Status: NOT APPLIED
-- Record with: node scripts/record-migration.cjs 20261116c_launch_scope_coming_soon_gates

-- ============================================================================
-- PRE-CHECK SQL (Run independently to verify prerequisites)
-- ============================================================================
-- SELECT tablename, policyname, cmd, permissive
-- FROM pg_policies
-- WHERE tablename IN ('applications', 'candidate_profiles', 'tailored_resumes');

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. applications table: Block SELECT, INSERT, UPDATE; preserve DELETE
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "applications_owner_select" ON public.applications;
DROP POLICY IF EXISTS "applications_owner_insert" ON public.applications;
DROP POLICY IF EXISTS "applications_owner_update" ON public.applications;

DROP POLICY IF EXISTS "applications_coming_soon_block_select" ON public.applications;
CREATE POLICY "applications_coming_soon_block_select"
  ON public.applications
  FOR SELECT
  TO authenticated, anon
  USING (false);

DROP POLICY IF EXISTS "applications_coming_soon_block_insert" ON public.applications;
CREATE POLICY "applications_coming_soon_block_insert"
  ON public.applications
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "applications_coming_soon_block_update" ON public.applications;
CREATE POLICY "applications_coming_soon_block_update"
  ON public.applications
  FOR UPDATE
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- Ensure owner delete policy exists for account deletion
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'applications' AND policyname = 'applications_owner_delete'
  ) THEN
    CREATE POLICY "applications_owner_delete"
      ON public.applications
      FOR DELETE
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. candidate_profiles table: Block SELECT, INSERT, UPDATE; preserve DELETE
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "candidate_profiles_owner_select" ON public.candidate_profiles;
DROP POLICY IF EXISTS "candidate_profiles_owner_insert" ON public.candidate_profiles;
DROP POLICY IF EXISTS "candidate_profiles_owner_update" ON public.candidate_profiles;

DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_select" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_coming_soon_block_select"
  ON public.candidate_profiles
  FOR SELECT
  TO authenticated, anon
  USING (false);

DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_insert" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_coming_soon_block_insert"
  ON public.candidate_profiles
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_update" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_coming_soon_block_update"
  ON public.candidate_profiles
  FOR UPDATE
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- Ensure owner delete policy exists for account deletion
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'candidate_profiles' AND policyname = 'candidate_profiles_owner_delete'
  ) THEN
    CREATE POLICY "candidate_profiles_owner_delete"
      ON public.candidate_profiles
      FOR DELETE
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. tailored_resumes table: Block SELECT, INSERT, UPDATE; preserve DELETE
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "tailored_resumes_owner_select" ON public.tailored_resumes;
DROP POLICY IF EXISTS "tailored_resumes_owner_insert" ON public.tailored_resumes;
DROP POLICY IF EXISTS "tailored_resumes_owner_update" ON public.tailored_resumes;

DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_select" ON public.tailored_resumes;
CREATE POLICY "tailored_resumes_coming_soon_block_select"
  ON public.tailored_resumes
  FOR SELECT
  TO authenticated, anon
  USING (false);

DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_insert" ON public.tailored_resumes;
CREATE POLICY "tailored_resumes_coming_soon_block_insert"
  ON public.tailored_resumes
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_update" ON public.tailored_resumes;
CREATE POLICY "tailored_resumes_coming_soon_block_update"
  ON public.tailored_resumes
  FOR UPDATE
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- Ensure owner delete policy exists for account deletion
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'tailored_resumes' AND policyname = 'tailored_resumes_owner_delete'
  ) THEN
    CREATE POLICY "tailored_resumes_owner_delete"
      ON public.tailored_resumes
      FOR DELETE
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. storage.objects resumes bucket: Block SELECT, INSERT, UPDATE; preserve DELETE
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Owner can select own resume files" ON storage.objects;
DROP POLICY IF EXISTS "Owner can insert own resume files" ON storage.objects;
DROP POLICY IF EXISTS "Owner can update own resume files" ON storage.objects;

DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_select" ON storage.objects;
CREATE POLICY "resumes_storage_coming_soon_block_select"
  ON storage.objects
  FOR SELECT
  TO authenticated, anon
  USING (bucket_id = 'resumes' AND false);

DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_insert" ON storage.objects;
CREATE POLICY "resumes_storage_coming_soon_block_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (bucket_id = 'resumes' AND false);

DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_update" ON storage.objects;
CREATE POLICY "resumes_storage_coming_soon_block_update"
  ON storage.objects
  FOR UPDATE
  TO authenticated, anon
  USING (bucket_id = 'resumes' AND false)
  WITH CHECK (bucket_id = 'resumes' AND false);

-- Ensure owner delete policy on storage.objects for resumes bucket remains
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Owner can delete own resume files'
  ) THEN
    CREATE POLICY "Owner can delete own resume files"
      ON storage.objects
      FOR DELETE
      TO authenticated
      USING (
        bucket_id = 'resumes'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY SQL (Run independently to verify correct policy application)
-- ============================================================================
-- SELECT tablename, policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE tablename IN ('applications', 'candidate_profiles', 'tailored_resumes');

-- ============================================================================
-- ROLLBACK SQL (Restore owner policies)
-- ============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS "applications_coming_soon_block_select" ON public.applications;
-- DROP POLICY IF EXISTS "applications_coming_soon_block_insert" ON public.applications;
-- DROP POLICY IF EXISTS "applications_coming_soon_block_update" ON public.applications;
-- CREATE POLICY "applications_owner_select" ON public.applications FOR SELECT USING (auth.uid() = user_id);
-- CREATE POLICY "applications_owner_insert" ON public.applications FOR INSERT WITH CHECK (auth.uid() = user_id);
-- CREATE POLICY "applications_owner_update" ON public.applications FOR UPDATE USING (auth.uid() = user_id);
--
-- DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_select" ON public.candidate_profiles;
-- DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_insert" ON public.candidate_profiles;
-- DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_update" ON public.candidate_profiles;
-- CREATE POLICY "candidate_profiles_owner_select" ON public.candidate_profiles FOR SELECT USING (auth.uid() = user_id);
-- CREATE POLICY "candidate_profiles_owner_insert" ON public.candidate_profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
-- CREATE POLICY "candidate_profiles_owner_update" ON public.candidate_profiles FOR UPDATE USING (auth.uid() = user_id);
--
-- DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_select" ON public.tailored_resumes;
-- DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_insert" ON public.tailored_resumes;
-- DROP POLICY IF EXISTS "tailored_resumes_coming_soon_block_update" ON public.tailored_resumes;
-- CREATE POLICY "tailored_resumes_owner_select" ON public.tailored_resumes FOR SELECT USING (auth.uid() = user_id);
-- CREATE POLICY "tailored_resumes_owner_insert" ON public.tailored_resumes FOR INSERT WITH CHECK (auth.uid() = user_id);
-- CREATE POLICY "tailored_resumes_owner_update" ON public.tailored_resumes FOR UPDATE USING (auth.uid() = user_id);
--
-- DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_select" ON storage.objects;
-- DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_insert" ON storage.objects;
-- DROP POLICY IF EXISTS "resumes_storage_coming_soon_block_update" ON storage.objects;
-- CREATE POLICY "Owner can select own resume files" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text);
-- CREATE POLICY "Owner can insert own resume files" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text);
-- CREATE POLICY "Owner can update own resume files" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text) WITH CHECK (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text);
-- COMMIT;
