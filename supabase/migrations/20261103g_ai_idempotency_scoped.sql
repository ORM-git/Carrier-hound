-- Migration: 20261103g_ai_idempotency_scoped.sql
-- Scopes plan_usage_events idempotency lookup by user + operation kind,
-- checks daily-cap before returning already_consumed,
-- adds response_payload column for cached replay,
-- and updates atomic consume/refund RPCs.

-- 1. Add nullable response_payload column to store generated result
alter table public.plan_usage_events
  add column if not exists response_payload jsonb;

-- 2. Drop legacy (user_id, idempotency_key) unique constraint if exists
alter table public.plan_usage_events
  drop constraint if exists plan_usage_events_user_id_idempotency_key_key;

-- 3. Add constraint scoped by (user_id, kind, idempotency_key)
alter table public.plan_usage_events
  drop constraint if exists plan_usage_events_user_kind_idempotency_unique;

alter table public.plan_usage_events
  add constraint plan_usage_events_user_kind_idempotency_unique
  unique (user_id, kind, idempotency_key);

-- Index for scoped lookup
create index if not exists idx_plan_usage_user_kind_idempotency
  on public.plan_usage_events(user_id, kind, idempotency_key);

-- 4. Atomic Plan Set Consumption (Daily cap FIRST, scoped by user_id and kind)
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

  -- 1. Daily Cap check (IST day) FIRST: prevents bypassing cap via old idempotency key
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

  -- 2. Scoped Idempotency Check: scoped strictly by user_id AND kind
  select id, source, credit_id, response_payload into v_existing
  from public.plan_usage_events
  where user_id = p_user_id
    and kind = p_kind
    and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true,
      'result', v_existing.response_payload
    );
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
    select id, source, credit_id, response_payload into v_existing
    from public.plan_usage_events
    where user_id = p_user_id
      and kind = p_kind
      and idempotency_key = p_idempotency_key;

    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true,
      'result', v_existing.response_payload
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

-- 5. Atomic Addon Set Consumption (Daily cap FIRST, scoped by user_id and kind)
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

  -- 1. Daily Cap check (IST day) FIRST
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

  -- 2. Scoped Idempotency Check: scoped strictly by user_id AND kind
  select id, kind, source, credit_id, response_payload into v_existing
  from public.plan_usage_events
  where user_id = p_user_id
    and kind = p_kind
    and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true,
      'result', v_existing.response_payload
    );
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
    update public.user_addon_credits
    set sets_remaining = sets_remaining + 1
    where id = v_credit_id;

    select id, source, credit_id, response_payload into v_existing
    from public.plan_usage_events
    where user_id = p_user_id
      and kind = p_kind
      and idempotency_key = p_idempotency_key;

    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'credit_id', v_existing.credit_id,
      'already_consumed', true,
      'result', v_existing.response_payload
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

-- 6. Unified Atomic Consume (Cap + Plan + Add-on decisions in ONE transaction)
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
  -- 1. Daily cap and plan quota attempt under advisory lock
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

-- 7. Atomic Quota Refund (Scoped by user_id and optional kind)
create or replace function public.refund_plan_or_addon_set(
  p_user_id uuid,
  p_idempotency_key text,
  p_kind text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_event record;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select id, source, credit_id into v_event
  from public.plan_usage_events
  where user_id = p_user_id
    and idempotency_key = p_idempotency_key
    and (p_kind is null or kind = p_kind);

  if not found then
    return jsonb_build_object(
      'success', true,
      'refunded', false,
      'message', 'Usage event not found'
    );
  end if;

  if v_event.source = 'addon' and v_event.credit_id is not null then
    update public.user_addon_credits
    set sets_remaining = least(sets_total, sets_remaining + 1)
    where id = v_event.credit_id
      and user_id = p_user_id;
  end if;

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

revoke all on function public.refund_plan_or_addon_set(uuid, text, text) from public;
grant execute on function public.refund_plan_or_addon_set(uuid, text, text) to service_role;

-- 8. Persist generated response payload on successful completion
create or replace function public.record_plan_usage_result(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text,
  p_result jsonb
)
returns boolean
language plpgsql
security definer
as $$
begin
  update public.plan_usage_events
  set response_payload = p_result
  where user_id = p_user_id
    and kind = p_kind
    and idempotency_key = p_idempotency_key;

  return found;
end;
$$;

revoke all on function public.record_plan_usage_result(uuid, text, text, jsonb) from public;
grant execute on function public.record_plan_usage_result(uuid, text, text, jsonb) to service_role;
