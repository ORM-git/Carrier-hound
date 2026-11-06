-- ==============================================================================
-- DB Health Monitoring Queries (CareerMonke / Supabase)
-- File: scripts/db-health.sql
-- Status: READ-ONLY diagnostics. Run section by section in the Supabase SQL
--         editor (or psql). Nothing here writes, alters or grants.
-- Covers audit rows: DB #25 unused index audit, DB #30 index usage monitoring,
-- DB #31 dead tuple / bloat watch, DB #17 matview staleness, DB #66 alert on
-- failed cron. Suggested cadence: weekly, plus after any ingest-heavy deploy.
-- ==============================================================================

-- 1. Failed cron runs in the last 7 days (DB #66 - the alert query)
--    If this returns rows, a scheduled job failed without a page. Wire the
--    count into an uptime/alert check when alerting is stood up.
select job_type, status, error_message, started_at
from public.cron_run_logs
where status = 'failed'
  and started_at > now() - interval '7 days'
order by started_at desc
limit 50;

-- 2. Unused indexes (DB #25 / #30)
--    idx_scan = 0 since last stats reset. Candidates to drop; verify against
--    known rare-but-real query paths (admin tools, exports) before dropping.
select schemaname, relname AS table_name, indexrelname AS index_name,
       idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
from pg_stat_user_indexes
where idx_scan = 0
  and indexrelname not like '%_pkey'
order by pg_relation_size(indexrelid) desc;

-- 3. Index usage overview (DB #30) - most and least used indexes
select relname AS table_name, indexrelname AS index_name, idx_scan,
       idx_tup_read, idx_tup_fetch
from pg_stat_user_indexes
order by idx_scan asc
limit 40;

-- 4. Dead tuple / bloat watch (DB #31)
--    dead_ratio above ~20% on update-heavy tables means autovacuum is falling
--    behind; consider a manual VACUUM (ANALYZE) of that table.
select relname AS table_name, n_live_tup, n_dead_tup,
       case when n_live_tup > 0
            then round(100.0 * n_dead_tup / n_live_tup, 1)
            else 0 end AS dead_ratio_pct,
       last_autovacuum, last_autoanalyze
from pg_stat_user_tables
order by n_dead_tup desc
limit 25;

-- 5. Table sizes (growth watch for the retention policy, DB #4/#5)
select relname AS table_name,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       pg_size_pretty(pg_relation_size(relid)) AS data_size,
       n_live_tup
from pg_stat_user_tables
order by pg_total_relation_size(relid) desc
limit 25;

-- 6. Materialized view inventory + staleness (DB #17)
--    Postgres does not track last-refresh time natively; cross-check
--    matview rowcounts against the source table to catch a stuck refresh.
select matviewname, ispopulated
from pg_matviews
order by matviewname;

-- 7. Long-running queries right now (> 30s, excludes this session)
select pid, now() - query_start AS duration, state, left(query, 200) AS query
from pg_stat_activity
where state <> 'idle'
  and pid <> pg_backend_pid()
  and now() - query_start > interval '30 seconds'
order by duration desc;

-- 8. Cache hit ratio (should stay above ~99% on a healthy hot path)
select sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0)
       AS cache_hit_ratio
from pg_statio_user_tables;

-- 9. PII access review (DB row: user data access audit) - who read personal data, when, what kind.
--    Reads land in admin_audit_log with action = 'pii_read' (user list, user activity,
--    early-access list, self-service data exports). Review weekly; investigate actors
--    you do not recognize or unusual volumes.
select date_trunc('day', created_at) as day,
       admin_user_id as actor_user_id,
       target_type,
       count(*) as reads,
       count(distinct target_id) as distinct_subjects
from public.admin_audit_log
where action = 'pii_read'
  and created_at > now() - interval '30 days'
group by 1, 2, 3
order by 1 desc, reads desc
limit 100;

-- 10. Activation / retention (Backend row: Activation / Retention Metrics).
--     DAU/WAU/MAU from page_views (signed-in users only), plus week-1 cohort retention
--     (signed up in week W, seen again in W+1). auth.users is readable in the SQL editor.

-- 11a. Active users
select 'DAU (avg, last 14d)' as metric,
       round(avg(cnt)) as value
from (
  select date_trunc('day', created_at) as d, count(distinct user_id) as cnt
  from public.page_views
  where created_at > now() - interval '14 days' and user_id is not null
  group by 1
) daily
union all
select 'WAU (avg, last 8w)',
       round(avg(cnt))
from (
  select date_trunc('week', created_at) as w, count(distinct user_id) as cnt
  from public.page_views
  where created_at > now() - interval '8 weeks' and user_id is not null
  group by 1
) weekly
union all
select 'MAU (last 30d)',
       count(distinct user_id)
from public.page_views
where created_at > now() - interval '30 days' and user_id is not null;

-- 11b. Week-1 retention by signup cohort (only cohorts old enough to have a week+1)
with cohorts as (
  select id, date_trunc('week', created_at) as cohort_week
  from auth.users
  where created_at < date_trunc('week', now()) - interval '1 week'
),
returns as (
  select distinct c.cohort_week, c.id
  from cohorts c
  join public.page_views pv
    on pv.user_id = c.id
   and pv.created_at >= c.cohort_week + interval '1 week'
   and pv.created_at <  c.cohort_week + interval '2 weeks'
)
select c.cohort_week::date as signup_week,
       count(*) as signups,
       count(r.id) as active_in_week_1,
       round(100.0 * count(r.id) / count(*), 1) as week1_retention_pct
from cohorts c
left join returns r on r.cohort_week = c.cohort_week and r.id = c.id
group by 1
order by 1 desc
limit 12;
