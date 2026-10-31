-- ==============================================================================
-- Migration: Manual Early Access Approval Gate
-- Table: public.early_access_approved (email, approved, created_at, updated_at)
--
-- Security & Operational Rules:
-- 1. Default approved = FALSE, NOT NULL.
-- 2. Email is stored lowercase (CHECK email = lower(trim(email))).
-- 3. RLS enabled: strictly REVOKE all from anon and authenticated.
-- 4. No client/user path may ever read or mutate this table.
-- 5. Only service_role can read/write for server-side verification and admin management.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.early_access_approved (
  email      TEXT PRIMARY KEY CHECK (char_length(email) <= 254 AND email = lower(trim(email))),
  approved   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_early_access_approved_lookup
  ON public.early_access_approved (email)
  WHERE approved = TRUE;

ALTER TABLE public.early_access_approved ENABLE ROW LEVEL SECURITY;

-- Revoke all permissions from untrusted roles
REVOKE ALL ON public.early_access_approved FROM PUBLIC, anon, authenticated;

-- Grant access strictly to service_role for server-side verification and manual updates
GRANT SELECT, INSERT, UPDATE, DELETE ON public.early_access_approved TO service_role;

-- Explicit fail-closed policies forbidding all anon and authenticated access
DROP POLICY IF EXISTS "Deny all user access on early_access_approved" ON public.early_access_approved;
CREATE POLICY "Deny all user access on early_access_approved"
  ON public.early_access_approved
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);
