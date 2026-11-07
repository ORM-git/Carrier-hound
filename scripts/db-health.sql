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

-- 6b. Refresh recency from the refresh log (requires migration 20261106d).
--     If last_refreshed_at is NULL or older than your ingest cadence, the
--     refresh trigger is stuck - check ingest_runs and cron_run_logs.
select matview_name,
       max(refreshed_at) as last_refreshed_at,
       now() - max(refreshed_at) as staleness,
       max(duration_ms) as slowest_refresh_ms,
       count(*) as refreshes_logged
from public.matview_refresh_log
group by matview_name
order by matview_name;

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

-- 10. Funnel review (Backend row: Funnel Tracking) - signup -> onboard -> apply conversion.
--     Unique actors prefer the signed-in user id, falling back to the pseudonymous
--     anonymous_id for pre-signup steps. Requires migration 20261106e.
select event,
       count(*) as events,
       count(distinct coalesce(user_id::text, anonymous_id)) as unique_actors
from public.funnel_events
where created_at > now() - interval '30 days'
group by event
order by array_position(
  array['signup_started','signup_completed','onboarding_started','onboarding_completed','apply_started','apply_completed'],
  event
);

-- 11. Slow queries (DB row: Slow-query log). pg_stat_statements is enabled by
--     migration 20261105c; this is the review surface for what it records.
--     NOTE: Postgres log_min_duration_statement cannot be set from the SQL editor
--     on Supabase - if log-file slow logging is wanted it is a dashboard setting.
select left(query, 120) as query,
       calls,
       round(total_exec_time::numeric, 1) as total_ms,
       round(mean_exec_time::numeric, 1) as mean_ms,
       round(max_exec_time::numeric, 1) as max_ms
from pg_stat_statements
where query not ilike '%pg_stat_statements%'
order by total_exec_time desc
limit 20;

-- 12. Activation / retention (Backend row: Activation / Retention Metrics).
--     DAU/WAU/MAU from page_views (signed-in users only), plus week-1 cohort retention
--     (signed up in week W, seen again in W+1). auth.users is readable in the SQL editor.

-- 12a. Active users
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

-- 12b. Week-1 retention by signup cohort (only cohorts old enough to have a week+1)
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

-- 13. Job archival (DB row: Archival strategy). jobs_archive is cold storage
--     for expired listings (migration 20261106l); archive_expired_jobs runs
--     weekly via the retention cron. Until the migration is applied the first
--     two queries fail - run the cron_run_logs one alone in that case.
select count(*) as archivable_now
from public.jobs
where is_active = false
  and status = 'expired'
  and last_seen_at < now() - interval '90 days';

select count(*) as archived_total,
       max(archived_at) as last_archived_at
from public.jobs_archive;

select started_at, status, metadata->>'dry_run' as dry_run
from public.cron_run_logs
where job_type = 'job_archival'
order by started_at desc
limit 5;

-- 14. Index maintenance (DB row: REINDEX maintenance). reindex_bloated_indexes
--     (migration 20261106m) rebuilds public-schema indexes >= 50 MB (chosen
--     default) weekly via the retention cron. Review the largest indexes and
--     their usage here; the cron_run_logs query works even before the
--     migration is applied.
select schemaname, relname as table_name, indexrelname as index_name,
       pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
       idx_scan, idx_tup_read, idx_tup_fetch
from pg_stat_user_indexes
where schemaname = 'public'
order by pg_relation_size(indexrelid) desc
limit 20;

select started_at, status,
       metadata->>'dry_run' as dry_run,
       jsonb_array_length(coalesce(metadata->'results', '[]'::jsonb)) as candidates
from public.cron_run_logs
where job_type = 'reindex_maintenance'
order by started_at desc
limit 5;

-- 15. Covering index (DB row: Covering indexes (INCLUDE)). Migration
--     20261106n adds jobs_active_list_covering_idx so the public jobs list
--     (CARD_FIELDS, keyset on first_seen_at DESC, id DESC) can run as an
--     index-only scan. Until applied, the first query returns no rows.
--     Watch idx_scan grow after deploy; a flat zero means the planner is
--     not picking it (stale stats - run ANALYZE public.jobs).
select indexrelname, idx_scan, idx_tup_read, idx_tup_fetch,
       pg_size_pretty(pg_relation_size(indexrelid)) as index_size
from pg_stat_user_indexes
where schemaname = 'public'
  and indexrelname = 'jobs_active_list_covering_idx';

-- Index-only scan efficiency on the jobs table: share of heap fetches vs
-- index tuples returned. Lower heap-fetch share is better; expect it to
-- drop after 20261106n is applied and ANALYZE has run.
select relname,
       idx_scan,
       idx_tup_fetch,
       heap_blks_read,
       heap_blks_hit
from pg_statio_user_tables
where schemaname = 'public'
  and relname = 'jobs';

-- 16. Constraint validation (DB row: NOT VALID then VALIDATE). Migration
--     20261106o adds jobs_salary_bounds_check as NOT VALID; it enforces new
--     writes immediately and is validated against existing rows in a
--     separate off-peak run (VALIDATE CONSTRAINT). Watch convalidated here.
select conname, conrelid::regclass as table_name, convalidated
from pg_constraint
where connamespace = 'public'::regnamespace
  and not convalidated
order by conname;

-- Rows that would fail jobs_salary_bounds_check (audit before Run B):
select count(*) as salary_bounds_violations
from public.jobs
where not (salary_min is null or salary_max is null or salary_min <= salary_max);
