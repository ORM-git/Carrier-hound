-- ==============================================================================
-- Migration: Lock Down page_views Inserts & Enforce Service-Role Only Writes
-- Date: 2026-11-01
-- File: supabase/migrations/20261101_lock_page_views_insert.sql
-- Status: PENDING APPLICATION (Run in Supabase SQL editor by project owner)
--   If/when applied: record with  node scripts/record-migration.cjs 20261101_lock_page_views_insert
--
-- Security Context:
-- 1. In migration 20261011_admin_page_views_and_blocked_users.sql, policy
--    "Allow public insert to page_views" was created with WITH CHECK (true),
--    and default Supabase grants gave the anon and authenticated roles INSERT
--    privileges on public.page_views.
-- 2. This permitted anyone holding the public anon key to INSERT arbitrary rows
--    directly into public.page_views via PostgREST (forged paths, fake user agents,
--    forged ip_hash, unbounded row growth), bypassing /api/track validation and
--    poisoning admin analytics.
-- 3. The /api/track route writes using the service-role client (getSupabaseAdmin),
--    so revoking anon/authenticated INSERT and dropping the open policy closes
--    direct client injection without impacting legitimate tracking.
-- ==============================================================================

-- 1. Revoke INSERT privilege on public.page_views from anon and authenticated roles
REVOKE INSERT ON public.page_views FROM anon, authenticated;

-- 2. Drop legacy permissive public insert policy
DROP POLICY IF EXISTS "Allow public insert to page_views" ON public.page_views;

-- 3. Ensure service_role has INSERT privilege on public.page_views
GRANT INSERT ON public.page_views TO service_role;

-- 4. Leave the existing admin-email-only SELECT policy ("Allow admin to select page_views")
-- and every other table/policy untouched.
