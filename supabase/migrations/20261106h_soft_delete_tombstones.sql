-- ============================================================================
-- Migration: 20261106h_soft_delete_tombstones.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106h_soft_delete_tombstones
--
-- Database rows #1 (Soft Deletes), #5 (Anonymization on delete),
-- #26 (deleted_at tombstones).
--
-- What this does:
--   1. Adds `deleted_at` (soft-delete marker) to every user-owned content
--      table the account-deletion flow touches, plus `anonymized_at` on
--      early_access_emails (guarded by to_regclass so absent tables are skipped).
--   2. Adds `deleted_account_tombstones`: a minimal, PII-free audit record
--      (user_id + SHA-256 email hash + timestamps + purge deadline) kept
--      after the auth identity is removed. This is the "undo / retention
--      window" anchor: account data is recoverable for 30 days, then the
--      purge function hard-deletes the soft-deleted rows.
--   3. Adds purge_soft_deleted_account_data() to hard-delete rows past the
--      retention window. Call it from pg_cron / an Edge cron (owner step,
--      see Database row #21) or manually.
--
-- Retention window: 30 days (best-practice default for account-deletion
-- undo windows; adjust the interval argument when calling the purge).
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

-- 1. Soft-delete columns (guarded by to_regclass so missing tables are skipped)

DO $$ BEGIN
  IF to_regclass('public.candidate_profiles') IS NOT NULL THEN
    ALTER TABLE public.candidate_profiles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.user_preferences') IS NOT NULL THEN
    ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.resumes') IS NOT NULL THEN
    ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.tailored_resumes') IS NOT NULL THEN
    ALTER TABLE public.tailored_resumes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.saved_jobs') IS NOT NULL THEN
    ALTER TABLE public.saved_jobs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.applications') IS NOT NULL THEN
    ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.job_applications') IS NOT NULL THEN
    ALTER TABLE public.job_applications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.search_alerts') IS NOT NULL THEN
    ALTER TABLE public.search_alerts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.daily_digests') IS NOT NULL THEN
    ALTER TABLE public.daily_digests ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.ai_usage_quotas') IS NOT NULL THEN
    ALTER TABLE public.ai_usage_quotas ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.ai_usage_ledger') IS NOT NULL THEN
    ALTER TABLE public.ai_usage_ledger ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.page_views') IS NOT NULL THEN
    ALTER TABLE public.page_views ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.user_roles') IS NOT NULL THEN
    ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.user_consents') IS NOT NULL THEN
    ALTER TABLE public.user_consents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.early_access_emails') IS NOT NULL THEN
    ALTER TABLE public.early_access_emails ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE public.early_access_emails ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
  END IF;
END $$;

-- Partial indexes keep the purge scan cheap without bloating hot paths.
DO $$ BEGIN
  IF to_regclass('public.candidate_profiles') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_candidate_profiles_deleted_at ON public.candidate_profiles (deleted_at) WHERE deleted_at IS NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.resumes') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_resumes_deleted_at ON public.resumes (deleted_at) WHERE deleted_at IS NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.applications') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_applications_deleted_at ON public.applications (deleted_at) WHERE deleted_at IS NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.job_applications') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_job_applications_deleted_at ON public.job_applications (deleted_at) WHERE deleted_at IS NOT NULL;
  END IF;
END $$;

-- 2. Tombstones --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.deleted_account_tombstones (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL,
  email_hash            TEXT NOT NULL,  -- SHA-256 hex of the lowercase email; lookup without PII
  deletion_completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hard_delete_after     TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days',
  purged_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deleted_account_tombstones_user_id
  ON public.deleted_account_tombstones (user_id);
CREATE INDEX IF NOT EXISTS idx_deleted_account_tombstones_purge_due
  ON public.deleted_account_tombstones (hard_delete_after) WHERE purged_at IS NULL;

ALTER TABLE public.deleted_account_tombstones ENABLE ROW LEVEL SECURITY;

-- No client access; only the service role (account-deletion flow) reads/writes.
REVOKE ALL ON public.deleted_account_tombstones FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.deleted_account_tombstones TO service_role;

-- 3. Purge function ----------------------------------------------------------
-- Hard-deletes soft-deleted rows whose retention window has elapsed and marks
-- the matching tombstones as purged. Fail-open per audit/history convention:
-- a failing table is reported as a WARNING and skipped, never aborts the run.

CREATE OR REPLACE FUNCTION public.purge_soft_deleted_account_data(
  retention INTERVAL DEFAULT INTERVAL '30 days'
)
RETURNS TABLE(purged_table TEXT, purged_rows BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cutoff TIMESTAMPTZ := now() - retention;
  t TEXT;
  n BIGINT;
  tables TEXT[] := ARRAY[
    'candidate_profiles', 'user_preferences', 'resumes', 'tailored_resumes',
    'saved_jobs', 'applications', 'job_applications', 'search_alerts',
    'daily_digests', 'ai_usage_quotas', 'ai_usage_ledger', 'page_views',
    'user_roles', 'user_consents', 'early_access_emails'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE deleted_at IS NOT NULL AND deleted_at < $1', t)
        USING cutoff;
      GET DIAGNOSTICS n = ROW_COUNT;
      purged_table := t;
      purged_rows := n;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'purge_soft_deleted_account_data: skipping %: %', t, SQLERRM;
    END;
  END LOOP;

  UPDATE public.deleted_account_tombstones
    SET purged_at = now()
    WHERE purged_at IS NULL AND hard_delete_after < now();
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'purge_soft_deleted_account_data: tombstone update failed: %', SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_soft_deleted_account_data(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_soft_deleted_account_data(INTERVAL) TO service_role;

-- ============================================================================
-- ROLLBACK (run manually if this must be undone):
--   DROP FUNCTION IF EXISTS public.purge_soft_deleted_account_data(INTERVAL);
--   DROP TABLE IF EXISTS public.deleted_account_tombstones;
--   ALTER TABLE public.candidate_profiles  DROP COLUMN IF EXISTS deleted_at;
--   ... (repeat DROP COLUMN for each table above; anonymized_at on
--        early_access_emails)
-- ============================================================================
