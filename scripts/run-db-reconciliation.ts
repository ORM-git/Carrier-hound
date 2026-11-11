/**
 * Scheduled Database Reconciliation Runner (Database sheet: Scheduled Reconciliation).
 *
 * Executes the reconciliation checks defined in supabase/scripts/reconciliation.sql:
 *   1. jobs vs. jobs_public view (active job count parity, leak & missing checks)
 *   2. subscriptions vs. user_addon_credits (balance bounds, orphan links, order status)
 *   3. funnel_events vs. page_views sanity bounds (volume ratio, progression monotonicity, 90d retention)
 *
 * Safety & Privacy:
 * - Strictly READ-ONLY operations.
 * - Prints aggregate counts and status verdicts ONLY; NEVER prints row data or user PII.
 * - Fails with exit code 1 if any discrepancy is detected or if credentials are missing.
 *
 * Usage:
 *   npx tsx scripts/run-db-reconciliation.ts
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface ReconciliationCheckResult {
  checkName: string;
  status: "PASS" | "FAIL";
  expectedCount?: number;
  actualCount?: number;
  discrepancy: number;
  description: string;
}

export interface ReconciliationReport {
  timestamp: string;
  healthy: boolean;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  results: ReconciliationCheckResult[];
}

/**
 * Executes reconciliation audit queries against a provided Supabase client.
 * Emits strictly aggregate counts and statuses matching supabase/scripts/reconciliation.sql.
 */
