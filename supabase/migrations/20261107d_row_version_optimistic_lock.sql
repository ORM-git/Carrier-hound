-- ============================================================================
-- Migration: 20261107d_row_version_optimistic_lock.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107d_row_version_optimistic_lock
--
-- Database row "Optimistic Locking (version column)" (MISSING).
--
-- Tables (owner to confirm the list; user-edited, non-billing only):
--   user_preferences, resumes, applications, candidate_profiles.
--   No payments, subscriptions or entitlement tables.
--
-- What this changes once applied:
--   1. Each table gets row_version INTEGER NOT NULL DEFAULT 1 (constant default,
--      no table rewrite on current Postgres; existing rows read 1).
--   2. A BEFORE UPDATE trigger sets NEW.row_version = OLD.row_version + 1 on
--      every UPDATE, whatever the caller sends. Existing writers are unaffected:
--      they still win (last write wins) exactly as today. Only the counter moves.
--   3. Nothing rejects a write in SQL. A stale update is detected by the caller
--      adding "AND row_version = <the version it read>" to its UPDATE
--      (src/lib/db/optimisticLock.ts does this): zero rows matched = stale.
--
-- Interactions to know: the change-history trigger on user_preferences
-- (20261106c) will record row_version in its old/new images; the new column
-- appears in select("*") reads of these four tables (select-star guard tracks
-- sites, not columns).
-- ============================================================================

ALTER TABLE public.user_preferences  ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.resumes           ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.applications      ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.bump_row_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $func$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$func$;

REVOKE ALL ON FUNCTION public.bump_row_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_row_version() TO service_role;

DROP TRIGGER IF EXISTS trg_row_version_user_preferences ON public.user_preferences;
create trigger trg_row_version_user_preferences
  before update on public.user_preferences
  for each row execute function public.bump_row_version();

DROP TRIGGER IF EXISTS trg_row_version_resumes ON public.resumes;
create trigger trg_row_version_resumes
  before update on public.resumes
  for each row execute function public.bump_row_version();

DROP TRIGGER IF EXISTS trg_row_version_applications ON public.applications;
create trigger trg_row_version_applications
  before update on public.applications
  for each row execute function public.bump_row_version();

DROP TRIGGER IF EXISTS trg_row_version_candidate_profiles ON public.candidate_profiles;
create trigger trg_row_version_candidate_profiles
  before update on public.candidate_profiles
  for each row execute function public.bump_row_version();

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP TRIGGER IF EXISTS trg_row_version_candidate_profiles ON public.candidate_profiles;
--   DROP TRIGGER IF EXISTS trg_row_version_applications ON public.applications;
--   DROP TRIGGER IF EXISTS trg_row_version_resumes ON public.resumes;
--   DROP TRIGGER IF EXISTS trg_row_version_user_preferences ON public.user_preferences;
--   DROP FUNCTION IF EXISTS public.bump_row_version();
--   ALTER TABLE public.candidate_profiles DROP COLUMN IF EXISTS row_version;
--   ALTER TABLE public.applications DROP COLUMN IF EXISTS row_version;
--   ALTER TABLE public.resumes DROP COLUMN IF EXISTS row_version;
--   ALTER TABLE public.user_preferences DROP COLUMN IF EXISTS row_version;
-- ============================================================================
