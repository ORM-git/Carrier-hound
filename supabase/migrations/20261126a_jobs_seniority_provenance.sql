-- ============================================================================
-- Migration: 20261126a_jobs_seniority_provenance.sql
-- STATUS: NOT APPLIED - owner-applied. Nothing reads or writes these columns yet;
-- ingestion does not depend on them (checklist #16, schema slice only). After applying, record:
--   node scripts/record-migration.cjs 20261126a_jobs_seniority_provenance
--
-- Provenance for jobs.seniority.
--   seniority_source        where jobs.seniority came from: source_field | title | description | none.
--   seniority_confidence    high | medium | low (NULL until the write slice lands).
-- Years of experience are NOT here: they use the existing jobs.min_experience_years and the
-- max_experience_years / experience_years_source proposal
-- (docs/proposed/executable/20261126b_advanced_preferences_slice1.sql).
-- The existing jobs.seniority column and jobs_seniority_check constraint are unchanged.
-- No backfill. Mapping logic: src/lib/jobs/seniorityMap.ts.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

ALTER TABLE public.jobs
ADD COLUMN IF NOT EXISTS seniority_source TEXT,
ADD COLUMN IF NOT EXISTS seniority_confidence TEXT;

-- Existence checks are scoped to public.jobs (conrelid), so a same-named constraint on another
-- table or schema cannot make these silently skip.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_seniority_source_check' AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_seniority_source_check
      CHECK (seniority_source IS NULL OR seniority_source IN ('source_field', 'title', 'description', 'none'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_seniority_confidence_check' AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_seniority_confidence_check
      CHECK (seniority_confidence IS NULL OR seniority_confidence IN ('high', 'medium', 'low'));
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (run manually):
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_seniority_confidence_check;
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_seniority_source_check;
--   ALTER TABLE public.jobs
--     DROP COLUMN IF EXISTS seniority_source,
--     DROP COLUMN IF EXISTS seniority_confidence;
-- ============================================================================
