-- ==============================================================================
-- Migration: 20261106f_funnel_events_retention.sql
-- Date: 2026-11-06
-- Status: NOT APPLIED - owner must run this file in the Supabase SQL editor, then
--         record it with:  node scripts/record-migration.cjs 20261106f_funnel_events_retention
-- Apply AFTER 20261106a_data_retention and 20261106e_funnel_events: this replaces
-- public.purge_operational_logs wholesale and references public.funnel_events.
-- Scope: Reviewer follow-up on funnel tracking - funnel_events had no retention
--        class and would grow unbounded. Adds it at 90 days (same window as
--        page_views). dry_run DEFAULT TRUE is preserved: a bare
--        select public.purge_operational_logs() only reports counts.
-- NOTE for the frontend half: the funnel emitter must sit behind the analytics
--        consent gate (same gate as UTM capture, PR #287) - no consent, no events.
-- Rollback: re-apply supabase/migrations/20261106a_data_retention.sql
--           (restores the function without the funnel_events class).
-- ==============================================================================

create or replace function public.purge_operational_logs(dry_run boolean default true)
returns table (table_name text, cutoff timestamptz, rows_matched bigint, rows_deleted bigint)
language plpgsql
security definer
set search_path = ''
as $func$
begin
  -- page_views: keep 90 days
  return query
    with del as (
      delete from public.page_views
      where created_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'page_views'::text, now() - interval '90 days',
           (select count(*) from public.page_views where created_at < now() - interval '90 days'),
           (select count(*) from del);

  -- gmail_send_log: keep 180 days (doubles as suppression evidence)
  return query
    with del as (
      delete from public.gmail_send_log
      where sent_at < now() - interval '180 days' and not dry_run
      returning 1
    )
    select 'gmail_send_log'::text, now() - interval '180 days',
           (select count(*) from public.gmail_send_log where sent_at < now() - interval '180 days'),
           (select count(*) from del);

  -- cron_run_logs: keep 90 days
  return query
    with del as (
      delete from public.cron_run_logs
      where started_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'cron_run_logs'::text, now() - interval '90 days',
           (select count(*) from public.cron_run_logs where started_at < now() - interval '90 days'),
           (select count(*) from del);

  -- admin_audit_log: keep 365 days
  return query
    with del as (
      delete from public.admin_audit_log
      where created_at < now() - interval '365 days' and not dry_run
      returning 1
    )
    select 'admin_audit_log'::text, now() - interval '365 days',
           (select count(*) from public.admin_audit_log where created_at < now() - interval '365 days'),
           (select count(*) from del);

  -- webhook_events: keep 90 days (implements the comment in 20261019_webhook_events.sql)
  return query
    with del as (
      delete from public.webhook_events
      where processed_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'webhook_events'::text, now() - interval '90 days',
           (select count(*) from public.webhook_events where processed_at < now() - interval '90 days'),
           (select count(*) from del);

  -- failed_events: keep replayed/dead rows for 90 days after the last attempt;
  -- pending rows are never purged (they still need replay).
  return query
    with del as (
      delete from public.failed_events
      where status in ('replayed', 'dead')
        and last_attempt_at < now() - interval '90 days'
        and not dry_run
      returning 1
    )
    select 'failed_events'::text, now() - interval '90 days',
           (select count(*) from public.failed_events
            where status in ('replayed', 'dead') and last_attempt_at < now() - interval '90 days'),
           (select count(*) from del);

  -- funnel_events: keep 90 days (same window as page_views; added in 20261106f)
  return query
    with del as (
      delete from public.funnel_events
      where created_at < now() - interval '90 days' and not dry_run
      returning 1
    )
    select 'funnel_events'::text, now() - interval '90 days',
           (select count(*) from public.funnel_events where created_at < now() - interval '90 days'),
           (select count(*) from del);
end;
$func$;

comment on function public.purge_operational_logs(boolean) is
  'Retention purge for operational/log tables. Weekly via retention-cron.yml. Windows: page_views 90d, gmail_send_log 180d, cron_run_logs 90d, admin_audit_log 365d, webhook_events 90d, failed_events(replayed/dead) 90d, funnel_events 90d. dry_run=true reports counts only.';

-- Only the service role (cron scripts) may run it.
revoke all on function public.purge_operational_logs(boolean) from public, anon, authenticated;
grant execute on function public.purge_operational_logs(boolean) to service_role;

-- Rollback: re-apply 20261106a_data_retention.sql to restore the previous
-- function body (without the funnel_events class).
