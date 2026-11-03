-- Migration: Ensure unique index on subscriptions(user_id) for safe upsert on conflict
create unique index if not exists idx_subscriptions_user_id_unique on public.subscriptions (user_id);
