-- Migration: 20261103d_consume_atomic_fn.sql
-- Atomic quota consumption and refund with advisory locking, IST daily cap, and credit row tracking

-- 1. Add nullable credit_id column to plan_usage_events referencing user_addon_credits
alter table public.plan_usage_events
  add column if not exists credit_id uuid references public.user_addon_credits(id) on delete set null;

-- Index for efficient credit refund and usage correlation
create index if not exists idx_plan_usage_credit_id
  on public.plan_usage_events(credit_id)
  where credit_id is not null;

-- 2. Atomic Plan Set Consumption
create or replace function public.consume_plan_set(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text,
  p_period_start timestamptz,
  p_quota int,
  p_daily_cap int default 30,
  p_day_start timestamptz default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing record;
  v_daily_count int := 0;
  v_plan_count int := 0;
begin
  -- Serializes operations per user across concurrent requests
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 1. Check idempotency: repeat key returns earlier result without burning twice
  select id, source, credit_id into v_existing
  from public.plan_usage_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true
    );
  end if;

  -- 2. Daily Cap check (IST day)
  if p_day_start is not null then
    select count(*) into v_daily_count
    from public.plan_usage_events
    where user_id = p_user_id and created_at >= p_day_start;

    if v_daily_count >= p_daily_cap then
      return jsonb_build_object(
        'success', false,
        'code', 'DAILY_LIMIT_REACHED',
        'error', 'Daily fair-use limit reached. Resets daily at midnight IST.'
      );
    end if;
  end if;

  -- 3. Plan Quota check for current stepped period
  select count(*) into v_plan_count
  from public.plan_usage_events
  where user_id = p_user_id
    and source = 'plan'
    and kind = p_kind
    and created_at >= p_period_start;

  if v_plan_count >= p_quota then
    return jsonb_build_object(
      'success', false,
      'code', 'PLAN_QUOTA_EXHAUSTED',
      'error', 'Plan quota exhausted for current period'
    );
  end if;

  -- 4. Record event
  begin
    insert into public.plan_usage_events (user_id, kind, source, idempotency_key, created_at)
    values (p_user_id, p_kind, 'plan', p_idempotency_key, now());
  exception when unique_violation then
    select id, source, credit_id into v_existing
    from public.plan_usage_events
    where user_id = p_user_id and idempotency_key = p_idempotency_key;

    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true
    );
  end;

  return jsonb_build_object(
    'success', true,
    'source', 'plan'
  );
end;
$$;

revoke all on function public.consume_plan_set(uuid, text, text, timestamptz, int, int, timestamptz) from public;
grant execute on function public.consume_plan_set(uuid, text, text, timestamptz, int, int, timestamptz) to service_role;

-- 3. Atomic Addon Set Consumption
create or replace function public.consume_addon_set(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text,
  p_daily_cap int default 30,
  p_day_start timestamptz default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_credit_id uuid;
  v_existing record;
  v_daily_count int := 0;
begin
  -- Serializes operations per user across concurrent requests
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- 1. Check idempotency: repeat key returns earlier result and never burns twice
  select id, kind, source, credit_id into v_existing
  from public.plan_usage_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true
    );
  end if;

  -- 2. Daily Cap check (IST day)
  if p_day_start is not null then
    select count(*) into v_daily_count
    from public.plan_usage_events
    where user_id = p_user_id and created_at >= p_day_start;

    if v_daily_count >= p_daily_cap then
      return jsonb_build_object(
        'success', false,
        'code', 'DAILY_LIMIT_REACHED',
        'error', 'Daily fair-use limit reached. Resets daily at midnight IST.'
      );
    end if;
  end if;

  -- 3. Lock and select earliest-expiring non-expired credit with remaining sets
  select id into v_credit_id
  from public.user_addon_credits
  where user_id = p_user_id
    and sets_remaining > 0
    and expires_at > now()
  order by expires_at asc
  limit 1
  for update;

  if v_credit_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'QUOTA_EXHAUSTED',
      'error', 'Plan quota finished and no active add-on credits available.'
    );
  end if;

  -- 4. Decrement sets_remaining atomically (never below 0 via check constraint)
  update public.user_addon_credits
  set sets_remaining = sets_remaining - 1
  where id = v_credit_id;

  -- 5. Insert usage event storing the exact decremented credit_id
  begin
    insert into public.plan_usage_events (user_id, kind, source, credit_id, idempotency_key, created_at)
    values (p_user_id, p_kind, 'addon', v_credit_id, p_idempotency_key, now());
  exception when unique_violation then
    -- Revert decrement if concurrent idempotency race occurred
    update public.user_addon_credits
    set sets_remaining = sets_remaining + 1
    where id = v_credit_id;

    select id, source, credit_id into v_existing
    from public.plan_usage_events
    where user_id = p_user_id and idempotency_key = p_idempotency_key;

    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true
    );
  end;

  return jsonb_build_object(
    'success', true,
    'source', 'addon',
    'credit_id', v_credit_id
  );
