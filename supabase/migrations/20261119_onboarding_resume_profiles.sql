-- ============================================================================
-- Migration: 20261119_onboarding_resume_profiles.sql
-- Description: Private store for the structured profile parsed from a user's
--   onboarding resume (or LinkedIn "Save to PDF" export) so /api/jobs/recommended
--   can use it for ranking.
--   * Additive only. Depends on 20261118_onboarding_resume_uploads (one row per
--     user there; this row is deleted with it, and with the account).
--   * Stores parsed fields only (job titles, skills, years of experience,
--     education, location, preferred roles). No raw resume text, no contact data.
--   * Writes are service_role only (POST /api/onboarding/resume). The owner may
--     read their own row; nobody else can.
--   * Objects this migration creates carry the marker comment
--     'created-by:20261119_onboarding_resume_profiles'; the rollback only touches
--     objects carrying that marker.
-- Transactional: preflight + DDL + post-checks run in one transaction; any
-- failure rolls everything back. Idempotent: safe to re-run.
-- Status: NOT APPLIED. Record with:
--   node scripts/record-migration.cjs 20261119_onboarding_resume_profiles
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- PREFLIGHT (read-only). Any RAISE EXCEPTION aborts and rolls back everything.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_marker   constant text := 'created-by:20261119_onboarding_resume_profiles';
  v_parent   regclass := to_regclass('public.onboarding_resume_uploads');
  v_table    regclass := to_regclass('public.onboarding_resume_profiles');
  v_cols     text;
  v_expected constant text :=
    'failure_reason:text:YES,parse_source:text:YES,parse_status:text:NO,parsed_at:timestamp with time zone:NO,'
    || 'profile:jsonb:NO,source_storage_path:text:NO,user_id:uuid:NO';
BEGIN
  -- 1. Parent table from 20261118 must exist and be the one that migration created.
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'preflight: public.onboarding_resume_uploads is missing (apply 20261118_onboarding_resume_uploads first)';
  END IF;
  IF obj_description(v_parent, 'pg_class') IS DISTINCT FROM 'created-by:20261118_onboarding_resume_uploads' THEN
    RAISE EXCEPTION 'preflight: public.onboarding_resume_uploads was not created by 20261118_onboarding_resume_uploads';
  END IF;

  -- 2. Refuse an incompatible or foreign pre-existing table.
  IF v_table IS NOT NULL THEN
    IF obj_description(v_table, 'pg_class') IS DISTINCT FROM v_marker THEN
      RAISE EXCEPTION 'preflight: public.onboarding_resume_profiles exists but was not created by this migration';
    END IF;
    SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name)
      INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'onboarding_resume_profiles';
    IF v_cols IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'preflight: public.onboarding_resume_profiles has incompatible columns: % (expected %)',
        v_cols, v_expected;
    END IF;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. Additive table: one parsed profile per user, tied to the current upload.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.onboarding_resume_profiles (
  user_id             uuid PRIMARY KEY
                      REFERENCES public.onboarding_resume_uploads(user_id) ON DELETE CASCADE,
  -- The upload this profile was parsed from. Readers ignore the row when it no
  -- longer matches onboarding_resume_uploads.storage_path (a newer upload).
  source_storage_path text NOT NULL
                      CHECK (source_storage_path LIKE user_id::text || '/onboarding/%'),
  parse_status        text NOT NULL CHECK (parse_status IN ('parsed', 'failed')),
  parse_source        text CHECK (parse_source IN ('ai', 'rules')),
  failure_reason      text CHECK (failure_reason IN ('no_text', 'scanned_pdf', 'parse_error')),
  profile             jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(profile) = 'object' AND octet_length(profile::text) <= 32768),
  parsed_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((parse_status = 'parsed' AND parse_source IS NOT NULL AND failure_reason IS NULL)
      OR (parse_status = 'failed' AND failure_reason IS NOT NULL))
);
COMMENT ON TABLE public.onboarding_resume_profiles IS 'created-by:20261119_onboarding_resume_profiles';

-- 2. Owner may read own row; writes are service_role only.
ALTER TABLE public.onboarding_resume_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_resume_profiles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.onboarding_resume_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.onboarding_resume_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.onboarding_resume_profiles TO service_role;

DROP POLICY IF EXISTS "onboarding_resume_profiles_owner_select" ON public.onboarding_resume_profiles;
CREATE POLICY "onboarding_resume_profiles_owner_select"
  ON public.onboarding_resume_profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 3. Atomic conditional save: locks the pointer row so a newer upload wins atomically.
CREATE OR REPLACE FUNCTION public.save_onboarding_resume_profile(
  p_user_id             uuid,
  p_storage_path        text,
  p_parse_status        text,
  p_parse_source        text,
  p_failure_reason      text,
  p_profile             jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_path text;
BEGIN
  -- Lock the pointer row to serialize saves for this user
  SELECT storage_path INTO v_current_path
    FROM public.onboarding_resume_uploads
   WHERE user_id = p_user_id
     FOR UPDATE;

  -- Stale save: pointer moved or does not exist
  IF v_current_path IS DISTINCT FROM p_storage_path THEN
    RETURN false;
  END IF;

  INSERT INTO public.onboarding_resume_profiles (
    user_id, source_storage_path, parse_status, parse_source, failure_reason, profile, parsed_at
  ) VALUES (
    p_user_id, p_storage_path, p_parse_status, p_parse_source, p_failure_reason, p_profile, now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    source_storage_path = excluded.source_storage_path,
    parse_status        = excluded.parse_status,
    parse_source        = excluded.parse_source,
    failure_reason      = excluded.failure_reason,
    profile             = excluded.profile,
    parsed_at           = excluded.parsed_at;

  RETURN true;
END;
$$;
COMMENT ON FUNCTION public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb)
  IS 'created-by:20261119_onboarding_resume_profiles';
REVOKE ALL ON FUNCTION public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb) TO service_role;

