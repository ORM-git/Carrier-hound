-- ============================================================
-- Migration: Add Ingestion, Deduplication & Cleanup Pipeline
-- ============================================================

-- 1. Add missing columns safely without breaking existing records
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS remote BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_job_id TEXT,
  ADD COLUMN IF NOT EXISTS salary_min NUMERIC,
  ADD COLUMN IF NOT EXISTS salary_max NUMERIC,
  ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- 2. Relax job_type constraint to allow 'job', 'internship', and existing types
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_job_type_check 
  CHECK (job_type IN ('job', 'internship', 'full-time', 'part-time', 'contract', 'other'));

-- 3. Backfill newly added columns from existing rows (preserves existing data)
UPDATE public.jobs
SET
  remote = COALESCE(remote, remote_scope = 'remote'),
  is_active = COALESCE(is_active, status = 'active'),
  created_at = COALESCE(created_at, first_seen_at, NOW()),
  posted_at = COALESCE(posted_at, first_seen_at, NOW())
WHERE remote IS NULL OR is_active IS NULL OR created_at IS NULL;

-- 4. Unique constraint on (source, source_job_id) for ON CONFLICT upserting
DROP INDEX IF EXISTS public.jobs_source_source_job_id_unique;
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_source_job_id_key;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_source_source_job_id_key UNIQUE (source, source_job_id);

-- 5. Deduplicate existing rows with identical apply_url if any before unique constraint
DELETE FROM public.jobs a
USING public.jobs b
WHERE a.id > b.id
  AND a.apply_url IS NOT NULL
  AND a.apply_url = b.apply_url;

-- 6. Strict unique index on apply_url
DROP INDEX IF EXISTS public.jobs_apply_url_unique;
CREATE UNIQUE INDEX jobs_apply_url_unique
  ON public.jobs (apply_url)
  WHERE apply_url IS NOT NULL;

-- 7. Query and filter indexes for high performance
CREATE INDEX IF NOT EXISTS jobs_is_active_idx ON public.jobs (is_active);
CREATE INDEX IF NOT EXISTS jobs_last_seen_at_idx ON public.jobs (last_seen_at);
CREATE INDEX IF NOT EXISTS jobs_posted_at_idx ON public.jobs (posted_at);

-- 8. Update RLS policies: public read for active jobs (backward compatible with status)
DROP POLICY IF EXISTS "jobs_public_read" ON public.jobs;
CREATE POLICY "jobs_public_read"
  ON public.jobs
  FOR SELECT
  USING (is_active = true OR status = 'active');

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "jobs_public_read" ON public.jobs;
--   DROP INDEX IF EXISTS public.jobs_apply_url_unique;
--   DROP INDEX IF EXISTS public.jobs_is_active_idx;
--   DROP INDEX IF EXISTS public.jobs_last_seen_at_idx;
--   DROP INDEX IF EXISTS public.jobs_posted_at_idx;
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS remote;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_source_job_id_key;
--   NOTE: constraint jobs_job_type_check was dropped and re-added by this file with a new definition; restore its prior definition from the earlier migration that created it.
--   NOTE: constraint jobs_source_source_job_id_key was dropped and re-added by this file with a new definition; restore its prior definition from the earlier migration that created it.
--   NOTE: this migration itself drops INDEX jobs_source_source_job_id_unique - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: this migration itself drops INDEX jobs_apply_url_unique - restore it from the earlier migration that created it (or from backup) if rolling back.
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================
