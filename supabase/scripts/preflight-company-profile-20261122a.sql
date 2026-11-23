-- ==============================================================================
-- CareerMonke (Carrier-hound): read-only preflight for 20261122a_company_profile_data
-- File: supabase/scripts/preflight-company-profile-20261122a.sql
--
-- READ-ONLY: SELECT only. No DDL, no DML, no function calls with side effects.
-- Owner-run in the Supabase SQL editor (or psql) against the target project.
-- Purpose: confirm the owner-reported "profile tables exist and are empty" state at
-- the column, constraint, function, grant and RLS level, not just by table name.
-- Every row of statement 1 should say ok = true. Any false row means: do NOT rerun the
-- migration blindly; send the output for review (a follow-up migration may be needed).
-- Statement 2 needs the four tables to exist; skip it if statement 1 shows they are missing.
-- ==============================================================================

-- 1. Checklist
WITH expected_columns(tbl, col, typ, nullable) AS (VALUES
  ('company_profile_facts','company_id','uuid','NO'), ('company_profile_facts','fact_key','text','NO'),
  ('company_profile_facts','fact_value','text','NO'), ('company_profile_facts','source_url','text','NO'),
  ('company_profile_facts','source_kind','text','NO'), ('company_profile_facts','observed_at','timestamp with time zone','YES'),
  ('company_profile_facts','fact_status','text','NO'), ('company_profile_facts','conflict_value','text','YES'),
  ('company_profile_facts','conflict_source_url','text','YES'), ('company_profile_facts','conflict_source_kind','text','YES'),
  ('company_profile_facts','conflict_retrieved_at','timestamp with time zone','YES'), ('company_profile_facts','conflict_observed_at','timestamp with time zone','YES'),
  ('company_profile_facts','retrieved_at','timestamp with time zone','NO'),
  ('company_profile_leadership','id','uuid','NO'), ('company_profile_leadership','company_id','uuid','NO'),
  ('company_profile_leadership','name','text','NO'), ('company_profile_leadership','role','text','NO'),
  ('company_profile_leadership','role_as_of','date','YES'), ('company_profile_leadership','source_url','text','NO'),
  ('company_profile_leadership','retrieved_at','timestamp with time zone','NO'),
  ('company_profile_news','id','uuid','NO'), ('company_profile_news','company_id','uuid','NO'),
  ('company_profile_news','headline','text','NO'), ('company_profile_news','published_at','timestamp with time zone','NO'),
  ('company_profile_news','source_url','text','NO'), ('company_profile_news','excerpt','text','YES'),
  ('company_profile_news','retrieved_at','timestamp with time zone','NO'),
  ('company_profile_refresh_state','company_id','uuid','NO'), ('company_profile_refresh_state','status','text','NO'),
  ('company_profile_refresh_state','last_attempted_at','timestamp with time zone','NO'), ('company_profile_refresh_state','last_succeeded_at','timestamp with time zone','YES'),
  ('company_profile_refresh_state','next_refresh_at','timestamp with time zone','NO'), ('company_profile_refresh_state','last_error','text','YES'),
  ('companies','id','uuid','NO'), ('companies','name','text','YES'), ('companies','canonical_domain','text','YES'),
  ('company_boards','id','uuid','NO'), ('company_boards','company_id','uuid','YES'), ('company_boards','enabled','boolean','YES'),
  ('company_boards','ats_type','text','YES'), ('company_boards','slug','text','YES'), ('company_boards','careers_url','text','YES')
),
profile_tables(tbl) AS (VALUES ('company_profile_facts'), ('company_profile_leadership'), ('company_profile_news'), ('company_profile_refresh_state')),
constraint_defs AS (
  SELECT rel.relname AS tbl, con.contype, pg_get_constraintdef(con.oid, true) AS def
  FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace n ON n.oid = rel.relnamespace
  WHERE n.nspname = 'public'
),
expected_constraints(name, tbl, contype, pattern) AS (VALUES
  ('facts primary key (company_id, fact_key)', 'company_profile_facts', 'p', 'PRIMARY KEY (company_id, fact_key)'),
  ('facts fact_key allowlist', 'company_profile_facts', 'c', '%fact_key%overview%website%headquarters%founded_year%employee_count_range%linkedin_url%twitter_url%'),
  ('facts fact_value length <= 700', 'company_profile_facts', 'c', '%length(fact_value) <= 700%'),
  ('facts source_kind allowlist', 'company_profile_facts', 'c', '%source_kind%official_site%official_report%official_announcement%'),
  ('facts fact_status allowlist', 'company_profile_facts', 'c', '%fact_status%fresh%stale%conflict%'),
  ('facts company_id -> companies ON DELETE CASCADE', 'company_profile_facts', 'f', 'FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE'),
  ('leadership primary key (id)', 'company_profile_leadership', 'p', 'PRIMARY KEY (id)'),
  ('leadership name length <= 100', 'company_profile_leadership', 'c', '%length(name) <= 100%'),
  ('leadership role length <= 120', 'company_profile_leadership', 'c', '%length(role) <= 120%'),
  ('leadership company_id -> companies ON DELETE CASCADE', 'company_profile_leadership', 'f', 'FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE'),
  ('news primary key (id)', 'company_profile_news', 'p', 'PRIMARY KEY (id)'),
  ('news unique (company_id, source_url)', 'company_profile_news', 'u', 'UNIQUE (company_id, source_url)'),
  ('news headline length <= 220', 'company_profile_news', 'c', '%length(headline) <= 220%'),
  ('news company_id -> companies ON DELETE CASCADE', 'company_profile_news', 'f', 'FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE'),
  ('refresh_state primary key (company_id)', 'company_profile_refresh_state', 'p', 'PRIMARY KEY (company_id)'),
  ('refresh_state status allowlist', 'company_profile_refresh_state', 'c', '%status%fresh%stale%conflict%'),
  ('refresh_state company_id -> companies ON DELETE CASCADE', 'company_profile_refresh_state', 'f', 'FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE')
),
observation_functions(fn) AS (VALUES
  ('public.record_company_profile_leadership_observation(jsonb)'), ('public.record_company_profile_news_observation(jsonb)')
),
checks(section, check_name, ok, detail) AS (
  SELECT '1 table', 'table public.' || tbl, to_regclass('public.' || tbl) IS NOT NULL, coalesce(to_regclass('public.' || tbl)::text, 'missing')
  FROM profile_tables
  UNION ALL
  SELECT '2 column', e.tbl || '.' || e.col,
    c.column_name IS NOT NULL AND c.data_type = e.typ AND (e.tbl IN ('companies','company_boards') OR c.is_nullable = e.nullable),
    CASE WHEN c.column_name IS NULL THEN 'missing' ELSE c.data_type || CASE WHEN c.is_nullable = 'NO' THEN ' not null' ELSE ' nullable' END END
      || ' (expected ' || e.typ || CASE WHEN e.tbl IN ('companies','company_boards') THEN ')' WHEN e.nullable = 'NO' THEN ' not null)' ELSE ' nullable)' END
  FROM expected_columns e
  LEFT JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = e.tbl AND c.column_name = e.col
  UNION ALL
  SELECT '3 constraint', e.name, EXISTS (SELECT 1 FROM constraint_defs d WHERE d.tbl = e.tbl AND d.contype = e.contype AND d.def LIKE e.pattern),
    coalesce((SELECT string_agg(d.def, ' ; ') FROM constraint_defs d WHERE d.tbl = e.tbl AND d.contype = e.contype), 'none of this type')
  FROM expected_constraints e
  UNION ALL
  SELECT '4 index', 'leadership identity unique (company_id, name, role, role_as_of) NULLS NOT DISTINCT',
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'company_profile_leadership_identity_idx'
            AND indexdef ILIKE '%UNIQUE%(company_id, name, role, role_as_of)%NULLS NOT DISTINCT%'),
    coalesce((SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'company_profile_leadership_identity_idx'), 'missing')
  UNION ALL
  SELECT '4 index', 'jobs_company_active_posted_idx (active jobs by canonical company)',
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'jobs_company_active_posted_idx'),
    coalesce((SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'jobs_company_active_posted_idx'), 'missing')
  UNION ALL
  SELECT '5 function', fn || ' exists, search_path pinned, timestamp-only conflict update',
    coalesce((SELECT p.proconfig @> ARRAY['search_path=""'] AND p.prosrc ILIKE '%ON CONFLICT%DO UPDATE SET retrieved_at = EXCLUDED.retrieved_at%'
              FROM pg_proc p WHERE p.oid = to_regprocedure(fn)), false),
    coalesce((SELECT array_to_string(p.proconfig, ',') FROM pg_proc p WHERE p.oid = to_regprocedure(fn)), 'missing')
  FROM observation_functions
  UNION ALL
  SELECT '6 function grant', fn || ': service_role only',
    coalesce(has_function_privilege('service_role', to_regprocedure(fn), 'EXECUTE')
      AND NOT has_function_privilege('anon', to_regprocedure(fn), 'EXECUTE')
      AND NOT has_function_privilege('authenticated', to_regprocedure(fn), 'EXECUTE'), false),
    CASE WHEN to_regprocedure(fn) IS NULL THEN 'missing' ELSE
      'service_role=' || has_function_privilege('service_role', to_regprocedure(fn), 'EXECUTE')
      || ' anon=' || has_function_privilege('anon', to_regprocedure(fn), 'EXECUTE')
      || ' authenticated=' || has_function_privilege('authenticated', to_regprocedure(fn), 'EXECUTE') END
  FROM observation_functions
  UNION ALL
  SELECT '7 rls', 'public.' || tbl || ' row level security enabled',
    coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || tbl)), false),
    coalesce((SELECT relrowsecurity::text FROM pg_class WHERE oid = to_regclass('public.' || tbl)), 'missing')
  FROM profile_tables
  UNION ALL
  SELECT '8 table grant', 'public.' || tbl || ': no anon/authenticated read, service_role read/write',
    coalesce(NOT has_table_privilege('anon', to_regclass('public.' || tbl), 'SELECT')
      AND NOT has_table_privilege('authenticated', to_regclass('public.' || tbl), 'SELECT')
      AND has_table_privilege('service_role', to_regclass('public.' || tbl), 'SELECT') AND has_table_privilege('service_role', to_regclass('public.' || tbl), 'INSERT')
      AND has_table_privilege('service_role', to_regclass('public.' || tbl), 'UPDATE') AND has_table_privilege('service_role', to_regclass('public.' || tbl), 'DELETE'), false),
    CASE WHEN to_regclass('public.' || tbl) IS NULL THEN 'missing' ELSE
      'anon_select=' || has_table_privilege('anon', to_regclass('public.' || tbl), 'SELECT')
      || ' authenticated_select=' || has_table_privilege('authenticated', to_regclass('public.' || tbl), 'SELECT') END
  FROM profile_tables
)
SELECT section, check_name, ok, detail FROM checks ORDER BY section, check_name;

-- 2. Exact row counts (owner reported: tables exist and are empty)
SELECT 'company_profile_facts' AS table_name, count(*) AS row_count FROM public.company_profile_facts
UNION ALL SELECT 'company_profile_leadership', count(*) FROM public.company_profile_leadership
UNION ALL SELECT 'company_profile_news', count(*) FROM public.company_profile_news
UNION ALL SELECT 'company_profile_refresh_state', count(*) FROM public.company_profile_refresh_state;
