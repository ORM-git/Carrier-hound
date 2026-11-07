-- Migration: 20261104a_global_ai_budget.sql
-- Hard global daily AI token budget and concurrency cap (cost-abuse gate).
-- Apply order: after every 20261103a-h migration.
--
-- Verification queries (run via service_role):
--   select proname from pg_proc where proname like 'ai_%';
--   select * from public.ai_global_budget_reserve(current_date, 1000, 2000000);
--   select public.ai_global_budget_settle(current_date, 1000, 850);
--   select public.ai_concurrency_acquire('test-lease-init', 25, 60);
--   select public.ai_concurrency_release('test-lease-init');

-- 1. Daily Token Budget Table
create table if not exists public.ai_global_budget_daily (
  period_date date primary key,
  reserved_tokens bigint not null default 0,
  used_tokens bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.ai_global_budget_daily enable row level security;
revoke all on table public.ai_global_budget_daily from public, anon, authenticated;
grant all on table public.ai_global_budget_daily to service_role;

-- 2. Concurrency Leases Table
create table if not exists public.ai_concurrency_leases (
  lease_id text primary key,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_ai_concurrency_leases_expires
  on public.ai_concurrency_leases (expires_at);

alter table public.ai_concurrency_leases enable row level security;
revoke all on table public.ai_concurrency_leases from public, anon, authenticated;
grant all on table public.ai_concurrency_leases to service_role;

-- 3. Atomic Token Budget Reservation RPC
-- Atomically checks if (used_tokens + reserved_tokens + p_tokens) <= p_cap.
-- If allowed, increments reserved_tokens and returns allowed = true with remaining budget.
-- If cap reached, leaves row unchanged and returns allowed = false with remaining budget.
create or replace function public.ai_global_budget_reserve(
  p_period date,
  p_tokens bigint,
  p_cap bigint
)
returns table(allowed boolean, remaining bigint)
language plpgsql
security definer
as $$
declare
  v_used bigint := 0;
  v_reserved bigint := 0;
  v_new_reserved bigint;
  v_allowed boolean := false;
  v_remaining bigint := 0;
begin
  -- Ensure period row exists
  insert into public.ai_global_budget_daily (period_date, reserved_tokens, used_tokens, updated_at)
  values (p_period, 0, 0, now())
  on conflict (period_date) do nothing;

  -- Lock row exclusively for atomic evaluation
  select used_tokens, reserved_tokens
  into v_used, v_reserved
  from public.ai_global_budget_daily
  where period_date = p_period
  for update;

  if (v_used + v_reserved + p_tokens) <= p_cap then
    v_allowed := true;
    v_new_reserved := v_reserved + p_tokens;
    update public.ai_global_budget_daily
    set reserved_tokens = v_new_reserved,
        updated_at = now()
    where period_date = p_period;
    v_remaining := p_cap - (v_used + v_new_reserved);
  else
    v_allowed := false;
    v_remaining := greatest(0::bigint, p_cap - (v_used + v_reserved));
  end if;

  return query select v_allowed, v_remaining;
end;
$$;

revoke all on function public.ai_global_budget_reserve(date, bigint, bigint) from public, anon, authenticated;
grant execute on function public.ai_global_budget_reserve(date, bigint, bigint) to service_role;

-- 4. Atomic Token Budget Settlement RPC
-- Releases unused reservation tokens (p_reserved) and records actual usage (p_actual).
create or replace function public.ai_global_budget_settle(
  p_period date,
  p_reserved bigint,
  p_actual bigint
)
returns void
language plpgsql
security definer
as $$
begin
  update public.ai_global_budget_daily
  set reserved_tokens = greatest(0::bigint, reserved_tokens - p_reserved),
      used_tokens = used_tokens + greatest(0::bigint, p_actual),
      updated_at = now()
  where period_date = p_period;
end;
$$;

revoke all on function public.ai_global_budget_settle(date, bigint, bigint) from public, anon, authenticated;
grant execute on function public.ai_global_budget_settle(date, bigint, bigint) to service_role;

-- 5. Concurrency Acquire RPC
-- Purges expired leases, counts active leases under exclusive table lock,
-- and inserts a new lease if under capacity.
create or replace function public.ai_concurrency_acquire(
  p_lease_id text,
  p_cap int,
  p_ttl_seconds int default 60
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_count int;
  v_ttl int := coalesce(nullif(p_ttl_seconds, 0), 60);
begin
  -- Exclusively serialize active concurrency count + insert
  lock table public.ai_concurrency_leases in exclusive mode;

  -- 1. Purge expired leases
  delete from public.ai_concurrency_leases
  where expires_at <= now();

  -- 2. Count active leases
  select count(*) into v_count
  from public.ai_concurrency_leases;

  -- 3. Check cap and acquire
  if v_count < p_cap then
    insert into public.ai_concurrency_leases (lease_id, acquired_at, expires_at)
    values (
      p_lease_id,
      now(),
      now() + (v_ttl || ' seconds')::interval
    )
    on conflict (lease_id) do update
      set expires_at = now() + (v_ttl || ' seconds')::interval;
    return true;
  else
    return false;
  end if;
end;
$$;

revoke all on function public.ai_concurrency_acquire(text, int, int) from public, anon, authenticated;
grant execute on function public.ai_concurrency_acquire(text, int, int) to service_role;

-- 6. Concurrency Release RPC
-- Releases acquired lease on request termination.
create or replace function public.ai_concurrency_release(
  p_lease_id text
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_deleted boolean;
begin
  delete from public.ai_concurrency_leases
  where lease_id = p_lease_id;
  v_deleted := found;
  return v_deleted;
end;
$$;

revoke all on function public.ai_concurrency_release(text) from public, anon, authenticated;
grant execute on function public.ai_concurrency_release(text) to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_ai_concurrency_leases_expires;
--   ALTER TABLE public.ai_global_budget_daily DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.ai_concurrency_leases DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.ai_global_budget_daily CASCADE;
--   DROP TABLE IF EXISTS public.ai_concurrency_leases CASCADE;
--   DROP FUNCTION IF EXISTS public.ai_global_budget_reserve(p_period date, p_tokens bigint, p_cap bigint);
--   DROP FUNCTION IF EXISTS public.ai_global_budget_settle(p_period date, p_reserved bigint, p_actual bigint);
--   DROP FUNCTION IF EXISTS public.ai_concurrency_acquire(p_lease_id text, p_cap int, p_ttl_seconds int);
--   DROP FUNCTION IF EXISTS public.ai_concurrency_release(p_lease_id text);
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================
