-- READ ONLY. Owner preflight, NOT RUN here. Stop on any error.
-- 1. Exact current column types. Missing job years / experience_level blocks migration.
SELECT c.relname, a.attname, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type
FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
AND ((c.relname='jobs' AND a.attname IN ('min_experience_years','max_experience_years','experience_years_source'))
 OR (c.relname='user_preferences' AND a.attname IN ('experience_level','required_years_min','required_years_max','preferred_skills','excluded_skills')))
ORDER BY 1,2;
-- 2. Existing checks and validation state, inspect before migration.
SELECT c.conrelid::regclass AS relation,c.conname,c.convalidated,pg_catalog.pg_get_constraintdef(c.oid) AS definition
FROM pg_catalog.pg_constraint c WHERE c.conrelid IN ('public.jobs'::regclass,'public.user_preferences'::regclass)
AND c.contype='c' ORDER BY 1,2;
-- 2b. Dependencies that can block ALTER TYPE (notably jobs_public views/rules).
-- Inspect ALL returned definitions before planning migration. Do NOT auto-drop views:
-- their permissions, security options and dependent objects must be preserved by review.
SELECT DISTINCT a.attname AS years_column, v.oid::regclass AS dependent_relation,
       r.rulename, pg_catalog.pg_get_ruledef(r.oid) AS rule_definition
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_depend d ON d.refobjid=a.attrelid AND d.refobjsubid=a.attnum
JOIN pg_catalog.pg_rewrite r ON r.oid=d.objid
JOIN pg_catalog.pg_class v ON v.oid=r.ev_class
WHERE a.attrelid='public.jobs'::regclass
 AND a.attname IN ('min_experience_years','max_experience_years') AND NOT a.attisdropped
ORDER BY 1,2,3;
-- A dependent view/rule may reject widening with SQLSTATE 0A000. That is a blocker
-- requiring a separate reviewed dependency plan, not permission to drop/recreate it.
-- 3. Run ONLY after check1 confirms both job columns exist and are integer/numeric.
-- Zero invalid rows required. Numeric widening preserves all finite integer/decimal values.
SELECT count(*) FILTER (WHERE min_experience_years::text IN ('NaN','Infinity','-Infinity')
 OR max_experience_years::text IN ('NaN','Infinity','-Infinity')
 OR min_experience_years<0 OR max_experience_years<0 OR min_experience_years>max_experience_years) AS invalid_year_rows,
 count(*) AS total_rows, count(min_experience_years) AS min_set,count(max_experience_years) AS max_set
FROM public.jobs;
-- 4. Filter-visible coverage, not a whole-database quality claim.
SELECT source_type,count(*) AS visible_active_rows,count(min_experience_years) AS min_set,count(max_experience_years) AS max_set
FROM public.jobs WHERE status='active' AND is_active=true AND (source_type IS NULL OR source_type<>'jobspy')
GROUP BY source_type ORDER BY visible_active_rows DESC;
-- No coverage threshold is invented. No data population, RLS/permissions or source provenance verified by these counts.
-- If new preference columns already exist, inspect their values with the same finite/nonnegative/order rule,
-- and require skill array cardinality<=50 before migration. The migration validates these atomically too.
