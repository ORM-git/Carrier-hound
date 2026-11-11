-- ==============================================================================
-- DATABASE RECONCILIATION & INTEGRITY AUDIT SUITE (READ-ONLY)
-- CareerMonke (Carrier-hound) — Database Sanity and Cross-Table Checks
-- File: supabase/scripts/reconciliation.sql
--
-- PURPOSE:
-- Read-only SQL queries designed to audit consistency and sanity bounds
-- across related database tables and views:
--   1. jobs vs. jobs_public view (active job parity & mask enforcement)
--   2. subscriptions vs. user_addon_credits (entitlement consistency & orphan checks)
--   3. funnel_events vs. page_views (volume, stage progression & retention bounds)
--
-- EXECUTION SAFETY:
-- - Strictly READ-ONLY: Contains only SELECT statements and Common Table Expressions (CTEs).
-- - ZERO writes: No INSERT, UPDATE, DELETE, ALTER, DROP, or TRUNCATE statements.
-- - Safe to run directly in the Supabase Dashboard SQL Editor or via psql during
--   disaster recovery post-restore verification (see docs/dr-runbook.md).
-- ==============================================================================


-- ------------------------------------------------------------------------------
-- 1. JOBS vs. JOBS_PUBLIC VIEW RECONCILIATION
-- ------------------------------------------------------------------------------
-- The public view `public.jobs_public` is defined as:
--   SELECT ... FROM public.jobs WHERE is_active = true OR status = 'active';
-- Therefore:
--   - Count of active jobs in `public.jobs` MUST equal total rows in `public.jobs_public`.
--   - Discrepancy MUST be exactly 0.
--   - Inactive jobs must NEVER leak into `public.jobs_public`.
-- ------------------------------------------------------------------------------

-- [QUERY 1.1] Jobs vs jobs_public count parity
WITH jobs_source AS (
  SELECT
    COUNT(*) AS total_raw_jobs,
    COUNT(*) FILTER (WHERE is_active = true OR status = 'active') AS expected_public_jobs,
    COUNT(*) FILTER (WHERE NOT (is_active = true OR status = 'active')) AS inactive_raw_jobs
  FROM public.jobs
),
jobs_view AS (
  SELECT COUNT(*) AS actual_view_jobs
  FROM public.jobs_public
)
SELECT
  'jobs_vs_jobs_public_count' AS check_name,
  js.expected_public_jobs AS expected_count,
  jv.actual_view_jobs AS view_count,
  (js.expected_public_jobs - jv.actual_view_jobs) AS discrepancy,
  CASE
    WHEN js.expected_public_jobs = jv.actual_view_jobs THEN 'PASS'
    ELSE 'FAIL'
  END AS status,
  'Public view must expose exactly all active jobs' AS description
FROM jobs_source js, jobs_view jv;

-- [QUERY 1.2] Detect any inactive jobs leaking into jobs_public view
SELECT
  'jobs_public_inactive_leak' AS check_name,
  COUNT(*) AS leaked_inactive_jobs_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'PASS'
    ELSE 'FAIL'
  END AS status,
  'View must contain zero rows where is_active is false and status is not active' AS description
FROM public.jobs_public
WHERE NOT (is_active = true OR status = 'active');

-- [QUERY 1.3] Detect any active raw jobs missing from jobs_public view
SELECT
  'jobs_active_missing_from_view' AS check_name,
  COUNT(*) AS missing_jobs_count,
  CASE
    WHEN COUNT(*) = 0 THEN 'PASS'
    ELSE 'FAIL'
  END AS status,
  'All active raw jobs must have an identical id in jobs_public' AS description
FROM public.jobs j
WHERE (j.is_active = true OR j.status = 'active')
  AND NOT EXISTS (
    SELECT 1 FROM public.jobs_public jp WHERE jp.id = j.id
  );


-- ------------------------------------------------------------------------------
-- 2. SUBSCRIPTIONS vs. USER_ADDON_CREDITS RECONCILIATION
-- ------------------------------------------------------------------------------
-- Validates add-on credit balances, user entitlement links, and orphan detection:
--   - sets_remaining must never exceed sets_total and must be >= 0.
--   - Active add-on credit holders should have a corresponding subscription record.
--   - Credits linked to payment_orders must reference orders with status = 'paid'.
-- ------------------------------------------------------------------------------

-- [QUERY 2.1] Add-on credit balance sanity bounds (sets_remaining <= sets_total)
SELECT
  'addon_credits_balance_bounds' AS check_name,
  COUNT(*) FILTER (WHERE sets_remaining > sets_total) AS overdrawn_credits_count,
  COUNT(*) FILTER (WHERE sets_remaining < 0) AS negative_credits_count,
  COUNT(*) AS total_credits_records,
  CASE
    WHEN COUNT(*) FILTER (WHERE sets_remaining > sets_total OR sets_remaining < 0) = 0 THEN 'PASS'
    ELSE 'FAIL'
  END AS status,
  'Add-on credits remaining must satisfy 0 <= sets_remaining <= sets_total' AS description
