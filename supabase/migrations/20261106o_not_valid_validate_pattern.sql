-- ============================================================================
-- Migration: 20261106o_not_valid_validate_pattern.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106o_not_valid_validate_pattern
--
-- Database row #13 (NOT VALID then VALIDATE).
--
-- Why: every CHECK on public.jobs so far was added inline
-- (20261001_ingestion_pipeline.sql, 20261001_filter_upgrades.sql): the
-- ALTER TABLE scans and validates the whole table while holding an
-- ACCESS EXCLUSIVE lock, which blocks writes on a big live table. The
-- two-phase pattern avoids that:
--
--   Phase 1 - ADD CONSTRAINT ... NOT VALID: no table scan; the lock is
--     held only long enough to register the constraint. New and updated
--     rows are enforced immediately; existing rows are trusted as-is.
--   Phase 2 - VALIDATE CONSTRAINT (run separately, off-peak): scans
--     existing rows under a SHARE UPDATE EXCLUSIVE lock, which does NOT
--     block ordinary reads, inserts, updates, or deletes.
--
-- Concrete constraint shipped here: jobs_salary_bounds_check
--   CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
-- No existing migration bounds salary_min vs salary_max (only enum-style
-- checks exist on jobs). Bad ranges break salary filters and sorts.
--
-- HOW TO APPLY (two separate SQL editor runs):
--   Run A (now): execute Phase 1 below. Then run the audit query from
--     scripts/db-health.sql section 16 (count of violating rows).
--   Run B (off-peak, once the audit is clean or remediated): uncomment and
--     execute Phase 2. If VALIDATE fails, the constraint stays NOT VALID -
--     writes keep working; remediate the rows the audit query lists, then
--     rerun Phase 2. Until Phase 2 runs, pg_constraint.convalidated stays
--     false for this constraint (visible in db-health section 16).
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

-- Phase 1: register the constraint without scanning the table -------------
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_salary_bounds_check
  CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
  NOT VALID;

-- Phase 2: validate existing rows off-peak (uncomment for Run B) ----------
-- ALTER TABLE public.jobs VALIDATE CONSTRAINT jobs_salary_bounds_check;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_salary_bounds_check;
-- ============================================================================
