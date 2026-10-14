-- ==============================================================================
-- DO NOT APPLY / REVIEW PENDING — READ-ONLY PREFLIGHT AUDIT PACKET
-- CareerMonke (Carrier-hound) — Production Migration Preflight Verification
-- File: supabase/scripts/preflight-readonly.sql
-- Status: READ-ONLY AUDIT FOR OWNER / DBA IN SUPABASE SQL EDITOR
--
-- STRICT ARCHITECTURAL CONSTRAINTS:
-- 1. Explicitly wrapped in a READ ONLY transaction block.
-- 2. Contains ONLY catalog and aggregate SELECT queries.
-- 3. ZERO DDL, ZERO DML, ZERO function invocations with side effects.
-- 4. Acquires NO exclusive table locks; safe for concurrent production inspection.
-- 5. Does NOT print individual private job records or user identifiers.
--
-- INSTRUCTIONS FOR OWNER / DBA:
-- Run this entire script in the Supabase Dashboard SQL Editor before any migration.
-- Review the output of each query against the documented SAFE vs. STOP conditions below.
-- If ANY check hits a STOP condition, DO NOT proceed with migration application.
-- ==============================================================================

-- Note: Standalone individual queries; run each SELECT query independently.

-- ==============================================================================
-- 1. POSTGRESQL ENGINE VERSION & REQUIRED EXTENSIONS
-- ==============================================================================

-- 1.1 Live PostgreSQL Version
-- SAFE CONDITION: PostgreSQL version 15.x, 16.x, 17.x, or 18.x.
-- STOP CONDITION: Version < 15.0 or unrecognized non-Postgres dialect.
SELECT version() AS postgres_engine_version;

-- 1.2 Availability & Installed State of Required Extensions
-- SAFE CONDITION: 'pg_trgm' and 'unaccent' are available (default_version is populated) or already installed.
-- STOP CONDITION: installed_version IS NULL and default_version IS NULL (extensions missing from host).
SELECT
  name AS extension_name,
  default_version,
  installed_version,
  comment
FROM pg_available_extensions
WHERE name IN ('pg_trgm', 'unaccent')
ORDER BY name;


-- ==============================================================================
-- 2. SCHEMA CATALOG: RELEVANT TABLES, COLUMNS, DEFAULTS & CONSTRAINTS
-- ==============================================================================

-- 2.1 Table Existence Check (public.jobs, jobs_public, tailored_resumes, ai_usage_quotas)
-- SAFE CONDITION: 'jobs' and 'jobs_public' exist. 'tailored_resumes' and 'ai_usage_quotas' can be absent (to be created).
-- STOP CONDITION: 'jobs' table is missing or corrupted.
SELECT
  table_name,
  table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('jobs', 'jobs_public', 'tailored_resumes', 'ai_usage_quotas')
ORDER BY table_name;

-- 2.2 Column Types, Nullability, Defaults & Generated Column Definitions on public.jobs
-- SAFE CONDITION: Columns match base schema.
-- STOP CONDITION: Conflicting column types already exist (e.g. categories is text instead of text[], or salary_min is integer instead of numeric).
SELECT
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default,
  is_generated,
  generation_expression
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'jobs'
  AND column_name IN (
    'id', 'title', 'company', 'location', 'country', 'country_code', 'category', 'categories',
    'remote', 'remote_scope', 'remote_eligibility', 'eligible_countries', 'job_type',
    'salary_text', 'salary_min', 'salary_max', 'currency', 'period', 'salary_period',
    'seniority', 'discovered_at', 'expires_at', 'first_seen_at', 'posted_at', 'created_at',
    'search_vector', 'source', 'source_job_id', 'status', 'is_active'
  )
ORDER BY ordinal_position;

-- 2.3 Existing Constraints on public.jobs
-- SAFE CONDITION: No conflicting CHECK constraints.
-- STOP CONDITION: Existing check constraints like jobs_remote_eligibility_check use hyphenated 'country-restricted' instead of underscore 'country_restricted'.
SELECT
  con.conname AS constraint_name,
  con.contype AS constraint_type,
  pg_get_constraintdef(con.oid, true) AS constraint_definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public'
  AND rel.relname = 'jobs'
ORDER BY con.conname;


-- ==============================================================================
-- 3. AGGREGATE EXISTING-VALUE DISTRIBUTIONS (CHECK CONSTRAINTS & BACKFILL AUDIT)
-- ==============================================================================

-- 3.1 Distribution of remote_eligibility on public.jobs
-- SAFE CONDITION: All non-null values are in ('worldwide', 'country_restricted', 'unknown'). Zero rows with 'country-restricted' (hyphen).
-- STOP CONDITION: Any rows exist with 'country-restricted' (hyphen) or other unexpected values violating the proposed CHECK constraint.
SELECT
  COALESCE(to_jsonb(j)->>'remote_eligibility', '<COLUMN_ABSENT_OR_NULL>') AS remote_eligibility_value,
  COUNT(*) AS row_count,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER () * 100, 2) AS percentage
FROM public.jobs j
GROUP BY 1
ORDER BY row_count DESC;

