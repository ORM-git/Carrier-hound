-- =============================================================================
-- Migration: 20261101_company_logos_bucket.sql
-- Purpose:
--   1. Create a public Supabase Storage bucket 'company-logos' for self-hosted
--      company logos in the landing page ticker strip.
--   2. Enforce public read access (SELECT) for all clients (public, anon, authenticated).
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
    'image/gif',
    'image/svg+xml'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = TRUE,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public read access on storage.objects for company-logos bucket
DROP POLICY IF EXISTS "Public company logos read access" ON storage.objects;
CREATE POLICY "Public company logos read access"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'company-logos');

-- Service role write access on storage.objects for company-logos bucket
DROP POLICY IF EXISTS "Service role write access on company logos" ON storage.objects;
CREATE POLICY "Service role write access on company logos"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'company-logos')
  WITH CHECK (bucket_id = 'company-logos');
