-- ==============================================================================
-- Migration: Early Access Email Waitlist & Gmail Outgoing Send Log
-- Tables:
--   1. public.early_access_emails (email, created_at)
--   2. public.gmail_send_log (sent_at)
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

-- Outgoing Gmail message counter table (caps total outgoing messages at 150/day)
CREATE TABLE IF NOT EXISTS public.gmail_send_log (
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gmail_send_log_sent_at
  ON public.gmail_send_log (sent_at DESC);

ALTER TABLE public.gmail_send_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.gmail_send_log FROM anon, authenticated;
GRANT SELECT, INSERT ON public.gmail_send_log TO service_role;
