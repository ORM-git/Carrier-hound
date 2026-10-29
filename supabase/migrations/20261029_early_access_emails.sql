-- ==============================================================================
-- Migration: Early Access Email Waitlist & Gmail Outgoing Send Log
-- Tables:
--   1. public.early_access_emails (email, created_at)
--   2. public.gmail_send_log (id, recipient_email, kind, sent_at)
--      Tracks:
--      - Outgoing message count for the 150 messages/day cap (sent_at)
--      - Double opt-in-light: at most 1 thank-you per distinct recipient_email ever
--      - Owner daily digest cursor: last_digest_at = MAX(sent_at) WHERE kind = 'digest'
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

CREATE TABLE IF NOT EXISTS public.gmail_send_log (
  id              BIGSERIAL PRIMARY KEY,
  recipient_email TEXT,
  kind            TEXT NOT NULL DEFAULT 'thank_you' CHECK (kind IN ('thank_you', 'digest')),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gmail_send_log_sent_at
  ON public.gmail_send_log (sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_gmail_send_log_recipient_kind
  ON public.gmail_send_log (recipient_email, kind);

CREATE INDEX IF NOT EXISTS idx_gmail_send_log_kind_sent_at
  ON public.gmail_send_log (kind, sent_at DESC);

ALTER TABLE public.gmail_send_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.gmail_send_log FROM anon, authenticated;
GRANT SELECT, INSERT ON public.gmail_send_log TO service_role;
