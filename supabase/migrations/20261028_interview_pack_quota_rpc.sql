-- ==============================================================================
-- Migration: Atomic Quota Consumption and Refund RPC for Interview Pack
-- Date: 2026-10-28
-- Scope: public.consume_interview_pack_quota (service-role only atomic counter)
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.consume_interview_pack_quota(
  p_user_id UUID,
  p_period_date DATE,
  p_operation TEXT DEFAULT 'interview_pack',
  p_limit INT DEFAULT 10,
  p_refund BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (count INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_refund THEN
    RETURN QUERY
    UPDATE public.ai_usage_quotas
    SET count = GREATEST(public.ai_usage_quotas.count - 1, 0),
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND period_date = p_period_date
      AND operation = p_operation
    RETURNING public.ai_usage_quotas.count;
  ELSE
    RETURN QUERY
    INSERT INTO public.ai_usage_quotas (user_id, period_date, operation, count, total_tokens, updated_at)
    VALUES (p_user_id, p_period_date, p_operation, 1, 0, NOW())
    ON CONFLICT (user_id, period_date, operation)
    DO UPDATE SET
      count = public.ai_usage_quotas.count + 1,
      updated_at = NOW()
    WHERE public.ai_usage_quotas.count < p_limit
    RETURNING public.ai_usage_quotas.count;
  END IF;
END;
$$;

-- Service-role only: revoke from public, anon, and authenticated
REVOKE EXECUTE ON FUNCTION public.consume_interview_pack_quota(UUID, DATE, TEXT, INT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_interview_pack_quota(UUID, DATE, TEXT, INT, BOOLEAN) TO service_role;
