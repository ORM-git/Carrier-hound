-- ============================================================================
-- Migration: 20261120a_restore_tracker_profile_owner_policies.sql
-- STATUS: NOT APPLIED - owner reviews and applies manually in the Supabase SQL editor, then records:
--   node scripts/record-migration.cjs 20261120a_restore_tracker_profile_owner_policies
--
-- Why: the product restore (Tracker, Resume confirm, Profile save, Jobs save/applied and match
-- scores) needs owner-only client access to public.applications and public.candidate_profiles.
-- 20261116c_launch_scope_coming_soon_gates.sql (if applied) dropped the owner SELECT/INSERT/UPDATE
-- policies on those tables and left only USING(false) "coming soon" policies.
--
-- Scope (forward-only, additive in effect, data-preserving):
--   * public.applications, public.candidate_profiles: owner-only SELECT / INSERT / UPDATE for
--     `authenticated` (auth.uid() = user_id); UPDATE also has WITH CHECK so user_id cannot be
--     re-pointed. The existing owner DELETE policies are left as they are.
--   * The matching *_coming_soon_block_* policies on these two tables are dropped (they would be
--     no-ops next to the owner policies because permissive policies are OR-ed).
-- NOT changed (intentionally):
--   * public.tailored_resumes and the private `resumes` storage bucket stay blocked: no reachable
--     product path uses them after AI tool entry points were removed. No owner-folder storage write
--     is re-opened, so resumes/<uid>/onboarding/ isolation (#655) is untouched.
--   * public.resumes (20261116d: no client INSERT) is untouched.
--   * #660 onboarding_resume_profiles / its atomic save RPC are untouched.
-- No rows are read, written or deleted. Transactional and idempotent: safe to run twice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- READ-ONLY PRECHECKS (run first, independently)
-- ----------------------------------------------------------------------------
-- -- Current policies on the two tables:
-- SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
--   FROM pg_policies
--  WHERE schemaname = 'public' AND tablename IN ('applications', 'candidate_profiles')
--  ORDER BY tablename, policyname;
-- -- RLS must be enabled on both:
-- SELECT relname, relrowsecurity, relforcerowsecurity
--   FROM pg_class WHERE oid IN ('public.applications'::regclass, 'public.candidate_profiles'::regclass);
-- -- Effective role ACLs (table privileges must exist for policies to matter):
-- SELECT t, p, has_table_privilege('authenticated', t, p) AS authenticated_has,
--        has_table_privilege('anon', t, p) AS anon_has
--   FROM unnest(ARRAY['public.applications', 'public.candidate_profiles']) AS t,
--        unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ----------------------------------------------------------------------------
-- PREFLIGHT: abort (and roll back) if the baseline is not what this migration expects.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['applications', 'candidate_profiles'] LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE EXCEPTION 'preflight: public.% does not exist', v_tbl;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_tbl)::regclass) THEN
      RAISE EXCEPTION 'preflight: RLS is disabled on public.%; refusing to change policies', v_tbl;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_tbl
         AND column_name = 'user_id' AND data_type = 'uuid'
    ) THEN
      RAISE EXCEPTION 'preflight: public.%.user_id (uuid) is missing', v_tbl;
    END IF;
    -- No permissive policy reaching anon/public may grant rows without an owner (auth.uid()) key;
    -- the USING(false) blocks and auth.uid()-keyed owner policies (e.g. owner DELETE) are fine.
    IF EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = v_tbl AND permissive = 'PERMISSIVE'
         AND ('anon' = ANY (roles) OR 'public' = ANY (roles))
         AND policyname NOT LIKE '%coming_soon_block%'
         AND position('auth.uid()' IN coalesce(qual, '') || coalesce(with_check, '')) = 0
    ) THEN
      RAISE EXCEPTION 'preflight: public.% has a permissive policy reaching anon/public without an owner key; review first', v_tbl;
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- public.applications
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "applications_coming_soon_block_select" ON public.applications;
DROP POLICY IF EXISTS "applications_coming_soon_block_insert" ON public.applications;
DROP POLICY IF EXISTS "applications_coming_soon_block_update" ON public.applications;

