/**
 * Offline unit & behavioral test suite for cron failure visibility alert logic.
 *
 * Requirements (Sheet row "Alerts"):
 * - Decision logic: workflow allowlist, dedupe key format, message shape.
 * - Sentry captureMessage path (DSN-gated, fail-open).
 * - GitHub issue creation & daily deduplication.
 * - Fully offline: fixtures and mocked dependencies, zero live network calls.
 *
 * Run: npx tsx scripts/test-workflow-failure-alert.ts
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  isScheduledCronWorkflow,
  SCHEDULED_CRON_WORKFLOWS,
  formatCronAlertDate,
  buildCronFailureDedupeKey,
  buildSentryAlertMessage,
  buildIssuePayload,
  processWorkflowAlert,
  WorkflowRunEvent,
  ExistingIssueSummary,
} from "./lib/workflow-failure-alert";

let passed = 0;
let failed = 0;

function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`PASS: ${label}`);
    passed += 1;
  } else {
    console.error(`FAIL: ${label}`);
    failed += 1;
  }
}

console.log("================================================================================");
console.log("CRON WORKFLOW FAILURE VISIBILITY & ALERT TEST SUITE (OFFLINE)");
console.log("================================================================================\n");

// --- 1. Allowlist Tests ---
console.log("1. Scheduled Cron Allowlist Tests");
check(isScheduledCronWorkflow("Weekly Retention Purge Cron"), "retention purge cron is allowlisted");
check(isScheduledCronWorkflow("Daily Early-Access Signup Digest Cron"), "early-access digest cron is allowlisted");
check(isScheduledCronWorkflow("Source Health Monitoring"), "source health monitoring is allowlisted");
check(isScheduledCronWorkflow("daily candidate matching & digest cron"), "case-insensitive allowlist matching works");
check(SCHEDULED_CRON_WORKFLOWS.length === 11, `all 11 scheduled cron workflows are cataloged (found ${SCHEDULED_CRON_WORKFLOWS.length})`);

// Non-cron workflows must be excluded
check(!isScheduledCronWorkflow("Continuous Integration (Build, Lint & Test)"), "CI workflow is excluded");
check(!isScheduledCronWorkflow("ATS Board Ingestion (Dry-Run / Manual Dispatch)"), "manual dispatch workflow is excluded");
check(!isScheduledCronWorkflow(""), "empty workflow name is rejected");
check(!isScheduledCronWorkflow(null as unknown as string), "null workflow name is rejected");

// --- 2. Dedupe Key Formatting Tests ---
console.log("\n2. Dedupe Key & Title Format Tests");
const key1 = buildCronFailureDedupeKey("Weekly Retention Purge Cron", "2026-11-08T19:30:00Z");
check(key1 === "Cron failure: Weekly Retention Purge Cron 2026-11-08", `retention dedupe key exact match: "${key1}"`);

const key2 = buildCronFailureDedupeKey("Daily Early-Access Signup Digest Cron", "2026-11-09T18:00:00.000Z");
check(key2 === "Cron failure: Daily Early-Access Signup Digest Cron 2026-11-09", `early access dedupe key exact match: "${key2}"`);

check(formatCronAlertDate("2026-11-08T23:59:59Z") === "2026-11-08", "formatCronAlertDate extracts YYYY-MM-DD from ISO string");
check(formatCronAlertDate("invalid-date").length === 10, "formatCronAlertDate falls back to today on invalid date");

// --- 3. Message Shape Tests ---
console.log("\n3. Sentry Alert Message Shape Tests");
const sampleEvent: WorkflowRunEvent = {
  workflowName: "Weekly Retention Purge Cron",
  conclusion: "failure",
  runUrl: "https://github.com/ORM-git/Carrier-hound/actions/runs/12345678",
  runId: 12345678,
  createdAt: "2026-11-08T19:30:00Z",
  repository: "ORM-git/Carrier-hound",
};

const sentryShape = buildSentryAlertMessage(sampleEvent);
check(sentryShape.cronTag === "weekly-retention-purge-cron", `cron tag slugified: "${sentryShape.cronTag}"`);
check(sentryShape.message.includes("Weekly Retention Purge Cron"), "sentry message names the failed workflow");
check(sentryShape.message.includes("12345678"), "sentry message includes the run ID");
check(sentryShape.extra.runUrl === sampleEvent.runUrl, "sentry extra includes exact runUrl");
check(sentryShape.extra.runConclusion === "failure", "sentry extra includes conclusion");
check(sentryShape.extra.createdAt === "2026-11-08T19:30:00Z", "sentry extra includes timestamp");

// --- 4. Issue Payload & Deduplication Tests ---
console.log("\n4. GitHub Issue Payload & Daily Dedupe Tests");
const createPayload = buildIssuePayload(sampleEvent, null);
check(createPayload.action === "create", "initial failure generates 'create' action");
check(createPayload.title === "Cron failure: Weekly Retention Purge Cron 2026-11-08", "issue title matches daily dedupe key");
check(createPayload.body.includes(sampleEvent.runUrl), "issue body includes the run URL");
check(createPayload.body.includes("Weekly Retention Purge Cron"), "issue body includes workflow name");

const existingIssue: ExistingIssueSummary = {
  id: 999,
  number: 42,
  title: "Cron failure: Weekly Retention Purge Cron 2026-11-08",
  body: createPayload.body,
};

const secondFailureEvent: WorkflowRunEvent = {
  ...sampleEvent,
  runId: 12349999,
  runUrl: "https://github.com/ORM-git/Carrier-hound/actions/runs/12349999",
  createdAt: "2026-11-08T21:00:00Z",
};

const updatePayload = buildIssuePayload(secondFailureEvent, existingIssue);
check(updatePayload.action === "update", "subsequent failure on same day generates 'update' action");
check(updatePayload.issueNumber === 42, "update targets existing issue number");
check(updatePayload.body.includes("https://github.com/ORM-git/Carrier-hound/actions/runs/12349999"), "update appends new run URL");
check(updatePayload.body.includes(sampleEvent.runUrl), "update preserves original run URL");

// If identical run URL is reprocessed, body is not duplicated
const duplicatePayload = buildIssuePayload(sampleEvent, existingIssue);
check(duplicatePayload.body === existingIssue.body, "duplicate run URL is not appended twice");

// --- 5. Decision Runner Integration Tests ---
console.log("\n5. Decision Runner (processWorkflowAlert) Behavioral Tests");
async function runBehavioralTests(): Promise<void> {
  let sentryCalls: Array<{ cron: string; msg: string; extra?: any }> = [];
  let createdIssues: Array<{ title: string; body: string }> = [];
  let updatedIssues: Array<{ num: number; body: string }> = [];

  const mockDeps = {
    sendSentryAlert: async (cron: string, msg: string, extra?: any) => {
      sentryCalls.push({ cron, msg, extra });
    },
    findExistingIssue: async (title: string) => {
      const match = createdIssues.find((i) => i.title === title);
      return match ? { number: 101, title: match.title, body: match.body } : null;
    },
    createIssue: async (title: string, body: string) => {
      createdIssues.push({ title, body });
      return { number: 101 };
    },
    updateIssue: async (num: number, body: string) => {
      updatedIssues.push({ num, body });
      return { number: num };
    },
  };

  // Case A: Successful run should be ignored
  const successRes = await processWorkflowAlert(
    { ...sampleEvent, conclusion: "success" },
    mockDeps
  );
  check(!successRes.eligible, "success conclusion is marked not eligible");
  check(successRes.issueAction === "none", "no issue action on success");
  check(sentryCalls.length === 0, "no sentry alert sent on success");

  // Case B: Non-allowlisted workflow should be ignored
  const nonCronRes = await processWorkflowAlert(
    { ...sampleEvent, workflowName: "Continuous Integration (Build, Lint & Test)", conclusion: "failure" },
    mockDeps
  );
  check(!nonCronRes.eligible, "non-cron workflow is marked not eligible");
  check(nonCronRes.issueAction === "none", "no issue action for non-cron");

  // Case C: Retention cron failure on 8 Nov -> should alert and create issue
  const retentionRes = await processWorkflowAlert(sampleEvent, mockDeps);
  check(retentionRes.eligible, "retention failure is eligible");
  check(retentionRes.sentryDispatched, "sentry alert was dispatched");
  check(retentionRes.issueAction === "created", "initial issue was created");
  check(sentryCalls.length === 1, "sentry called once");
  check(createdIssues.length === 1, "issue created once");

  // Case D: Second failure on same day -> should alert and update issue
  const secondRes = await processWorkflowAlert(secondFailureEvent, mockDeps);
  check(secondRes.eligible, "second retention failure is eligible");
  check(secondRes.sentryDispatched, "sentry alert was dispatched for second failure");
  check(secondRes.issueAction === "updated", "second failure updated existing issue");
  check(createdIssues.length === 1, "no duplicate issue created");
  check(updatedIssues.length === 1, "existing issue updated");

  // Case E: Fail-open on Sentry error
  const failingSentryDeps = {
    ...mockDeps,
    sendSentryAlert: async () => {
      throw new Error("Sentry network timeout");
    },
  };
  const failOpenRes = await processWorkflowAlert(
    { ...sampleEvent, createdAt: "2026-11-12T00:00:00Z" },
    failingSentryDeps
  );
  check(failOpenRes.eligible, "fail-open run completes without throwing");
  check(!failOpenRes.sentryDispatched, "sentry dispatch failure recorded gracefully");

  // --- 6. Workflow YAML Static Validation ---
  console.log("\n6. Workflow YAML Static Validation");
  const yamlPath = join(".github", "workflows", "workflow-failure-alert.yml");
  check(existsSync(yamlPath), "workflow-failure-alert.yml exists");
  const yamlContent = readFileSync(yamlPath, "utf8");
  check(yamlContent.includes("workflow_run:"), "workflow triggers on workflow_run");
  check(yamlContent.includes("types:\n      - completed"), "workflow triggers on completed event");
  check(yamlContent.includes("Weekly Retention Purge Cron"), "workflow monitors Weekly Retention Purge Cron");
  check(yamlContent.includes("Daily Early-Access Signup Digest Cron"), "workflow monitors Daily Early-Access Signup Digest Cron");
  check(yamlContent.includes("Source Health Monitoring"), "workflow monitors Source Health Monitoring");
  check(yamlContent.includes("conclusion == 'failure'"), "workflow guards on conclusion == 'failure'");
  check(yamlContent.includes("issues: write"), "workflow requests issues: write permission");
  check(yamlContent.includes("npx tsx scripts/workflow-failure-alert.ts"), "workflow executes scripts/workflow-failure-alert.ts");

  // --- 7. Negative Control Verification ---
  console.log("\n7. Negative Control Verification");
  const wrongKey = buildCronFailureDedupeKey("Weekly Retention Purge Cron", "2026-11-08T19:30:00Z");
  const expectedKey = "Cron failure: Weekly Retention Purge Cron 2026-11-08";
  check(wrongKey === expectedKey, "key matches expectation");
  const negativeControlCheck = wrongKey === "Cron failure: Weekly Retention Purge Cron 2026-11-09";
  check(!negativeControlCheck, "negative control: wrong date correctly evaluated as false");
}

runBehavioralTests()
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
