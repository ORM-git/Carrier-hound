-- ============================================================================
-- Migration: 20261123a_grant_tombstone_delete_to_service_role.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor when rolling out
--   account deletion recovery.
--
-- What this does:
--   Grants DELETE on public.deleted_account_tombstones to service_role so
--   cancelled deletion recovery requests can remove the tombstone cleanly.
--   Complements 20261106h_soft_delete_tombstones.sql which granted SELECT, INSERT, UPDATE.
-- ============================================================================

DO $$ BEGIN
  IF to_regclass('public.deleted_account_tombstones') IS NOT NULL THEN
    GRANT DELETE ON public.deleted_account_tombstones TO service_role;
  END IF;
END $$;
