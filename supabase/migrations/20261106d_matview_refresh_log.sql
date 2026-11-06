-- ============================================================================
-- Migration: 20261106d_matview_refresh_log.sql
-- Purpose:   Matview staleness metric (audit DB #17). Postgres does not track
--            last-refresh time natively, so a stuck refresh was invisible.
--            This logs every successful refresh of
--            public.worldwide_company_counts so scripts/db-health.sql can
--            report real refresh recency.
-- Status:    NOT APPLIED - owner applies in the Supabase SQL editor, then runs
--            node scripts/record-migration.cjs 20261106d_matview_refresh_log
-- Covers:    audit row DB#17 (matview staleness metric).
-- Notes:     The refresh function keeps its original semantics (concurrent
--            refresh with non-concurrent fallback) and its pinned search_path.
--            The log insert is fail-open (BEGIN/EXCEPTION -> RAISE WARNING):
--            logging must never fail a refresh, matching the owner decision on
--            change-history triggers (20261106c).
-- Rollback:  CREATE OR REPLACE the function from 20261101_lock_scraper_metadata.sql;
--            DROP TABLE IF EXISTS public.matview_refresh_log;
-- ============================================================================

-- 1. Refresh log
create table if not exists public.matview_refresh_log (
  id            bigint generated always as identity primary key,
  matview_name  text not null,
  refreshed_at  timestamptz not null default now(),
  duration_ms   integer
);

create index if not exists idx_matview_refresh_log_name_time
  on public.matview_refresh_log (matview_name, refreshed_at desc);

-- Service-role only: ops telemetry, nothing for client roles.
alter table public.matview_refresh_log enable row level security;
revoke all on table public.matview_refresh_log from anon, authenticated;
grant all on table public.matview_refresh_log to service_role;

-- 2. Instrument the refresh function (same semantics as 20261101, plus logging)
create or replace function public.refresh_worldwide_company_counts()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_started   timestamptz := clock_timestamp();
  v_refreshed boolean := false;
begin
  -- Attempt concurrent refresh first so existing readers are never blocked
  begin
    refresh materialized view concurrently public.worldwide_company_counts;
    v_refreshed := true;
  exception when others then
    -- Fallback to non-concurrent refresh (e.g. when unpopulated)
    begin
      refresh materialized view public.worldwide_company_counts;
      v_refreshed := true;
    exception when others then
      raise warning 'worldwide_company_counts refresh failed: %', SQLERRM;
    end;
  end;

  -- Staleness metric: record every successful refresh. Fail-open.
  if v_refreshed then
    begin
      insert into public.matview_refresh_log (matview_name, duration_ms)
      values (
        'worldwide_company_counts',
        greatest(0, floor(extract(epoch from clock_timestamp() - v_started) * 1000)::int)
      );
    exception when others then
      raise warning 'matview_refresh_log insert failed: %', SQLERRM;
    end;
  end if;
end;
$func$;

-- Re-assert execution privileges (CREATE OR REPLACE preserves ACLs; be explicit)
revoke all on function public.refresh_worldwide_company_counts() from public, anon, authenticated;
grant execute on function public.refresh_worldwide_company_counts() to service_role;