-- ----------------------------------------------------------------------------
-- POST-CHECK (inside the transaction): clients cannot write, service_role can.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r text;
  p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    FOREACH p IN ARRAY ARRAY['TRUNCATE', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.onboarding_resume_profiles', p) THEN
        RAISE EXCEPTION 'post-check: role % still holds % on public.onboarding_resume_profiles', r, p;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (
    SELECT 1
      FROM pg_class c
     CROSS JOIN LATERAL aclexplode(c.relacl) AS a
      LEFT JOIN pg_roles g ON g.oid = a.grantee
     WHERE c.oid = 'public.onboarding_resume_profiles'::regclass
       AND (a.grantee = 0 OR g.rolname IN ('anon', 'authenticated'))
       AND NOT (g.rolname = 'authenticated' AND a.privilege_type = 'SELECT')
  ) THEN
    RAISE EXCEPTION 'post-check: PUBLIC/anon/authenticated hold a privilege beyond owner SELECT on public.onboarding_resume_profiles';
  END IF;
  IF has_table_privilege('anon', 'public.onboarding_resume_profiles', 'SELECT') THEN
    RAISE EXCEPTION 'post-check: anon can SELECT public.onboarding_resume_profiles';
  END IF;
  IF has_table_privilege('public', 'public.onboarding_resume_profiles', 'SELECT') THEN
    RAISE EXCEPTION 'post-check: public can SELECT public.onboarding_resume_profiles';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy pol
     WHERE pol.polrelid = 'public.onboarding_resume_profiles'::regclass
       AND pol.polname <> 'onboarding_resume_profiles_owner_select'
  ) THEN
    RAISE EXCEPTION 'post-check: unexpected extra policy on public.onboarding_resume_profiles';
  END IF;
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.onboarding_resume_profiles', p) THEN
      RAISE EXCEPTION 'post-check: service_role lacks % on public.onboarding_resume_profiles', p;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: anon can EXECUTE save_onboarding_resume_profile';
  END IF;
  IF has_function_privilege('authenticated', 'public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: authenticated can EXECUTE save_onboarding_resume_profile';
  END IF;
  IF has_function_privilege('public', 'public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: public can EXECUTE save_onboarding_resume_profile';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: service_role lacks EXECUTE on save_onboarding_resume_profile';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY (run separately after applying):
-- -- Client write is false (expect every column false):
-- SELECT r AS role,
--        has_table_privilege(r, 'public.onboarding_resume_profiles', 'INSERT') AS can_insert,
--        has_table_privilege(r, 'public.onboarding_resume_profiles', 'UPDATE') AS can_update,
--        has_table_privilege(r, 'public.onboarding_resume_profiles', 'DELETE') AS can_delete,
--        has_table_privilege(r, 'public.onboarding_resume_profiles', 'TRUNCATE') AS can_truncate
--   FROM unnest(ARRAY['anon', 'authenticated', 'public']) AS r;
-- -- anon cannot read (expect false):
-- SELECT has_table_privilege('anon', 'public.onboarding_resume_profiles', 'SELECT') AS anon_can_select;
-- -- Service write is true (expect every column true):
-- SELECT has_table_privilege('service_role', 'public.onboarding_resume_profiles', 'INSERT') AS can_insert,
--        has_table_privilege('service_role', 'public.onboarding_resume_profiles', 'UPDATE') AS can_update,
--        has_table_privilege('service_role', 'public.onboarding_resume_profiles', 'DELETE') AS can_delete,
--        has_table_privilege('service_role', 'public.onboarding_resume_profiles', 'TRUNCATE') AS can_truncate;
-- -- Only the owner-select policy:
-- SELECT policyname, cmd, roles, qual FROM pg_policies WHERE tablename = 'onboarding_resume_profiles';
-- ============================================================================
-- ROLLBACK (guarded). Acts only on the table carrying this migration's marker.
-- Keeps the rows (renames the table); never touches onboarding_resume_uploads.
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- SET LOCAL statement_timeout = '60s';
-- DO $$
-- DECLARE
--   v_marker constant text := 'created-by:20261119_onboarding_resume_profiles';
--   v_tb regclass := to_regclass('public.onboarding_resume_profiles');
-- BEGIN
--   DROP FUNCTION IF EXISTS public.save_onboarding_resume_profile(uuid, text, text, text, text, jsonb);
--   IF v_tb IS NOT NULL AND obj_description(v_tb, 'pg_class') = v_marker THEN
--     REVOKE SELECT ON TABLE public.onboarding_resume_profiles FROM authenticated;
--     ALTER TABLE public.onboarding_resume_profiles RENAME TO onboarding_resume_profiles_rolled_back_20261119;
--   ELSE
--     RAISE NOTICE 'rollback: skipping onboarding_resume_profiles (absent or not created by this migration)';
--   END IF;
-- END $$;
-- COMMIT;
-- ============================================================================
