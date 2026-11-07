-- ============================================================================
-- Migration: 20261106p_security_definer_search_path.sql
-- STATUS: NOT APPLIED - apply manually in Supabase SQL editor, then record:
--   node scripts/record-migration.cjs 20261106p_security_definer_search_path
--
-- Database row #60 (SECURITY DEFINER search_path pinning).
--
-- Why: a SECURITY DEFINER function runs with its owner's privileges; an
-- unpinned search_path lets a caller shadow unqualified names (tables,
-- operators, functions) with objects in schemas earlier on the path - the
-- classic search_path hijack. Sheet evidence: "Only the 2 matview functions
-- SET search_path; payment/AI RPCs unpinned." Audit of all migrations
-- confirms 14 unpinned definitions across 10 function names:
--   fulfil_payment_order   (20261103c/g, superseded by 20261104b)
--   consume_addon_set      (20261103b, superseded by 20261103d/h)
--   consume_plan_set       (20261103d, superseded by 20261103h)
--   consume_user_set       (20261103d, superseded by 20261103h)
--   refund_plan_or_addon_set (20261103d, superseded by 20261103h)
--   record_plan_usage_result (20261103h)
--   ai_global_budget_reserve / ai_global_budget_settle (20261104a)
--   ai_concurrency_acquire / ai_concurrency_release (20261104a)
-- CREATE OR REPLACE with different argument types creates overloads, so
-- both the old and new signatures may exist live. The DO block below pins
-- EVERY public-schema SECURITY DEFINER function, whatever its signature,
-- so no overload is missed; already-pinned functions get the same setting
-- reapplied (idempotent).
--
-- Value pinned: search_path = public - the same setting the already-pinned
-- house functions use (20261020 rate_limits, 20261101 matviews, 20261106
-- series). No function body changes; semantics unchanged because every
-- affected function only references public-schema objects.
--
-- Rollback: see the commented block at the bottom.
-- ============================================================================

DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN
    SELECT p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
  LOOP
    EXECUTE format(
      'ALTER FUNCTION public.%I(%s) SET search_path = public',
      f.proname, f.args
    );
  END LOOP;
END;
$$;

-- Verify afterwards (scripts/db-health.sql section 17 runs the same check):
--   SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prosecdef
--     AND (p.proconfig IS NULL OR NOT p.proconfig::text LIKE '%search_path%');
-- Expected: zero rows.

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DO $$
--   DECLARE f RECORD;
--   BEGIN
--     FOR f IN
--       SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
--       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public' AND p.prosecdef
--         AND p.proname IN ('fulfil_payment_order','consume_addon_set',
--           'consume_plan_set','consume_user_set','refund_plan_or_addon_set',
--           'record_plan_usage_result','ai_global_budget_reserve',
--           'ai_global_budget_settle','ai_concurrency_acquire',
--           'ai_concurrency_release')
--     LOOP
--       EXECUTE format('ALTER FUNCTION public.%I(%s) RESET search_path',
--         f.proname, f.args);
--     END LOOP;
--   END $$;
-- (Only the previously-unpinned functions are reset; the house-pinned ones
--  keep their setting.)
-- ============================================================================
