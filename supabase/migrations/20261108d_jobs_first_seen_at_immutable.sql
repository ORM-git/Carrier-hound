-- Migration: 20261108d_jobs_first_seen_at_immutable.sql
-- STATUS: NOT APPLIED - apply manually after review, then record:
--   node scripts/record-migration.cjs 20261108d_jobs_first_seen_at_immutable
--
-- RATIONALE:
-- Guarantees immutability of public.jobs.first_seen_at.
-- Once a job is first discovered and inserted, its first_seen_at timestamp must
-- never be modified or overwritten by subsequent upserts, updates, or reappearance
-- syncs. This ensures measurable and accurate daily new job supply calculation.
--
-- SAFETY:
-- - No table rewrite or locks: creates a BEFORE UPDATE trigger function.
-- - If first_seen_at is already set on the existing row, any attempt to change it
--   is intercepted and overwritten with the existing OLD.first_seen_at.
-- - Idempotent and reversible.

-- 1. Ensure first_seen_at default is now()
ALTER TABLE public.jobs ALTER COLUMN first_seen_at SET DEFAULT now();

-- 2. Trigger function to protect first_seen_at immutability on UPDATE
CREATE OR REPLACE FUNCTION public.protect_jobs_first_seen_at()
RETURNS TRIGGER AS $$
BEGIN
  -- If first_seen_at is already set on the existing row, preserve it immutably
  IF OLD.first_seen_at IS NOT NULL AND NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at THEN
    NEW.first_seen_at := OLD.first_seen_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Attach trigger to public.jobs
DROP TRIGGER IF EXISTS trg_protect_jobs_first_seen_at ON public.jobs;
CREATE TRIGGER trg_protect_jobs_first_seen_at
BEFORE UPDATE ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.protect_jobs_first_seen_at();

COMMENT ON FUNCTION public.protect_jobs_first_seen_at() IS
  'Guarantees immutability of first_seen_at on public.jobs across all updates and upserts.';

-- VERIFICATION (catalog only, safe on production):
-- SELECT tgname, relname, proname
-- FROM pg_trigger t
-- JOIN pg_class c ON t.tgrelid = c.oid
-- JOIN pg_proc p ON t.tgfoid = p.oid
-- WHERE tgname = 'trg_protect_jobs_first_seen_at';

-- ROLLBACK:
-- DROP TRIGGER IF EXISTS trg_protect_jobs_first_seen_at ON public.jobs;
-- DROP FUNCTION IF EXISTS public.protect_jobs_first_seen_at();
