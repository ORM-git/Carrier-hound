-- ==============================================================================
-- Migration: Admin Early Access Approvals Schema Support
-- Adds:
-- 1. status, approved_at, approved_by to public.early_access_emails
-- 2. approved_at, approved_by to public.early_access_approved
-- 3. Grants UPDATE on early_access_emails to service_role
-- 4. Idempotently syncs existing approved status
-- ==============================================================================

-- 1. Add status, approved_at, approved_by to early_access_emails
ALTER TABLE public.early_access_emails
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT;

CREATE INDEX IF NOT EXISTS idx_early_access_emails_status_created_at
  ON public.early_access_emails (status, created_at DESC);

-- Allow service_role to update early_access_emails for approvals/rejections
GRANT UPDATE ON public.early_access_emails TO service_role;

-- 2. Add approved_at, approved_by to early_access_approved
ALTER TABLE public.early_access_approved
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT;

-- 3. Sync existing approved records from early_access_approved into early_access_emails
UPDATE public.early_access_emails e
SET status = 'approved',
    approved_at = a.approved_at,
    approved_by = a.approved_by
FROM public.early_access_approved a
WHERE lower(trim(e.email)) = lower(trim(a.email)) AND a.approved = TRUE;
