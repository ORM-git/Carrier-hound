-- Migration: 20261103g_fulfil_payment_upgrade_extend.sql
-- Money-path fulfillment hardening:
-- 1. Never mark order paid before entitlement grant succeeds (fail-closed and atomic).
-- 2. On renewal or upgrade with an active plan, new period end = max(current_period_end, now) + new plan duration.
-- 3. Never shorten an existing subscription period.
-- 4. Retries re-attempt the entitlement grant if previously incomplete.

create or replace function public.fulfil_payment_order(
  p_provider_order_id text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_order record;
  v_existing_sub record;
  v_existing_credit record;
  v_duration int := 30;
  v_sets int := 10;
  v_validity int := 60;
  v_sub record;
  v_credit record;
  v_base_time timestamptz;
  v_new_end timestamptz;
  v_period_start timestamptz;
begin
  -- 1. Lock the order row for update
  select * into v_order
  from public.payment_orders
  where provider_order_id = p_provider_order_id
    and user_id = p_user_id
  for update;

  if v_order is null then
    return jsonb_build_object(
      'success', false,
      'code', 'ORDER_NOT_FOUND',
      'error', 'Payment order not found for user'
    );
  end if;

  -- 2. Verify state is valid (created or paid-retry)
  if v_order.status not in ('created', 'paid') then
    return jsonb_build_object(
      'success', false,
      'code', 'ORDER_INVALID_STATE',
      'error', 'Payment order is not in created or paid state'
    );
  end if;

  -- 3. Check if already fully fulfilled (idempotency check)
  if v_order.status = 'paid' then
    if v_order.plan_code is not null then
      select * into v_existing_sub
      from public.subscriptions
      where user_id = p_user_id;

      if v_existing_sub is not null and (
        (v_existing_sub.metadata->>'payment_order_id' = v_order.id::text) or
        (v_existing_sub.metadata->>'provider_order_id' = p_provider_order_id)
      ) then
        return jsonb_build_object(
          'success', true,
          'already_paid', true,
          'type', 'plan',
          'plan_code', v_order.plan_code,
          'order_id', v_order.id,
          'period_end', v_existing_sub.current_period_end,
          'message', 'Order already fulfilled and marked as paid'
        );
      end if;
      -- If subscription grant missing, proceed below to re-attempt grant!
    elsif v_order.addon_code is not null then
      select * into v_existing_credit
      from public.user_addon_credits
      where order_id = v_order.id;

      if v_existing_credit is not null then
        return jsonb_build_object(
          'success', true,
          'already_paid', true,
          'type', 'addon',
          'addon_code', v_order.addon_code,
          'order_id', v_order.id,
          'credit_id', v_existing_credit.id,
          'message', 'Order already fulfilled and marked as paid'
        );
      end if;
      -- If add-on grant missing, proceed below to re-attempt grant!
    end if;
  end if;

  -- 4. Fulfillment Path A: Subscription Plan purchase / renewal / upgrade
  if v_order.plan_code is not null then
    select duration_days into v_duration
    from public.plans
    where code = v_order.plan_code;

    if v_duration is null or v_duration <= 0 then
      if v_order.plan_code = 'weekly' then
        v_duration := 7;
      elsif v_order.plan_code = 'quarterly' then
        v_duration := 90;
      else
        v_duration := 30;
      end if;
    end if;

    -- Look up existing subscription to calculate extension
    select * into v_existing_sub
    from public.subscriptions
    where user_id = p_user_id;

    if v_existing_sub is not null and (v_existing_sub.status in ('active', 'trialing')) and v_existing_sub.current_period_end is not null then
      -- User has an active plan: new period end = max(current_period_end, now) + duration
      v_base_time := greatest(v_existing_sub.current_period_end, now());
      v_new_end := v_base_time + (v_duration * interval '1 day');
      -- Never shorten existing period
      if v_new_end < v_existing_sub.current_period_end then
        v_new_end := v_existing_sub.current_period_end;
      end if;
      v_period_start := coalesce(v_existing_sub.current_period_start, now());
    else
      -- Expired or no previous subscription: period end = now + duration
      v_period_start := now();
      v_new_end := now() + (v_duration * interval '1 day');
    end if;

    -- Grant subscription entitlement FIRST
    insert into public.subscriptions (
      user_id,
      plan_id,
      provider,
      currency,
      amount,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      metadata,
      updated_at
    ) values (
      p_user_id,
      v_order.plan_code,
      'razorpay',
      v_order.currency,
      v_order.amount_paise,
      'active',
      v_period_start,
      v_new_end,
      false,
      jsonb_build_object(
        'provider_order_id', p_provider_order_id,
        'payment_order_id', v_order.id,
        'verified_at', now()
      ),
      now()
    )
    on conflict (user_id) do update set
      plan_id = excluded.plan_id,
      status = 'active',
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = false,
      metadata = excluded.metadata,
      updated_at = now()
    returning * into v_sub;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    update public.payment_orders
    set status = 'paid',
        paid_at = coalesce(paid_at, now())
    where id = v_order.id
    returning * into v_order;

    return jsonb_build_object(
      'success', true,
      'type', 'plan',
      'plan_code', v_order.plan_code,
      'order_id', v_order.id,
      'period_end', v_sub.current_period_end
    );
  end if;

  -- 5. Fulfillment Path B: Add-on pack purchase
  if v_order.addon_code is not null then
    select sets, validity_days into v_sets, v_validity
    from public.addon_packs
    where code = v_order.addon_code;

    if v_sets is null or v_sets <= 0 then
      if v_order.addon_code = 'addon_30' then
        v_sets := 30;
      elsif v_order.addon_code = 'addon_60' then
        v_sets := 60;
      else
        v_sets := 10;
      end if;
    end if;

    if v_validity is null or v_validity <= 0 then
      v_validity := 60;
    end if;

    -- Grant add-on credit entitlement FIRST
    insert into public.user_addon_credits (
      user_id,
      pack_code,
      sets_total,
      sets_remaining,
      expires_at,
      order_id,
      created_at
    ) values (
      p_user_id,
      v_order.addon_code,
      v_sets,
      v_sets,
      now() + (v_validity * interval '1 day'),
      v_order.id,
      now()
    )
    on conflict (order_id) where order_id is not null do nothing
    returning * into v_credit;

    if v_credit is null then
      select * into v_credit
      from public.user_addon_credits
      where order_id = v_order.id;
    end if;

    -- Entitlement grant succeeded: ONLY NOW mark the order as paid
    update public.payment_orders
    set status = 'paid',
        paid_at = coalesce(paid_at, now())
    where id = v_order.id
    returning * into v_order;

    return jsonb_build_object(
      'success', true,
      'type', 'addon',
      'addon_code', v_order.addon_code,
      'order_id', v_order.id,
      'sets_granted', v_sets,
      'credit_id', v_credit.id,
      'expires_at', v_credit.expires_at
    );
  end if;

  return jsonb_build_object(
    'success', false,
    'code', 'ORDER_ITEM_MISSING',
    'error', 'Order contains neither plan_code nor addon_code'
  );
end;
$$;

revoke all on function public.fulfil_payment_order(text, uuid) from public;
grant execute on function public.fulfil_payment_order(text, uuid) to service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   NOTE: replaces function public.fulfil_payment_order (first defined in 20261103c_fulfil_payment_fn.sql); restore the prior definition from that file if this change must be undone.
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================
