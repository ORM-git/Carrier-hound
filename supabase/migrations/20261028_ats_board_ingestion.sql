-- ==============================================================================
-- Migration: ATS Company Board Token Registry & Consecutive Misses Tracking
-- Date: 2026-10-28
-- Scope: public.company_token_registry, public.jobs.consecutive_misses
-- Safety: Do NOT apply directly to production database during test/review.
-- ==============================================================================

-- 1. Add consecutive_misses column to public.jobs for stale board tracking
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS consecutive_misses INTEGER DEFAULT 0;

-- Optional index for stale tracking (commented out per migration safety):
-- Note: If needed in production, execute CONCURRENTLY outside a transaction block:
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_consecutive_misses_idx
--   ON public.jobs (consecutive_misses)
--   WHERE is_active = true;

-- 2. Create company_token_registry table for Greenhouse, Lever, and Ashby boards
CREATE TABLE IF NOT EXISTS public.company_token_registry (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company          TEXT NOT NULL,
  ats              TEXT NOT NULL CHECK (ats IN ('greenhouse', 'lever', 'ashby')),
  token            TEXT NOT NULL,
  country_hint     TEXT DEFAULT 'global',
  is_active        BOOLEAN DEFAULT true,
  last_verified_at TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT company_token_registry_ats_token_key UNIQUE (ats, token)
);

CREATE INDEX IF NOT EXISTS company_token_registry_ats_active_idx
  ON public.company_token_registry (ats, is_active)
  WHERE is_active = true;

-- 3. Row Level Security: Service-role only access (no public exposure)
ALTER TABLE public.company_token_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company_token_registry_service_all" ON public.company_token_registry;

REVOKE ALL ON public.company_token_registry FROM anon, authenticated;
GRANT ALL ON public.company_token_registry TO service_role;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.company_token_registry_ats_active_idx;
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS consecutive_misses;
--   ALTER TABLE public.company_token_registry DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.company_token_registry CASCADE;
--   REVOKE ALL ON public.company_token_registry FROM service_role;
--   GRANT ALL ON public.company_token_registry TO anon, authenticated;
--   NOTE: this migration itself drops POLICY company_token_registry_service_all - restore it from the earlier migration that created it (or from backup) if rolling back.
-- ============================================================================
