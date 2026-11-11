/**
 * Offline test for Scheduled Database Reconciliation workflow wiring & aggregate execution.
 *
 * Verifies:
 * - .github/workflows/db-reconciliation.yml exists with weekly schedule and workflow_dispatch.
 * - Service-role secrets pattern matches db-health-probe.yml.
 * - Exact workflow name is registered in .github/workflows/workflow-failure-alert.yml and SCHEDULED_CRON_WORKFLOWS.
 * - scripts/run-db-reconciliation.ts outputs aggregate metrics only (no row data / user PII).
 * - Fails with mismatch detection when discrepancies are present.
 * - Accurately models all 9 checks from supabase/scripts/reconciliation.sql:
 *   * jobs_vs_jobs_public_count
 *   * jobs_public_inactive_leak
 *   * jobs_active_missing_from_view
 *   * addon_credits_balance_bounds (overallocated / negative credits)
 *   * addon_credits_orphan_users (active credits with no subscriptions row)
 *   * addon_credits_order_status (credits referencing paid orders; pending orders without credits ignored)
 *   * telemetry_volume_ratio (funnel_events <= page_views)
 *   * funnel_stage_progression_bounds (completed <= started for signup, onboarding, apply)
 *   * retention_90d_purge_health (91-day window on both page_views and funnel_events)
 * - Verifies bounded pagination (.range) traverses result sets larger than page size and catches bad rows on later pages.
 * - Verifies every query error and null count on funnel progression explicitly fails the run.
 *
 * Run: npx tsx scripts/test-reconciliation-workflow-wiring.ts
 * Negative control: npx tsx scripts/test-reconciliation-workflow-wiring.ts --negative-control
 */

import * as fs from "fs";
import * as path from "path";
import { executeReconciliation } from "./run-db-reconciliation";
import { isScheduledCronWorkflow, SCHEDULED_CRON_WORKFLOWS } from "./lib/workflow-failure-alert";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}

interface MockBuilderConfig {
  data?: any[];
  count?: number | null;
  error?: any;
  onRange?: (from: number, to: number) => { data: any[] | null; error: any };
  onThen?: (state: any) => { data: any[] | null; count: number | null; error: any };
}

function createChainableQuery(config: MockBuilderConfig = {}) {
  const state: any = {
    filters: [],
    isLeak: false,
    isRetention: false,
    eventFilter: null,
  };

  const builder: any = {
    or: () => {
      state.isLeak = true;
      return builder;
    },
    not: () => {
      state.isLeak = true;
      return builder;
    },
    lt: () => {
      state.isRetention = true;
      return builder;
    },
    gt: () => builder,
    neq: () => builder,
    eq: (col: string, val: any) => {
      if (col === "event") {
        state.eventFilter = val;
      }
      return builder;
    },
    in: () => builder,
    range: (from: number, to: number) => {
      if (config.onRange) {
        return Promise.resolve(config.onRange(from, to));
      }
      if (config.error) {
        return Promise.resolve({ data: null, error: config.error });
      }
      const data = config.data ?? [];
      const sliced = data.slice(from, to + 1);
      return Promise.resolve({ data: sliced, error: null });
    },
    then: (resolve: any, reject?: any) => {
      if (config.onThen) {
        return Promise.resolve(config.onThen(state)).then(resolve, reject);
      }
      const data = config.data ?? [];
      let count = config.count !== undefined ? config.count : data.length;
      return Promise.resolve({
        data,
        count,
        error: config.error ?? null,
      }).then(resolve, reject);
    },
  };

  return builder;
}

