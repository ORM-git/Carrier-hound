-- ============================================================================
-- Migration: 20261106s_resume_bucket_limits.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106s_resume_bucket_limits
--
-- Backend row #70 (Upload Type & Size Validation), storage-side boundary.
--
-- Why: the code contract (src/lib/resume/parser.ts) allows up to 10 MB
-- (MAX_RESUME_UPLOAD_BYTES = 10 * 1024 * 1024) and extensions
-- pdf/docx/txt/md, but the bucket row created in
-- 20261031_account_delete_and_private_resumes.sql still says 5 MB and a
-- mime list without text/markdown. Files between 5-10 MB and .md uploads
-- pass code validation and then fail at the storage boundary with an
-- inconsistent error, and the storage layer is the last line of defense
-- when a caller bypasses the app entirely. Aligning the bucket with the
-- code contract makes the boundary real and consistent.
--
-- What this does:
--   1. Aligns storage.buckets for `resumes` with the code contract:
--      file_size_limit = 10485760 (10 MB, == MAX_RESUME_UPLOAD_BYTES) and
--      allowed_mime_types = pdf / docx (OOXML) / plain / markdown. The
--      legacy 'application/msword' (.doc) entry is dropped because the
--      code contract rejects .doc uploads.
--   2. Re-asserts the owner-path INSERT policy on storage.objects
--      (uploads only into <auth.uid()>/<filename>) so this migration is
--      self-contained even if the 20261031 policies were drifted.
--
-- ROLLBACK (re-apply the 20261031 bucket values):
--   UPDATE storage.buckets
--     SET file_size_limit = 5242880,
--         allowed_mime_types = ARRAY[
--           'application/pdf',
--           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
--           'application/msword',
--           'text/plain'
--         ]
--     WHERE id = 'resumes';
-- ============================================================================

UPDATE storage.buckets
  SET file_size_limit = 10485760,
      allowed_mime_types = ARRAY[
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
        'text/markdown'
      ]
  WHERE id = 'resumes';

DROP POLICY IF EXISTS "Owner can insert own resume files" ON storage.objects;
CREATE POLICY "Owner can insert own resume files"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'resumes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
