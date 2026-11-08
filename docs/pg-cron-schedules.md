# pg_cron schedules (database-native jobs)

Added by migration `20261108a_pg_cron_scheduled_jobs.sql` (NOT APPLIED until the
owner applies it in the Supabase SQL editor). Audit row DB#10: DB maintenance
must not depend on GitHub Actions staying green (the 2026-11-05 Actions billing
outage silenced every cron at once).

## Schedules

Times below assume the pg_cron default UTC/GMT timezone; IST equivalents are
in parentheses. Before applying, inspect `show cron.timezone` when supported
and confirm the project uses UTC/GMT. No live timezone was checked here.

| Job name | Schedule | When | What it runs |
| --- | --- | --- | --- |
| `purge-operational-logs-weekly` | `15 2 * * 0` | Sun 02:15 UTC (07:45 IST) | `select public.purge_operational_logs(false);` - purges operational log tables past their retention windows (docs/retention-policy.md) |
| `refresh-worldwide-counts-daily` | `45 2 * * *` | daily 02:45 UTC (08:15 IST) | `select public.refresh_worldwide_company_counts();` - refreshes the worldwide counts matview after the nightly ingest |

The GitHub Actions crons (`.github/workflows/retention-cron.yml`, ingest) stay in
place. Both paths call the same functions; the purge is idempotent, so running
from two schedulers is safe. The DB-side schedule is the fallback that keeps
working during an Actions outage.

## Inspect

```sql
select jobid, jobname, schedule, active from cron.job;
select j.jobname, r.status, r.return_message, r.start_time
from cron.job_run_details r
left join cron.job j on j.jobid = r.jobid
order by r.start_time desc
limit 20;
```

## Pause / resume / remove

```sql
select cron.unschedule('purge-operational-logs-weekly');   -- remove
select cron.unschedule('refresh-worldwide-counts-daily');  -- remove
-- re-apply the migration to restore both
```

## First apply and re-apply

Named `cron.schedule(jobname, schedule, command)` creates the job or updates the
existing job for the current database user. It must not call `cron.unschedule`
first: that overload raises an error when no job exists. This fixes the initial
unapplied migration's first-run failure. No live SQL was executed.

Implementation reference: https://raw.githubusercontent.com/citusdata/pg_cron/main/src/job_metadata.c
(named schedule upsert and `cron_unschedule_named`).

## Apply order

Apply after `20261106a_data_retention.sql` (purge function) and
`20261106d_matview_refresh_log.sql` (refresh function). Scheduling a job whose
function is missing does not fail at schedule time; the run fails and is visible
in `cron.job_run_details`, so apply order still matters.
