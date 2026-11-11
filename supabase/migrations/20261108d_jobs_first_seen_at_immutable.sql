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
-- SAFETY & LOCKING GUIDANCE:
-- - ALTER TABLE ... ALTER COLUMN SET DEFAULT acquires an ACCESS EXCLUSIVE lock (very brief, metadata-only, no table rewrite).
-- - CREATE TRIGGER acquires a SHARE ROW EXCLUSIVE lock on public.jobs.
-- - To prevent queueing behind long-running queries or blocking live search/ingest traffic,
--   always set a conservative lock_timeout before applying:
--     SET lock_timeout = '2s';
-- - If lock acquisition times out, retry during low-traffic windows.
-- - The function is SECURITY INVOKER with immutable search_path pinned to public, pg_temp.
-- - Idempotent and reversible.

-- Lock timeout recommendation for live migration apply:
-- SET lock_timeout = '2s';

-- 1. Ensure first_seen_at default is now()
ALTER TABLE public.jobs ALTER COLUMN first_seen_at SET DEFAULT now();

-- 2. Trigger function to protect first_seen_at immutability on UPDATE
CREATE OR REPLACE FUNCTION public.protect_jobs_first_seen_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- If first_seen_at is already set on the existing row, preserve it immutably
  IF OLD.first_seen_at IS NOT NULL AND NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at THEN
    NEW.first_seen_at := OLD.first_seen_at;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Attach trigger to public.jobs
DROP TRIGGER IF EXISTS trg_protect_jobs_first_seen_at ON public.jobs;
CREATE TRIGGER trg_protect_jobs_first_seen_at
BEFORE UPDATE ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.protect_jobs_first_seen_at();

COMMENT ON FUNCTION public.protect_jobs_first_seen_at() IS
  'Guarantees immutability of first_seen_at on public.jobs across all updates and upserts.';

-- VERIFICATION (catalog only, safe on production):
-- SELECT tgname, relname, proname, prosecdef
-- FROM pg_trigger t
-- JOIN pg_class c ON t.tgrelid = c.oid
-- JOIN pg_proc p ON t.tgfoid = p.oid
-- WHERE tgname = 'trg_protect_jobs_first_seen_at';

-- ROLLBACK:
-- DROP TRIGGER IF EXISTS trg_protect_jobs_first_seen_at ON public.jobs;
-- DROP FUNCTION IF EXISTS public.protect_jobs_first_seen_at();
