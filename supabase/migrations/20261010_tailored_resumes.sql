-- ==============================================================================
-- Migration: Tailored Resumes & Cover Letters Per-Job Cache (Multi-User)
-- Date: 2026-10-10
-- Scope: tailored_resumes (stores tailored ATS resumes and cover letters per user & job)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.tailored_resumes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id            TEXT NOT NULL,
  job_title         TEXT NOT NULL,
  company           TEXT NOT NULL,
  ats_score         INTEGER DEFAULT 85,
  tailored_data     JSONB,
  cover_letter_data JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT tailored_resumes_user_job_unique UNIQUE (user_id, job_id)
);

-- Indexes for lightning fast per-job caching lookups
CREATE INDEX IF NOT EXISTS tailored_resumes_user_job_idx
  ON public.tailored_resumes (user_id, job_id);

CREATE INDEX IF NOT EXISTS tailored_resumes_user_updated_idx
  ON public.tailored_resumes (user_id, updated_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE public.tailored_resumes ENABLE ROW LEVEL SECURITY;

-- Idempotent RLS policies for owner access
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tailored_resumes' AND policyname = 'tailored_resumes_owner_select') THEN
    CREATE POLICY "tailored_resumes_owner_select" ON public.tailored_resumes FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tailored_resumes' AND policyname = 'tailored_resumes_owner_insert') THEN
    CREATE POLICY "tailored_resumes_owner_insert" ON public.tailored_resumes FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tailored_resumes' AND policyname = 'tailored_resumes_owner_update') THEN
    CREATE POLICY "tailored_resumes_owner_update" ON public.tailored_resumes FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tailored_resumes' AND policyname = 'tailored_resumes_owner_delete') THEN
    CREATE POLICY "tailored_resumes_owner_delete" ON public.tailored_resumes FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "tailored_resumes_owner_select" ON public.tailored_resumes;
--   DROP POLICY IF EXISTS "tailored_resumes_owner_insert" ON public.tailored_resumes;
--   DROP POLICY IF EXISTS "tailored_resumes_owner_update" ON public.tailored_resumes;
--   DROP POLICY IF EXISTS "tailored_resumes_owner_delete" ON public.tailored_resumes;
--   DROP INDEX IF EXISTS public.tailored_resumes_user_job_idx;
--   DROP INDEX IF EXISTS public.tailored_resumes_user_updated_idx;
--   ALTER TABLE public.tailored_resumes DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.tailored_resumes CASCADE;
-- ============================================================================
