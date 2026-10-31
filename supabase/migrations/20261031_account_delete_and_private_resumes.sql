-- =============================================================================
-- Migration: 20261031_account_delete_and_private_resumes.sql
-- Purpose:
--   1. Ensure `saved_jobs` and `resumes` metadata tables exist with owner-only RLS
--      and ON DELETE CASCADE to auth.users(id).
--   2. Enforce private `resumes` storage bucket (`public = FALSE`) with owner-only
--      storage.objects RLS policies (access strictly via signed URLs, never public URLs).
--   3. Document exact SQL / steps executed during account deletion before auth.users removal.
-- =============================================================================

-- 1. Saved Jobs table (owner-only RLS)
CREATE TABLE IF NOT EXISTS public.saved_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_jobs_user_id ON public.saved_jobs(user_id);

ALTER TABLE public.saved_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own saved_jobs" ON public.saved_jobs;
CREATE POLICY "Users can manage own saved_jobs"
  ON public.saved_jobs
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON TABLE public.saved_jobs FROM anon;

-- 2. Resumes metadata table (owner-only RLS, stores private storage object path only)
CREATE TABLE IF NOT EXISTS public.resumes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resumes_user_id ON public.resumes(user_id);

ALTER TABLE public.resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resumes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own resumes" ON public.resumes;
CREATE POLICY "Users can manage own resumes"
  ON public.resumes
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON TABLE public.resumes FROM anon;

-- 3. Private `resumes` Storage Bucket (`public = FALSE`, owner-only access via signed URLs)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'resumes',
  'resumes',
  FALSE,
  5242880,
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = FALSE,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Remove any public/anon policies on storage.objects for `resumes`
DROP POLICY IF EXISTS "Public resume access" ON storage.objects;
DROP POLICY IF EXISTS "Owner can select own resume files" ON storage.objects;
DROP POLICY IF EXISTS "Owner can insert own resume files" ON storage.objects;
DROP POLICY IF EXISTS "Owner can update own resume files" ON storage.objects;
DROP POLICY IF EXISTS "Owner can delete own resume files" ON storage.objects;

-- Owner-only policies scoped strictly to `<auth.uid()>/<filename>` inside private bucket `resumes`
CREATE POLICY "Owner can select own resume files"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Owner can insert own resume files"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Owner can update own resume files"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Owner can delete own resume files"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- =============================================================================
-- Reference Account Deletion SQL Steps (executed via service_role in /api/account/delete):
--   Step 1 (Profile):       DELETE FROM public.candidate_profiles WHERE user_id = :uid;
--                           DELETE FROM public.user_preferences   WHERE user_id = :uid;
--   Step 2 (Resumes):       DELETE FROM public.resumes            WHERE user_id = :uid;
--                           DELETE FROM public.tailored_resumes   WHERE user_id = :uid;
--   Step 3 (Saved Jobs):    DELETE FROM public.saved_jobs         WHERE user_id = :uid;
--   Step 4 (Applications):  DELETE FROM public.applications       WHERE user_id = :uid;
--                           DELETE FROM public.job_applications   WHERE user_id = :uid;
--   Step 5 (Subscriptions): DELETE FROM public.subscriptions      WHERE user_id = :uid;
--   Step 6 (Early Access):  DELETE FROM public.early_access_emails   WHERE lower(email) = lower(:email);
--   Step 7 (Storage Files): Remove all objects under `resumes/:uid/*` via Supabase Storage API
--   Step 8 (Auth User):     Delete user `:uid` from `auth.users` via `auth.admin.deleteUser(:uid)`
-- =============================================================================
