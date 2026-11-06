-- ============================================================================
-- Migration: 20261106a_data_retention.sql
-- Purpose:   Retention enforcement for operational/log tables. One SECURITY
--            DEFINER function, callable only by service_role, purges rows past
--            each table's retention window (docs/retention-policy.md).
--            dry_run DEFAULTS TO TRUE (reviewer nit, 2026-11-06): a bare
--            select public.purge_operational_logs() only reports counts; pass
--            false explicitly to delete. Safer against SQL-editor fat-finger.
-- Status:    NOT APPLIED - owner applies in the Supabase SQL editor, then runs
--            node scripts/record-migration.cjs 20261106a_data_retention
-- Covers:    audit rows DB#4 (retention enforcement), DB#5 (purge jobs for
--            log tables); the 90-day webhook_events cleanup that previously
--            existed only as a comment in 20261019_webhook_events.sql.
-- Rollback:  DROP FUNCTION IF EXISTS public.purge_operational_logs(boolean);
-- ============================================================================

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
end;
$func$;

comment on function public.purge_operational_logs(boolean) is
  'Retention purge for operational/log tables. Weekly via retention-cron.yml. Windows: page_views 90d, gmail_send_log 180d, cron_run_logs 90d, admin_audit_log 365d, webhook_events 90d, failed_events(replayed/dead) 90d. dry_run=true reports counts only.';

-- Only the service role (cron scripts) may run it.
revoke all on function public.purge_operational_logs(boolean) from public, anon, authenticated;
grant execute on function public.purge_operational_logs(boolean) to service_role;

-- ============================================================================
-- Verification (after applying):
--   select * from public.purge_operational_logs(true);  -- dry run, counts only
-- ============================================================================
