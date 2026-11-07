-- Migration: Ensure unique index on subscriptions(user_id) for safe upsert on conflict
create unique index if not exists idx_subscriptions_user_id_unique on public.subscriptions (user_id);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_subscriptions_user_id_unique;
-- ============================================================================
