-- ==============================================================================
-- Migration: webhook_events idempotency table
-- Purpose: Atomic, race-safe webhook event deduplication for billing webhooks
-- (replaces the read-then-write metadata array approach, which is not atomic
-- and grows unbounded inside the subscriptions row).
-- NOTE: Owner applies this manually in the Supabase SQL Editor. Agents never run SQL.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.webhook_events (
  event_id     TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_type   TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- Webhooks are server-to-server only: no client-role access at all.
REVOKE ALL ON public.webhook_events FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.webhook_events TO service_role;

-- Optional periodic cleanup (keeps the table small; 90 days of events):
-- DELETE FROM public.webhook_events WHERE processed_at < now() - interval '90 days';

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   ALTER TABLE public.webhook_events DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.webhook_events CASCADE;
--   REVOKE SELECT, INSERT, DELETE ON public.webhook_events FROM service_role;
--   GRANT ALL ON public.webhook_events TO anon, authenticated;
-- ============================================================================
