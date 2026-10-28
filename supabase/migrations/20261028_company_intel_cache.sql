-- ==============================================================================
-- Migration: Company Intel 30-Day Cache Table
-- Date: 2026-10-28
-- Scope: company_intel_cache (cached public company research keyed by normalized name)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.company_intel_cache (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_company  TEXT NOT NULL UNIQUE,
  company_name        TEXT NOT NULL,
  intel_json          JSONB NOT NULL,
  claims_count        INTEGER NOT NULL DEFAULT 0,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS company_intel_cache_normalized_idx
  ON public.company_intel_cache (normalized_company);

CREATE INDEX IF NOT EXISTS company_intel_cache_expires_idx
  ON public.company_intel_cache (expires_at);

ALTER TABLE public.company_intel_cache ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'company_intel_cache' AND policyname = 'company_intel_cache_service_all'
  ) THEN
    CREATE POLICY "company_intel_cache_service_all" ON public.company_intel_cache
      FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
