-- READ-ONLY checks for the owner to run BEFORE docs/proposed/feed_salary_exact_rpc.NOT_APPLIED.sql. They change nothing.
-- Not run by the agent (no authorized database path). Expected results are stated per check.

-- 1. Column types the exact join relies on. Expect: id uuid, salary_min numeric (unconstrained), currency text,
--    salary_period text on public.jobs. A float/real salary_min would make "exact" false; stop if so.
select a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) as type
  from pg_catalog.pg_attribute a
 where a.attrelid = 'public.jobs'::regclass and a.attname in ('id', 'salary_min', 'currency', 'salary_period') and not a.attisdropped
 order by a.attname;

-- 2. salary_period values actually stored. The thresholds only cover 'yearly', 'monthly', 'hourly'; any other value never
--    passes the salary filter. Report the counts; do not assume.
select j.salary_period, j.currency, count(*) as active_rows, count(j.salary_min) as with_salary_min
  from public.jobs j
 where j.status = 'active' and j.is_active = true and (j.source_type is null or j.source_type <> 'jobspy')
 group by 1, 2 order by 3 desc;

-- 3. Non-finite or extreme salary_min values (excluded / would overflow). Expect zero rows above 1e12.
select count(*) filter (where j.salary_min::text in ('NaN', 'Infinity', '-Infinity')) as non_finite,
       count(*) filter (where j.salary_min > 1e12) as above_1e12,
       max(j.salary_min) as max_salary_min
  from public.jobs j where j.status = 'active';

-- 4. Dependencies present and names free. Expect: frozen relation and typed validator present (after their own
--    proposals are applied), both new function names absent before applying, and no other overloads.
select pg_catalog.to_regclass('public.feed_corpus_frozen') as frozen_relation,
       pg_catalog.to_regprocedure('public.salary_thresholds_typed(jsonb)') as typed_validator,
       pg_catalog.to_regprocedure('public.feed_frozen_salary_rows(uuid, jsonb)') as build_fn,
       pg_catalog.to_regprocedure('public.jobs_salary_rows(uuid[], jsonb)') as serve_fn;
select p.oid::regprocedure as signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('feed_frozen_salary_rows', 'jobs_salary_rows', 'salary_thresholds_typed', 'salary_meets_threshold', 'put_feed_snapshot');

-- 5. PostgREST exposure: after applying, the functions must be callable by service_role only.
select p.proname, r.rolname, pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 cross join pg_catalog.pg_roles r
 where n.nspname = 'public' and p.proname in ('feed_frozen_salary_rows', 'jobs_salary_rows', 'salary_thresholds_typed')
   and r.rolname in ('service_role', 'anon', 'authenticated');