FROM public.user_addon_credits;

-- [QUERY 2.2] Active add-on credits held by users without subscriptions
-- Flags users with active credits who do not hold a subscription row
WITH credit_users AS (
  SELECT
    c.user_id,
    SUM(c.sets_remaining) AS total_remaining,
    MAX(c.expires_at) AS latest_expiry
  FROM public.user_addon_credits c
  WHERE c.sets_remaining > 0
    AND c.expires_at > NOW()
  GROUP BY c.user_id
)
SELECT
  'addon_credits_orphan_users' AS check_name,
  COUNT(cu.user_id) AS users_with_active_credits,
  COUNT(cu.user_id) FILTER (
    WHERE NOT EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.user_id = cu.user_id)
  ) AS unlinked_credit_users_count,
  CASE
    WHEN COUNT(cu.user_id) FILTER (
      WHERE NOT EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.user_id = cu.user_id)
    ) = 0 THEN 'PASS'
    ELSE 'FLAG' -- Informational / requires review for manual grants
  END AS status,
  'Active add-on credits should map to a user with a subscriptions entry' AS description
FROM credit_users cu;

-- [QUERY 2.3] Add-on credits linked to payment_orders status reconciliation
SELECT
  'addon_credits_order_status' AS check_name,
  COUNT(*) AS credits_with_order_id,
  COUNT(*) FILTER (
    WHERE po.id IS NULL OR po.status <> 'paid'
  ) AS unconfirmed_order_credits,
  COUNT(*) FILTER (
    WHERE po.user_id IS NOT NULL AND po.user_id <> c.user_id
  ) AS user_mismatch_credits,
  CASE
    WHEN COUNT(*) FILTER (
      WHERE po.id IS NULL OR po.status <> 'paid' OR (po.user_id IS NOT NULL AND po.user_id <> c.user_id)
    ) = 0 THEN 'PASS'
    ELSE 'FAIL'
  END AS status,
  'Add-on credits referencing an order must point to a paid order for the same user' AS description
FROM public.user_addon_credits c
LEFT JOIN public.payment_orders po ON po.id = c.order_id
WHERE c.order_id IS NOT NULL;


-- ------------------------------------------------------------------------------
-- 3. FUNNEL_EVENTS vs. PAGE_VIEWS SANITY BOUNDS
-- ------------------------------------------------------------------------------
-- Validates telemetry pipeline sanity:
--   - Overall volume sanity: Funnel conversion actions represent discreet
--     page interactions, so total funnel_events should be bounded by page_views.
--   - Funnel step progression bounds: Completed stages must never exceed started stages:
--       * signup_completed <= signup_started
--       * onboarding_completed <= onboarding_started
--       * apply_completed <= apply_started
--   - Retention boundary sanity: Both tables share a 90-day retention window
--     (per 20261106f_funnel_events_retention.sql).
-- ------------------------------------------------------------------------------

-- [QUERY 3.1] Overall volume ratio sanity bound (funnel_events vs. page_views)
WITH telemetry_totals AS (
  SELECT
    (SELECT COUNT(*) FROM public.page_views) AS total_page_views,
    (SELECT COUNT(*) FROM public.funnel_events) AS total_funnel_events
)
SELECT
  'telemetry_volume_ratio' AS check_name,
  tt.total_page_views,
  tt.total_funnel_events,
  ROUND(
    CASE
      WHEN tt.total_page_views = 0 THEN 0.00
      ELSE (tt.total_funnel_events::numeric / tt.total_page_views::numeric)
    END, 4
  ) AS funnel_to_pageview_ratio,
  CASE
    WHEN tt.total_page_views = 0 AND tt.total_funnel_events = 0 THEN 'PASS'
    WHEN tt.total_page_views = 0 AND tt.total_funnel_events > 0 THEN 'FAIL'
    WHEN (tt.total_funnel_events::numeric / tt.total_page_views::numeric) <= 1.0 THEN 'PASS'
    ELSE 'FLAG' -- Possible tracking spike or orphan event batch
  END AS status,
  'Total funnel events count should reasonably not exceed total page views' AS description
FROM telemetry_totals tt;

-- [QUERY 3.2] Funnel stage progression monotonicity bounds
WITH stage_counts AS (
  SELECT
    COUNT(*) FILTER (WHERE event = 'signup_started') AS signup_started,
    COUNT(*) FILTER (WHERE event = 'signup_completed') AS signup_completed,
    COUNT(*) FILTER (WHERE event = 'onboarding_started') AS onboarding_started,
    COUNT(*) FILTER (WHERE event = 'onboarding_completed') AS onboarding_completed,
    COUNT(*) FILTER (WHERE event = 'apply_started') AS apply_started,
    COUNT(*) FILTER (WHERE event = 'apply_completed') AS apply_completed
  FROM public.funnel_events
)
SELECT
  'funnel_stage_progression_bounds' AS check_name,
  sc.signup_started,
  sc.signup_completed,
  sc.onboarding_started,
  sc.onboarding_completed,
  sc.apply_started,
  sc.apply_completed,
  CASE
    WHEN sc.signup_completed > sc.signup_started
      OR sc.onboarding_completed > sc.onboarding_started
      OR sc.apply_completed > sc.apply_started THEN 'FAIL'
    ELSE 'PASS'
  END AS status,
  'Each completed funnel stage count must be <= its respective started count' AS description
