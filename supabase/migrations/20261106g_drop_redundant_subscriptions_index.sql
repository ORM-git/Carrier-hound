-- ==============================================================================
-- Migration: 20261106g_drop_redundant_subscriptions_index.sql
-- Date: 2026-11-06
-- Status: NOT APPLIED - owner must run this file in the Supabase SQL editor, then
--         record it with:  node scripts/record-migration.cjs 20261106g_drop_redundant_subscriptions_index
-- Scope: Database row "Redundant index cleanup" - idx_subscriptions_user_id is a
--        plain btree on subscriptions(user_id) that duplicates the unique index
--        backing CONSTRAINT subscriptions_user_unique UNIQUE (user_id)
--        (20261008_phase3_subscriptions_and_billing.sql). Every insert/update pays
--        for both. The unique constraint stays; uniqueness and lookups are unchanged.
--        Note: idx_subscriptions_user_id_unique (20261103f) also overlaps the same
--        constraint; left in place deliberately - drop candidates belong to a
--        separate review.
-- Locking: plain DROP INDEX on this per-user table takes a sub-second lock; the
--        CONCURRENTLY variant cannot run inside the SQL editor's implicit
--        transaction handling for multi-statement scripts, so it is not used.
-- Rollback: CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.subscriptions(user_id);
-- ==============================================================================

drop index if exists public.idx_subscriptions_user_id;

-- Rollback:
--   create index if not exists idx_subscriptions_user_id on public.subscriptions(user_id);