-- 3.2 Distribution of seniority on public.jobs
-- SAFE CONDITION: Non-null values are in ('entry', 'mid', 'senior', 'staff', 'lead', 'director', 'unknown') or column is absent/null.
-- STOP CONDITION: Pre-existing values exist that violate proposed jobs_seniority_check.
SELECT
  COALESCE(to_jsonb(j)->>'seniority', '<COLUMN_ABSENT_OR_NULL>') AS seniority_value,
  COUNT(*) AS row_count,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER () * 100, 2) AS percentage
FROM public.jobs j
GROUP BY 1
ORDER BY row_count DESC;

-- 3.3 Distribution of period & salary_period on public.jobs
-- SAFE CONDITION: Column is absent or values allow proposed CHECK (period IS NULL OR period IN ('year', 'month', 'hour')).
-- STOP CONDITION: Non-null values exist violating proposed CHECK constraint without NULL allowance.
SELECT
  COALESCE(to_jsonb(j)->>'period', '<COLUMN_ABSENT_OR_NULL>') AS period_value,
  COALESCE(to_jsonb(j)->>'salary_period', '<COLUMN_ABSENT_OR_NULL>') AS legacy_salary_period_value,
  COUNT(*) AS row_count
FROM public.jobs j
GROUP BY 1, 2
ORDER BY row_count DESC;

-- 3.4 Distribution of remote_scope and Remote Spelling Variants
-- SAFE CONDITION: Identifies distribution between remote, office, hybrid, and null.
-- STOP CONDITION: Unexpected text causing unhandled edge cases in single-decision remote CTE.
SELECT
  COALESCE(to_jsonb(j)->>'remote_scope', '<NULL>') AS remote_scope,
  COALESCE(to_jsonb(j)->>'remote_eligibility', '<NULL>') AS remote_eligibility,
  COUNT(*) AS row_count
FROM public.jobs j
GROUP BY 1, 2
ORDER BY row_count DESC;

-- 3.5 Simulation: Proposed Single-Decision Remote Categorization Breakdown
-- SAFE CONDITION: Evaluates expected distribution under Prompt 7 single-decision CTE logic without modifying any table rows.
-- STOP CONDITION: Unintended broad classifications (e.g. genuine_worldwide unexpectedly high).
SELECT
  CASE
    WHEN (to_jsonb(j)->>'remote_scope') IS DISTINCT FROM 'remote' THEN '1_non_remote'
    WHEN COALESCE(to_jsonb(j)->>'location', '') ~* '\y(europe|emea|apac|latam|asia)\y' THEN '2_region_phrase_unknown'
    WHEN COALESCE(to_jsonb(j)->>'location', '') ~* '\y(us only|usa only|united states only)\y'
      OR (COALESCE(to_jsonb(j)->>'location', '') ~* '\y(united states|usa)\y' AND COALESCE(to_jsonb(j)->>'location', '') ~* '\y(not accepted|ineligible|only)\y')
      OR COALESCE(to_jsonb(j)->>'location', '') ~* '\y(anywhere in the us|anywhere in the usa)\y'
      OR (to_jsonb(j)->>'country') ILIKE 'United States' OR (to_jsonb(j)->>'country_code') = 'US' THEN '3_us_restricted'
    WHEN (to_jsonb(j)->>'country') ILIKE 'India' OR (to_jsonb(j)->>'country_code') = 'IN' OR COALESCE(to_jsonb(j)->>'location', '') ~* '\y(india only|anywhere in india)\y' THEN '4_india_restricted'
    WHEN (COALESCE(to_jsonb(j)->>'location', '') ~* '\y(worldwide|anywhere in the world|work from anywhere)\y')
      AND COALESCE(to_jsonb(j)->>'location', '') !~* '\y(only|us|usa|united states|uk|canada|europe|emea|apac|latam|asia|india|germany)\y' THEN '5_genuine_worldwide'
    WHEN (to_jsonb(j)->>'country_code') IS NOT NULL AND (to_jsonb(j)->>'country_code') != '' THEN '6_other_country_restricted'
    ELSE '7_remote_unmapped_unknown'
  END AS simulated_remote_category,
  COUNT(*) AS row_count,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER () * 100, 2) AS percentage
FROM public.jobs j
GROUP BY 1
ORDER BY 1;

-- 3.6 Country & Country Code Alignment and Ambiguity Breakdown
-- SAFE CONDITION: High proportion of explicit country matches or known ISOs.
-- STOP CONDITION: Pre-existing invalid ISO codes on live data.
SELECT
  COALESCE(to_jsonb(j)->>'country', '<NULL>') AS country,
  COALESCE(to_jsonb(j)->>'country_code', '<NULL>') AS country_code,
  COUNT(*) AS row_count
FROM public.jobs j
GROUP BY 1, 2
ORDER BY row_count DESC
LIMIT 25;


-- ==============================================================================
-- 4. DUPLICATE KEY AUDIT: (source, source_job_id) GROUPS
-- ==============================================================================

