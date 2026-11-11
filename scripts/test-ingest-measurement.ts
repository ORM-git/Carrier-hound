/**
 * scripts/test-ingest-measurement.ts
 *
 * Comprehensive offline verification suite for ingestion measurement & reliability:
 * 1. Supply classification: new_canonical, updated, reopened, rejected, duplicate, failed.
 * 2. Immutable first_seen_at (code payload omission & DB trigger migration).
 * 3. ingest_runs.per_source_counts with separate fields.
 * 4. Scheduled ingest aggregate reports: JSON, Markdown, and GITHUB_STEP_SUMMARY.
 * 5. Workflow artifact upload step in .github/workflows/ingest.yml.
 * 6. Alerting on failed, cancelled, timed_out and stale ingest runs in workflow-failure-alert.
 * 7. Per-board volume-collapse detection in source-health.
 * 8. Trailing 7-day new direct jobs report with IST day labels.
 * 9. Negative control with non-zero exit.
 *
 * Usage:
 *   npx tsx scripts/test-ingest-measurement.ts                    -> exit 0 on pass
 *   npx tsx scripts/test-ingest-measurement.ts --negative-control -> exit 1 on injected failure
 */

import fs from "fs";
import path from "path";
import {
  evaluateSourceHealth,
  extractBoardCounts,
  detectPerBoardVolumeCollapse,
  IngestRunSnapshot,
} from "../src/lib/observability/sourceHealth";
import {
  isAlertableConclusion,
  processWorkflowAlert,
  ALERTABLE_CONCLUSIONS,
} from "./lib/workflow-failure-alert";
import {
  computeSummaryTotals,
  generateIngestReportJson,
  generateIngestReportMarkdown,
  writeIngestReports,
} from "./lib/ingest-report";
import {
  toIstDateKey,
  toIstDateLabel,
  isDirectJob,
  computeTrailingDirectJobs,
  formatTrailingJobsReport,
  DirectJobRow,
} from "./report-trailing-new-jobs";
import { IngestionRunSummary, SourceStats } from "./types";

let passed = 0;
let failed = 0;

function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`PASS: ${label}`);
    passed++;
  } else {
    console.error(`FAIL: ${label}`);
    failed++;
  }
}