export async function executeReconciliation(
  supabase: SupabaseClient<any, any, any>
): Promise<ReconciliationReport> {
  const results: ReconciliationCheckResult[] = [];

  // ============================================================================
  // 1. JOBS vs. JOBS_PUBLIC VIEW RECONCILIATION
  // ============================================================================
  // 1.1 Jobs vs jobs_public count parity
  const { count: rawActiveCount, error: err1 } = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .or("is_active.eq.true,status.eq.active");

  const { count: viewCount, error: err2 } = await supabase
    .from("jobs_public")
    .select("id", { count: "exact", head: true });

  const activeCountVal = rawActiveCount ?? 0;
  const viewCountVal = viewCount ?? 0;
  const countDiff = Math.abs(activeCountVal - viewCountVal);
  results.push({
    checkName: "jobs_vs_jobs_public_count",
    status: err1 || err2 || countDiff !== 0 ? "FAIL" : "PASS",
    expectedCount: activeCountVal,
    actualCount: viewCountVal,
    discrepancy: countDiff,
    description: "Public view must expose exactly all active jobs",
  });

  // 1.2 Detect inactive jobs leaking into jobs_public view
  const { count: leakCount, error: errLeak } = await supabase
    .from("jobs_public")
    .select("id", { count: "exact", head: true })
    .not("is_active", "eq", true)
    .not("status", "eq", "active");

  const leakCountVal = leakCount ?? 0;
  results.push({
    checkName: "jobs_public_inactive_leak",
    status: errLeak || leakCountVal > 0 ? "FAIL" : "PASS",
    expectedCount: 0,
    actualCount: leakCountVal,
    discrepancy: leakCountVal,
    description: "View must contain zero rows where is_active is false and status is not active",
  });

  // 1.3 Detect active raw jobs missing from jobs_public view
  results.push({
    checkName: "jobs_active_missing_from_view",
    status: countDiff === 0 && leakCountVal === 0 ? "PASS" : "FAIL",
    expectedCount: 0,
    actualCount: countDiff,
    discrepancy: countDiff,
    description: "All active raw jobs must have an identical row in jobs_public",
  });

  // ============================================================================
  // 2. SUBSCRIPTIONS vs. USER_ADDON_CREDITS RECONCILIATION
  // ============================================================================
  // 2.1 Add-on credit balance sanity bounds (0 <= sets_remaining <= sets_total)
  const { data: creditsData, error: errCredits } = await supabase
    .from("user_addon_credits")
    .select("id, sets_remaining, sets_total");

  let invalidCreditsCount = 0;
  if (creditsData && Array.isArray(creditsData)) {
    for (const row of creditsData) {
      const remaining = Number(row.sets_remaining);
      const total = Number(row.sets_total);
      if (remaining < 0 || remaining > total) {
        invalidCreditsCount++;
      }
    }
  }

  results.push({
    checkName: "addon_credits_balance_bounds",
    status: errCredits || invalidCreditsCount > 0 ? "FAIL" : "PASS",
    expectedCount: 0,
    actualCount: invalidCreditsCount,
    discrepancy: invalidCreditsCount,
    description: "Add-on credits remaining must satisfy 0 <= sets_remaining <= sets_total",
  });

  // 2.2 Active add-on credits held by users without subscriptions (orphan users check)
  const nowIso = new Date().toISOString();
  const { data: activeCreditsData, error: errActiveCredits } = await supabase
    .from("user_addon_credits")
    .select("user_id, sets_remaining, expires_at")
    .gt("sets_remaining", 0)
    .gt("expires_at", nowIso);

  let orphanUsersCount = 0;
  if (activeCreditsData && Array.isArray(activeCreditsData) && activeCreditsData.length > 0) {
    const activeUserIds = Array.from(new Set(activeCreditsData.map((c: any) => c.user_id).filter(Boolean)));
    if (activeUserIds.length > 0) {
      const { data: subsData, error: errSubs } = await supabase
        .from("subscriptions")
        .select("user_id")
        .in("user_id", activeUserIds);

      if (errSubs) {
        orphanUsersCount = activeUserIds.length;
      } else {
        const subUserSet = new Set((subsData || []).map((s: any) => s.user_id));
        for (const uid of activeUserIds) {
          if (!subUserSet.has(uid)) {
            orphanUsersCount++;
          }
        }
      }
    }
  }

  results.push({
    checkName: "addon_credits_orphan_users",
    status: errActiveCredits || orphanUsersCount > 0 ? "FAIL" : "PASS",
    expectedCount: 0,
    actualCount: orphanUsersCount,
    discrepancy: orphanUsersCount,
    description: "Active add-on credits should map to a user with a subscriptions entry",
  });

  // 2.3 Add-on credits linked to payment_orders status reconciliation
  // Joins credits to referenced orders; pending/abandoned orders without credits are NOT a failure.
  const { data: linkedCreditsData, error: errLinkedCredits } = await supabase
    .from("user_addon_credits")
    .select("id, user_id, order_id")
    .not("order_id", "is", null);

  let unconfirmedOrderCredits = 0;
  if (linkedCreditsData && Array.isArray(linkedCreditsData) && linkedCreditsData.length > 0) {
    const orderIds = Array.from(new Set(linkedCreditsData.map((c: any) => c.order_id).filter(Boolean)));
    if (orderIds.length > 0) {
      const { data: ordersData, error: errOrders } = await supabase
        .from("payment_orders")
        .select("id, user_id, status")
        .in("id", orderIds);

      if (errOrders) {
        unconfirmedOrderCredits = linkedCreditsData.length;
      } else {
        const orderMap = new Map((ordersData || []).map((o: any) => [o.id, o]));
        for (const credit of linkedCreditsData) {
          const po = orderMap.get(credit.order_id);
          if (!po || po.status !== "paid" || (po.user_id && po.user_id !== credit.user_id)) {
            unconfirmedOrderCredits++;
          }
        }
      }
    }
  }

  results.push({
    checkName: "addon_credits_order_status",
    status: errLinkedCredits || unconfirmedOrderCredits > 0 ? "FAIL" : "PASS",
    expectedCount: 0,
    actualCount: unconfirmedOrderCredits,
    discrepancy: unconfirmedOrderCredits,
    description: "Add-on credits referencing an order must point to a paid order for the same user",
  });

  // ============================================================================
  // 3. FUNNEL_EVENTS vs. PAGE_VIEWS SANITY BOUNDS
  // ============================================================================
  // 3.1 Overall volume ratio sanity bound (funnel_events vs. page_views)
  const { count: funnelCount, error: errFunnel } = await supabase
    .from("funnel_events")
    .select("id", { count: "exact", head: true });

  const { count: pageviewCount, error: errPv } = await supabase
    .from("page_views")
    .select("id", { count: "exact", head: true });

  const fCount = funnelCount ?? 0;
  const pvCount = pageviewCount ?? 0;
  const ratioPass = (pvCount === 0 && fCount === 0) || (pvCount > 0 && fCount <= pvCount);

  results.push({
    checkName: "telemetry_volume_ratio",
    status: errFunnel || errPv || !ratioPass ? "FAIL" : "PASS",
    expectedCount: pvCount,
    actualCount: fCount,
    discrepancy: ratioPass ? 0 : Math.max(0, fCount - pvCount),
    description: "Total funnel events count should reasonably not exceed total page views",
  });

  // 3.2 Funnel stage progression monotonicity bounds
  // signup_completed <= signup_started, onboarding_completed <= onboarding_started, apply_completed <= apply_started
  const stages = [
    { start: "signup_started", end: "signup_completed" },
    { start: "onboarding_started", end: "onboarding_completed" },
    { start: "apply_started", end: "apply_completed" },
  ];

  let progressionDiscrepancies = 0;
  for (const { start, end } of stages) {
    const { count: startCount } = await supabase
      .from("funnel_events")
      .select("id", { count: "exact", head: true })
      .eq("event", start);

    const { count: endCount } = await supabase
      .from("funnel_events")
      .select("id", { count: "exact", head: true })
      .eq("event", end);

    const s = startCount ?? 0;
    const e = endCount ?? 0;
    if (e > s) {
      progressionDiscrepancies += e - s;
    }
  }

  results.push({
    checkName: "funnel_stage_progression_bounds",
    status: progressionDiscrepancies === 0 ? "PASS" : "FAIL",
    expectedCount: 0,
    actualCount: progressionDiscrepancies,
    discrepancy: progressionDiscrepancies,
    description: "Each completed funnel stage count must be <= its respective started count",
  });

  // 3.3 90-Day Data Retention Window Consistency (+1-day grace = 91 days)
  const grace91DaysAgo = new Date(Date.now() - 91 * 86400000).toISOString();

  const { count: oldPv, error: errOldPv } = await supabase
    .from("page_views")
    .select("id", { count: "exact", head: true })
    .lt("created_at", grace91DaysAgo);

  const { count: oldFe, error: errOldFe } = await supabase
    .from("funnel_events")
    .select("id", { count: "exact", head: true })
    .lt("created_at", grace91DaysAgo);

  const unpurgedPv = oldPv ?? 0;
  const unpurgedFe = oldFe ?? 0;
  const totalUnpurged = unpurgedPv + unpurgedFe;

  results.push({
    checkName: "retention_90d_purge_health",
    status: errOldPv || errOldFe || totalUnpurged > 0 ? "FAIL" : "PASS",
    expectedCount: 0,
    actualCount: totalUnpurged,
    discrepancy: totalUnpurged,
    description: "No records older than 90 days (+1d grace) should persist in page_views or funnel_events",
  });

  const passedChecks = results.filter((r) => r.status === "PASS").length;
  const failedChecks = results.filter((r) => r.status === "FAIL").length;

  return {
    timestamp: new Date().toISOString(),
    healthy: failedChecks === 0,
    totalChecks: results.length,
    passedChecks,
    failedChecks,
    results,
  };
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    console.error("DB reconciliation configuration missing (values redacted).");
    process.exitCode = 1;
    return;
  }

  try {
    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });

    const report = await executeReconciliation(supabase);

    // Output aggregate metrics ONLY: no rows, no candidate records, no PII
    console.log(
      JSON.stringify(
        {
          timestamp: report.timestamp,
          healthy: report.healthy,
          totalChecks: report.totalChecks,
          passedChecks: report.passedChecks,
          failedChecks: report.failedChecks,
          results: report.results.map((r) => ({
            checkName: r.checkName,
            status: r.status,
            discrepancy: r.discrepancy,
          })),
        },
        null,
        2
      )
    );

    if (!report.healthy) {
      console.error(`Reconciliation audit failed: ${report.failedChecks} check(s) mismatched.`);
      process.exitCode = 1;
    } else {
      console.log("Reconciliation audit PASSED: all cross-table checks in parity.");
    }
  } catch {
    console.error("DB reconciliation probe unavailable. Check migration/configuration privately.");
    process.exitCode = 1;
  }
}

// Only execute when invoked directly as a CLI script, not when imported
const isDirectCli = typeof process !== "undefined" && process.argv[1] && (
  process.argv[1].endsWith("run-db-reconciliation.ts") ||
  process.argv[1].endsWith("run-db-reconciliation")
);

if (isDirectCli) {
  void main();
}
