-- ============================================================================
-- Migration: 20261106c_change_history_triggers.sql
-- Purpose:   Per-row change history on user and billing tables. A generic
--            trigger function logs non-sensitive audit metadata to
--            public.row_change_history on every INSERT/UPDATE/DELETE.
--            Full row images are NOT stored.
--            - user_preferences: changed column names only (no values).
--            - subscriptions, payment_orders, user_addon_credits: non-sensitive
--              fields only (status, plans, amounts, timestamps).
--              Provider/customer/subscription/order IDs and metadata are omitted.
--            - UPDATE operations record changed_columns list.
--            Includes 90-day retention purge function purge_row_change_history().
-- Status:    NOT APPLIED - owner applies in the Supabase SQL editor, then runs
--            node scripts/record-migration.cjs 20261106c_change_history_triggers
-- Covers:    audit row DB#10 (change-history triggers). admin_audit_log
--            (20261020) covers admin actions only; this covers row-level data
--            changes from any writer. The history insert is fail-open
--            (BEGIN/EXCEPTION -> RAISE WARNING): a write to a billing or
--            user table must never fail because of audit logging.
-- Scope:     subscriptions, payment_orders, user_addon_credits,
--            user_preferences. High-churn operational tables are intentionally
--            excluded to keep volume bounded.
-- Rollback:  DROP TRIGGER IF EXISTS trg_change_history_subscriptions ON public.subscriptions;
--            DROP TRIGGER IF EXISTS trg_change_history_payment_orders ON public.payment_orders;
--            DROP TRIGGER IF EXISTS trg_change_history_user_addon_credits ON public.user_addon_credits;
--            DROP TRIGGER IF EXISTS trg_change_history_user_preferences ON public.user_preferences;
--            DROP FUNCTION IF EXISTS public.purge_row_change_history(boolean);
--            DROP FUNCTION IF EXISTS public.log_row_change();
--            DROP TABLE IF EXISTS public.row_change_history;
-- ============================================================================

-- 1. Append-only history table with privacy-preserving schema
create table if not exists public.row_change_history (
  id              bigint generated always as identity primary key,
  changed_at      timestamptz not null default now(),
  table_name      text not null,
  row_id          text,
  operation       text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  changed_columns text[],
  old_row         jsonb,
  new_row         jsonb,
  changed_by      text
);

create index if not exists idx_row_change_history_table_row
  on public.row_change_history (table_name, row_id, changed_at desc);
create index if not exists idx_row_change_history_changed_at
  on public.row_change_history (changed_at desc);

-- 2. Lock down: service_role only, nothing for client roles
alter table public.row_change_history enable row level security;
revoke all on table public.row_change_history from anon, authenticated;
grant all on table public.row_change_history to service_role;

