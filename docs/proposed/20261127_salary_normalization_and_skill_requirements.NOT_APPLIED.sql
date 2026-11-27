-- ============================================================================
-- PROPOSAL ONLY. STATUS: NOT APPLIED. Nothing reads or writes these columns yet.
-- Checklist rows #21 (salary normalization) and #27 (required vs preferred skills).
-- Owner applies after review; then the ingest writer (scripts/ingest.ts, pending
-- owner file OK) fills them only when the columns exist, like its other optional columns.
--
-- #21: annual figures come from src/lib/salary/normalize.ts (strict mode). They stay
--      NULL when the period was not stated: never a guess. period_inferred and
--      conversion_assumed are the "estimate" flags the row asks for.
--      Not here on purpose: widening jobs.salary_period to daily/weekly. formatSalary
--      (src/lib/salary/parser.ts) renders any unknown period as "/yr", so the display
--      side must handle daily/weekly first, or a $300/day job would show "$300 /yr".
-- #27: output of src/lib/jobs/skillRequirements.ts, stored whole with its
--      extractorVersion so a later extractor can re-run only stale rows.
--      Empty lists mean "not stated", never "no requirements".
-- ============================================================================

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS salary_annual_min numeric,
  ADD COLUMN IF NOT EXISTS salary_annual_max numeric,
  ADD COLUMN IF NOT EXISTS salary_period_inferred boolean,
  ADD COLUMN IF NOT EXISTS salary_conversion_assumed boolean,
  ADD COLUMN IF NOT EXISTS skill_requirements jsonb,
  ADD COLUMN IF NOT EXISTS skill_requirements_version text;

-- Like description and skills, skill_requirements is auth-gated: do not add it to any guest select.

-- ROLLBACK:
--   ALTER TABLE public.jobs
--     DROP COLUMN IF EXISTS salary_annual_min, DROP COLUMN IF EXISTS salary_annual_max,
--     DROP COLUMN IF EXISTS salary_period_inferred, DROP COLUMN IF EXISTS salary_conversion_assumed,
--     DROP COLUMN IF EXISTS skill_requirements, DROP COLUMN IF EXISTS skill_requirements_version;