-- 4.1 Count Duplicate Non-Null (source, source_job_id) Groups
-- SAFE CONDITION: duplicate_groups_count = 0 and excess_duplicate_rows = 0.
-- STOP CONDITION: duplicate_groups_count > 0.
-- EXPLANATION: If duplicate_groups_count > 0, applying 'CREATE UNIQUE INDEX jobs_source_source_job_id_unique'
--              will immediately ABORT with 'ERROR: 23505: duplicate key value violates unique constraint'.
--              Deduplication script MUST be run prior to applying the unique index.
SELECT
  COUNT(*) AS duplicate_groups_count,
  COALESCE(SUM(group_size - 1), 0) AS excess_duplicate_rows,
  COALESCE(MAX(group_size), 0) AS max_duplicates_in_single_group
FROM (
  SELECT
    to_jsonb(j)->>'source' AS source_val,
    to_jsonb(j)->>'source_job_id' AS source_job_id_val,
    COUNT(*) AS group_size
  FROM public.jobs j
  WHERE (to_jsonb(j)->>'source') IS NOT NULL
    AND (to_jsonb(j)->>'source_job_id') IS NOT NULL
  GROUP BY 1, 2
  HAVING COUNT(*) > 1
) dupes;


-- ==============================================================================
-- 5. EXISTING RELEVANT INDEX DEFINITIONS
-- ==============================================================================

-- 5.1 Full Definitions of All Existing Indexes on Migration Tables
-- SAFE CONDITION: Identifies existing index names, expressions, and predicate clauses.
-- STOP CONDITION: Conflicting index definitions exist under identical names with incompatible column orders.
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('jobs', 'tailored_resumes', 'ai_usage_quotas')
ORDER BY tablename, indexname;


-- ==============================================================================
-- 6. SECURITY, RLS, PERMISSIONS & RPC PRIVILEGES AUDIT
-- ==============================================================================

-- 6.1 Table Grants on public.jobs and public.jobs_public
-- SAFE CONDITION: anon and authenticated have SELECT on 'jobs_public', but NO direct SELECT on raw 'jobs'.
-- STOP CONDITION: anon has direct SELECT granted on raw 'jobs' (violates paid-data lock).
SELECT
  grantee,
  table_schema,
  table_name,
  privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('jobs', 'jobs_public')
  AND grantee IN ('anon', 'authenticated', 'service_role')
ORDER BY table_name, grantee, privilege_type;

-- 6.2 Row Level Security State on public.jobs
-- SAFE CONDITION: rls_enabled = true.
-- STOP CONDITION: rls_enabled = false on public.jobs.
SELECT
  relname AS relation_name,
  relrowsecurity AS rls_enabled,
  relforcerowsecurity AS rls_enforced_for_table_owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND relname IN ('jobs', 'tailored_resumes', 'ai_usage_quotas');

-- 6.3 Existing RLS Policies on public.jobs
-- SAFE CONDITION: No permissive "jobs_public_read" policy on public.jobs for anon.
-- STOP CONDITION: "jobs_public_read" policy exists and permits anonymous SELECT on raw public.jobs.
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual AS using_expression,
  with_check AS with_check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'jobs'
ORDER BY policyname;

-- 6.4 Definition and Options for public.jobs_public View
-- SAFE CONDITION: View masks company, salary_text, apply_url, and description for public consumers.
-- STOP CONDITION: View definition exposes unmasked company or apply_url to callers.
SELECT
  schemaname,
  viewname,
  definition
FROM pg_views
WHERE schemaname = 'public'
  AND viewname = 'jobs_public';

SELECT
  c.relname AS view_name,
  c.reloptions AS view_options
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'jobs_public';

-- 6.5 Inspect Any Existing public.get_jobs_with_facets Functions (DO NOT INVOKE)
-- SAFE CONDITION: Function is absent (0 rows returned), OR exists as dropped target.
-- STOP CONDITION: Function exists with SECURITY DEFINER and GRANT EXECUTE to anon returning raw unmasked fields.
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  pg_get_function_result(p.oid) AS return_type,
  CASE p.prosecdef WHEN true THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END AS security_type,
  r.rolname AS owner_role
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public'
  AND p.proname = 'get_jobs_with_facets';

SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'get_jobs_with_facets';


-- ==============================================================================
-- 7. LIMITS OF CATALOG AUDITING (WHAT CATALOGS CANNOT PROVE)
-- ==============================================================================
-- 1. Real Role-Based Masking in Application Context:
--    - The database catalog confirms that 'public.jobs_public' replaces company with
--      'Verified Employer' and masks apply_url/description.
--    - However, the catalog CANNOT prove whether backend server endpoints (Next.js)
--      bypass the view using SUPABASE_SERVICE_ROLE_KEY to serve unauthenticated endpoints.
-- 2. Entitlement Enforcement:
--    - User Pro vs. Free entitlements are verified in application code (getServerEntitlement).
--    - Catalogs cannot evaluate whether JWT tokens are verified or whether Pro unlocks
--      leak data across user sessions.
-- 3. Restore & Backup Readiness:
--    - Catalog SELECTs verify object schema definitions, but CANNOT verify whether
--      point-in-time recovery (PITR) is enabled or whether a pg_dump restore test succeeds.
-- ==============================================================================
