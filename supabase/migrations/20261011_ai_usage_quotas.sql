-- ==============================================================================
-- Migration: Durable AI Usage Quota Tracking
-- Date: 2026-10-11
-- Scope: ai_usage_quotas (persistent per-user daily AI call counters)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.ai_usage_quotas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  operation    TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_usage_quotas_user_date_op_key UNIQUE (user_id, period_date, operation)
);

CREATE INDEX IF NOT EXISTS ai_usage_quotas_user_date_idx
  ON public.ai_usage_quotas (user_id, period_date);

CREATE INDEX IF NOT EXISTS ai_usage_quotas_user_idx
  ON public.ai_usage_quotas (user_id);

ALTER TABLE public.ai_usage_quotas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ai_usage_quotas' AND policyname = 'ai_usage_quotas_owner_select'
  ) THEN
    CREATE POLICY "ai_usage_quotas_owner_select" ON public.ai_usage_quotas
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "ai_usage_quotas_owner_select" ON public.ai_usage_quotas;
--   DROP INDEX IF EXISTS public.ai_usage_quotas_user_date_idx;
--   DROP INDEX IF EXISTS public.ai_usage_quotas_user_idx;
--   ALTER TABLE public.ai_usage_quotas DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.ai_usage_quotas CASCADE;
-- ============================================================================
