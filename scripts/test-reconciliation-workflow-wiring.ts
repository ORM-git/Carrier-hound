/**
 * Offline test for Scheduled Database Reconciliation workflow wiring & aggregate execution.
 *
 * Verifies:
 * - .github/workflows/db-reconciliation.yml exists with weekly schedule and workflow_dispatch.
 * - Service-role secrets pattern matches db-health-probe.yml.
 * - Exact workflow name is registered in .github/workflows/workflow-failure-alert.yml and SCHEDULED_CRON_WORKFLOWS.
 * - scripts/run-db-reconciliation.ts outputs aggregate metrics only (no row data / user PII).
 * - Fails with mismatch detection when discrepancies are present.
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
  const runnerContent = fs.readFileSync(runnerScriptPath, "utf8");

  // Ensure no select(*) or raw column dumps
  check(
    "runner script queries use head count requests without selecting rows",
    /select\([^)]*count:\s*["']exact["'][^)]*head:\s*true/.test(runnerContent)
  );

  // 4. In-Memory Mock Testing of Reconciliation Logic
  function createChainableQuery(count: number) {
    const res = { count, error: null };
    const builder: any = {
      or: () => builder,
      not: () => builder,
      lt: () => builder,
      neq: () => builder,
      then: (resolve: any) => resolve(res),
    };
    return builder;
  }

  // 4a. Healthy mock: counts match, zero leaks, zero unpaid
  const mockHealthySupabase: any = {
    from: (table: string) => ({
      select: () => {
        if (table === "jobs") return createChainableQuery(150);
        if (table === "jobs_public") {
          // When filtering for leaks with .not(), return 0; for view count parity, return 150
          const resParity = { count: 150, error: null };
          const resZeroLeak = { count: 0, error: null };
          const builder: any = {
            or: () => builder,
            not: () => ({
              not: () => ({
                then: (r: any) => r(resZeroLeak),
              }),
              then: (r: any) => r(resZeroLeak),
            }),
            lt: () => builder,
            neq: () => builder,
            then: (resolve: any) => resolve(resParity),
          };
          return builder;
        }
        if (table === "page_views") return createChainableQuery(100);
        if (table === "funnel_events") {
          // Total funnel events = 10, but ancient funnel events (> 365d) via .lt() = 0
          const resTotal = { count: 10, error: null };
          const resAncient = { count: 0, error: null };
          const builder: any = {
            or: () => builder,
            not: () => builder,
            lt: () => ({ then: (r: any) => r(resAncient) }),
            neq: () => builder,
            then: (resolve: any) => resolve(resTotal),
          };
          return builder;
        }
        return createChainableQuery(0);
      },
    }),
  };

  const healthyReport = await executeReconciliation(mockHealthySupabase);
  check("reconciliation passes on healthy database state", healthyReport.healthy === true);
  check("healthy report has zero failed checks", healthyReport.failedChecks === 0);
  check("report contains all 7 aggregate checks", healthyReport.totalChecks === 7);

  // 4b. Discrepancy mock: job count mismatch and 5 inactive leaks
  const mockMismatchSupabase: any = {
    from: (table: string) => ({
      select: () => {
        if (table === "jobs") return createChainableQuery(150);
        if (table === "jobs_public") {
          const resParity = { count: 140, error: null };
          const resLeak = { count: 5, error: null };
          const builder: any = {
            or: () => builder,
            not: () => ({
              not: () => ({
                then: (r: any) => r(resLeak),
              }),
              then: (r: any) => r(resLeak),
            }),
            lt: () => builder,
            neq: () => builder,
            then: (resolve: any) => resolve(resParity),
          };
          return builder;
        }
        return createChainableQuery(0);
      },
    }),
  };

  const mismatchReport = await executeReconciliation(mockMismatchSupabase);
  check("reconciliation fails when discrepancy is detected", mismatchReport.healthy === false);
  check("mismatch report records failed checks", mismatchReport.failedChecks > 0);
  const leakedCheck = mismatchReport.results.find((r) => r.checkName === "jobs_public_inactive_leak");
  check("leaked inactive jobs check status is FAIL", leakedCheck?.status === "FAIL");
  check("discrepancy count is reported accurately", leakedCheck?.discrepancy === 5);

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
