-- ============================================================================
-- Migration: 20261106e_push_subscriptions.sql
-- Purpose:   Web Push subscription storage (Backend sheet rank 13). Stores
--            browser push subscriptions so a future dispatcher can send
--            web-push notifications. Repo-side scaffolding only: no sender
--            ships until the owner makes the product decision (docs/
--            push-notifications.md).
-- Status:    NOT APPLIED - owner applies in the Supabase SQL editor, then runs
--            node scripts/record-migration.cjs 20261106e_push_subscriptions
-- Covers:    Backend sheet rank 13 (push notifications).
-- Notes:     RLS: users manage only their own subscriptions; the service
--            role bypasses RLS for the future dispatcher. Endpoint is unique
--            per spec (one browser subscription = one endpoint URL).
-- Rollback:  DROP TABLE IF EXISTS public.push_subscriptions;
-- ============================================================================

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);

create index if not exists idx_push_subscriptions_user
  on public.push_subscriptions (user_id)
  where revoked_at is null;

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_owner_select" on public.push_subscriptions;
create policy "push_subscriptions_owner_select"
  on public.push_subscriptions for select
  using (auth.uid() = user_id);

drop policy if exists "push_subscriptions_owner_insert" on public.push_subscriptions;
create policy "push_subscriptions_owner_insert"
  on public.push_subscriptions for insert
  with check (auth.uid() = user_id);

drop policy if exists "push_subscriptions_owner_update" on public.push_subscriptions;
create policy "push_subscriptions_owner_update"
  on public.push_subscriptions for update
  using (auth.uid() = user_id);

drop policy if exists "push_subscriptions_owner_delete" on public.push_subscriptions;
create policy "push_subscriptions_owner_delete"
  on public.push_subscriptions for delete
  using (auth.uid() = user_id);
