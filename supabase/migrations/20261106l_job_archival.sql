-- ============================================================================
-- Migration: 20261106l_job_archival.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106l_job_archival
--
-- Database row #8 (Archival strategy).
--
-- What this does:
--   1. Creates public.jobs_archive: cold storage for expired job listings,
--      same shape as public.jobs (via LIKE ... INCLUDING DEFAULTS INCLUDING
--      CONSTRAINTS, so future jobs columns should be mirrored here when
--      added) plus description_text (denormalized from job_descriptions at
--      archive time) and archived_at. No client access: RLS enabled, anon
--      and authenticated revoked, service_role only.
--   2. Creates public.archive_expired_jobs(dry_run, older_than): moves jobs
--      that have been inactive AND expired for longer than `older_than` out
--      of the hot jobs table into jobs_archive, preserving the description
--      text. dry_run DEFAULTS TO TRUE (reviewer precedent, 20261106a): a
--      bare call only counts. Fail-open per audit/history convention: on
--      error it raises a WARNING and reports zero archived instead of
--      aborting the caller.
--
-- Archival threshold: 90 days inactive (chosen default, not a measured
-- value - jobs older than that have no product value in search results and
-- stay recoverable in jobs_archive). Pass a different `older_than` when
-- calling to override.
--
-- Scheduling: wired into the weekly retention cron runner
-- (scripts/retention-cron.ts, .github/workflows/retention-cron.yml), which
-- skips the archive step with a warning until this migration is applied.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

-- 1. Archive table -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.jobs_archive (
  LIKE public.jobs INCLUDING DEFAULTS INCLUDING CONSTRAINTS
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_archive_pkey'
  ) THEN
    ALTER TABLE public.jobs_archive ADD CONSTRAINT jobs_archive_pkey PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE public.jobs_archive ADD COLUMN IF NOT EXISTS description_text TEXT;
ALTER TABLE public.jobs_archive ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_jobs_archive_archived_at ON public.jobs_archive (archived_at);

ALTER TABLE public.jobs_archive ENABLE ROW LEVEL SECURITY;

-- No client access; only the service role (archival cron, manual review)
-- reads or writes the archive.
REVOKE ALL ON public.jobs_archive FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.jobs_archive TO service_role;

-- 2. Archival function -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.archive_expired_jobs(
  dry_run BOOLEAN DEFAULT TRUE,
  older_than INTERVAL DEFAULT INTERVAL '90 days'
)
RETURNS TABLE(cutoff TIMESTAMPTZ, rows_matched BIGINT, rows_archived BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := now() - older_than;
  n_matched BIGINT;
  n_archived BIGINT := 0;
BEGIN
  SELECT count(*) INTO n_matched
  FROM public.jobs j
  WHERE j.is_active = false
    AND j.status = 'expired'
    AND j.last_seen_at < v_cutoff;

  IF NOT dry_run AND n_matched > 0 THEN
    WITH moved AS (
      DELETE FROM public.jobs j
      WHERE j.is_active = false
        AND j.status = 'expired'
        AND j.last_seen_at < v_cutoff
      RETURNING j.*
    )
    INSERT INTO public.jobs_archive
    SELECT m.*, jd.description_text, now()
    FROM moved m
    LEFT JOIN public.job_descriptions jd ON jd.job_id = m.id;
    GET DIAGNOSTICS n_archived = ROW_COUNT;
  END IF;

  cutoff := v_cutoff;
  rows_matched := n_matched;
  rows_archived := n_archived;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'archive_expired_jobs failed: %', SQLERRM;
  cutoff := v_cutoff;
  rows_matched := 0;
  rows_archived := 0;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_expired_jobs(BOOLEAN, INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_expired_jobs(BOOLEAN, INTERVAL) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.archive_expired_jobs(BOOLEAN, INTERVAL);
--   -- Optionally restore archived rows back into the hot table first:
--   -- INSERT INTO public.jobs SELECT <jobs columns> FROM public.jobs_archive
--   --   ON CONFLICT (id) DO NOTHING;
--   DROP TABLE IF EXISTS public.jobs_archive;
-- ============================================================================
