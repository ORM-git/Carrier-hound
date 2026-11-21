-- ============================================================================
-- Migration: 20261121a_error_events.sql
-- Purpose:   In-product view of server request errors for the owner
--            (/admin/errors). reportRequestErrorToSentry also writes one row
--            per error here, best-effort; the admin route groups the last
--            7 days by (route, stack_hash) and sums count.
-- Status:    NOT APPLIED - owner applies in the Supabase SQL editor, then runs
--            node scripts/record-migration.cjs 20261121a_error_events
-- Notes:     Until applied, the reporter's insert fails silently (fail-open)
--            and /api/admin/errors returns 500 with the PostgREST error.
--            error_message is truncated to 500 chars by the writer; route is
--            the URL pathname only (no query string). Service role only.
-- Rollback:  DROP TABLE IF EXISTS public.error_events;
-- ============================================================================

create table if not exists public.error_events (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  route          text not null,
  error_message  text not null,
  stack_hash     text not null,
  user_id        uuid null references auth.users (id) on delete set null,
  count          integer not null default 1 check (count > 0)
);

create index if not exists idx_error_events_occurred_at
  on public.error_events (occurred_at desc);

alter table public.error_events enable row level security;

revoke all on table public.error_events from anon, authenticated;
grant all on table public.error_events to service_role;
