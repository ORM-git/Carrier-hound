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
 * - Uses bounded pagination (.range) on row queries so PostgREST result caps never truncate checks.
 * - Fails with exit code 1 if any discrepancy or query error is detected or if credentials are missing.
 *
 * Usage:
 *   npx tsx scripts/run-db-reconciliation.ts
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_PAGE_SIZE = 1000;

export interface ReconciliationOptions {
  pageSize?: number;
}

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
 * Reads all rows from a query by paginating with .range(from, to) until all pages are retrieved.
 */
async function fetchAllRows<T = any>(
  queryBuilderFactory: (from: number, to: number) => any,
  pageSize = DEFAULT_PAGE_SIZE
): Promise<{ data: T[]; error: any }> {
  const allRows: T[] = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await queryBuilderFactory(from, to);
    if (error) {
      return { data: allRows, error };
    }
    if (!data || !Array.isArray(data) || data.length === 0) {
      break;
    }
    allRows.push(...data);
    if (data.length < pageSize) {
      break; // Reached last page
    }
    from += pageSize;
  }

  return { data: allRows, error: null };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Executes reconciliation audit queries against a provided Supabase client.
 * Emits strictly aggregate counts and statuses matching supabase/scripts/reconciliation.sql.
 */
export async function executeReconciliation(
  supabase: SupabaseClient<any, any, any>,
  options: ReconciliationOptions = {}
): Promise<ReconciliationReport> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
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

  const hasParityError = Boolean(
    err1 || err2 || rawActiveCount === null || viewCount === null ||
    rawActiveCount === undefined || viewCount === undefined
  );
  const activeCountVal = rawActiveCount ?? 0;
  const viewCountVal = viewCount ?? 0;
  const countDiff = hasParityError ? 1 : Math.abs(activeCountVal - viewCountVal);
  results.push({
    checkName: "jobs_vs_jobs_public_count",
    status: !hasParityError && countDiff === 0 ? "PASS" : "FAIL",
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

  const hasLeakError = Boolean(errLeak || leakCount === null || leakCount === undefined);
  const leakCountVal = hasLeakError ? 1 : (leakCount ?? 0);
  results.push({
    checkName: "jobs_public_inactive_leak",
    status: !hasLeakError && leakCountVal === 0 ? "PASS" : "FAIL",
    expectedCount: 0,
    actualCount: leakCountVal,
    discrepancy: leakCountVal,
    description: "View must contain zero rows where is_active is false and status is not active",
  });

  // 1.3 Detect active raw jobs missing from jobs_public view
  results.push({
    checkName: "jobs_active_missing_from_view",
    status: !hasParityError && countDiff === 0 && leakCountVal === 0 ? "PASS" : "FAIL",
    expectedCount: 0,
    actualCount: countDiff,
    discrepancy: countDiff,
    description: "All active raw jobs must have an identical row in jobs_public",
  });

  // ============================================================================
  // 2. SUBSCRIPTIONS vs. USER_ADDON_CREDITS RECONCILIATION
  // ============================================================================
  // 2.1 Add-on credit balance sanity bounds (0 <= sets_remaining <= sets_total)
  const { data: creditsData, error: errCredits } = await fetchAllRows(
    (from, to) => supabase.from("user_addon_credits").select("id, sets_remaining, sets_total").range(from, to),
    pageSize
  );

  let invalidCreditsCount = 0;
  if (errCredits) {
    invalidCreditsCount = 1;
  } else {
    for (const row of creditsData) {
      const remaining = Number(row.sets_remaining);
      const total = Number(row.sets_total);
      if (isNaN(remaining) || isNaN(total) || remaining < 0 || remaining > total) {
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
  const { data: activeCreditsData, error: errActiveCredits } = await fetchAllRows(
    (from, to) =>
      supabase
        .from("user_addon_credits")
        .select("user_id, sets_remaining, expires_at")
        .gt("sets_remaining", 0)
        .gt("expires_at", nowIso)
        .range(from, to),
    pageSize
  );

  let orphanUsersCount = 0;
  let orphanHasError = Boolean(errActiveCredits);

  if (errActiveCredits) {
    orphanUsersCount = 1;
  } else if (activeCreditsData.length > 0) {
    const activeUserIds = Array.from(new Set(activeCreditsData.map((c: any) => c.user_id).filter(Boolean)));
    const userIdChunks = chunkArray(activeUserIds, 500);

    const subUserSet = new Set<string>();
    for (const chunk of userIdChunks) {
      const { data: subsData, error: errSubs } = await fetchAllRows(
        (from, to) => supabase.from("subscriptions").select("user_id").in("user_id", chunk).range(from, to),
        pageSize
      );
      if (errSubs) {
        orphanHasError = true;
        orphanUsersCount = activeUserIds.length;
        break;
      }
      for (const s of subsData) {
        if (s?.user_id) subUserSet.add(s.user_id);
      }
    }

    if (!orphanHasError) {
      for (const uid of activeUserIds) {
        if (!subUserSet.has(uid)) {
          orphanUsersCount++;
        }
      }
    }
  }

  results.push({
    checkName: "addon_credits_orphan_users",
    status: orphanHasError || orphanUsersCount > 0 ? "FAIL" : "PASS",
    expectedCount: 0,
    actualCount: orphanUsersCount,
    discrepancy: orphanUsersCount,
    description: "Active add-on credits should map to a user with a subscriptions entry",
  });

  // 2.3 Add-on credits linked to payment_orders status reconciliation
  // Joins credits to referenced orders; pending/abandoned orders without credits are NOT a failure.
  const { data: linkedCreditsData, error: errLinkedCredits } = await fetchAllRows(
    (from, to) =>
      supabase
        .from("user_addon_credits")
        .select("id, user_id, order_id")
        .not("order_id", "is", null)
        .range(from, to),
    pageSize
  );

  let unconfirmedOrderCredits = 0;
  let orderLinkHasError = Boolean(errLinkedCredits);

  if (errLinkedCredits) {
    unconfirmedOrderCredits = 1;
  } else if (linkedCreditsData.length > 0) {
    const orderIds = Array.from(new Set(linkedCreditsData.map((c: any) => c.order_id).filter(Boolean)));
    const orderIdChunks = chunkArray(orderIds, 500);
    const orderMap = new Map<string, any>();

    for (const chunk of orderIdChunks) {
      const { data: ordersData, error: errOrders } = await fetchAllRows(
        (from, to) => supabase.from("payment_orders").select("id, user_id, status").in("id", chunk).range(from, to),
        pageSize
      );
      if (errOrders) {
        orderLinkHasError = true;
        unconfirmedOrderCredits = linkedCreditsData.length;
        break;
      }
      for (const o of ordersData) {
        if (o?.id) orderMap.set(o.id, o);
      }
    }

    if (!orderLinkHasError) {
      for (const credit of linkedCreditsData) {
        const po = orderMap.get(credit.order_id);
        if (!po || po.status !== "paid" || (po.user_id && po.user_id !== credit.user_id)) {
          unconfirmedOrderCredits++;
        }
      }
    }
  }

  results.push({
    checkName: "addon_credits_order_status",
    status: orderLinkHasError || unconfirmedOrderCredits > 0 ? "FAIL" : "PASS",
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

  const hasTelemetryError = Boolean(
    errFunnel || errPv || funnelCount === null || pageviewCount === null ||
    funnelCount === undefined || pageviewCount === undefined
  );

  const fCount = funnelCount ?? 0;
  const pvCount = pageviewCount ?? 0;
  const ratioPass = !hasTelemetryError && ((pvCount === 0 && fCount === 0) || (pvCount > 0 && fCount <= pvCount));

  results.push({
    checkName: "telemetry_volume_ratio",
    status: ratioPass ? "PASS" : "FAIL",
    expectedCount: pvCount,
    actualCount: fCount,
    discrepancy: ratioPass ? 0 : Math.max(1, fCount - pvCount),
    description: "Total funnel events count should reasonably not exceed total page views",
  });

  // 3.2 Funnel stage progression monotonicity bounds
  // Every query error and null count must fail the run explicitly!
  const stages = [
    { start: "signup_started", end: "signup_completed" },
    { start: "onboarding_started", end: "onboarding_completed" },
    { start: "apply_started", end: "apply_completed" },
  ];

  let progressionDiscrepancies = 0;
  let progressionHasError = false;

  for (const { start, end } of stages) {
    const { count: startCount, error: errStart } = await supabase
      .from("funnel_events")
      .select("id", { count: "exact", head: true })
      .eq("event", start);

    const { count: endCount, error: errEnd } = await supabase
      .from("funnel_events")
      .select("id", { count: "exact", head: true })
      .eq("event", end);

    if (
      errStart ||
      errEnd ||
      startCount === null ||
      startCount === undefined ||
      endCount === null ||
      endCount === undefined
    ) {
      progressionHasError = true;
      progressionDiscrepancies++;
      continue;
    }

    if (endCount > startCount) {
      progressionDiscrepancies += endCount - startCount;
    }
  }

  results.push({
    checkName: "funnel_stage_progression_bounds",
    status: !progressionHasError && progressionDiscrepancies === 0 ? "PASS" : "FAIL",
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

  const hasRetentionError = Boolean(
    errOldPv || errOldFe || oldPv === null || oldFe === null ||
    oldPv === undefined || oldFe === undefined
  );

  const unpurgedPv = oldPv ?? 0;
  const unpurgedFe = oldFe ?? 0;
  const totalUnpurged = hasRetentionError ? 1 : unpurgedPv + unpurgedFe;

  results.push({
    checkName: "retention_90d_purge_health",
    status: !hasRetentionError && totalUnpurged === 0 ? "PASS" : "FAIL",
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
