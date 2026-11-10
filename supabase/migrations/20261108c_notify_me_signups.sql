-- ==============================================================================
-- Migration: 20261108c_notify_me_signups.sql
-- Date: 2026-11-10
-- Status: NOT APPLIED - owner must run this file in the Supabase SQL editor, then
--         record it with:  node scripts/record-migration.cjs 20261108c_notify_me_signups
-- Scope: Backend task 1, notify-me email list (table public.notify_me_signups).
--        Inserts happen via /api/notify-me using service_role only.
-- Rollback: DROP TABLE IF EXISTS public.notify_me_signups;
-- ==============================================================================

-- 1. Create notify_me_signups table
create table if not exists public.notify_me_signups (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  source      text default 'pricing',
  created_at  timestamptz default now(),
  constraint notify_me_signups_email_check check (char_length(email) <= 254 and position('@' in email) > 1)
);

-- 2. Indexes: unique index on lower(email) and timeline ordering
create unique index if not exists idx_notify_me_signups_lower_email
  on public.notify_me_signups (lower(email));

create index if not exists idx_notify_me_signups_created_at
  on public.notify_me_signups (created_at desc);

-- 3. Row Level Security & Service-Role Grants
alter table public.notify_me_signups enable row level security;

-- Client roles (anon, authenticated) have no direct access.
revoke all on table public.notify_me_signups from anon, authenticated;
grant select, insert on table public.notify_me_signups to service_role;

comment on table public.notify_me_signups is
  'Email signups for feature/plan launch notifications. Inserted exclusively by /api/notify-me via service role.';

-- ==============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP TABLE IF EXISTS public.notify_me_signups;
-- ==============================================================================
