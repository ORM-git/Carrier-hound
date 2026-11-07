-- ============================================================================
-- Migration: 20261107g_touch_updated_at_triggers.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261107g_touch_updated_at_triggers
--
-- Database rows "Auto-touch updated_at trigger" and "updated_at maintenance
-- trigger" (PARTIAL): "other updated_at set by app/RPC code".
--
-- What this changes once applied: a BEFORE UPDATE trigger on five user-owned
-- tables sets NEW.updated_at = now() when the UPDATE did not change updated_at
-- itself. A caller that sets updated_at explicitly keeps its value, so existing
-- writers behave as today; only writers that forgot to touch it are fixed.
-- Nothing rejects a write.
--
-- Tables (owner to confirm the list). Each already has an updated_at TIMESTAMPTZ
-- column in an earlier migration: candidate_profiles, applications,
-- user_preferences, resumes, tailored_resumes.
-- Deliberately NOT included: subscriptions and anything billing (payments stay
-- off, webhook-managed), jobs and ingest tables (their timestamps describe the
-- source data, not the row edit), and tables that already manage their own.
--
-- Interactions: trg_change_history_user_preferences (AFTER) will record the
-- touched updated_at in its images; trg_row_version_* (BEFORE, 20261107d) is
-- independent of this trigger.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $func$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$func$;

REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_updated_at() TO service_role;

DROP TRIGGER IF EXISTS trg_touch_updated_at_candidate_profiles ON public.candidate_profiles;
create trigger trg_touch_updated_at_candidate_profiles
  before update on public.candidate_profiles
  for each row execute function public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at_applications ON public.applications;
create trigger trg_touch_updated_at_applications
  before update on public.applications
  for each row execute function public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at_user_preferences ON public.user_preferences;
create trigger trg_touch_updated_at_user_preferences
  before update on public.user_preferences
  for each row execute function public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at_resumes ON public.resumes;
create trigger trg_touch_updated_at_resumes
  before update on public.resumes
  for each row execute function public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at_tailored_resumes ON public.tailored_resumes;
create trigger trg_touch_updated_at_tailored_resumes
  before update on public.tailored_resumes
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP TRIGGER IF EXISTS trg_touch_updated_at_tailored_resumes ON public.tailored_resumes;
--   DROP TRIGGER IF EXISTS trg_touch_updated_at_resumes ON public.resumes;
--   DROP TRIGGER IF EXISTS trg_touch_updated_at_user_preferences ON public.user_preferences;
--   DROP TRIGGER IF EXISTS trg_touch_updated_at_applications ON public.applications;
--   DROP TRIGGER IF EXISTS trg_touch_updated_at_candidate_profiles ON public.candidate_profiles;
--   DROP FUNCTION IF EXISTS public.touch_updated_at();
-- ============================================================================