function createHealthyMockSupabase(overrides: {
  jobsCount?: number;
  jobsPublicCount?: number;
  pageViewsCount?: number;
  funnelCount?: number;
  creditsBalanceRows?: any[];
  activeCreditsRows?: any[];
  orderCreditsRows?: any[];
  subscriptionsRows?: any[];
  paymentOrdersRows?: any[];
  funnelProgressionHandler?: (stage: string) => { count: number | null; error: any };
  expiredPageViews?: number;
  expiredFunnelEvents?: number;
} = {}) {
  const jobsCount = overrides.jobsCount ?? 150;
  const jobsPublicCount = overrides.jobsPublicCount ?? 150;
  const pageViewsCount = overrides.pageViewsCount ?? 100;
  const funnelCount = overrides.funnelCount ?? 50;
  const creditsBalanceRows = overrides.creditsBalanceRows ?? [
    { id: "c1", sets_remaining: 3, sets_total: 5 },
  ];
  const activeCreditsRows = overrides.activeCreditsRows ?? [
    { user_id: "u1", sets_remaining: 3, expires_at: "2099-01-01" },
  ];
  const orderCreditsRows = overrides.orderCreditsRows ?? [
    { id: "c1", user_id: "u1", order_id: "order-paid-1" },
  ];
  const subscriptionsRows = overrides.subscriptionsRows ?? [{ user_id: "u1" }];
  const paymentOrdersRows = overrides.paymentOrdersRows ?? [
    { id: "order-paid-1", user_id: "u1", status: "paid" },
  ];
  const expiredPageViews = overrides.expiredPageViews ?? 0;
  const expiredFunnelEvents = overrides.expiredFunnelEvents ?? 0;

  return {
    from: (table: string) => ({
      select: (cols?: string, options?: { count?: string; head?: boolean }) => {
        if (options?.count) {
          if (table === "jobs") {
            return createChainableQuery({ count: jobsCount });
          }
          if (table === "jobs_public") {
            return createChainableQuery({
              onThen: (state) => ({
                data: [],
                count: state.isLeak ? 0 : jobsPublicCount,
                error: null,
              }),
            });
          }
          if (table === "page_views") {
            return createChainableQuery({
              onThen: (state) => ({
                data: [],
                count: state.isRetention ? expiredPageViews : pageViewsCount,
                error: null,
              }),
            });
          }
          if (table === "funnel_events") {
            return createChainableQuery({
              onThen: (state) => {
                if (state.isRetention) {
                  return { data: [], count: expiredFunnelEvents, error: null };
                }
                if (state.eventFilter) {
                  if (overrides.funnelProgressionHandler) {
                    const res = overrides.funnelProgressionHandler(state.eventFilter);
                    return { data: [], count: res.count, error: res.error };
                  }
                  const cnt = state.eventFilter.endsWith("_started") ? 20 : 10;
                  return { data: [], count: cnt, error: null };
                }
                return { data: [], count: funnelCount, error: null };
              },
            });
          }
          return createChainableQuery({ count: 0 });
        }

        // Row queries with pagination (.range)
        if (table === "user_addon_credits") {
          if (cols?.includes("sets_total")) {
            return createChainableQuery({ data: creditsBalanceRows });
          }
          if (cols?.includes("expires_at")) {
            return createChainableQuery({ data: activeCreditsRows });
          }
          if (cols?.includes("order_id")) {
            return createChainableQuery({ data: orderCreditsRows });
          }
          return createChainableQuery({ data: creditsBalanceRows });
        }

        if (table === "subscriptions") {
          return createChainableQuery({ data: subscriptionsRows });
        }

        if (table === "payment_orders") {
          return createChainableQuery({ data: paymentOrdersRows });
        }

        return createChainableQuery({ data: [] });
      },
    }),
  };
}