end;
$$;

revoke all on function public.consume_addon_set(uuid, text, text, int, timestamptz) from public;
grant execute on function public.consume_addon_set(uuid, text, text, int, timestamptz) to service_role;

-- 4. Unified Atomic Consume (Cap + Plan + Add-on decisions in ONE transaction)
create or replace function public.consume_user_set(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text,
  p_period_start timestamptz,
  p_quota int,
  p_daily_cap int,
  p_day_start timestamptz
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_plan_res jsonb;
begin
  -- First attempt plan quota under advisory lock
  v_plan_res := public.consume_plan_set(
    p_user_id,
    p_kind,
    p_idempotency_key,
    p_period_start,
    p_quota,
    p_daily_cap,
    p_day_start
  );

  if (v_plan_res->>'success')::boolean = true then
    return v_plan_res;
  end if;

  -- If daily cap reached, fail immediately
  if v_plan_res->>'code' = 'DAILY_LIMIT_REACHED' then
    return v_plan_res;
  end if;

  -- If plan quota exhausted, fall back to add-on sets
  return public.consume_addon_set(
    p_user_id,
    p_kind,
    p_idempotency_key,
    p_daily_cap,
    p_day_start
  );
end;
$$;

revoke all on function public.consume_user_set(uuid, text, text, timestamptz, int, int, timestamptz) from public;
grant execute on function public.consume_user_set(uuid, text, text, timestamptz, int, int, timestamptz) to service_role;

-- 5. Atomic Quota Refund (Restores exact credit row and deletes usage event)
create or replace function public.refund_plan_or_addon_set(
  p_user_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_event record;
begin
  -- Serializes operations per user
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select id, source, credit_id into v_event
  from public.plan_usage_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if not found then
    return jsonb_build_object(
      'success', true,
      'refunded', false,
      'message', 'Usage event not found'
    );
  end if;

  -- If source was addon and credit_id is recorded, restore that exact row
  if v_event.source = 'addon' and v_event.credit_id is not null then
    update public.user_addon_credits
    set sets_remaining = least(sets_total, sets_remaining + 1)
    where id = v_event.credit_id
      and user_id = p_user_id;
  end if;

  -- Delete event from plan_usage_events
  delete from public.plan_usage_events
  where id = v_event.id;

  return jsonb_build_object(
    'success', true,
    'refunded', true,
    'source', v_event.source,
    'credit_id', v_event.credit_id
  );
end;
$$;

revoke all on function public.refund_plan_or_addon_set(uuid, text) from public;
grant execute on function public.refund_plan_or_addon_set(uuid, text) to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_plan_usage_credit_id;
--   ALTER TABLE public.plan_usage_events DROP COLUMN IF EXISTS credit_id;
--   DROP FUNCTION IF EXISTS public.consume_plan_set(p_user_id uuid, p_kind text, p_idempotency_key text, p_period_start timestamptz, p_quota int, p_daily_cap int, p_day_start timestamptz);
--   DROP FUNCTION IF EXISTS public.consume_user_set(p_user_id uuid, p_kind text, p_idempotency_key text, p_period_start timestamptz, p_quota int, p_daily_cap int, p_day_start timestamptz);
--   DROP FUNCTION IF EXISTS public.refund_plan_or_addon_set(p_user_id uuid, p_idempotency_key text);
--   NOTE: replaces function public.consume_addon_set (first defined in 20261103b_consume_set_fn.sql); restore the prior definition from that file if this change must be undone.
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================
