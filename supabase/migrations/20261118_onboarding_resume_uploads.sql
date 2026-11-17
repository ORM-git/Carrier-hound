-- ============================================================================
-- Migration: 20261118_onboarding_resume_uploads.sql
-- Description: Pointer table + orphan finder for the onboarding resume upload (PR #655).
--   * Additive only. Does NOT modify the existing private `resumes` bucket row
--     (size limit / allowed MIME types), its policies, or any stored object.
--   * The 5 MB, PDF/DOCX-only rule is enforced by /api/onboarding/resume.
--   * Uploads run server-side with the service role (client writes to the bucket
--     stay blocked by 20261116c).
--   * Rate limiting reuses public.check_rate_limit (20261020).
-- Transactional: preflight + all DDL run in one transaction; any failure rolls back.
-- Idempotent: safe to run twice.
-- Status: NOT APPLIED. Record with:
--   node scripts/record-migration.cjs 20261118_onboarding_resume_uploads
-- ============================================================================

BEGIN;

-- PREFLIGHT: abort (rolls back everything) unless prerequisites hold. Read-only.
DO $$
BEGIN
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
END $$;

-- 1. Additive table: one current onboarding resume per user (pointer to the private object).
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

-- 2. Owner may read own row; all writes are server-side (service role) only.
ALTER TABLE public.onboarding_resume_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_resume_uploads FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.onboarding_resume_uploads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.onboarding_resume_uploads TO authenticated;

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
ALTER FUNCTION public.list_onboarding_resume_orphans(interval, integer) SET statement_timeout = '5s';
REVOKE ALL ON FUNCTION public.list_onboarding_resume_orphans(interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_onboarding_resume_orphans(interval, integer) TO service_role;

COMMIT;

-- ============================================================================
-- VERIFY (run separately):
-- SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'resumes';  -- unchanged
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'onboarding_resume_uploads';          -- owner_select only
-- SELECT has_table_privilege('authenticated', 'public.onboarding_resume_uploads', 'INSERT');      -- false
-- ============================================================================
-- ROLLBACK (non-destructive: keeps every row and every storage object; bucket untouched):
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.list_onboarding_resume_orphans(interval, integer) FROM service_role;
-- DROP FUNCTION IF EXISTS public.list_onboarding_resume_orphans(interval, integer);
-- REVOKE SELECT ON TABLE public.onboarding_resume_uploads FROM authenticated;
-- ALTER TABLE IF EXISTS public.onboarding_resume_uploads
--   RENAME TO onboarding_resume_uploads_rolled_back_20261118;
-- COMMIT;
-- ============================================================================
