-- ============================================================================
-- Migration: 20261126a_jobs_years_and_seniority_provenance.sql
-- STATUS: NOT APPLIED - owner-applied. Nothing reads or writes these columns yet;
-- ingestion does not depend on them (checklist #16, schema slice only).
--
-- Numeric years-of-experience bounds and provenance for jobs.seniority.
--   years_min / years_max   parsed from listing text; NULL = not stated / not parsed.
--   seniority_source        where jobs.seniority came from: source_field | title | description | none.
--   seniority_confidence    high | medium | low (NULL until the write slice lands).
-- The existing jobs.seniority column and jobs_seniority_check constraint are unchanged.
-- No backfill. Mapping logic: src/lib/jobs/seniorityMap.ts.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

ALTER TABLE public.jobs
ADD COLUMN IF NOT EXISTS years_min NUMERIC,
ADD COLUMN IF NOT EXISTS years_max NUMERIC,
ADD COLUMN IF NOT EXISTS seniority_source TEXT,
ADD COLUMN IF NOT EXISTS seniority_confidence TEXT;

-- Existence checks are scoped to public.jobs (conrelid), so a same-named constraint on another
-- table or schema cannot make these silently skip.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_seniority_confidence_check' AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_seniority_confidence_check
      CHECK (seniority_confidence IS NULL OR seniority_confidence IN ('high', 'medium', 'low'));
  END IF;

  -- Years bounds: NULL allowed (not stated / not parsed); when present, nonnegative and min <= max.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_years_bounds_check' AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_years_bounds_check
      CHECK (
        (years_min IS NULL OR years_min >= 0)
        AND (years_max IS NULL OR years_max >= 0)
        AND (years_min IS NULL OR years_max IS NULL OR years_min <= years_max)
      );
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (run manually):
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_years_bounds_check;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_seniority_confidence_check;
--   ALTER TABLE public.jobs
--     DROP COLUMN IF EXISTS years_min,
--     DROP COLUMN IF EXISTS years_max,
--     DROP COLUMN IF EXISTS seniority_source,
--     DROP COLUMN IF EXISTS seniority_confidence;
-- ============================================================================
