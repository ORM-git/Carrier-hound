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
