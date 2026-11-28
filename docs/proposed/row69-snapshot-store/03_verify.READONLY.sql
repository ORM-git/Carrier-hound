-- ROW 69 FEED SNAPSHOT STORE: VERIFY. READ ONLY (SELECT only). Run AFTER 02_apply (and again after 04_rollback).
-- Each query states the expected result. Paste the full output into the hand-off thread.

-- 1. Objects present (after apply: 1 table + 8 functions; after rollback: zero rows).
SELECT 'table' AS kind, c.oid::regclass::text AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'feed_snapshots'
UNION ALL
SELECT 'function', p.oid::regprocedure::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('feed_snapshot_limits', 'feed_snapshot_admit', 'feed_snapshot_check_args',
   'feed_capture_snapshot', 'feed_snapshot_filter_sql', 'feed_capture_search_snapshot', 'feed_read_snapshot_window',
   'feed_purge_expired_snapshots')
 ORDER BY 1, 2;

-- 2. RLS on, zero policies (expect rls = true, policies = 0).
SELECT c.relrowsecurity AS rls, (SELECT count(*) FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'feed_snapshots') AS policies
  FROM pg_catalog.pg_class c WHERE c.oid = 'public.feed_snapshots'::regclass;

-- 3. Table privileges (expect anon/authenticated all false; service_role select/insert/delete true, update false).
SELECT r.rolname,
       pg_catalog.has_table_privilege(r.rolname, 'public.feed_snapshots', 'SELECT') AS sel,
       pg_catalog.has_table_privilege(r.rolname, 'public.feed_snapshots', 'INSERT') AS ins,
       pg_catalog.has_table_privilege(r.rolname, 'public.feed_snapshots', 'UPDATE') AS upd,
       pg_catalog.has_table_privilege(r.rolname, 'public.feed_snapshots', 'DELETE') AS del
  FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') ORDER BY r.rolname;

-- 4. Function privileges and security mode (expect: anon/authenticated can_execute false everywhere; service_role true;
--    prosecdef false (SECURITY INVOKER) and proconfig {search_path=""} for every function).
SELECT p.oid::regprocedure AS fn, p.prosecdef, p.proconfig,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname LIKE 'feed\_%snapshot%' ESCAPE '\' ORDER BY 1;

-- 5. Constraints and indexes (expect the id/kind/tier/query_hash/scoring_rev/ids/member_count checks, feed_snapshots_ttl,
--    feed_snapshots_size, the primary key, and indexes on expires_at and (owner_id, created_at)).
SELECT conname, pg_catalog.pg_get_constraintdef(oid) AS definition FROM pg_catalog.pg_constraint
 WHERE conrelid = 'public.feed_snapshots'::regclass ORDER BY conname;
SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND tablename = 'feed_snapshots' ORDER BY indexname;

-- 6. Limits in force (expect 10, 20, 50000, 60, 100 unless the owner changed them in review).
SELECT * FROM public.feed_snapshot_limits();

-- 7. Live state (read only): active vs expired rows, oldest expiry. A growing expired count means purge is not scheduled.
SELECT count(*) FILTER (WHERE expires_at > pg_catalog.now()) AS active, count(*) FILTER (WHERE expires_at <= pg_catalog.now()) AS expired,
       min(expires_at) AS oldest_expiry FROM public.feed_snapshots;
