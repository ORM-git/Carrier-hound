-- ==============================================================================
-- PROPOSED SCHEMA: Server-Backed Launch Access Policy, Tier Selection & Usage Accounting
-- STATUS: PROPOSED ONLY — NOT APPLIED TO DATABASE
-- SAFETY: DO NOT EXECUTE. FOR OWNER ARCHITECTURAL REVIEW ONLY.
--
-- This script supersedes the earlier `launch_passes` signed-pass design.
-- Under the owner decision, every signed-in user may choose Listings or AI and use
-- the actual features free for now. Payments will be enabled in a future release.
--
-- Compatibility & Rollback:
-- 1. Does not modify or drop customer subscriptions in `public.subscriptions`.
-- 2. If `public.launch_passes` was created in an earlier sandbox, this script
--    supersedes it cleanly. `launch_passes` can be dropped or left dormant.
-- 3. Policy starts explicitly DISABLED (`is_enabled = false`). Launch access cannot
--    become active until the owner reviews and executes the enabling UPDATE.
-- 4. Complete rollback script provided at the end of this file.
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

-- Grants & Revokes
REVOKE ALL ON public.launch_policy FROM PUBLIC, anon;
GRANT SELECT ON public.launch_policy TO authenticated, service_role;
GRANT ALL ON public.launch_policy TO service_role;

-- RLS Policies
CREATE POLICY "allow_read_launch_policy"
  ON public.launch_policy
  FOR SELECT
  TO authenticated, service_role
  USING (true);

CREATE POLICY "service_role_manage_launch_policy"
  ON public.launch_policy
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- 2. User Launch Access Selection Table
-- Stores the server-backed tier selection for signed-in users.
-- Single primary key on user_id ensures idempotent tier updates.
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

-- Grants & Revokes
REVOKE ALL ON public.user_launch_access FROM PUBLIC, anon;
GRANT SELECT ON public.user_launch_access TO authenticated, service_role;
GRANT ALL ON public.user_launch_access TO service_role;

-- RLS Policies
-- Users can view only their own launch access row; service_role can view all
CREATE POLICY "user_view_own_launch_access"
  ON public.user_launch_access
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

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
-- SECURITY DEFINER with safe search_path = public.
-- ------------------------------------------------------------------------------

-- Procedure 5.1: Atomic User Tier Selection
CREATE OR REPLACE FUNCTION public.set_user_launch_tier(
  p_tier VARCHAR(16)
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_policy RECORD;
  v_existing RECORD;
BEGIN
  -- Derive user ID strictly from authenticated session
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'AUTH_REQUIRED',
      'error', 'Authentication required to select a launch access tier.'
    );
  END IF;

  -- Validate tier input
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
  WHERE user_id = v_user_id;

  IF FOUND AND v_existing.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'LAUNCH_ACCESS_REVOKED',
      'error', 'Launch access has been revoked for this account.',
      'revocation_reason', v_existing.revocation_reason
    );
  END IF;

  -- Idempotently upsert tier selection
  INSERT INTO public.user_launch_access (user_id, tier, selected_at, updated_at)
  VALUES (v_user_id, p_tier, NOW(), NOW())
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

-- Function grants with explicit signatures
REVOKE ALL ON FUNCTION public.set_user_launch_tier(VARCHAR(16)) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_user_launch_tier(VARCHAR(16)) TO authenticated, service_role;

-- Procedure 5.2: Administrative Individual Revocation
CREATE OR REPLACE FUNCTION public.revoke_user_launch_access(
  p_user_id UUID,
  p_reason TEXT DEFAULT 'Revoked by administrator'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.user_launch_access
  SET revoked_at = NOW(),
      revocation_reason = p_reason,
      updated_at = NOW(),
      revoked_by = auth.uid()
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'USER_NOT_FOUND',
      'error', 'No launch access record found for the specified user.'
    );
  END IF;

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
-- 6. Superseding Note & Rollback Instructions
-- ------------------------------------------------------------------------------
-- SUPERSEDING NOTE:
-- This script replaces the previous `launch_passes` signed-token mechanism.
-- Existing customer subscriptions in `public.subscriptions` remain completely untouched.
-- To drop the superseded `launch_passes` table if it was created in a test database:
--   DROP TABLE IF EXISTS public.launch_passes CASCADE;
--
-- ROLLBACK INSTRUCTIONS (to completely remove this proposed feature):
--   DROP VIEW IF EXISTS public.active_job_country_counts;
--   DROP FUNCTION IF EXISTS public.set_user_launch_tier(VARCHAR(16));
--   DROP FUNCTION IF EXISTS public.revoke_user_launch_access(UUID, TEXT);
--   DROP TABLE IF EXISTS public.user_launch_access;
--   DROP TABLE IF EXISTS public.ai_global_usage_daily;
--   DROP TABLE IF EXISTS public.launch_policy;
