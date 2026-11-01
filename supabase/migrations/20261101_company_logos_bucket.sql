-- =============================================================================
-- Migration: 20261101_company_logos_bucket.sql
-- Purpose:
--   1. Create a public Supabase Storage bucket 'company-logos' for self-hosted
--      company logos in the landing page ticker strip (raster images only: png, jpeg, webp, gif).
--   2. Direct object downloads via public URLs (/storage/v1/object/public/company-logos/...)
--      work because `public = TRUE`. Public directory listing on storage.objects
--      is disallowed (no public SELECT policy).
--   3. Restrict writes (INSERT, UPDATE, DELETE) to service_role only.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'company-logos',
  'company-logos',
  TRUE,
  2097152,
  ARRAY[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = TRUE,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public listing must not be allowed: drop any public SELECT policy on storage.objects
DROP POLICY IF EXISTS "Public company logos read access" ON storage.objects;

-- Service role write access on storage.objects for company-logos bucket
DROP POLICY IF EXISTS "Service role write access on company logos" ON storage.objects;
CREATE POLICY "Service role write access on company logos"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'company-logos')
  WITH CHECK (bucket_id = 'company-logos');
