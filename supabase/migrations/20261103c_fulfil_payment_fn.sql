-- Migration: 20261103c_fulfil_payment_fn.sql
-- Atomic payment order fulfillment and unique constraint on add-on credit order link

-- 1. Add nullable order_id column on user_addon_credits referencing payment_orders
alter table public.user_addon_credits
  add column if not exists order_id uuid references public.payment_orders(id) on delete set null;

-- 2. Unique index ensuring one payment order can never create multiple add-on credit rows
create unique index if not exists idx_user_addon_credits_order_id
  on public.user_addon_credits(order_id)
  where order_id is not null;

-- 3. Function to atomically transition payment_order to 'paid' and grant subscription/add-on credits
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
  v_existing record;
  v_duration int := 30;
  v_sets int := 10;
  v_validity int := 60;
  v_sub record;
  v_credit record;
begin
  -- 1. Conditional atomic update: only flip if currently 'created'
  update public.payment_orders
  set status = 'paid',
      paid_at = now()
  where provider_order_id = p_provider_order_id
    and user_id = p_user_id
    and status = 'created'
  returning * into v_order;

  -- 2. If no row updated, check if order was already paid or missing
  if v_order is null then
    select id, plan_code, addon_code, status into v_existing
    from public.payment_orders
    where provider_order_id = p_provider_order_id
      and user_id = p_user_id;

    if v_existing is null then
      return jsonb_build_object(
        'success', false,
        'code', 'ORDER_NOT_FOUND',
        'error', 'Payment order not found for user'
      );
    end if;

    if v_existing.status = 'paid' then
      return jsonb_build_object(
        'success', true,
        'already_paid', true,
        'order_id', v_existing.id,
        'message', 'Order already fulfilled and marked as paid'
      );
    end if;

    return jsonb_build_object(
      'success', false,
      'code', 'ORDER_INVALID_STATE',
      'error', 'Payment order is not in created state'
    );
  end if;

  -- 3. Fulfillment path A: Subscription plan purchase
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
      now(),
      now() + (v_duration * interval '1 day'),
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
      current_period_start = now(),
      current_period_end = now() + (v_duration * interval '1 day'),
      cancel_at_period_end = false,
      metadata = excluded.metadata,
      updated_at = now()
    returning * into v_sub;

    return jsonb_build_object(
      'success', true,
      'type', 'plan',
      'plan_code', v_order.plan_code,
      'order_id', v_order.id,
      'period_end', v_sub.current_period_end
    );
  end if;

  -- 4. Fulfillment path B: Add-on pack purchase
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
    returning * into v_credit;

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
--   DROP INDEX IF EXISTS public.idx_user_addon_credits_order_id;
--   ALTER TABLE public.user_addon_credits DROP COLUMN IF EXISTS order_id;
--   DROP FUNCTION IF EXISTS public.fulfil_payment_order(p_provider_order_id text, p_user_id uuid);
--   NOTE: data writes above (insert/update/delete) need a manual restore from backup or a hand-written reverse; no automatic rollback.
-- ============================================================================
