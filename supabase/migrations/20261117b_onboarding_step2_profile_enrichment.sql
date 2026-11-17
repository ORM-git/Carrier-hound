-- Migration: 20261117b_onboarding_step2_profile_enrichment.sql
-- Description: Add linkedin_url and resume_filename to profiles and candidate_profiles,
--              and configure the private 'resumes' storage bucket and RLS policies.
-- Date: 2026-11-17
-- Safe & Idempotent: Uses ADD COLUMN IF NOT EXISTS and ON CONFLICT.

-- 1. Defensively add profile enrichment columns to public.profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS resume_filename TEXT;

-- 2. Defensively add profile enrichment columns to public.candidate_profiles
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS resume_filename TEXT;

-- 3. Configure private 'resumes' Supabase storage bucket (max 5 MB, PDF and DOCX only)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'resumes',
  'resumes',
  false,
  5242880, -- 5 MB (5 * 1024 * 1024 bytes)
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];

-- 4. Enable RLS on storage.objects (if not already enabled)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 5. Drop existing policies on 'resumes' bucket to ensure clean idempotent recreation
DROP POLICY IF EXISTS "Users can upload their own resume" ON storage.objects;
DROP POLICY IF EXISTS "Users can view their own resume" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own resume" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own resume" ON storage.objects;

-- 6. RLS Policies: Authenticated users can manage files strictly in their own folder
CREATE POLICY "Users can upload their own resume"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "Users can view their own resume"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "Users can update their own resume"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "Users can delete their own resume"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================================================
-- ROLLBACK INSTRUCTIONS
-- ============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS "Users can delete their own resume" ON storage.objects;
-- DROP POLICY IF EXISTS "Users can update their own resume" ON storage.objects;
-- DROP POLICY IF EXISTS "Users can view their own resume" ON storage.objects;
-- DROP POLICY IF EXISTS "Users can upload their own resume" ON storage.objects;
-- DELETE FROM storage.buckets WHERE id = 'resumes';
-- ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS resume_filename;
-- ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS linkedin_url;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS resume_filename;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS linkedin_url;
-- COMMIT;

