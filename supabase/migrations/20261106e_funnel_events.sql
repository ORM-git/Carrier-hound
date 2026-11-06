-- ==============================================================================
-- Migration: 20261106e_funnel_events.sql
-- Date: 2026-11-06
-- Status: NOT APPLIED - owner must run this file in the Supabase SQL editor, then
--         record it with:  node scripts/record-migration.cjs 20261106e_funnel_events
-- Scope: Backend row "Funnel Tracking" - storage for signup -> onboard -> apply
--        funnel events. Inserts go through /api/track (eventType: "funnel") with a
--        server-side allowlist; the table itself is service_role only.
-- Rollback: DROP TABLE IF EXISTS public.funnel_events;
-- ==============================================================================

create table if not exists public.funnel_events (
  id uuid primary key default gen_random_uuid(),
  -- Funnel stage, allowlisted both here and in src/app/api/track/route.ts
  -- (ALLOWED_FUNNEL_EVENTS). The static test asserts both lists stay identical.
  event text not null check (
    event in (
      'signup_started',
      'signup_completed',
      'onboarding_started',
      'onboarding_completed',
      'apply_started',
      'apply_completed'
    )
  ),
  -- Signed-in actor when available; derived server-side from the session, never
  -- trusted from the request body. Pre-signup events have NULL here.
  user_id uuid references auth.users(id) on delete set null,
  -- Client-generated pseudonymous id tying pre-signup events to the later
  -- signup. Random token, no PII; capped at 64 chars app-side.
  anonymous_id text,
  path text,
  ip_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_funnel_events_event_created_at
  on public.funnel_events (event, created_at desc);
create index if not exists idx_funnel_events_created_at
  on public.funnel_events (created_at desc);
create index if not exists idx_funnel_events_user_id
  on public.funnel_events (user_id, created_at desc);
create index if not exists idx_funnel_events_anonymous_id
  on public.funnel_events (anonymous_id, created_at desc);

alter table public.funnel_events enable row level security;

-- Client roles get nothing; inserts happen via the service role in /api/track.
revoke all on table public.funnel_events from anon, authenticated;
grant all on table public.funnel_events to service_role;

comment on table public.funnel_events is
  'Signup->onboard->apply funnel events, inserted by /api/track (eventType=funnel). Service-role only. NOTE: add to purge_operational_logs retention classes when a retention window is agreed.';

-- Rollback:
--   drop table if exists public.funnel_events;
