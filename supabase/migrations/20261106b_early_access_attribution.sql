-- ==============================================================================
-- Migration: Early-access attribution columns (UTM / referrer)
-- File: supabase/migrations/20261106b_early_access_attribution.sql
-- Status: NOT APPLIED - owner runs in the Supabase SQL editor (additive,
--         nullable; safe while code ships first since inserts name columns
--         explicitly and the route omits them when absent).
-- Backend half of UTM capture (frontend: PR #287 / src/lib/analytics/utm.ts).
-- ==============================================================================

ALTER TABLE public.early_access_emails
  ADD COLUMN IF NOT EXISTS utm_source   TEXT CHECK (utm_source   IS NULL OR char_length(utm_source)   <= 200),
  ADD COLUMN IF NOT EXISTS utm_medium   TEXT CHECK (utm_medium   IS NULL OR char_length(utm_medium)   <= 200),
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT CHECK (utm_campaign IS NULL OR char_length(utm_campaign) <= 200),
  ADD COLUMN IF NOT EXISTS utm_term     TEXT CHECK (utm_term     IS NULL OR char_length(utm_term)     <= 200),
  ADD COLUMN IF NOT EXISTS utm_content  TEXT CHECK (utm_content  IS NULL OR char_length(utm_content)  <= 200),
  ADD COLUMN IF NOT EXISTS referrer     TEXT CHECK (referrer     IS NULL OR char_length(referrer)     <= 500),
  ADD COLUMN IF NOT EXISTS landing_path TEXT CHECK (landing_path IS NULL OR char_length(landing_path) <= 200);

COMMENT ON COLUMN public.early_access_emails.utm_source IS 'First-touch campaign attribution, session-scoped (backend half of UTM capture, 2026-11-06).';