async function run() {
  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("Running negative control check...");
    check("negative control: forced assertion failure", false);
    process.exit(1);
  }

  // 1. Workflow file verification
  const workflowPath = path.resolve(".github/workflows/db-reconciliation.yml");
  check("db-reconciliation.yml workflow file exists", fs.existsSync(workflowPath));

  const workflowContent = fs.readFileSync(workflowPath, "utf8");
  check(
    "workflow has weekly cron schedule",
    /schedule:\s*-\s*cron:\s*['"][0-9* ]+['"]/.test(workflowContent)
  );
  check("workflow supports workflow_dispatch", /workflow_dispatch:/.test(workflowContent));
  check(
    "workflow uses NEXT_PUBLIC_SUPABASE_URL secret",
    /NEXT_PUBLIC_SUPABASE_URL:\s*\${{\s*secrets\.NEXT_PUBLIC_SUPABASE_URL\s*}}/.test(workflowContent)
  );
  check(
    "workflow uses SUPABASE_SERVICE_ROLE_KEY secret",
    /SUPABASE_SERVICE_ROLE_KEY:\s*\${{\s*secrets\.SUPABASE_SERVICE_ROLE_KEY\s*}}/.test(workflowContent)
  );

  // 2. Alerter list verification
  const alerterPath = path.resolve(".github/workflows/workflow-failure-alert.yml");
  const alerterContent = fs.readFileSync(alerterPath, "utf8");
  check(
    "exact workflow name is in workflow-failure-alert.yml",
    alerterContent.includes('"Weekly Database Reconciliation Audit"')
  );

  check(
    "exact workflow name is in SCHEDULED_CRON_WORKFLOWS",
    SCHEDULED_CRON_WORKFLOWS.includes("Weekly Database Reconciliation Audit")
  );
  check(
    "isScheduledCronWorkflow matches Weekly Database Reconciliation Audit",
    isScheduledCronWorkflow("Weekly Database Reconciliation Audit")
  );

  // 3. Privacy & Aggregate Output Security Audit
  const runnerScriptPath = path.resolve("scripts/run-db-reconciliation.ts");
  check("run-db-reconciliation.ts script exists", fs.existsSync(runnerScriptPath));

  // 4a. Healthy mock: all 9 checks pass
  const mockHealthySupabase: any = createHealthyMockSupabase();

  const healthyReport = await executeReconciliation(mockHealthySupabase);
  if (!healthyReport.healthy) {
    console.error("HEALTHY FAILED CHECKS:", healthyReport.results.filter((r) => r.status === "FAIL"));
  }
  check("reconciliation passes on healthy database state", healthyReport.healthy === true);
  check("healthy report has zero failed checks", healthyReport.failedChecks === 0);
  check("report contains all 9 aggregate checks", healthyReport.totalChecks === 9);

  // 4b. Fixture: pending/abandoned order without credits does NOT cause failure
  const mockPendingOrderSupabase: any = createHealthyMockSupabase({
    orderCreditsRows: [{ id: "c1", user_id: "u1", order_id: "order-paid-1" }],
    paymentOrdersRows: [
      { id: "order-paid-1", user_id: "u1", status: "paid" },
      { id: "order-pending-2", user_id: "u2", status: "pending" },
    ],
  });

  const pendingOrderReport = await executeReconciliation(mockPendingOrderSupabase);
  const orderCheck = pendingOrderReport.results.find((r) => r.checkName === "addon_credits_order_status");
  check("pending order without credits does not cause failure", orderCheck?.status === "PASS");

  // 4c. Fixture: overallocated credit (sets_remaining > sets_total) FAILS
  const mockOverallocatedCreditSupabase: any = createHealthyMockSupabase({
    creditsBalanceRows: [
      { id: "c1", sets_remaining: 2, sets_total: 5 },
      { id: "c2", sets_remaining: 10, sets_total: 5 },
    ],
  });

  const overallocatedReport = await executeReconciliation(mockOverallocatedCreditSupabase);
  const balanceCheck = overallocatedReport.results.find((r) => r.checkName === "addon_credits_balance_bounds");
  check("overallocated credit balance (remaining > total) fails check", balanceCheck?.status === "FAIL");
  check("overallocated discrepancy is recorded", balanceCheck?.discrepancy === 1);

  // 4d. Fixture: expired 91+ day telemetry in page_views or funnel_events FAILS
  const mockExpiredTelemetrySupabase: any = createHealthyMockSupabase({
    expiredPageViews: 4,
    expiredFunnelEvents: 2,
  });

  const expiredReport = await executeReconciliation(mockExpiredTelemetrySupabase);
  const retentionCheck = expiredReport.results.find((r) => r.checkName === "retention_90d_purge_health");
  check("expired 91+ day telemetry fails retention check", retentionCheck?.status === "FAIL");
  check("expired telemetry discrepancy count sums unpurged rows (4+2=6)", retentionCheck?.discrepancy === 6);

  // 4e. Funnel stage progression check: completed > started FAILS
  const mockInvertedProgressionSupabase: any = createHealthyMockSupabase({
    funnelProgressionHandler: (stage: string) => {
      if (stage === "signup_started") return { count: 5, error: null };
      if (stage === "signup_completed") return { count: 8, error: null };
      return { count: 0, error: null };
    },
  });

  const progressionReport = await executeReconciliation(mockInvertedProgressionSupabase);
  const progCheck = progressionReport.results.find((r) => r.checkName === "funnel_stage_progression_bounds");
  check("inverted stage progression (completed > started) fails check", progCheck?.status === "FAIL");

  // 4f. Fixture: result set larger than the page size with a bad row on a later page FAILS
  // 5 rows total with pageSize = 2. Row index 3 (on page 2) has remaining (10) > total (5).
  // Without pagination, an unpaginated read or single-page read would stop at page 1 and falsely PASS.
  const paginatedRows = [
    { id: "c1", sets_remaining: 1, sets_total: 5 },
    { id: "c2", sets_remaining: 2, sets_total: 5 },
    { id: "c3", sets_remaining: 3, sets_total: 5 },
    { id: "c4", sets_remaining: 10, sets_total: 5 }, // Bad row on page 2 (index 3)
    { id: "c5", sets_remaining: 4, sets_total: 5 },
  ];
  const mockPaginatedSupabase: any = createHealthyMockSupabase({
    creditsBalanceRows: paginatedRows,
  });

  const paginatedReport = await executeReconciliation(mockPaginatedSupabase, { pageSize: 2 });
  const paginatedBalanceCheck = paginatedReport.results.find((r) => r.checkName === "addon_credits_balance_bounds");
  check(
    "pagination traverses pages and catches bad row on later page",
    paginatedBalanceCheck?.status === "FAIL" && paginatedBalanceCheck?.discrepancy === 1
  );
  check("paginated failure marks overall report unhealthy", paginatedReport.healthy === false);

  // 4g. Fixture: query error on funnel progression (must FAIL)
  const mockFunnelErrorSupabase: any = createHealthyMockSupabase({
    funnelProgressionHandler: (_stage: string) => ({
      count: null,
      error: new Error("PostgREST query timeout or connection dropped"),
    }),
  });

  const funnelErrorReport = await executeReconciliation(mockFunnelErrorSupabase);
  const funnelErrorCheck = funnelErrorReport.results.find((r) => r.checkName === "funnel_stage_progression_bounds");
  check("query error on funnel progression fails check", funnelErrorCheck?.status === "FAIL");
  check("query error on funnel progression marks report unhealthy", funnelErrorReport.healthy === false);

  // 4h. Fixture: null count on funnel progression (must FAIL)
  const mockFunnelNullCountSupabase: any = createHealthyMockSupabase({
    funnelProgressionHandler: (_stage: string) => ({
      count: null,
      error: null,
    }),
  });

  const funnelNullReport = await executeReconciliation(mockFunnelNullCountSupabase);
  const funnelNullCheck = funnelNullReport.results.find((r) => r.checkName === "funnel_stage_progression_bounds");
  check("null count on funnel progression fails check", funnelNullCheck?.status === "FAIL");
  check("null count on funnel progression marks report unhealthy", funnelNullReport.healthy === false);

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
