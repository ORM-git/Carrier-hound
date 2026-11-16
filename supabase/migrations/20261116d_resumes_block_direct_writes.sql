-- Migration: 20261116d_resumes_block_direct_writes.sql
-- Description: Close the direct-INSERT path on public.resumes.
--
-- Problem: 20261031_account_delete_and_private_resumes.sql created ONE policy,
-- "Users can manage own resumes" (FOR ALL TO authenticated, USING/WITH CHECK auth.uid() = user_id).
-- FOR ALL includes INSERT, so any signed-in user could insert rows with the Supabase client
-- (anon key + user JWT), bypassing any server-side resume gate. 20261116c gated applications,
-- candidate_profiles, tailored_resumes and the storage bucket but missed this table.
--
-- Chosen fix (option A): no code path in this repo inserts into public.resumes (resume files go to
-- the private storage bucket and candidate_profiles, both already gated). So the safest fix is to
-- remove client INSERT entirely:
--   * drop every policy that permits INSERT (FOR ALL or FOR INSERT), whatever it is named in an
--     environment, then recreate owner-only SELECT / UPDATE / DELETE policies;
--   * REVOKE INSERT from authenticated, anon and PUBLIC (this also blocks INSERT ... ON CONFLICT
--     upsert, which needs INSERT privilege);
--   * the UPDATE policy keeps WITH CHECK (auth.uid() = user_id), so user_id cannot be re-pointed.
-- Future resume creation must go through a gated server route using the service role (BYPASSRLS),
-- setting user_id from the verified session. A count-in-RLS gate is deliberately not used (racy).
--
-- Idempotent: safe to run twice. Status: NOT APPLIED
-- Record with: node scripts/record-migration.cjs 20261116d_resumes_block_direct_writes

-- ============================================================================
-- PRE-CHECK SQL (Run independently)
-- ============================================================================
-- SELECT policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies WHERE schemaname = 'public' AND tablename = 'resumes';
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND table_name = 'resumes';

BEGIN;

ALTER TABLE public.resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resumes FORCE ROW LEVEL SECURITY;

-- 1. Drop every policy that allows INSERT (exact names differ between environments).
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'resumes' AND cmd IN ('ALL', 'INSERT')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.resumes', p.policyname);
  END LOOP;
END $$;

-- 2. Owner-only SELECT / UPDATE / DELETE (same visibility as before, minus INSERT).
DROP POLICY IF EXISTS "resumes_owner_select" ON public.resumes;
CREATE POLICY "resumes_owner_select" ON public.resumes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "resumes_owner_update" ON public.resumes;
CREATE POLICY "resumes_owner_update" ON public.resumes
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "resumes_owner_delete" ON public.resumes;
CREATE POLICY "resumes_owner_delete" ON public.resumes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 3. Privilege layer: no client INSERT (also blocks upsert-as-insert).
REVOKE INSERT ON TABLE public.resumes FROM authenticated, anon, PUBLIC;

COMMIT;

-- ============================================================================
-- VERIFY SQL (Run independently)
-- ============================================================================
-- SELECT policyname, cmd, qual, with_check FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'resumes';   -- expect select/update/delete only
-- SELECT has_table_privilege('authenticated', 'public.resumes', 'INSERT');  -- expect false

-- ============================================================================
-- ROLLBACK SQL (Restores the previous FOR ALL policy, i.e. re-opens direct INSERT)
-- ============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS "resumes_owner_select" ON public.resumes;
-- DROP POLICY IF EXISTS "resumes_owner_update" ON public.resumes;
-- DROP POLICY IF EXISTS "resumes_owner_delete" ON public.resumes;
-- GRANT INSERT ON TABLE public.resumes TO authenticated;
-- CREATE POLICY "Users can manage own resumes" ON public.resumes
--   FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
-- COMMIT;
