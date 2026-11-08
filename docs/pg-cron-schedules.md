# pg_cron schedules (database-native jobs)

Added by migration `20261108a_pg_cron_scheduled_jobs.sql` (NOT APPLIED until the
owner applies it in the Supabase SQL editor). Audit row DB#10: DB maintenance
must not depend on GitHub Actions staying green (the 2026-11-05 Actions billing
outage silenced every cron at once).

## Schedules

All times are UTC (pg_cron runs in UTC); IST equivalents in parentheses.

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
select jobname, status, return_message, start_time
from cron.job_run_details
order by start_time desc
limit 20;
```

## Pause / resume / remove

```sql
select cron.unschedule('purge-operational-logs-weekly');   -- remove
select cron.unschedule('refresh-worldwide-counts-daily');  -- remove
-- re-apply the migration to restore both
```

## Apply order

Apply after `20261106a_data_retention.sql` (purge function) and
`20261106d_matview_refresh_log.sql` (refresh function). Scheduling a job whose
function is missing does not fail at schedule time; the run fails and is visible
in `cron.job_run_details`, so apply order still matters.
