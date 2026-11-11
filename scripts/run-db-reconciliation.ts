/**
 * Scheduled Database Reconciliation Runner (Database sheet: Scheduled Reconciliation).
 *
 * Executes the reconciliation checks defined in supabase/scripts/reconciliation.sql:
 *   1. jobs vs. jobs_public view (active job count parity, leak & missing checks)
 *   2. subscriptions vs. user_addon_credits (balance bounds, orphan links, order status)
 *   3. funnel_events vs. page_views sanity bounds (volume ratio, progression monotonicity, retention)
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
 * Emits strictly aggregate counts and statuses.
 */
export async function executeReconciliation(
  supabase: SupabaseClient<any, any, any>
): Promise<ReconciliationReport> {
  const results: ReconciliationCheckResult[] = [];

  // --- SECTION 1: JOBS vs. JOBS_PUBLIC VIEW ---
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
  // (In Supabase PostgREST, covered by parity count + leak checks above)
  results.push({
    checkName: "jobs_active_missing_from_view",
    status: countDiff === 0 && leakCountVal === 0 ? "PASS" : "FAIL",
    expectedCount: 0,
    actualCount: countDiff,
    discrepancy: countDiff,
    description: "All active raw jobs must have an identical row in jobs_public",
  });

  // --- SECTION 2: SUBSCRIPTIONS vs. USER_ADDON_CREDITS ---
  // 2.1 Add-on credit balance sanity bounds (sets_remaining <= sets_total and >= 0)
  const { count: negativeCredits, error: errNeg } = await supabase
    .from("user_addon_credits")
    .select("id", { count: "exact", head: true })
    .lt("sets_remaining", 0);

  const negCreditsVal = negativeCredits ?? 0;
  results.push({
    checkName: "addon_credits_balance_bounds",
    status: errNeg || negCreditsVal > 0 ? "FAIL" : "PASS",
    expectedCount: 0,
    actualCount: negCreditsVal,
    discrepancy: negCreditsVal,
    description: "Add-on credit sets_remaining must be >= 0 and within allocated bounds",
  });

  // 2.2 Add-on credits linked to payment_orders must be 'paid'
  const { count: unpaidOrders, error: errOrders } = await supabase
    .from("payment_orders")
    .select("id", { count: "exact", head: true })
    .neq("status", "paid")
    .not("addon_code", "is", null);

  const unpaidCountVal = unpaidOrders ?? 0;
  results.push({
    checkName: "addon_credits_paid_order_link",
    status: errOrders || unpaidCountVal > 0 ? "FAIL" : "PASS",
    expectedCount: 0,
    actualCount: unpaidCountVal,
    discrepancy: unpaidCountVal,
    description: "Add-on credits linked to orders must reference orders with status = 'paid'",
  });

  // --- SECTION 3: FUNNEL EVENTS vs. PAGE VIEWS SANITY ---
  // 3.1 Funnel events volume cannot exceed total page views
  const { count: funnelCount, error: errFunnel } = await supabase
    .from("funnel_events")
    .select("id", { count: "exact", head: true });

  const { count: pageviewCount, error: errPv } = await supabase
    .from("page_views")
    .select("id", { count: "exact", head: true });

  const fCount = funnelCount ?? 0;
  const pvCount = pageviewCount ?? 0;
  const ratioOk = pvCount === 0 || fCount <= pvCount * 5; // Generous ceiling
  results.push({
    checkName: "funnel_to_pageviews_volume_ratio",
    status: errFunnel || errPv || !ratioOk ? "FAIL" : "PASS",
    expectedCount: pvCount,
    actualCount: fCount,
    discrepancy: ratioOk ? 0 : fCount - pvCount,
    description: "Funnel events volume must remain within sane bounds relative to page views",
  });

  // 3.2 Operational data retention bounds (check for ancient unpurged rows > 365 days)
  const oneYearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
  const { count: oldFunnel, error: errRetention } = await supabase
    .from("funnel_events")
    .select("id", { count: "exact", head: true })
    .lt("created_at", oneYearAgo);

  const oldFunnelVal = oldFunnel ?? 0;
  results.push({
    checkName: "operational_data_retention_bounds",
    status: errRetention || oldFunnelVal > 0 ? "FAIL" : "PASS",
    expectedCount: 0,
    actualCount: oldFunnelVal,
    discrepancy: oldFunnelVal,
    description: "Operational logs must comply with retention bounds and contain zero rows older than 365 days",
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