DROP POLICY IF EXISTS "applications_owner_select" ON public.applications;
CREATE POLICY "applications_owner_select" ON public.applications
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "applications_owner_insert" ON public.applications;
CREATE POLICY "applications_owner_insert" ON public.applications
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "applications_owner_update" ON public.applications;
CREATE POLICY "applications_owner_update" ON public.applications
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- public.candidate_profiles
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_select" ON public.candidate_profiles;
DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_insert" ON public.candidate_profiles;
DROP POLICY IF EXISTS "candidate_profiles_coming_soon_block_update" ON public.candidate_profiles;

DROP POLICY IF EXISTS "candidate_profiles_owner_select" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_owner_select" ON public.candidate_profiles
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "candidate_profiles_owner_insert" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_owner_insert" ON public.candidate_profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "candidate_profiles_owner_update" ON public.candidate_profiles;
CREATE POLICY "candidate_profiles_owner_update" ON public.candidate_profiles
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- POST-CHECK inside the transaction: owner policies present, no anon reach.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename IN ('applications', 'candidate_profiles')
         AND policyname ~ '_owner_(select|insert|update)$') <> 6 THEN
    RAISE EXCEPTION 'postcheck: expected 6 owner select/insert/update policies';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename IN ('applications', 'candidate_profiles')
                AND ('anon' = ANY (roles) OR 'public' = ANY (roles)) AND permissive = 'PERMISSIVE'
                AND position('auth.uid()' IN coalesce(qual, '') || coalesce(with_check, '')) = 0) THEN
    RAISE EXCEPTION 'postcheck: a permissive policy reaches anon/public without an owner key';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY (run independently after applying)
-- ============================================================================
-- SELECT tablename, policyname, roles, cmd, qual, with_check FROM pg_policies
--  WHERE schemaname = 'public' AND tablename IN ('applications', 'candidate_profiles')
--  ORDER BY tablename, policyname;
--   -- expect *_owner_select / *_owner_insert / *_owner_update / *_owner_delete, TO authenticated,
--   -- all keyed on auth.uid() = user_id; no *_coming_soon_block_* rows.
-- -- Cross-user check with two test accounts (A and B), as each user's JWT via the client:
-- --   A: insert into applications/candidate_profiles with user_id = A  -> succeeds
-- --   A: insert with user_id = B                                         -> rejected (RLS)
-- --   A: select ... where user_id = B                                    -> 0 rows
-- --   A: update own row set user_id = B                                  -> rejected (WITH CHECK)

-- ============================================================================
-- ROLLBACK (data-preserving: policies only, no rows touched)
-- ============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS "applications_owner_select" ON public.applications;
-- DROP POLICY IF EXISTS "applications_owner_insert" ON public.applications;
-- DROP POLICY IF EXISTS "applications_owner_update" ON public.applications;
-- CREATE POLICY "applications_coming_soon_block_select" ON public.applications FOR SELECT TO authenticated, anon USING (false);
-- CREATE POLICY "applications_coming_soon_block_insert" ON public.applications FOR INSERT TO authenticated, anon WITH CHECK (false);
-- CREATE POLICY "applications_coming_soon_block_update" ON public.applications FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
-- DROP POLICY IF EXISTS "candidate_profiles_owner_select" ON public.candidate_profiles;
-- DROP POLICY IF EXISTS "candidate_profiles_owner_insert" ON public.candidate_profiles;
-- DROP POLICY IF EXISTS "candidate_profiles_owner_update" ON public.candidate_profiles;
-- CREATE POLICY "candidate_profiles_coming_soon_block_select" ON public.candidate_profiles FOR SELECT TO authenticated, anon USING (false);
-- CREATE POLICY "candidate_profiles_coming_soon_block_insert" ON public.candidate_profiles FOR INSERT TO authenticated, anon WITH CHECK (false);
-- CREATE POLICY "candidate_profiles_coming_soon_block_update" ON public.candidate_profiles FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
-- COMMIT;
