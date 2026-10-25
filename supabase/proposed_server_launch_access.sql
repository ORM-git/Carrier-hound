-- ==============================================================================
-- PROPOSED SCHEMA: Server-Backed Launch Access Policy, Tier Selection & Usage Accounting
-- STATUS: PROPOSED ONLY — NOT APPLIED TO DATABASE
-- SAFETY: DO NOT EXECUTE. FOR OWNER ARCHITECTURAL REVIEW ONLY.
--
-- REVISION NOTICE (Post-Review Hardening):
-- 1. Correct schema contract: `user_launch_access` uses `user_id UUID PRIMARY KEY`,
--    NOT an artificial `id` column.
-- 2. `SECURITY DEFINER` procedures strictly pin `SET search_path = public, pg_temp;`
--    preventing search_path hijacking via temporary objects.
-- 3. Policy and RLS definitions are idempotent and rerunnable (`DROP POLICY IF EXISTS`).
-- 4. Explicitly revokes `authenticated` privileges on all launch tables prior to
--    narrow column-level grants.
-- 5. Internal administrative fields (`revocation_reason`, `revoked_by`) are strictly
--    omitted from the `authenticated` SELECT column grant to preserve admin privacy.
-- 6. Administrative revocation procedure supports pre-selection abuse revocation via
--    atomic upsert (`INSERT ... ON CONFLICT DO UPDATE`).
-- 7. Eliminates authenticated RPC bypass: `set_user_launch_tier` is callable ONLY by
--    `service_role`. All client selection flows route through `POST /api/billing/activate`
--    which enforces session verification, payload validation, and rate limiting.
-- 8. Global AI quota uses atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE request_count < limit`
--    with `RETURNING`, eliminating race conditions and TOCTOU bugs. Refund uses atomic decrement.
-- 9. Rate limiting transparency: Edge in-memory Maps are best-effort per isolate;
--    cross-instance rate limiting relies on shared PostgreSQL store (`public.check_rate_limit`).
-- 10. Paid-Listings / Free-Launch-AI interaction: Existing paid subscriptions in
--     `public.subscriptions` retain strict precedence (`accessSource: "subscription"`).
--     They are NEVER silently modified or downgraded.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Server-Side Launch Access Policy Table
-- Controls global launch availability, supported tiers, and announcements.
-- Defaults to is_enabled = false (starts disabled until owner approval).
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.launch_policy (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  allow_ai BOOLEAN NOT NULL DEFAULT true,
  allow_listings BOOLEAN NOT NULL DEFAULT true,
  announcement TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

-- Seed initial disabled policy row if not present
INSERT INTO public.launch_policy (id, is_enabled, allow_ai, allow_listings, announcement)
VALUES (1, false, true, true, 'Launch access pending owner activation.')
ON CONFLICT (id) DO NOTHING;

-- RLS: Enabled
ALTER TABLE public.launch_policy ENABLE ROW LEVEL SECURITY;

-- Grants & Revokes: Explicitly revoke all authenticated before narrow grant
REVOKE ALL ON public.launch_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.launch_policy TO authenticated, service_role;
GRANT ALL ON public.launch_policy TO service_role;

-- RLS Policies (Idempotent)
DROP POLICY IF EXISTS "allow_read_launch_policy" ON public.launch_policy;
CREATE POLICY "allow_read_launch_policy"
  ON public.launch_policy
  FOR SELECT
  TO authenticated, service_role
  USING (true);

DROP POLICY IF EXISTS "service_role_manage_launch_policy" ON public.launch_policy;
CREATE POLICY "service_role_manage_launch_policy"
  ON public.launch_policy
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- 2. User Launch Access Selection Table
-- Stores server-backed tier selection for signed-in users.
-- Single primary key on user_id ensures idempotent tier updates (no artificial id).
-- Supports administrative revocation for abuse via revoked_at timestamp.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_launch_access (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tier VARCHAR(16) NOT NULL CHECK (tier IN ('listings', 'ai')),
  selected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  revoked_by UUID REFERENCES auth.users(id)
);

-- Index for active access lookup
CREATE INDEX IF NOT EXISTS idx_user_launch_access_active
  ON public.user_launch_access (user_id, tier)
  WHERE revoked_at IS NULL;

-- RLS: Enabled
ALTER TABLE public.user_launch_access ENABLE ROW LEVEL SECURITY;

-- Grants & Revokes: Explicitly revoke authenticated table-wide privileges
REVOKE ALL ON public.user_launch_access FROM PUBLIC, anon, authenticated;

-- PRIVACY CONTROL: Grant SELECT strictly on user-facing columns.
-- Internal revocation_reason and revoked_by are NEVER selectable by authenticated users.
GRANT SELECT (user_id, tier, selected_at, updated_at, revoked_at)
  ON public.user_launch_access TO authenticated;

-- Full access reserved strictly for backend service_role
GRANT ALL ON public.user_launch_access TO service_role;

-- RLS Policies (Idempotent)
DROP POLICY IF EXISTS "user_view_own_launch_access" ON public.user_launch_access;
CREATE POLICY "user_view_own_launch_access"
  ON public.user_launch_access
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "service_role_manage_user_launch_access" ON public.user_launch_access;
CREATE POLICY "service_role_manage_user_launch_access"
  ON public.user_launch_access
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- 3. Global AI Daily Usage Accounting Table
-- Tracks platform-wide daily AI request volume for the owner-configurable capacity
-- guard (MAX_GLOBAL_DAILY_AI_REQUESTS).
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_global_usage_daily (
  usage_date DATE PRIMARY KEY DEFAULT CURRENT_DATE,
  request_count INT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: Enabled
ALTER TABLE public.ai_global_usage_daily ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ai_global_usage_daily FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ai_global_usage_daily TO service_role;

DROP POLICY IF EXISTS "service_role_manage_ai_global_usage" ON public.ai_global_usage_daily;
CREATE POLICY "service_role_manage_ai_global_usage"
  ON public.ai_global_usage_daily
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- 4. Active Job Country Counts Aggregate View
-- Derives distinct country codes and active listing volume directly from the
-- existing `jobs_public` view (which already enforces `is_active = true OR status = 'active'`).
-- Completely eliminates expensive per-visitor multi-page scans on client devices.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.active_job_country_counts AS
SELECT
  country_code,
  COUNT(*)::INT AS job_count
FROM public.jobs_public
WHERE country_code IS NOT NULL
  AND TRIM(country_code) <> ''
GROUP BY country_code
ORDER BY job_count DESC;

-- Public read grant on aggregate view
GRANT SELECT ON public.active_job_country_counts TO anon, authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 5. Stored Procedures: Tier Selection & Administrative Revocation
-- All SECURITY DEFINER procedures strictly pin search_path = public, pg_temp.
-- ------------------------------------------------------------------------------

-- Procedure 5.1: Service-Role Controlled User Tier Selection
-- NOTE: Callable ONLY by service_role. Revoked from authenticated/anon to prevent RPC bypass.
CREATE OR REPLACE FUNCTION public.set_user_launch_tier(
  p_user_id UUID,
  p_tier VARCHAR(16)
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_policy RECORD;
  v_existing RECORD;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'USER_ID_REQUIRED',
      'error', 'A valid user ID is required.'
    );
  END IF;

  IF p_tier NOT IN ('listings', 'ai') THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'INVALID_TIER',
      'error', 'Invalid tier selection. Allowed values are listings or ai.'
    );
  END IF;

  -- Verify server launch policy is active
  SELECT is_enabled, allow_ai, allow_listings INTO v_policy
  FROM public.launch_policy
  WHERE id = 1;

  IF NOT FOUND OR NOT v_policy.is_enabled THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'LAUNCH_POLICY_DISABLED',
      'error', 'Launch access is currently disabled.'
    );
  END IF;

  IF p_tier = 'ai' AND NOT v_policy.allow_ai THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'AI_TIER_DISABLED',
      'error', 'AI access tier is currently disabled by launch policy.'
    );
  END IF;

  IF p_tier = 'listings' AND NOT v_policy.allow_listings THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'LISTINGS_TIER_DISABLED',
      'error', 'Listings access tier is currently disabled by launch policy.'
    );
  END IF;

  -- Check if user is revoked for abuse
  SELECT revoked_at, revocation_reason INTO v_existing
  FROM public.user_launch_access
  WHERE user_id = p_user_id;

  IF FOUND AND v_existing.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'LAUNCH_ACCESS_REVOKED',
      'error', 'Launch access has been revoked for this account.'
    );
  END IF;

  -- Idempotently upsert tier selection
  INSERT INTO public.user_launch_access (user_id, tier, selected_at, updated_at)
  VALUES (p_user_id, p_tier, NOW(), NOW())
  ON CONFLICT (user_id) DO UPDATE
  SET tier = EXCLUDED.tier,
      updated_at = NOW();

  RETURN jsonb_build_object(
    'success', true,
    'tier', p_tier,
    'accessSource', 'launch_access',
    'status', 'none',
    'message', 'Launch access tier updated successfully.'
  );
END;
$$;

-- Service-role only execution; explicitly revoked from authenticated and anon
REVOKE ALL ON FUNCTION public.set_user_launch_tier(UUID, VARCHAR(16)) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_launch_tier(UUID, VARCHAR(16)) TO service_role;

-- Procedure 5.2: Administrative Individual Revocation (Supports Pre-Selection Upsert)
CREATE OR REPLACE FUNCTION public.revoke_user_launch_access(
  p_user_id UUID,
  p_reason TEXT DEFAULT 'Revoked by administrator'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'USER_ID_REQUIRED',
      'error', 'A valid user ID is required.'
    );
  END IF;

  -- Atomically upsert revocation row so that users revoked prior to first selection are also blocked
  INSERT INTO public.user_launch_access (
    user_id,
    tier,
    selected_at,
    updated_at,
    revoked_at,
    revocation_reason,
    revoked_by
  )
  VALUES (
    p_user_id,
    'listings',
    NOW(),
    NOW(),
    NOW(),
    p_reason,
    auth.uid()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET revoked_at = NOW(),
      revocation_reason = p_reason,
      updated_at = NOW(),
      revoked_by = auth.uid();

  RETURN jsonb_build_object(
    'success', true,
    'userId', p_user_id,
    'message', 'User launch access revoked successfully.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_user_launch_access(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_user_launch_access(UUID, TEXT) TO service_role;

-- ------------------------------------------------------------------------------
-- 6. Atomic Global AI Quota & Refund Functions
-- Eliminates race conditions via single-statement INSERT ... ON CONFLICT DO UPDATE ... WHERE
-- ------------------------------------------------------------------------------

-- Procedure 6.1: Atomic Conditional Capacity Check & Increment
CREATE OR REPLACE FUNCTION public.check_and_increment_global_ai_quota(
  p_estimated_tokens BIGINT DEFAULT 0,
  p_max_daily_requests INT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_res RECORD;
BEGIN
  IF p_max_daily_requests IS NULL OR p_max_daily_requests <= 0 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'CAP_REQUIRED',
      'error', 'Global AI capacity cap is unset or invalid. Explicit positive limit is required.'
    );
  END IF;

  -- Atomic insert-or-increment with conditional ceiling enforcement
  INSERT INTO public.ai_global_usage_daily AS d (usage_date, request_count, total_tokens, updated_at)
  VALUES (CURRENT_DATE, 1, GREATEST(0, p_estimated_tokens), NOW())
  ON CONFLICT (usage_date) DO UPDATE
  SET request_count = d.request_count + 1,
      total_tokens = d.total_tokens + GREATEST(0, p_estimated_tokens),
      updated_at = NOW()
  WHERE d.request_count < p_max_daily_requests
  RETURNING d.request_count, d.total_tokens INTO v_res;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'currentCount', v_res.request_count,
      'limit', p_max_daily_requests
    );
  ELSE
    SELECT request_count INTO v_res FROM public.ai_global_usage_daily WHERE usage_date = CURRENT_DATE;
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'GLOBAL_AI_CAPACITY_REACHED',
      'currentCount', COALESCE(v_res.request_count, p_max_daily_requests),
      'limit', p_max_daily_requests
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_increment_global_ai_quota(BIGINT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_increment_global_ai_quota(BIGINT, INT) TO service_role;

-- Procedure 6.2: Atomic Upstream Failure Refund
CREATE OR REPLACE FUNCTION public.refund_global_ai_quota(
  p_estimated_tokens BIGINT DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_res RECORD;
BEGIN
  UPDATE public.ai_global_usage_daily
  SET request_count = GREATEST(0, request_count - 1),
      total_tokens = GREATEST(0, total_tokens - GREATEST(0, p_estimated_tokens)),
      updated_at = NOW()
  WHERE usage_date = CURRENT_DATE
  RETURNING request_count, total_tokens INTO v_res;

  RETURN jsonb_build_object(
    'success', true,
    'currentCount', COALESCE(v_res.request_count, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.refund_global_ai_quota(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_global_ai_quota(BIGINT) TO service_role;

-- ------------------------------------------------------------------------------
-- 7. Superseding Note & Rollback Instructions
-- ------------------------------------------------------------------------------
-- SUPERSEDING NOTE:
-- This script replaces the previous `launch_passes` signed-token mechanism.
-- Existing customer subscriptions in `public.subscriptions` remain completely untouched.
-- To drop the superseded `launch_passes` table if it was created in a test database:
--   DROP TABLE IF EXISTS public.launch_passes CASCADE;
--
-- ROLLBACK INSTRUCTIONS (to completely remove this proposed feature):
--   DROP VIEW IF EXISTS public.active_job_country_counts;
--   DROP FUNCTION IF EXISTS public.refund_global_ai_quota(BIGINT);
--   DROP FUNCTION IF EXISTS public.check_and_increment_global_ai_quota(BIGINT, INT);
--   DROP FUNCTION IF EXISTS public.revoke_user_launch_access(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.set_user_launch_tier(UUID, VARCHAR(16));
--   DROP TABLE IF EXISTS public.user_launch_access CASCADE;
--   DROP TABLE IF EXISTS public.ai_global_usage_daily CASCADE;
--   DROP TABLE IF EXISTS public.launch_policy CASCADE;
