-- Migration: 20261105b_web_vitals.sql
-- Description: Core Web Vitals telemetry table for Real User Monitoring (RUM)
-- Table: public.web_vitals
-- Access: Row Level Security enabled, revoke all from anon and authenticated, service_role only

create table if not exists public.web_vitals (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name in ('LCP', 'INP', 'CLS', 'TTFB', 'FCP')),
  value double precision not null check (value >= 0),
  rating text check (rating in ('good', 'needs-improvement', 'poor')),
  route text not null,
  navigation_type text,
  created_at timestamptz not null default now()
);

-- Operational indexes for aggregating performance metrics by name and route over time
create index if not exists idx_web_vitals_name_route_created_at
  on public.web_vitals (name, route, created_at desc);

create index if not exists idx_web_vitals_created_at
  on public.web_vitals (created_at desc);

-- Row Level Security (deny-all to anon/authenticated, service_role only)
alter table public.web_vitals enable row level security;

-- Revoke all permissions from anon, authenticated, and public
revoke all on public.web_vitals from public, anon, authenticated;

-- Grant access to service_role only
grant all on public.web_vitals to service_role;
