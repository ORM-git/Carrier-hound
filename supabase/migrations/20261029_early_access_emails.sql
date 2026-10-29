-- ==============================================================================
-- Migration: Early Access Email Waitlist
-- Table: public.early_access_emails (email, created_at)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.early_access_emails (
  email      TEXT PRIMARY KEY CHECK (char_length(email) <= 254 AND position('@' in email) > 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_early_access_emails_created_at
  ON public.early_access_emails (created_at DESC);

ALTER TABLE public.early_access_emails ENABLE ROW LEVEL SECURITY;

-- Lock down direct client access; only server-side service_role can read/write
REVOKE ALL ON public.early_access_emails FROM anon, authenticated;
GRANT SELECT, INSERT ON public.early_access_emails TO service_role;
