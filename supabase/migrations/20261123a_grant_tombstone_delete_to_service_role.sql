-- ============================================================================
-- Migration: 20261123a_grant_tombstone_delete_to_service_role.sql
-- STATUS: NOT APPLIED - apply this standalone statement in autocommit mode,
-- outside BEGIN/COMMIT, DO blocks, functions or transactional migration runners.
-- Review docs/ops/account-deletion-preflight.md before applying, then record:
--   node scripts/record-migration.cjs 20261123a_grant_tombstone_delete_to_service_role
--
-- Account Deletion Tombstone Permissions:
-- Grants DELETE on public.deleted_account_tombstones to service_role to support
-- account deletion cancellation and cleanup.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

GRANT DELETE ON public.deleted_account_tombstones TO service_role;

-- ============================================================================
-- ROLLBACK (run manually as one autocommit statement, never in a transaction):
--   REVOKE DELETE ON public.deleted_account_tombstones FROM service_role;
-- ============================================================================
