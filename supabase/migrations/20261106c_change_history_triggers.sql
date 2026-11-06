-- ============================================================================
-- Migration: 20261106c_change_history_triggers.sql
-- Purpose:   Per-row change history on user and billing tables. A generic
--            trigger function appends the old and new row images to
--            public.row_change_history on every INSERT/UPDATE/DELETE, so it
--            is always possible to see what a billing row looked like before
--            a change.
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
-- Note:      row_change_history grows with write volume on those tables. If
--            retention is needed, extend purge_operational_logs (20261106a) in
--            a follow-up migration.
-- Rollback:  DROP TRIGGER IF EXISTS trg_change_history_subscriptions ON public.subscriptions;
--            DROP TRIGGER IF EXISTS trg_change_history_payment_orders ON public.payment_orders;
--            DROP TRIGGER IF EXISTS trg_change_history_user_addon_credits ON public.user_addon_credits;
--            DROP TRIGGER IF EXISTS trg_change_history_user_preferences ON public.user_preferences;
--            DROP FUNCTION IF EXISTS public.log_row_change();
--            DROP TABLE IF EXISTS public.row_change_history;
-- ============================================================================

-- 1. Append-only history table
create table if not exists public.row_change_history (
  id          bigint generated always as identity primary key,
  changed_at  timestamptz not null default now(),
  table_name  text not null,
  row_id      text,
  operation   text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  old_row     jsonb,
  new_row     jsonb,
  changed_by  text
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
  v_old    jsonb;
  v_new    jsonb;
  v_row_id text;
  v_actor  text;
begin
  if TG_OP = 'DELETE' then
    v_old := to_jsonb(OLD);
  elsif TG_OP = 'INSERT' then
    v_new := to_jsonb(NEW);
  else
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
  end if;

  -- Covered tables key rows by id (uuid) or user_id (uuid).
  v_row_id := coalesce(
    coalesce(v_new, v_old) ->> 'id',
    coalesce(v_new, v_old) ->> 'user_id'
  );

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
    insert into public.row_change_history (table_name, row_id, operation, old_row, new_row, changed_by)
    values (TG_TABLE_NAME, v_row_id, TG_OP, v_old, v_new, v_actor);
  exception when others then
    raise warning 'row_change_history insert failed for % (% op): %', TG_TABLE_NAME, v_row_id, TG_OP, SQLERRM;
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