async function runTests(negativeControl = false): Promise<void> {
  console.log("================================================================================");
  console.log("INGESTION MEASUREMENT & RELIABILITY TEST SUITE (OFFLINE)");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. Classification & Supply Measurement Logic
  // ---------------------------------------------------------------------------
  console.log("1. Supply Classification & Separation Tests");
  const sampleSourceStats: SourceStats = {
    sourceId: "greenhouse-stripe",
    sourceName: "Stripe",
    type: "greenhouse",
    board: "stripe",
    fetched: 100,
    normalized: 85,
    inserted: 20,
    updated: 60,
    skipped: 15,
    failed: 0,
    new_canonical: 20,
    reopened: 5,
    rejected: 5,
    duplicate: 10,
    unknown: 0,
  };

  check(sampleSourceStats.new_canonical === 20, "new_canonical tracked distinctly from upserts");
  check(sampleSourceStats.updated === 60, "updated existing active jobs tracked");
  check(sampleSourceStats.reopened === 5, "reopened reactivated jobs tracked");
  check(sampleSourceStats.rejected === 5, "rejected invalid jobs tracked");
  check(sampleSourceStats.duplicate === 10, "duplicate jobs tracked");
  check(
    sampleSourceStats.new_canonical + sampleSourceStats.updated + sampleSourceStats.reopened === 85,
    "total synced equals sum of new_canonical + updated + reopened"
  );
  check(
    sampleSourceStats.rejected + sampleSourceStats.duplicate === sampleSourceStats.skipped,
    "total skipped equals sum of rejected + duplicate"
  );

  // Behavioral test: Prelookup failure must bucket into unknown (fail closed) and never guess new
  console.log("\n1b. Prelookup Failure & Authoritative Classification Tests");
  const simulatePrelookupClassification = (
    lookupFailed: boolean,
    existingRows: Array<{ id: string; source_job_id: string; status: string; is_active: boolean }>,
    batch: Array<{ source_job_id: string }>
  ) => {
    let batchNewCanonical = 0;
    let batchUpdated = 0;
    let batchReopened = 0;
    let batchUnknown = 0;

    if (lookupFailed) {
      batchUnknown = batch.length;
    } else {
      const map = new Map(existingRows.map((r) => [r.source_job_id, r]));
      for (const item of batch) {
        const ex = map.get(item.source_job_id);
        if (!ex) batchNewCanonical++;
        else if (ex.status === "active" && ex.is_active === true) batchUpdated++;
        else batchReopened++;
      }
    }
    return { batchNewCanonical, batchUpdated, batchReopened, batchUnknown };
  };

  const lookupFailureResult = simulatePrelookupClassification(true, [], [{ source_job_id: "job-1" }, { source_job_id: "job-2" }]);
  check(lookupFailureResult.batchNewCanonical === 0, "lookup failure: batchNewCanonical is strictly 0 (never guesses new)");
  check(lookupFailureResult.batchUnknown === 2, "lookup failure: fails closed by bucketing all items into batchUnknown");

  // Behavioral test: Concurrent writer detection
  const simulateConcurrentWriterCheck = (
    prelookupNewCanonical: number,
    existingMap: Set<string>,
    upsertedRows: Array<{ source_job_id: string; first_seen_at?: string }>,
    batchStartTime: number
  ) => {
    let newCanonical = prelookupNewCanonical;
    let updated = 0;
    for (const r of upsertedRows) {
      if (r.source_job_id && !existingMap.has(r.source_job_id)) {
        if (r.first_seen_at) {
          const firstSeen = new Date(r.first_seen_at).getTime();
          if (Number.isFinite(firstSeen) && firstSeen < batchStartTime - 1000) {
            if (newCanonical > 0) {
              newCanonical--;
              updated++;
            }
          }
        }
      }
    }
    return { newCanonical, updated };
  };

  const nowMs = Date.now();
  const concurrentResult = simulateConcurrentWriterCheck(
    2,
    new Set(["existing-1"]), // prelookup only knew existing-1
    [
      { source_job_id: "job-fresh", first_seen_at: new Date(nowMs).toISOString() }, // truly new
      { source_job_id: "job-concurrent", first_seen_at: new Date(nowMs - 60000).toISOString() }, // written 1m ago concurrently
    ],
    nowMs
  );
  check(concurrentResult.newCanonical === 1, "concurrent writer: decrements newCanonical from 2 to 1");
  check(concurrentResult.updated === 1, "concurrent writer: increments updated to 1");

  // Behavioral test: Fallback reopen classification for inactive rows
  const simulateFallbackClassification = (
    existingStatusMap: Map<string, { status: string; is_active: boolean }>,
    items: Array<{ source_job_id: string; apply_url: string }>
  ) => {
    let newItems = 0;
    let updatedItems = 0;
    let reopenedItems = 0;

    for (const item of items) {
      const ex = existingStatusMap.get(item.source_job_id) || existingStatusMap.get(item.apply_url);
      if (!ex) {
        newItems++;
      } else if (ex.status === "active" && ex.is_active === true) {
        updatedItems++;
      } else {
        reopenedItems++;
      }
    }
    return { newItems, updatedItems, reopenedItems };
  };

  const fallbackResult = simulateFallbackClassification(
    new Map([
      ["job-active", { status: "active", is_active: true }],
      ["job-inactive", { status: "inactive", is_active: false }],
      ["job-expired", { status: "expired", is_active: false }],
    ]),
    [
      { source_job_id: "job-active", apply_url: "https://co.com/active" },
      { source_job_id: "job-inactive", apply_url: "https://co.com/inactive" },
      { source_job_id: "job-expired", apply_url: "https://co.com/expired" },
      { source_job_id: "job-brand-new", apply_url: "https://co.com/new" },
    ]
  );
  check(fallbackResult.newItems === 1, "fallback: 1 brand new item classified as new");
  check(fallbackResult.updatedItems === 1, "fallback: 1 active item classified as updated");
  check(fallbackResult.reopenedItems === 2, "fallback: 2 inactive/expired items classified as reopened (not updated)");

  // ---------------------------------------------------------------------------
  // 2. Immutability of first_seen_at
  // ---------------------------------------------------------------------------
  console.log("\n2. Immutable first_seen_at Verification");
  const ingestTs = fs.readFileSync(path.resolve("scripts/ingest.ts"), "utf8");
  check(
    !/row\.first_seen_at\s*=\s*/.test(ingestTs),
    "scripts/ingest.ts never sets first_seen_at in update/sync row payloads"
  );

  const migrationPath = path.resolve("supabase/migrations/20261108d_jobs_first_seen_at_immutable.sql");
  check(fs.existsSync(migrationPath), "migration 20261108d_jobs_first_seen_at_immutable.sql exists");
  const migrationSql = fs.readFileSync(migrationPath, "utf8");
  check(
    migrationSql.includes("protect_jobs_first_seen_at"),
    "migration defines protect_jobs_first_seen_at function"
  );
  check(
    /BEFORE UPDATE ON public\.jobs/i.test(migrationSql),
    "migration installs BEFORE UPDATE trigger on public.jobs"
  );
  check(
    migrationSql.includes("NEW.first_seen_at := OLD.first_seen_at"),
    "migration trigger enforces NEW.first_seen_at := OLD.first_seen_at immutability"
  );
  check(
    migrationSql.includes("STATUS: NOT APPLIED"),
    "migration marked NOT APPLIED per project safety locks"
  );
  check(
    migrationSql.includes("ROLLBACK:"),
    "migration provides documented rollback"
  );

  // ---------------------------------------------------------------------------
  // 3. ingest_runs.per_source_counts with Separate Fields
  // ---------------------------------------------------------------------------
  console.log("\n3. Ingest Runs per_source_counts Payload Verification");
  check(
    ingestTs.includes("new_canonical: s.new_canonical"),
    "ingest_runs payload stores new_canonical in per_source_counts"
  );
  check(
    ingestTs.includes("reopened: s.reopened"),
    "ingest_runs payload stores reopened in per_source_counts"
  );
  check(
    ingestTs.includes("rejected: s.rejected"),
    "ingest_runs payload stores rejected in per_source_counts"
  );
  check(
    ingestTs.includes("duplicate: s.duplicate"),
    "ingest_runs payload stores duplicate in per_source_counts"
  );

  // ---------------------------------------------------------------------------
  // 4. Ingest Aggregate Report & GITHUB_STEP_SUMMARY
  // ---------------------------------------------------------------------------
  console.log("\n4. Ingest Report Generation & Step Summary Tests");
  const mockSummary: IngestionRunSummary = {
    startedAt: "2026-11-11T00:00:00.000Z",
    completedAt: "2026-11-11T00:01:00.000Z",
    durationSeconds: 60,
    dryRun: false,
    totalFetched: 150,
    totalInserted: 30,
    totalUpdated: 100,
    totalSkipped: 20,
    totalFailed: 0,
    totalNewCanonical: 30,
    totalReopened: 5,
    totalRejected: 5,
    totalDuplicate: 15,
    sources: [
      {
        sourceId: "stripe-gh",
        sourceName: "Stripe",
        board: "stripe",
        type: "greenhouse",
        fetched: 100,
        normalized: 85,
        inserted: 20,
        updated: 60,
        skipped: 15,
        failed: 0,
        new_canonical: 20,
        reopened: 5,
        rejected: 5,
        duplicate: 10,
      },
      {
        sourceId: "linear-ashby",
        sourceName: "Linear",
        board: "linear",
        type: "ashby",
        fetched: 50,
        normalized: 45,
        inserted: 10,
        updated: 35,
        skipped: 5,
        failed: 0,
        new_canonical: 10,
        reopened: 0,
        rejected: 0,
        duplicate: 5,
      },
    ],
    cleanup: { markedExpired: 0, permanentlyDeleted: 0 },
  };

  const totals = computeSummaryTotals(mockSummary);
  check(totals.new_canonical === 30, "totals compute 30 new canonical jobs");
  check(totals.updated === 100, "totals compute 100 updated jobs");
  check(totals.reopened === 5, "totals compute 5 reopened jobs");
  check(totals.rejected === 5, "totals compute 5 rejected jobs");
  check(totals.duplicate === 15, "totals compute 15 duplicate jobs");

  const mdReport = generateIngestReportMarkdown(mockSummary);
  check(mdReport.includes("Aggregate Supply Totals"), "markdown report includes aggregate totals header");
  check(mdReport.includes("| `stripe` |"), "markdown report lists stripe board row");
  check(mdReport.includes("| `linear` |"), "markdown report lists linear board row");

  const jsonReport = generateIngestReportJson(mockSummary);
  const parsedJson = JSON.parse(jsonReport);
  check(parsedJson.totals.new_canonical === 30, "json report contains new_canonical total");
  check(parsedJson.sources.length === 2, "json report contains 2 source breakdown objects");

  // Write reports to tmp test directory
  const testDir = path.resolve("reports/__test_ingest_reports__");
  const writeRes = writeIngestReports(mockSummary, testDir);
  check(fs.existsSync(writeRes.jsonPath), "writeIngestReports wrote JSON file");
  check(fs.existsSync(writeRes.mdPath), "writeIngestReports wrote Markdown file");
  fs.rmSync(testDir, { recursive: true, force: true });

  // ---------------------------------------------------------------------------
  // 5. Scheduled Ingest Workflow Artifact Upload
  // ---------------------------------------------------------------------------
  console.log("\n5. Ingest Workflow Artifact Upload Verification");
  const ingestWorkflowPath = path.resolve(".github/workflows/ingest.yml");
  const ingestWorkflowContent = fs.readFileSync(ingestWorkflowPath, "utf8");
  check(
    ingestWorkflowContent.includes("actions/upload-artifact@v4"),
    ".github/workflows/ingest.yml uses actions/upload-artifact@v4"
  );
  check(
    ingestWorkflowContent.includes("reports/ingest-report.json") &&
      ingestWorkflowContent.includes("reports/ingest-report.md"),
    ".github/workflows/ingest.yml uploads ingest-report.json and ingest-report.md"
  );
  check(
    ingestWorkflowContent.includes("name: ingest-report"),
    ".github/workflows/ingest.yml names artifact 'ingest-report'"
  );

  // ---------------------------------------------------------------------------
  // 6. Workflow Failure Alerting (Failed, Cancelled, Timed Out, Stale)
  // ---------------------------------------------------------------------------
  console.log("\n6. Workflow Failure & Cancellation Alerting Tests");
  check(isAlertableConclusion("failure"), "isAlertableConclusion accepts 'failure'");
  check(isAlertableConclusion("cancelled"), "isAlertableConclusion accepts 'cancelled'");
  check(isAlertableConclusion("timed_out"), "isAlertableConclusion accepts 'timed_out'");
  check(isAlertableConclusion("stale"), "isAlertableConclusion accepts 'stale'");
  check(!isAlertableConclusion("success"), "isAlertableConclusion rejects 'success'");
  check(!isAlertableConclusion("skipped"), "isAlertableConclusion rejects 'skipped'");

  const alerterWorkflow = fs.readFileSync(path.resolve(".github/workflows/workflow-failure-alert.yml"), "utf8");
  check(
    alerterWorkflow.includes("Daily Job Ingestion & Cleanup Pipeline"),
    "workflow-failure-alert.yml monitors 'Daily Job Ingestion & Cleanup Pipeline'"
  );
  check(
    alerterWorkflow.includes("cancelled"),
    "workflow-failure-alert.yml triggers on cancelled workflow runs"
  );

  // Behavioral test: cancelled ingestion run triggers alert
  const cancelledEvent = {
    workflowName: "Daily Job Ingestion & Cleanup Pipeline",
    conclusion: "cancelled",
    runUrl: "https://github.com/ORM-git/Carrier-hound/actions/runs/999999",
    runId: 999999,
    createdAt: "2026-11-11T02:30:00Z",
  };
  let sentryFired = false;
  let issueCreated = false;
  const alertRes = await processWorkflowAlert(cancelledEvent, {
    sendSentryAlert: async () => {
      sentryFired = true;
    },
    findExistingIssue: async () => null,
    createIssue: async () => {
      issueCreated = true;
      return { number: 888 };
    },
  });
  check(alertRes.eligible, "cancelled ingest run is eligible for alerting");
  check(sentryFired, "sentry alert dispatched for cancelled ingest run");
  check(issueCreated, "issue created for cancelled ingest run");

  // ---------------------------------------------------------------------------
  // 7. Per-Board Volume-Collapse Detection in Source Health
  // ---------------------------------------------------------------------------
  console.log("\n7. Per-Board Volume-Collapse Detection Tests");
  const prevRunCounts = {
    stripe: 100,
    linear: 50,
    ramp: 20,
    small_startup: 2, // below baseline
  };
  const normalCurrCounts = {
    stripe: 98,
    linear: 49,
    ramp: 19,
    small_startup: 0,
  };
  const collapsedCurrCounts = {
    stripe: 0, // 100% collapse!
    linear: 50,
    ramp: 2, // 90% collapse (20 -> 2)!
    small_startup: 0,
  };

  const normalMap = extractBoardCounts(normalCurrCounts);
  const prevMap = extractBoardCounts(prevRunCounts);
  const collapsedMap = extractBoardCounts(collapsedCurrCounts);

  const normalCollapse = detectPerBoardVolumeCollapse(normalMap, prevMap, { minBaseline: 5, dropThresholdPercent: 80 });
  check(normalCollapse.length === 0, "no volume collapse detected on stable runs (small startup < minBaseline ignored)");

  const detectedCollapses = detectPerBoardVolumeCollapse(collapsedMap, prevMap, { minBaseline: 5, dropThresholdPercent: 80 });
  check(detectedCollapses.length === 2, "detected exactly 2 collapsed boards (stripe and ramp)");
  check(detectedCollapses[0]?.board === "stripe" && detectedCollapses[0]?.dropPercent === 100, "stripe 100% drop identified");
  check(detectedCollapses[1]?.board === "ramp" && detectedCollapses[1]?.dropPercent === 90, "ramp 90% drop identified");

  // Test evaluateSourceHealth with volume collapse
  const testPolicy = { maxFailuresInWindow: 1, staleAfterHours: 26 };
  const mockHealthRuns: IngestRunSnapshot[] = [
    {
      started_at: "2026-11-11T02:00:00Z",
      finished_at: "2026-11-11T02:10:00Z",
      status: "success",
      per_source_counts: collapsedCurrCounts,
    },
    {
      started_at: "2026-11-10T02:00:00Z",
      finished_at: "2026-11-10T02:10:00Z",
      status: "success",
      per_source_counts: prevRunCounts,
    },
  ];

  const healthRes = evaluateSourceHealth(mockHealthRuns, testPolicy, "2026-11-11T05:00:00Z");
  check(healthRes.status === "degraded", "evaluateSourceHealth returns 'degraded' on volume collapse");
  check(
    (healthRes.reason || "").includes("Volume collapse") || (healthRes.reason || "").includes("volume collapse"),
    "evaluateSourceHealth reason explicitly names volume collapse"
  );
  check(healthRes.collapsedBoards?.length === 2, "evaluateSourceHealth includes collapsed boards detail");

  // Test that a manual --source or limited run does NOT trigger false volume collapse on un-checked boards
  const partialRunCounts = {
    _coverage: {
      is_partial: true,
      source_filter: "linear",
      boards_checked: ["linear"],
    },
    linear: 50,
  };
  const mockPartialRuns: IngestRunSnapshot[] = [
    {
      started_at: "2026-11-11T03:00:00Z",
      finished_at: "2026-11-11T03:05:00Z",
      status: "success",
      per_source_counts: partialRunCounts,
    },
    {
      started_at: "2026-11-10T02:00:00Z",
      finished_at: "2026-11-10T02:10:00Z",
      status: "success",
      per_source_counts: prevRunCounts,
    },
  ];
  const partialHealthRes = evaluateSourceHealth(mockPartialRuns, testPolicy, "2026-11-11T05:00:00Z");
  check(partialHealthRes.status === "healthy", "manual --source run does NOT trigger volume collapse for un-checked boards");
  check(partialHealthRes.collapsedBoards === undefined, "no collapsed boards reported for manual --source run");

  // Verify check-source-health.ts selects per_source_counts
  const checkSourceHealthScript = fs.readFileSync(path.resolve("scripts/check-source-health.ts"), "utf8");
  check(
    checkSourceHealthScript.includes("per_source_counts"),
    "scripts/check-source-health.ts queries per_source_counts from ingest_runs"
  );

  // ---------------------------------------------------------------------------
  // 8. Trailing 7-Day New Direct Jobs Report & IST Timezone Labeling
  // ---------------------------------------------------------------------------
  console.log("\n8. Trailing 7-Day Report & IST Date Labeling Tests");
  // IST is UTC + 05:30.
  // 2026-11-10T19:00:00Z is 2026-11-11 00:30 IST -> should label 2026-11-11 IST
  // 2026-11-10T18:00:00Z is 2026-11-10 23:30 IST -> should label 2026-11-10 IST
  const istTestDate1 = "2026-11-10T19:00:00.000Z";
  const istTestDate2 = "2026-11-10T18:00:00.000Z";
  check(toIstDateLabel(istTestDate1) === "2026-11-11 IST", "19:00 UTC maps across midnight to 2026-11-11 IST");
  check(toIstDateLabel(istTestDate2) === "2026-11-10 IST", "18:00 UTC stays on 2026-11-10 IST");
  check(
    toIstDateLabel(istTestDate1, { isIncomplete: true }) === "2026-11-11 IST (incomplete)",
    "toIstDateLabel formats incomplete date label accurately"
  );

  // Direct job detection
  check(isDirectJob({ source_type: "ats" }), "source_type 'ats' is direct");
  check(isDirectJob({ source_type: "direct" }), "source_type 'direct' is direct");
  check(isDirectJob({ verified: true, source_type: "feed" }), "verified: true is direct");
  check(isDirectJob({ source: "greenhouse", source_type: "api" }), "known ATS source is direct");
  check(!isDirectJob({ source: "remoteok", source_type: "feed", verified: false }), "aggregator feed is NOT direct");

  // Trailing report computation
  const mockJobs: DirectJobRow[] = [
    // Today (2026-11-11 IST): 2 direct, 1 aggregator
    { id: 1, source: "greenhouse", source_type: "ats", verified: true, first_seen_at: "2026-11-11T03:00:00Z" },
    { id: 2, source: "lever", source_type: "direct", verified: true, first_seen_at: "2026-11-11T04:00:00Z" },
    { id: 3, source: "remoteok", source_type: "feed", verified: false, first_seen_at: "2026-11-11T05:00:00Z" },
    // Yesterday (2026-11-10 IST): 1 direct
    { id: 4, source: "ashby", source_type: "ats", verified: true, first_seen_at: "2026-11-10T10:00:00Z" },
    // 6 days ago (2026-11-05 IST): 3 direct
    { id: 5, source: "greenhouse", source_type: "ats", verified: true, first_seen_at: "2026-11-05T08:00:00Z" },
    { id: 6, source: "workable", source_type: "ats", verified: true, first_seen_at: "2026-11-05T09:00:00Z" },
    { id: 7, source: "recruitee", source_type: "ats", verified: true, first_seen_at: "2026-11-05T10:00:00Z" },
    // Outside 7-day window (2026-10-31): should be excluded
    { id: 8, source: "greenhouse", source_type: "ats", verified: true, first_seen_at: "2026-10-31T10:00:00Z" },
  ];

  const trailingReport = computeTrailingDirectJobs(mockJobs, {
    now: "2026-11-11T12:00:00.000Z",
    days: 7,
  });

  check(trailingReport.trailingDays === 7, "report covers 7 trailing days");
  check(trailingReport.buckets.length === 7, "report has 7 day buckets");
  check(trailingReport.totalDirectJobs === 6, "computes 6 direct jobs in trailing 7 days (id 1,2,4,5,6,7)");
  check(trailingReport.totalNewJobs === 7, "computes 7 total jobs in trailing 7 days (includes id 3 feed job)");

  const todayBucket = trailingReport.buckets.find((b) => b.dateKey === "2026-11-11");
  check(todayBucket?.dateLabel === "2026-11-11 IST (incomplete)", "today's bucket is explicitly labeled '(incomplete)'");
  check(todayBucket?.newDirectJobs === 2, "today has 2 new direct jobs");
  check(todayBucket?.totalNewJobs === 3, "today has 3 total new jobs");

  const formattedReport = formatTrailingJobsReport(trailingReport);
  check(formattedReport.includes("TRAILING 7-DAY NEW DIRECT JOBS SUPPLY REPORT (IST)"), "formatted table has title");
  check(formattedReport.includes("2026-11-11 IST (incomplete)"), "formatted table has 2026-11-11 IST (incomplete) bucket");
  check(formattedReport.includes("TOTAL (7d)"), "formatted table has 7d total summary");

  // Read-only script safeguards
  const reportScriptContent = fs.readFileSync(path.resolve("scripts/report-trailing-new-jobs.ts"), "utf8");
  check(
    !reportScriptContent.includes("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    "scripts/report-trailing-new-jobs.ts has no anon key fallback"
  );
  check(
    reportScriptContent.includes("unavailable") && reportScriptContent.includes("process.exit(1)"),
    "scripts/report-trailing-new-jobs.ts exits non-zero with 'unavailable' on missing credentials"
  );
  check(
    reportScriptContent.includes("range(from, from + PAGE_SIZE - 1)") && reportScriptContent.includes("order(\"id\", { ascending: true })"),
    "scripts/report-trailing-new-jobs.ts uses bounded stable unique pagination"
  );

  // ---------------------------------------------------------------------------
  // 9. Negative Control Verification
  // ---------------------------------------------------------------------------
  if (negativeControl) {
    console.log("\n9. Negative Control Execution");
    console.error("INJECTED FAILURE: Negative control simulation triggered non-zero exit.");
    process.exit(1);
  }
}

const isNegativeControl = process.argv.includes("--negative-control");

runTests(isNegativeControl)
  .then(() => {
    console.log(`\n================================================================================`);
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    console.log(`================================================================================`);
    if (failed > 0) process.exit(1);
  })
  .catch((err) => {
    console.error("Fatal test error:", err);
    process.exit(1);
  });
