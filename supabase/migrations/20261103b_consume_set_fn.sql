-- Migration: 20261103b_consume_set_fn.sql
-- Function to atomically consume one add-on set and insert plan_usage_event

create or replace function public.consume_addon_set(
  p_user_id uuid,
  p_kind text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_credit_id uuid;
  v_existing record;
begin
  -- 1. Check idempotency: repeat key returns earlier result and never burns twice
  select id, kind, source into v_existing
  from public.plan_usage_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'success', true,
      'source', v_existing.source,
      'already_consumed', true
    );
  end if;

  -- 2. Lock and select earliest-expiring non-expired credit with remaining sets
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
      'error', 'No active add-on sets available'
    );
  end if;

  -- 3. Decrement sets_remaining atomically (never below 0 via check constraint)
  update public.user_addon_credits
  set sets_remaining = sets_remaining - 1
  where id = v_credit_id;

  -- 4. Insert usage event
  insert into public.plan_usage_events (user_id, kind, source, idempotency_key, created_at)
  values (p_user_id, p_kind, 'addon', p_idempotency_key, now());

  return jsonb_build_object(
    'success', true,
    'source', 'addon',
    'credit_id', v_credit_id
  );
end;
$$;

revoke all on function public.consume_addon_set(uuid, text, text) from public;
grant execute on function public.consume_addon_set(uuid, text, text) to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP FUNCTION IF EXISTS public.consume_addon_set(p_user_id uuid, p_kind text, p_idempotency_key text);
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================
