-- ============================================================================
-- Migration: 20261118_onboarding_resume_uploads.sql
-- Description: Pointer table + orphan finder for the onboarding resume upload (PR #655).
--   * Additive only. Does NOT modify the existing private `resumes` bucket row
--     (size limit / allowed MIME types), its storage.objects policies, or any object.
--   * The 5 MB, PDF/DOCX-only rule is enforced by /api/onboarding/resume.
--   * Uploads run server-side with the service role; clients get no write path.
--   * Rate limiting reuses public.check_rate_limit (20261020).
--   * Objects this migration creates are stamped with the marker comment
--     'created-by:20261118_onboarding_resume_uploads'; the rollback only touches
--     objects carrying that marker.
-- Transactional: preflight + DDL + post-checks run in one transaction; any
-- failure rolls everything back. Idempotent: safe to re-run.
-- Status: NOT APPLIED. Record with:
--   node scripts/record-migration.cjs 20261118_onboarding_resume_uploads
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- PREFLIGHT (read-only). Any RAISE EXCEPTION aborts and rolls back everything.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_marker   constant text := 'created-by:20261118_onboarding_resume_uploads';
  v_table    regclass := to_regclass('public.onboarding_resume_uploads');
  v_cols     text;
  v_expected constant text :=
    'file_name:text:NO,mime_type:text:NO,size_bytes:integer:NO,storage_path:text:NO,'
    || 'uploaded_at:timestamp with time zone:NO,user_id:uuid:NO';
  v_bad      text;
BEGIN
  -- 1. Bucket prerequisites (read only; never modified here).
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'resumes') THEN
    RAISE EXCEPTION 'preflight: storage bucket "resumes" does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'resumes' AND public IS DISTINCT FROM false) THEN
    RAISE EXCEPTION 'preflight: storage bucket "resumes" is not private';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'resumes'
             AND file_size_limit IS NOT NULL AND file_size_limit < 5242880) THEN
    RAISE EXCEPTION 'preflight: "resumes" size limit is below 5 MB';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'resumes'
             AND allowed_mime_types IS NOT NULL
             AND NOT allowed_mime_types @> ARRAY[
               'application/pdf',
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) THEN
    RAISE EXCEPTION 'preflight: "resumes" does not allow both PDF and DOCX';
  END IF;
  IF to_regprocedure('public.check_rate_limit(text,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'preflight: public.check_rate_limit(text,integer,integer) is missing';
  END IF;

  -- 2. Refuse if any unexpected permissive policy lets clients INSERT/UPDATE into
  --    the resumes bucket (or any bucket, when the policy has no bucket_id filter).
  --    Allowed: the known owner-folder policies and the coming-soon deny policies.
  SELECT string_agg(
           format('%s [%s] roles=%s using=%s check=%s',
                  p.policyname, p.cmd, p.roles, coalesce(p.qual, '-'), coalesce(p.with_check, '-')),
           '; ')
    INTO v_bad
    FROM pg_policies p
   WHERE p.schemaname = 'storage'
     AND p.tablename = 'objects'
     AND p.permissive = 'PERMISSIVE'
     AND p.cmd IN ('INSERT', 'UPDATE', 'ALL')
     AND p.roles && ARRAY['authenticated', 'anon', 'public']::name[]
     AND (   coalesce(p.qual, '') || coalesce(p.with_check, '') LIKE '%resumes%'
          OR coalesce(p.qual, '') || coalesce(p.with_check, '') NOT LIKE '%bucket_id%')
     AND NOT (
           p.policyname IN ('Owner can insert own resume files', 'Owner can update own resume files',
                            'Users can upload their own resume', 'Users can update their own resume')
           AND coalesce(p.with_check, p.qual) LIKE '%foldername(%'
           AND coalesce(p.with_check, p.qual) LIKE '%auth.uid()%')
     AND NOT (
           p.policyname IN ('resumes_storage_coming_soon_block_insert', 'resumes_storage_coming_soon_block_update')
           AND coalesce(p.with_check, p.qual) LIKE '%false%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'preflight: unexpected client write policy on storage.objects for resumes: %', v_bad
      USING HINT = 'Review these policies before applying; this migration does not change storage policies.';
  END IF;

  -- 3. Refuse an incompatible or foreign pre-existing table.
  IF v_table IS NOT NULL THEN
    IF obj_description(v_table, 'pg_class') IS DISTINCT FROM v_marker THEN
      RAISE EXCEPTION 'preflight: public.onboarding_resume_uploads exists but was not created by this migration';
    END IF;
    SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name)
      INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'onboarding_resume_uploads';
    IF v_cols IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'preflight: public.onboarding_resume_uploads has incompatible columns: % (expected %)',
        v_cols, v_expected;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = v_table AND i.indisprimary AND a.attname = 'user_id' AND i.indnatts = 1
    ) THEN
      RAISE EXCEPTION 'preflight: public.onboarding_resume_uploads primary key is not (user_id)';
    END IF;
  END IF;

  -- 4. Refuse an incompatible or foreign pre-existing function of the same name.
  SELECT string_agg(format('%s(%s) -> %s [%s]', p.proname,
                           pg_get_function_identity_arguments(p.oid),
                           pg_get_function_result(p.oid),
                           coalesce(obj_description(p.oid, 'pg_proc'), 'no marker')), '; ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'list_onboarding_resume_orphans'
     AND (   pg_get_function_identity_arguments(p.oid) <> 'p_older_than interval, p_limit integer'
          OR pg_get_function_result(p.oid) <> 'TABLE(object_name text)'
          OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM v_marker);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'preflight: incompatible or foreign public.list_onboarding_resume_orphans: %', v_bad;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. Additive table: one current onboarding resume per user (pointer to the private object).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.onboarding_resume_uploads (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path text NOT NULL UNIQUE
               CHECK (storage_path LIKE user_id::text || '/onboarding/%'),
  file_name    text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  mime_type    text NOT NULL CHECK (mime_type IN (
                 'application/pdf',
                 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes   integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.onboarding_resume_uploads IS 'created-by:20261118_onboarding_resume_uploads';

-- 2. Owner may read own row; writes are service_role only.
ALTER TABLE public.onboarding_resume_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_resume_uploads FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.onboarding_resume_uploads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.onboarding_resume_uploads TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.onboarding_resume_uploads TO service_role;

DROP POLICY IF EXISTS "onboarding_resume_uploads_owner_select" ON public.onboarding_resume_uploads;
CREATE POLICY "onboarding_resume_uploads_owner_select"
  ON public.onboarding_resume_uploads
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 3. Orphan finder: onboarding objects older than N with no pointer row.
--    Only LISTS names; deletion goes through the Storage API so blobs are really removed.
CREATE OR REPLACE FUNCTION public.list_onboarding_resume_orphans(
  p_older_than interval DEFAULT interval '1 hour',
  p_limit      integer  DEFAULT 500
)
RETURNS TABLE (object_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.name
  FROM storage.objects o
  WHERE o.bucket_id = 'resumes'
    AND (storage.foldername(o.name))[2] = 'onboarding'
    AND o.created_at < now() - p_older_than
    AND NOT EXISTS (
      SELECT 1 FROM public.onboarding_resume_uploads u WHERE u.storage_path = o.name
    )
  ORDER BY o.created_at
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
$$;
COMMENT ON FUNCTION public.list_onboarding_resume_orphans(interval, integer)
  IS 'created-by:20261118_onboarding_resume_uploads';
ALTER FUNCTION public.list_onboarding_resume_orphans(interval, integer) SET statement_timeout = '5s';
REVOKE ALL ON FUNCTION public.list_onboarding_resume_orphans(interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_onboarding_resume_orphans(interval, integer) TO service_role;

-- ----------------------------------------------------------------------------
-- POST-CHECK (inside the transaction): clients cannot write, service_role can.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r text;
  p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.onboarding_resume_uploads', p) THEN
        RAISE EXCEPTION 'post-check: role % still holds % on public.onboarding_resume_uploads', r, p;
      END IF;
    END LOOP;
    IF has_function_privilege(r, 'public.list_onboarding_resume_orphans(interval,integer)', 'EXECUTE') THEN
      RAISE EXCEPTION 'post-check: role % can EXECUTE public.list_onboarding_resume_orphans', r;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.onboarding_resume_uploads', 'SELECT') THEN
    RAISE EXCEPTION 'post-check: anon can SELECT public.onboarding_resume_uploads';
  END IF;
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.onboarding_resume_uploads', p) THEN
      RAISE EXCEPTION 'post-check: service_role lacks % on public.onboarding_resume_uploads', p;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.list_onboarding_resume_orphans(interval,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: service_role cannot EXECUTE public.list_onboarding_resume_orphans';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFY (run separately after applying):
-- -- Bucket unchanged:
-- SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'resumes';
-- -- Client write is false (expect every column false):
-- SELECT r AS role,
--        has_table_privilege(r, 'public.onboarding_resume_uploads', 'INSERT') AS can_insert,
--        has_table_privilege(r, 'public.onboarding_resume_uploads', 'UPDATE') AS can_update,
--        has_table_privilege(r, 'public.onboarding_resume_uploads', 'DELETE') AS can_delete,
--        has_function_privilege(r, 'public.list_onboarding_resume_orphans(interval,integer)', 'EXECUTE') AS can_exec
--   FROM unnest(ARRAY['anon', 'authenticated']) AS r;
-- -- Service write is true (expect every column true):
-- SELECT has_table_privilege('service_role', 'public.onboarding_resume_uploads', 'INSERT') AS can_insert,
--        has_table_privilege('service_role', 'public.onboarding_resume_uploads', 'UPDATE') AS can_update,
--        has_table_privilege('service_role', 'public.onboarding_resume_uploads', 'DELETE') AS can_delete,
--        has_function_privilege('service_role', 'public.list_onboarding_resume_orphans(interval,integer)', 'EXECUTE') AS can_exec;
-- -- Only the owner-select policy on the new table:
-- SELECT policyname, cmd, roles FROM pg_policies WHERE tablename = 'onboarding_resume_uploads';
-- ============================================================================
-- ROLLBACK (guarded, non-destructive). Acts only on objects carrying this
-- migration's marker comment; keeps every row and every storage object; never
-- touches the bucket or storage policies.
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- SET LOCAL statement_timeout = '60s';
-- DO $$
-- DECLARE
--   v_marker constant text := 'created-by:20261118_onboarding_resume_uploads';
--   v_fn regprocedure := to_regprocedure('public.list_onboarding_resume_orphans(interval,integer)');
--   v_tb regclass := to_regclass('public.onboarding_resume_uploads');
-- BEGIN
--   IF v_fn IS NOT NULL AND obj_description(v_fn, 'pg_proc') = v_marker THEN
--     DROP FUNCTION public.list_onboarding_resume_orphans(interval, integer);
--   ELSE
--     RAISE NOTICE 'rollback: skipping list_onboarding_resume_orphans (absent or not created by this migration)';
--   END IF;
--   IF v_tb IS NOT NULL AND obj_description(v_tb, 'pg_class') = v_marker THEN
--     REVOKE SELECT ON TABLE public.onboarding_resume_uploads FROM authenticated;
--     ALTER TABLE public.onboarding_resume_uploads RENAME TO onboarding_resume_uploads_rolled_back_20261118;
--   ELSE
--     RAISE NOTICE 'rollback: skipping onboarding_resume_uploads (absent or not created by this migration)';
--   END IF;
-- END $$;
-- COMMIT;
-- ============================================================================
