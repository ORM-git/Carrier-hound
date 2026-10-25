-- ==============================================================================
-- PROPOSED SCHEMA: Launch Pass Server-Side Registry & Atomic Anti-Repeat Controls
-- SAFETY NOTICE: DO NOT RUN THIS SCRIPT IN ANY ENVIRONMENT.
-- Architectural specification for owner review only. No SQL execution permitted.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Server-Side Registry Table
-- Stores issued launch pass records, cryptographic hashes, lifecycle timestamps,
-- and revocation state. The server registry is authoritative for tier and expiry.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.launch_passes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tier VARCHAR(16) NOT NULL CHECK (tier IN ('listings', 'ai')),
  token_hash CHAR(64) NOT NULL UNIQUE, -- SHA-256 hex hash of token (raw tokens are never stored)
  audience VARCHAR(64) NOT NULL DEFAULT 'careermonke-launch-pass',
  environment VARCHAR(32) NOT NULL DEFAULT 'production',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_launch_pass_lifetime CHECK (
    expires_at > issued_at AND expires_at <= issued_at + INTERVAL '14 days'
  )
);

-- ------------------------------------------------------------------------------
-- 2. Anti-Repeat Partial Unique Index & Renewal Tradeoff Explanation
-- 
-- PostgreSQL partial indexes CANNOT use volatile functions such as `NOW()`.
-- Therefore, an index predicate like `WHERE revoked_at IS NULL AND expires_at > NOW()`
-- is rejected by PostgreSQL.
--
-- DESIGN EXPLANATION FOR EXPIRED UNREVOKED RECORDS:
-- With `WHERE revoked_at IS NULL`, once a pass expires, its record remains in the index.
-- This strictly blocks ANY subsequent grant insertion for that user FOREVER (enforcing
-- a strict "one-grant-per-lifetime" policy), UNLESS an explicit revocation/archival
-- transition occurs (`revoked_at = NOW()` or pass deletion).
--
-- To avoid silently choosing a renewal policy in the database:
-- - If the owner policy is "One lifetime pass only": this index enforces it at the DB level.
-- - If the owner policy allows renewal after expiry: the RPC `issue_launch_pass_atomic`
--   checks `expires_at > NOW()` dynamically and archives/revokes the expired pass before
--   inserting a new one, OR the partial index can be adjusted upon owner policy approval.
-- ------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_launch_passes_single_active_grant
  ON public.launch_passes (user_id)
  WHERE revoked_at IS NULL;

-- High-performance token lookup index for server entitlement verification
CREATE INDEX IF NOT EXISTS idx_launch_passes_token_lookup
  ON public.launch_passes (token_hash)
  WHERE revoked_at IS NULL;

-- ------------------------------------------------------------------------------
-- 3. Row Level Security (RLS) & Granular Role Permissions
-- 
-- Zero client access: anon and authenticated roles have NO SELECT, INSERT, UPDATE,
-- or DELETE privileges. Only the backend `service_role` can access or manage this table.
-- ------------------------------------------------------------------------------
ALTER TABLE public.launch_passes ENABLE ROW LEVEL SECURITY;

-- Revoke all default public permissions
REVOKE ALL ON public.launch_passes FROM PUBLIC, anon, authenticated;

-- Grant access strictly to service_role (used by Cloudflare Worker server handlers)
GRANT SELECT, INSERT, UPDATE ON public.launch_passes TO service_role;

-- RLS Policy: service_role has full management; anon/authenticated have zero visibility
CREATE POLICY "service_role_manage_launch_passes"
  ON public.launch_passes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- 4. Atomic Anti-Repeat Issuance Stored Procedure
-- Serializes requests per user, checks lifetime quota, and guarantees atomic grant issuance.
-- Bound strictly to: user_id, tier, token_hash, audience, environment, and lifetime.
-- Role: Callable ONLY by service_role. Revoked from anon and authenticated.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_launch_pass_atomic(
  p_user_id UUID,
  p_tier VARCHAR(16),
  p_token_hash CHAR(64),
  p_audience VARCHAR(64),
  p_environment VARCHAR(32),
  p_lifetime_seconds INT,
  p_max_lifetime_grants INT DEFAULT 1
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_count INT;
  v_total_grants INT;
  v_new_id UUID;
BEGIN
  -- Lock user row in auth.users to serialize concurrent requests and eliminate race conditions
  PERFORM id FROM auth.users WHERE id = p_user_id FOR UPDATE;

  -- 1. Check for existing active, unexpired, unrevoked grant
  SELECT COUNT(*) INTO v_active_count
  FROM public.launch_passes
  WHERE user_id = p_user_id
    AND revoked_at IS NULL
    AND expires_at > NOW();

  IF v_active_count > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'ACTIVE_GRANT_EXISTS',
      'error', 'User already possesses an active, unexpired launch pass'
    );
  END IF;

  -- 2. Check total lifetime grants against owner repeat policy
  SELECT COUNT(*) INTO v_total_grants
  FROM public.launch_passes
  WHERE user_id = p_user_id;

  IF v_total_grants >= p_max_lifetime_grants THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MAX_GRANTS_EXCEEDED',
      'error', 'User has reached the maximum permitted lifetime launch pass grants'
    );
  END IF;

  -- 3. If an expired unrevoked pass exists and lifetime grants allow renewal,
  -- archive the expired pass so the partial unique index allows the new grant
  UPDATE public.launch_passes
  SET revoked_at = NOW(),
      revocation_reason = 'SUPERSEDED_BY_RENEWAL'
  WHERE user_id = p_user_id
    AND revoked_at IS NULL
    AND expires_at <= NOW();

  -- 4. Atomically insert new pass record
  INSERT INTO public.launch_passes (
    user_id,
    tier,
    token_hash,
    audience,
    environment,
    issued_at,
    expires_at
  ) VALUES (
    p_user_id,
    p_tier,
    p_token_hash,
    p_audience,
    p_environment,
    NOW(),
    NOW() + (p_lifetime_seconds || ' seconds')::INTERVAL
  ) RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'success', true,
    'pass_id', v_new_id,
    'tier', p_tier
  );
END;
$$;

-- Restrict RPC execution to service_role only
REVOKE ALL ON FUNCTION public.issue_launch_pass_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_launch_pass_atomic TO service_role;

-- ------------------------------------------------------------------------------
-- 5. Server-Side Revocation Stored Procedure
-- Immediate revocation by pass_id and user_id with audit reason.
-- Role: Callable ONLY by service_role. Revoked from anon and authenticated.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_launch_pass(
  p_user_id UUID,
  p_pass_id UUID,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.launch_passes
  SET revoked_at = NOW(),
      revocation_reason = p_reason
  WHERE id = p_pass_id
    AND user_id = p_user_id
    AND revoked_at IS NULL;

  IF FOUND THEN
    RETURN jsonb_build_object('success', true);
  ELSE
    RETURN jsonb_build_object(
      'success', false,
      'code', 'PASS_NOT_FOUND_OR_ALREADY_REVOKED',
      'error', 'Pass not found or already revoked'
    );
  END IF;
END;
$$;

-- Restrict RPC execution to service_role only
REVOKE ALL ON FUNCTION public.revoke_launch_pass FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_launch_pass TO service_role;
