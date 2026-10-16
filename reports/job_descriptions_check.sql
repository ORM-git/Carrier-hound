-- ==============================================================================
-- AUDIT REPORT: READ-ONLY Job Descriptions & Public Table Permissions Check
-- Purpose: Diagnostic SQL queries to inspect RLS policies, table privileges,
--          and table row counts without reading or exposing any sensitive content.
-- Usage: Copy and paste into the Supabase SQL Editor.
-- Safety: READ-ONLY queries only. No mutations, no schema modifications.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- (a) List all Row Level Security (RLS) policies on public.job_descriptions
-- ------------------------------------------------------------------------------
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd AS operation,
  qual AS using_condition,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'job_descriptions';

-- ------------------------------------------------------------------------------
-- (b) Check SELECT privilege for anon, authenticated, and service_role on job_descriptions
-- ------------------------------------------------------------------------------
SELECT
  'public.job_descriptions' AS table_name,
  has_table_privilege('anon', 'public.job_descriptions', 'SELECT') AS anon_can_select,
  has_table_privilege('authenticated', 'public.job_descriptions', 'SELECT') AS authenticated_can_select,
  has_table_privilege('service_role', 'public.job_descriptions', 'SELECT') AS service_role_can_select;

-- ------------------------------------------------------------------------------
-- (c) Privilege and Policy Audit across public tables (companies, company_boards,
--     ingest_runs, and all other tables with USING (true) or open read access)
-- ------------------------------------------------------------------------------

-- c.1: Table-level privilege check for anon vs authenticated vs service_role
SELECT
  c.relname AS table_name,
  c.rowsecurity AS rls_enabled,
  has_table_privilege('anon', format('public.%I', c.relname), 'SELECT') AS anon_can_select,
  has_table_privilege('authenticated', format('public.%I', c.relname), 'SELECT') AS authenticated_can_select,
  has_table_privilege('service_role', format('public.%I', c.relname), 'SELECT') AS service_role_can_select
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'jobs',
    'job_descriptions',
    'companies',
    'company_boards',
    'ingest_runs',
    'subscriptions',
    'blocked_users',
    'page_views',
    'candidate_profiles'
  )
ORDER BY c.relname;

-- c.2: Active policies with USING (true) or permissive read rules
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd AS operation,
  qual AS using_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    qual ILIKE '%true%'
    OR tablename IN ('job_descriptions', 'companies', 'company_boards', 'ingest_runs')
  )
ORDER BY tablename, policyname;

-- ------------------------------------------------------------------------------
-- (d) Row counts only (aggregate metrics only — no sensitive content returned)
-- ------------------------------------------------------------------------------
SELECT 'job_descriptions' AS table_name, COUNT(*)::bigint AS total_rows FROM public.job_descriptions
UNION ALL
SELECT 'jobs', COUNT(*)::bigint FROM public.jobs
UNION ALL
SELECT 'companies', COUNT(*)::bigint FROM public.companies
UNION ALL
SELECT 'company_boards', COUNT(*)::bigint FROM public.company_boards
UNION ALL
SELECT 'ingest_runs', COUNT(*)::bigint FROM public.ingest_runs
UNION ALL
SELECT 'subscriptions', COUNT(*)::bigint FROM public.subscriptions
UNION ALL
SELECT 'blocked_users', COUNT(*)::bigint FROM public.blocked_users
UNION ALL
SELECT 'page_views', COUNT(*)::bigint FROM public.page_views
ORDER BY table_name;
