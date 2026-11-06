-- ==============================================================================
-- Schema: Shared Rate Limit Store & Distributed Sliding-Window Throttling
-- Scope: Multi-instance serverless rate limiting for signup, login, and AI calls
-- File: supabase/migrations/20261020_rate_limits.sql
-- Status: APPLIED OUT-OF-BAND 2026-10-20 (owner-run in Supabase SQL editor).
-- Recorded here to close repo-vs-live drift (audit DB #58 / #65). DO NOT re-run.
-- ==============================================================================

-- 1. Create durable rate_limits table
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 1,
  window_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

-- 2. Index on expires_at for efficient cleanup/eviction of expired buckets
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires_at ON public.rate_limits (expires_at);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- Revoke direct table mutations from client roles
REVOKE ALL ON public.rate_limits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limits TO service_role;

-- 4. Atomic rate-limit checking function (token-bucket / sliding window)
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key TEXT,
  p_max_requests INTEGER,
  p_window_seconds INTEGER
)
RETURNS TABLE (
  allowed BOOLEAN,
  retry_after INTEGER,
  current_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_reset_at TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  -- Insert or increment atomically
  INSERT INTO public.rate_limits (key, count, window_start, expires_at)
  VALUES (
    p_key,
    1,
    v_now,
    v_now + (p_window_seconds || ' seconds')::interval
  )
  ON CONFLICT (key) DO UPDATE
  SET
    count = CASE
      WHEN public.rate_limits.expires_at <= v_now THEN 1
      ELSE public.rate_limits.count + 1
    END,
    window_start = CASE
      WHEN public.rate_limits.expires_at <= v_now THEN v_now
      ELSE public.rate_limits.window_start
    END,
    expires_at = CASE
      WHEN public.rate_limits.expires_at <= v_now THEN v_now + (p_window_seconds || ' seconds')::interval
      ELSE public.rate_limits.expires_at
    END
  RETURNING public.rate_limits.count, public.rate_limits.expires_at
  INTO v_count, v_reset_at;

  IF v_count > p_max_requests THEN
    RETURN QUERY SELECT
      false AS allowed,
      GREATEST(1, EXTRACT(EPOCH FROM (v_reset_at - v_now))::INTEGER) AS retry_after,
      v_count AS current_count;
  ELSE
    RETURN QUERY SELECT
      true AS allowed,
      0 AS retry_after,
      v_count AS current_count;
  END IF;
END;
$$;

-- Allow serverless functions and authenticated clients to invoke the check function
GRANT EXECUTE ON FUNCTION public.check_rate_limit(TEXT, INTEGER, INTEGER) TO anon, authenticated, service_role;

-- 5. Automated TTL cleanup function for cron maintenance
CREATE OR REPLACE FUNCTION public.cleanup_expired_rate_limits()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.rate_limits
  WHERE expires_at < clock_timestamp() - INTERVAL '1 hour';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