-- 3. Generic trigger function. search_path pinned to '' (audit DB#64) and all
--    references schema-qualified. Runs as definer so trigger inserts are not
--    subject to the calling role's table privileges.
create or replace function public.log_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $func$
declare
  v_raw_old         jsonb;
  v_raw_new         jsonb;
  v_old             jsonb := null;
  v_new             jsonb := null;
  v_changed_columns text[] := null;
  v_row_id          text;
  v_actor           text;
begin
  if TG_OP = 'DELETE' then
    v_raw_old := to_jsonb(OLD);
  elsif TG_OP = 'INSERT' then
    v_raw_new := to_jsonb(NEW);
  else
    v_raw_old := to_jsonb(OLD);
    v_raw_new := to_jsonb(NEW);
  end if;

  -- Covered tables key rows by id (uuid) or user_id (uuid).
  v_row_id := coalesce(
    coalesce(v_raw_new, v_raw_old) ->> 'id',
    coalesce(v_raw_new, v_raw_old) ->> 'user_id'
  );

  -- Compute list of changed column names on UPDATE
  if TG_OP = 'UPDATE' and v_raw_old is not null and v_raw_new is not null then
    select coalesce(array_agg(key order by key), '{}'::text[])
    into v_changed_columns
    from jsonb_each(v_raw_new) n
    where (v_raw_old -> n.key) is distinct from n.value;
  end if;

  -- Privacy filtering: never store full row images or sensitive identifiers
  -- user_preferences: changed column names only, no values (v_old and v_new stay null)
  -- subscriptions, payment_orders, user_addon_credits: non-sensitive fields only
  -- NEVER store provider, customer_id, subscription_id, provider_order_id, or metadata
  if TG_TABLE_NAME = 'subscriptions' then
    if v_raw_old is not null then
      v_old := jsonb_strip_nulls(jsonb_build_object(
        'status', v_raw_old ->> 'status',
        'plan_id', v_raw_old ->> 'plan_id',
        'amount', v_raw_old -> 'amount',
        'currency', v_raw_old ->> 'currency',
        'current_period_start', v_raw_old ->> 'current_period_start',
        'current_period_end', v_raw_old ->> 'current_period_end',
        'grace_period_end', v_raw_old ->> 'grace_period_end',
        'cancel_at_period_end', v_raw_old -> 'cancel_at_period_end',
        'created_at', v_raw_old ->> 'created_at',
        'updated_at', v_raw_old ->> 'updated_at'
      ));
    end if;
    if v_raw_new is not null then
      v_new := jsonb_strip_nulls(jsonb_build_object(
        'status', v_raw_new ->> 'status',
        'plan_id', v_raw_new ->> 'plan_id',
        'amount', v_raw_new -> 'amount',
        'currency', v_raw_new ->> 'currency',
        'current_period_start', v_raw_new ->> 'current_period_start',
        'current_period_end', v_raw_new ->> 'current_period_end',
        'grace_period_end', v_raw_new ->> 'grace_period_end',
        'cancel_at_period_end', v_raw_new -> 'cancel_at_period_end',
        'created_at', v_raw_new ->> 'created_at',
        'updated_at', v_raw_new ->> 'updated_at'
      ));
    end if;
  elsif TG_TABLE_NAME = 'payment_orders' then
    if v_raw_old is not null then
      v_old := jsonb_strip_nulls(jsonb_build_object(
        'status', v_raw_old ->> 'status',
        'plan_code', v_raw_old ->> 'plan_code',
        'addon_code', v_raw_old ->> 'addon_code',
        'amount_paise', v_raw_old -> 'amount_paise',
        'currency', v_raw_old ->> 'currency',
        'created_at', v_raw_old ->> 'created_at',
        'paid_at', v_raw_old ->> 'paid_at'
      ));
    end if;
    if v_raw_new is not null then
      v_new := jsonb_strip_nulls(jsonb_build_object(
        'status', v_raw_new ->> 'status',
        'plan_code', v_raw_new ->> 'plan_code',
        'addon_code', v_raw_new ->> 'addon_code',
        'amount_paise', v_raw_new -> 'amount_paise',
        'currency', v_raw_new ->> 'currency',
        'created_at', v_raw_new ->> 'created_at',
        'paid_at', v_raw_new ->> 'paid_at'
      ));
    end if;
  elsif TG_TABLE_NAME = 'user_addon_credits' then
    if v_raw_old is not null then
      v_old := jsonb_strip_nulls(jsonb_build_object(
        'pack_code', v_raw_old ->> 'pack_code',
        'sets_total', v_raw_old -> 'sets_total',
        'sets_remaining', v_raw_old -> 'sets_remaining',
        'expires_at', v_raw_old ->> 'expires_at',
        'created_at', v_raw_old ->> 'created_at'
      ));
    end if;
    if v_raw_new is not null then
      v_new := jsonb_strip_nulls(jsonb_build_object(
        'pack_code', v_raw_new ->> 'pack_code',
        'sets_total', v_raw_new -> 'sets_total',
        'sets_remaining', v_raw_new -> 'sets_remaining',
        'expires_at', v_raw_new ->> 'expires_at',
        'created_at', v_raw_new ->> 'created_at'
      ));
    end if;
  -- user_preferences and any unhandled table: v_old and v_new remain null
  end if;

  -- Best-effort actor: Supabase JWT subject when present, else the DB role.
  begin
    v_actor := coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    );
  exception when others then
    v_actor := null;
  end;
  v_actor := coalesce(v_actor, session_user);

  -- Fail-open per owner decision: a write to a billing or user table must
  -- never fail because of audit logging. Log a warning and continue.
  begin
    insert into public.row_change_history (
      table_name, row_id, operation, changed_columns, old_row, new_row, changed_by
    )
    values (
      TG_TABLE_NAME, v_row_id, TG_OP, v_changed_columns, v_old, v_new, v_actor
    );
  exception when others then
    raise warning 'row_change_history insert failed for % (row %, op %): %', TG_TABLE_NAME, v_row_id, TG_OP, SQLERRM;
  end;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$func$;

revoke all on function public.log_row_change() from public, anon, authenticated;
grant execute on function public.log_row_change() to service_role;

-- 4. Attach to the user and billing tables in scope
drop trigger if exists trg_change_history_subscriptions on public.subscriptions;
create trigger trg_change_history_subscriptions
  after insert or update or delete on public.subscriptions
  for each row execute function public.log_row_change();

drop trigger if exists trg_change_history_payment_orders on public.payment_orders;
create trigger trg_change_history_payment_orders
  after insert or update or delete on public.payment_orders
  for each row execute function public.log_row_change();

drop trigger if exists trg_change_history_user_addon_credits on public.user_addon_credits;
create trigger trg_change_history_user_addon_credits
  after insert or update or delete on public.user_addon_credits
  for each row execute function public.log_row_change();

drop trigger if exists trg_change_history_user_preferences on public.user_preferences;
create trigger trg_change_history_user_preferences
  after insert or update or delete on public.user_preferences
  for each row execute function public.log_row_change();

-- 5. Retention purge for row_change_history (older than 90 days)
create or replace function public.purge_row_change_history(dry_run boolean default true)
returns table (table_name text, cutoff timestamptz, rows_matched bigint, rows_deleted bigint)
language plpgsql
security definer
set search_path = ''
as $func$
begin
  return query
    with del as (
      delete from public.row_change_history
      where changed_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'row_change_history'::text, now() - interval '90 days',
           (select count(*) from public.row_change_history where changed_at < now() - interval '90 days'),
           (select count(*) from del);
end;
$func$;

comment on function public.purge_row_change_history(boolean) is
  'Retention purge for row_change_history. Purges records older than 90 days. dry_run=true reports counts only.';

revoke all on function public.purge_row_change_history(boolean) from public, anon, authenticated;
grant execute on function public.purge_row_change_history(boolean) to postgres, service_role;

-- ============================================================================
-- VERIFY (Supabase SQL editor):
--   select c.relname, c.rowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'row_change_history';
--   select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('log_row_change', 'purge_row_change_history');
--   select tgname, relname from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname like 'trg_change_history%';
--   select * from public.purge_row_change_history(true);
-- ============================================================================