FROM stage_counts sc;

-- [QUERY 3.3] 90-Day Data Retention Window Consistency
-- Asserts that retention purge job (20261106f) is maintaining the 90-day window
WITH retention_audit AS (
  SELECT
    'page_views' AS table_name,
    COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '91 days') AS expired_rows_unpurged
  FROM public.page_views
  UNION ALL
  SELECT
    'funnel_events' AS table_name,
    COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '91 days') AS expired_rows_unpurged
  FROM public.funnel_events
)
SELECT
  'retention_90d_purge_health' AS check_name,
  table_name,
  expired_rows_unpurged,
  CASE
    WHEN expired_rows_unpurged = 0 THEN 'PASS'
    ELSE 'FLAG' -- Purge cron may need execution
  END AS status,
  'No records older than 90 days (+1d grace) should persist after scheduled retention run' AS description
FROM retention_audit;


-- ------------------------------------------------------------------------------
-- 4. UNIFIED EXECUTIVE RECONCILIATION SUMMARY
-- ------------------------------------------------------------------------------
-- Aggregates all key indicators into a single executive dashboard rowset.
-- ------------------------------------------------------------------------------

WITH executive_checks AS (
  -- 1. Jobs parity
  SELECT
    '1. Jobs Parity' AS category,
    'Active jobs in jobs table vs jobs_public view' AS check_item,
    (SELECT COUNT(*) FROM public.jobs WHERE is_active = true OR status = 'active') AS expected_value,
    (SELECT COUNT(*) FROM public.jobs_public) AS observed_value,
    CASE
      WHEN (SELECT COUNT(*) FROM public.jobs WHERE is_active = true OR status = 'active') = (SELECT COUNT(*) FROM public.jobs_public)
      THEN 'PASS' ELSE 'FAIL'
    END AS status

  UNION ALL

  -- 2. Add-on Credit Bounds
  SELECT
    '2. Add-on Credits' AS category,
    'Invalid credit balances (remaining > total or remaining < 0)' AS check_item,
    0 AS expected_value,
    (SELECT COUNT(*) FROM public.user_addon_credits WHERE sets_remaining > sets_total OR sets_remaining < 0) AS observed_value,
    CASE
      WHEN (SELECT COUNT(*) FROM public.user_addon_credits WHERE sets_remaining > sets_total OR sets_remaining < 0) = 0
      THEN 'PASS' ELSE 'FAIL'
    END AS status

  UNION ALL

  -- 3. Telemetry Ratio Bounds
  SELECT
    '3. Telemetry Sanity' AS category,
    'Funnel events exceeding page views' AS check_item,
    0 AS expected_value,
    CASE
      WHEN (SELECT COUNT(*) FROM public.page_views) = 0 AND (SELECT COUNT(*) FROM public.funnel_events) > 0 THEN 1
      WHEN (SELECT COUNT(*) FROM public.funnel_events) > (SELECT COUNT(*) FROM public.page_views) THEN 1
      ELSE 0
    END AS observed_value,
    CASE
      WHEN (SELECT COUNT(*) FROM public.page_views) = 0 AND (SELECT COUNT(*) FROM public.funnel_events) = 0 THEN 'PASS'
      WHEN (SELECT COUNT(*) FROM public.funnel_events) <= (SELECT COUNT(*) FROM public.page_views) THEN 'PASS'
      ELSE 'FLAG'
    END AS status

  UNION ALL

  -- 4. Funnel Progression Bounds
  SELECT
    '4. Funnel Progression' AS category,
    'Inverted funnel stages (completed > started)' AS check_item,
    0 AS expected_value,
    (
      SELECT
        CASE WHEN (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'signup_completed') > (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'signup_started') THEN 1 ELSE 0 END +
        CASE WHEN (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'onboarding_completed') > (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'onboarding_started') THEN 1 ELSE 0 END +
        CASE WHEN (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'apply_completed') > (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'apply_started') THEN 1 ELSE 0 END
    ) AS observed_value,
    CASE
      WHEN (
        SELECT
          CASE WHEN (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'signup_completed') > (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'signup_started') THEN 1 ELSE 0 END +
          CASE WHEN (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'onboarding_completed') > (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'onboarding_started') THEN 1 ELSE 0 END +
          CASE WHEN (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'apply_completed') > (SELECT COUNT(*) FROM public.funnel_events WHERE event = 'apply_started') THEN 1 ELSE 0 END
      ) = 0 THEN 'PASS' ELSE 'FAIL'
    END AS status
)
SELECT
  category,
  check_item,
  expected_value,
  observed_value,
  status
FROM executive_checks
ORDER BY category;
