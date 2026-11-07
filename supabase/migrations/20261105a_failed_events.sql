-- Migration: 20261105a_failed_events.sql
-- Description: Add failed_events dead-letter table for async background tasks
-- Table: public.failed_events
-- Access: RLS enabled, deny-all to anon/authenticated, service_role only

create table if not exists public.failed_events (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  event_id text not null,
  payload jsonb not null default '{}'::jsonb,
  error text not null,
  attempts int not null default 1,
  status text not null default 'pending' check (status in ('pending', 'replayed', 'dead')),
  first_failed_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  next_retry_at timestamptz not null default now()
);

-- Unique constraint ensuring idempotency on (source, event_id)
create unique index if not exists idx_failed_events_source_event
  on public.failed_events (source, event_id);

-- Operational index for querying pending events ready for retry
create index if not exists idx_failed_events_pending_retry
  on public.failed_events (status, next_retry_at)
  where status = 'pending';

-- Row Level Security (deny-all to anon/authenticated, service_role only)
alter table public.failed_events enable row level security;

revoke all on public.failed_events from public, anon, authenticated;
grant all on public.failed_events to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_failed_events_source_event;
--   DROP INDEX IF EXISTS public.idx_failed_events_pending_retry;
--   ALTER TABLE public.failed_events DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.failed_events CASCADE;
--   REVOKE ALL ON public.failed_events FROM service_role;
--   GRANT ALL ON public.failed_events TO public, anon, authenticated;
-- ============================================================================
