-- Migration: 20261105b_email_suppressions.sql
-- Description: Add email_suppressions table to prevent sending emails to bounced, unsubscribed, or blocked addresses
-- Table: public.email_suppressions
-- Access: RLS enabled, deny-all to anon/authenticated, service_role only

create table if not exists public.email_suppressions (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) <= 254 and position('@' in email) > 1),
  reason text not null default 'manual' check (reason in ('bounce', 'complaint', 'unsubscribe', 'manual', 'invalid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive unique index on email
create unique index if not exists idx_email_suppressions_lower_email
  on public.email_suppressions (lower(email));

-- Operational index for querying recent suppressions
create index if not exists idx_email_suppressions_created_at
  on public.email_suppressions (created_at desc);

-- Row Level Security (deny-all to anon/authenticated, service_role only)
alter table public.email_suppressions enable row level security;

revoke all on public.email_suppressions from public, anon, authenticated;
grant all on public.email_suppressions to service_role;

-- Enforce lowercase email on write (insert / update)
create or replace function public.trg_email_suppressions_lowercase()
returns trigger as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_email_suppressions_lowercase on public.email_suppressions;
create trigger trg_email_suppressions_lowercase
  before insert or update on public.email_suppressions
  for each row execute function public.trg_email_suppressions_lowercase();

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP TRIGGER IF EXISTS trg_email_suppressions_lowercase ON public.email_suppressions;
--   DROP INDEX IF EXISTS public.idx_email_suppressions_lower_email;
--   DROP INDEX IF EXISTS public.idx_email_suppressions_created_at;
--   ALTER TABLE public.email_suppressions DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.email_suppressions CASCADE;
--   DROP FUNCTION IF EXISTS public.trg_email_suppressions_lowercase();
--   REVOKE ALL ON public.email_suppressions FROM service_role;
--   GRANT ALL ON public.email_suppressions TO public, anon, authenticated;
-- ============================================================================
