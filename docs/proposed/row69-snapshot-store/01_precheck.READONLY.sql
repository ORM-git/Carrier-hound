-- ROW 69 FEED SNAPSHOT STORE: PRE-CHECK. READ ONLY (SELECT only, no writes, no DDL). Run BEFORE 02_apply.
-- Every statement is safe to run on production. Paste the full output into the hand-off thread.

-- A. Nothing to collide with: the table and every function name must be absent (expect zero rows).
SELECT 'table' AS kind, c.oid::regclass::text AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'feed_snapshots'
UNION ALL
SELECT 'function', p.oid::regprocedure::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('feed_snapshot_limits', 'feed_snapshot_admit', 'feed_snapshot_check_args',
   'feed_capture_snapshot', 'feed_snapshot_filter_sql', 'feed_capture_search_snapshot', 'feed_read_snapshot_window',
   'feed_purge_expired_snapshots');

-- B. Roles and server facts the design relies on (expect anon, authenticated, service_role; service_role rolbypassrls = true).
SELECT rolname, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') ORDER BY rolname;
SELECT pg_catalog.current_setting('server_version') AS server_version,
       pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') IS NOT NULL AS has_gen_random_uuid,
       pg_catalog.to_regprocedure('pg_catalog.hashtextextended(text,bigint)') IS NOT NULL AS has_hashtextextended;

-- C. public.jobs columns the search capture reads (expect every name below; types as listed in the design doc).
SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
  FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.jobs'::regclass AND NOT a.attisdropped
   AND a.attname IN ('id','title','company','company_slug','location','category','job_type','remote','remote_scope','country_code',
     'source','source_type','salary_min','description','min_experience_years','max_experience_years','posted_at','is_active','status','verified')
 ORDER BY a.attname;

-- D. Excluded-skills relation. SAME QUERY TEXT as docs/proposed/advanced_skill_rpc.READONLY.sql (shared with the
--    advanced-filter work, so the owner is asked once). The real definition is not in the repo: this prints it.
SELECT p.oid::regprocedure AS signature,p.prosecdef,p.proconfig,
       pg_catalog.pg_get_functiondef(p.oid) AS definition
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('advanced_skill_key','jobs_without_excluded_skills');
SELECT p.oid::regprocedure,r.rolname,pg_catalog.has_function_privilege(r.rolname,p.oid,'EXECUTE') AS can_execute
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN pg_catalog.pg_roles r WHERE n.nspname='public'
AND p.proname IN ('advanced_skill_key','jobs_without_excluded_skills')
AND r.rolname IN ('service_role','anon','authenticated');
--    Also a VIEW of that name, in case it exists as a view rather than a function (expect zero or one row):
SELECT c.oid::regclass AS view_name, pg_catalog.pg_get_viewdef(c.oid, true) AS definition
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'jobs_without_excluded_skills' AND c.relkind IN ('v', 'm');
-- The search capture calls public.jobs_without_excluded_skills(text[]) and needs it to return rows with an id column.
-- If D shows a different signature, a view, or nothing, do NOT apply the excluded-skills path; report it instead.

-- E. Default privileges that would grant new public objects to anon/authenticated (02_apply revokes explicitly anyway).
SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS owner, d.defaclobjtype AS object_type, d.defaclacl
  FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname = 'public';
