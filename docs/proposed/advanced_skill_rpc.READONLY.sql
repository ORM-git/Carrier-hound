-- READ ONLY proposal, NOT RUN live. Inspect before 20261126c, then again after owner application.
SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type
FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.jobs'::regclass
AND a.attname IN ('skills','status','is_active','source_type') AND NOT a.attisdropped;
-- Expected skills text[], status/source_type compatible text, is_active boolean.
SELECT p.oid::regprocedure AS signature,p.prosecdef,p.proconfig,
       pg_catalog.pg_get_functiondef(p.oid) AS definition
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('advanced_skill_key','jobs_without_excluded_skills');
-- Existing names/overloads must be reviewed. Do not replace a different existing function blindly.
SELECT p.oid::regprocedure,r.rolname,pg_catalog.has_function_privilege(r.rolname,p.oid,'EXECUTE') AS can_execute
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN pg_catalog.pg_roles r WHERE n.nspname='public'
AND p.proname IN ('advanced_skill_key','jobs_without_excluded_skills')
AND r.rolname IN ('service_role','anon','authenticated');
-- Only service_role true; check inherited grants, table ownership and API readiness gate separately.
SELECT source_type,count(*) AS visible_rows,
 count(*) FILTER(WHERE coalesce(cardinality(skills),0)=0) AS empty_or_unknown
FROM public.jobs WHERE status='active' AND is_active=true AND(source_type IS NULL OR source_type<>'jobspy')
GROUP BY source_type;
-- Preview only, after reviewed application and readiness gate, never proof from tiny fixture:
-- EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM public.jobs_without_excluded_skills(ARRAY['react'])
-- WHERE country_code='IN' ORDER BY posted_at DESC,id DESC LIMIT 25;
-- Repeat realistic preferred/excluded lists and all query/select/count variants.
-- PL/pgSQL SETOF may materialize the active relation BEFORE outer filters/limit;
-- a correct membership result is NOT proof of predicate pushdown or acceptable cost.
-- PostgREST RPC chaining/order/range/embedded relationship metadata must be tested live on PREVIEW.
-- Shared skill-key fixtures are required in JS + this actual SQL function. Preserve
-- non-ASCII case/whitespace through preference save; normalizeTextList currently does not.
-- No production activation until function permissions, normalization and cost gates pass.
