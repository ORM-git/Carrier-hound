-- ============================================================================
-- Migration: 20261108c_matview_refresh_deferred.sql
-- Purpose:   Decouple materialized view refresh from ingest transactions (DB #68).
--            Previously, trigger_refresh_worldwide_company_counts executed
--            refresh_worldwide_company_counts() directly inside the ingest_runs
--            transaction. In PostgreSQL, REFRESH MATERIALIZED VIEW CONCURRENTLY
--            cannot execute inside a transaction block, which caused it to throw
--            an exception and silently downgrade to a blocking refresh.
--            This migration refactors to a deferred path:
--              1. The trigger function only records a refresh request (dirty flag
--                 in public.matview_refresh_control) without refreshing in-tx.
--              2. A separate service-role-only function (process_deferred_matview_refresh)
--                 processes the refresh post-commit, attempting CONCURRENTLY first,
--                 with blocking fallback explicitly logged via RAISE WARNING rather
--                 than silently downgraded.
--              3. Preserves existing scheduled matview refresh and matview_refresh_log.
-- Status:    NOT APPLIED - apply manually in Supabase SQL editor, then record:
--            node scripts/record-migration.cjs 20261108c_matview_refresh_deferred
-- Covers:    audit row DB#68 (decoupled matview refresh).
-- Notes:     RLS enabled on control table (service-role only; no anon/authenticated).
--            SECURITY DEFINER with pinned search_path = public, pg_temp on all functions.
-- Rollback:  See ROLLBACK section at bottom.
-- ============================================================================

-- 1. Control table for tracking deferred refresh requests
create table if not exists public.matview_refresh_control (
  matview_name       text primary key,
  is_dirty           boolean not null default true,
  requested_at       timestamptz not null default now(),
  last_refreshed_at  timestamptz,
  last_refresh_mode  text check (last_refresh_mode in ('concurrent', 'blocking', 'failed'))
);

create index if not exists idx_matview_refresh_control_dirty
  on public.matview_refresh_control (is_dirty)
  where is_dirty = true;

-- Enable RLS: service-role only, no access for anon or authenticated
alter table public.matview_refresh_control enable row level security;
revoke all on table public.matview_refresh_control from anon, authenticated;
grant all on table public.matview_refresh_control to service_role;

-- Seed initial control row for worldwide_company_counts
insert into public.matview_refresh_control (matview_name, is_dirty, requested_at)
values ('worldwide_company_counts', false, now())
on conflict (matview_name) do nothing;

-- 2. Trigger function updated to record deferred request instead of running refresh
create or replace function public.on_ingest_run_completed_refresh_worldwide()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Record the deferred refresh request (set dirty flag) in control table.
  -- Does NOT execute refresh inside the transaction, preventing transaction lock contention
  -- and avoiding exception downgrade from concurrent to blocking refresh.
  insert into public.matview_refresh_control (matview_name, is_dirty, requested_at)
  values ('worldwide_company_counts', true, clock_timestamp())
  on conflict (matview_name) do update
    set is_dirty = true,
        requested_at = excluded.requested_at;

  return new;
end;
$$;

revoke all on function public.on_ingest_run_completed_refresh_worldwide() from public, anon, authenticated;

-- 3. Dedicated service-role function to process deferred matview refreshes post-commit
create or replace function public.process_deferred_matview_refresh(
  p_matview text default 'worldwide_company_counts'
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_is_dirty boolean := false;
  v_started timestamptz;
  v_refreshed boolean := false;
  v_mode text := 'concurrent';
  v_concurrent_err text;
begin
  -- 1. Check if the matview has a pending refresh request
  select is_dirty into v_is_dirty
  from public.matview_refresh_control
  where matview_name = p_matview;

  -- If not dirty (no pending request), exit early without refreshing
  if not coalesce(v_is_dirty, false) then
    return false;
  end if;

  v_started := clock_timestamp();

  -- 2. Process refresh: attempt REFRESH CONCURRENTLY first
  begin
    if p_matview = 'worldwide_company_counts' then
      refresh materialized view concurrently public.worldwide_company_counts;
      v_refreshed := true;
      v_mode := 'concurrent';
    else
      raise warning 'Unknown materialized view: %', p_matview;
      return false;
    end if;
  exception when others then
    v_concurrent_err := SQLERRM;
    -- Explicitly log fallback rather than silently downgrading
    raise warning 'Materialized view % concurrent refresh failed (%), falling back to blocking refresh',
      p_matview, v_concurrent_err;

    begin
      if p_matview = 'worldwide_company_counts' then
        refresh materialized view public.worldwide_company_counts;
        v_refreshed := true;
        v_mode := 'blocking';
      end if;
    exception when others then
      raise warning 'Materialized view % blocking refresh failed: %', p_matview, SQLERRM;
      v_mode := 'failed';
    end;
  end;

  -- 3. Update control table state and record telemetry log
  if v_refreshed then
    update public.matview_refresh_control
    set is_dirty = false,
        last_refreshed_at = clock_timestamp(),
        last_refresh_mode = v_mode
    where matview_name = p_matview;

    -- Existing staleness metric log (fail-open)
    begin
      insert into public.matview_refresh_log (matview_name, duration_ms)
      values (
        p_matview,
        greatest(0, floor(extract(epoch from clock_timestamp() - v_started) * 1000)::int)
      );
    exception when others then
      raise warning 'matview_refresh_log insert failed: %', SQLERRM;
    end;

    return true;
  else
    -- Refresh failed, record failed mode in control table
    update public.matview_refresh_control
    set last_refreshed_at = clock_timestamp(),
        last_refresh_mode = 'failed'
    where matview_name = p_matview;

    return false;
  end if;
end;
$func$;

revoke all on function public.process_deferred_matview_refresh(text) from public, anon, authenticated;
grant execute on function public.process_deferred_matview_refresh(text) to service_role;

-- 4. Instrument existing direct refresh function with logged fallback and control reset
create or replace function public.refresh_worldwide_company_counts()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $func$
declare
  v_started   timestamptz := clock_timestamp();
  v_refreshed boolean := false;
  v_mode      text := 'concurrent';
  v_err       text;
begin
  -- Attempt concurrent refresh first so existing readers are never blocked
  begin
    refresh materialized view concurrently public.worldwide_company_counts;
    v_refreshed := true;
    v_mode := 'concurrent';
  exception when others then
    v_err := SQLERRM;
    -- Log the fallback warning rather than silently downgrading
    raise warning 'worldwide_company_counts concurrent refresh failed (%), falling back to blocking refresh', v_err;
    begin
      refresh materialized view public.worldwide_company_counts;
      v_refreshed := true;
      v_mode := 'blocking';
    exception when others then
      raise warning 'worldwide_company_counts refresh failed: %', SQLERRM;
      v_mode := 'failed';
    end;
  end;

  -- Reset dirty flag on control table if refreshed
  if v_refreshed then
    begin
      update public.matview_refresh_control
      set is_dirty = false,
          last_refreshed_at = clock_timestamp(),
          last_refresh_mode = v_mode
      where matview_name = 'worldwide_company_counts';
    exception when others then
      -- Fail-open: control table update must never abort refresh
      null;
    end;

    -- Staleness metric: record every successful refresh. Fail-open.
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

revoke all on function public.refresh_worldwide_company_counts() from public, anon, authenticated;
grant execute on function public.refresh_worldwide_company_counts() to service_role;

-- ==============================================================================
-- 5. READ-ONLY CATALOG VERIFICATION CHECKS
-- ==============================================================================
-- Run these queries in the Supabase SQL editor to verify correct privileges and schema:
--
-- 1. Verify matview_refresh_control table exists and has RLS enabled:
-- SELECT relrowsecurity FROM pg_class WHERE relname = 'matview_refresh_control'; -- Must be: true
--
-- 2. Verify anon and authenticated cannot access matview_refresh_control:
-- SELECT has_table_privilege('anon', 'public.matview_refresh_control', 'SELECT') AS anon_control_select; -- Must be: false
-- SELECT has_table_privilege('authenticated', 'public.matview_refresh_control', 'SELECT') AS auth_control_select; -- Must be: false
-- SELECT has_table_privilege('service_role', 'public.matview_refresh_control', 'SELECT') AS service_control_select; -- Must be: true
--
-- 3. Verify anon cannot execute process_deferred_matview_refresh:
-- SELECT has_function_privilege('anon', 'public.process_deferred_matview_refresh(text)', 'EXECUTE') AS anon_proc_exec; -- Must be: false
-- SELECT has_function_privilege('service_role', 'public.process_deferred_matview_refresh(text)', 'EXECUTE') AS service_proc_exec; -- Must be: true
--
-- 4. Verify trigger function points to deferred path (contains matview_refresh_control):
-- SELECT prosrc LIKE '%matview_refresh_control%' AS trigger_is_deferred
-- FROM pg_proc WHERE proname = 'on_ingest_run_completed_refresh_worldwide'; -- Must be: true

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--
-- 1. Restore trigger function from 20261101_lock_scraper_metadata.sql:
--   CREATE OR REPLACE FUNCTION public.on_ingest_run_completed_refresh_worldwide()
--   RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
--   BEGIN PERFORM public.refresh_worldwide_company_counts(); RETURN NEW; END; $$;
--
-- 2. Restore refresh_worldwide_company_counts() from 20261106d_matview_refresh_log.sql:
--   (see 20261106d_matview_refresh_log.sql lines 37-78)
--
-- 3. Drop deferred refresh processing function:
--   DROP FUNCTION IF EXISTS public.process_deferred_matview_refresh(text);
--
-- 4. Drop control table:
--   DROP TABLE IF EXISTS public.matview_refresh_control;
-- ============================================================================
