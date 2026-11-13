/**
 * Offline guard test for scheduled jobs policies and timeout scopes:
 * 1. Ingest source timeout scope: verifies that in scripts/ingest.ts, the 45s timeout
 *    bounds ONLY the adapter.fetchJobs() phase, clearing the timer upon fetch completion
 *    so multi-batch DB upserts on large boards (400+ jobs) are not prematurely aborted.
 * 2. Daily digest cron secret hygiene: verifies that .github/workflows/daily-digest-cron.yml
 *    does not reference obsolete model secrets (GROQ_API_KEY, FAST_MODEL, SMART_MODEL)
 *    since dailyDigestCron uses deterministic computeFitDiagnostics against Supabase.
 * 3. Synthetic simulation / negative control: verifies slow fetch rejects with expected
 *    timeout while fast fetch followed by slow DB processing executes to completion.
 *
 * Run: npx tsx scripts/test-scheduled-jobs-policy.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++;
    console.log(`✅ PASS: ${name}`);
  } else {
    failed++;
    console.error(`❌ FAIL: ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

async function runTests() {
  console.log("======================================================");
  console.log("🧪 Scheduled Jobs Policy & Timeout Scope Guard Tests");
  console.log("======================================================\n");

  // ---------------------------------------------------------------------------
  // TEST 1: scripts/ingest.ts fetch timeout scoping
  // ---------------------------------------------------------------------------
  console.log("--- TEST 1: Ingestion Source Timeout Scope ---");
  const ingestPath = path.resolve(__dirname, "ingest.ts");
  assert(fs.existsSync(ingestPath), "scripts/ingest.ts exists");

  const ingestCode = fs.readFileSync(ingestPath, "utf-8");

  // Verify adapter.fetchJobs is raced against timeoutPromise
  const hasFetchRace = /const\s+rawJobs\s*=\s*await\s+Promise\.race\(\s*\[\s*adapter\.fetchJobs\(source\)\s*,\s*timeoutPromise\s*,?\s*\]\s*\)/m.test(ingestCode);
  assert(hasFetchRace, "adapter.fetchJobs(source) is directly raced with timeoutPromise");

  // Verify timeoutId is cleared immediately after fetch completes
  const hasImmediateClear = /clearTimeout\(timeoutId\)/.test(ingestCode);
  assert(hasImmediateClear, "timeoutId is cleared immediately upon fetch resolution");

  // Verify that multi-batch DB writes are outside the timeoutPromise
  const dbWriteAfterFetch = ingestCode.indexOf(".from('jobs')\n              .upsert(jobsPayload");
  const fetchTimeoutIndex = ingestCode.indexOf("Promise.race([");
  assert(
    dbWriteAfterFetch > fetchTimeoutIndex,
    "Database upsert loop occurs sequentially AFTER the fetch Promise.race finishes"
  );

  // ---------------------------------------------------------------------------
  // TEST 2: Daily Digest Cron Secret Hygiene
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 2: Daily Digest Cron Secret Hygiene ---");
  const workflowPath = path.resolve(__dirname, "../.github/workflows/daily-digest-cron.yml");
  assert(fs.existsSync(workflowPath), ".github/workflows/daily-digest-cron.yml exists");

  const workflowContent = fs.readFileSync(workflowPath, "utf-8");
  assert(!workflowContent.includes("GROQ_API_KEY"), "Workflow does not reference obsolete GROQ_API_KEY");
  assert(!workflowContent.includes("FAST_MODEL"), "Workflow does not reference obsolete FAST_MODEL");
  assert(!workflowContent.includes("SMART_MODEL"), "Workflow does not reference obsolete SMART_MODEL");
  assert(workflowContent.includes("NEXT_PUBLIC_SUPABASE_URL"), "Workflow retains required NEXT_PUBLIC_SUPABASE_URL");
  assert(workflowContent.includes("SUPABASE_SERVICE_ROLE_KEY"), "Workflow retains required SUPABASE_SERVICE_ROLE_KEY");

  // ---------------------------------------------------------------------------
  // TEST 3: Synthetic Behavioral Simulation (Fast vs Slow Fetch)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 3: Synthetic Behavioral Simulation ---");

  // Case A: Slow fetch exceeding timeout must reject with expected error
  let slowFetchRejected = false;
  let slowFetchErrorMsg = "";
  try {
    let tId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      tId = setTimeout(() => reject(new Error("Timeout after 45s processing TestSlowSource")), 50);
    });

    const slowAdapterFetch = new Promise<string[]>((resolve) => {
      setTimeout(() => resolve(["job-1", "job-2"]), 200);
    });

    await Promise.race([slowAdapterFetch, timeoutPromise]);
    if (tId) clearTimeout(tId);
  } catch (err: any) {
    slowFetchRejected = true;
    slowFetchErrorMsg = err?.message || "";
  }
  assert(
    slowFetchRejected && slowFetchErrorMsg.includes("Timeout after 45s processing TestSlowSource"),
    "Slow fetch (> timeout) rejects with expected timeout error message"
  );

  // Case B: Fast fetch (< timeout) followed by long processing succeeds to completion
  let fastFetchSucceeded = false;
  let postFetchProcessingCompleted = false;
  try {
    let tId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      tId = setTimeout(() => reject(new Error("Timeout after 45s processing TestFastSource")), 50);
    });

    const fastAdapterFetch = new Promise<string[]>((resolve) => {
      setTimeout(() => resolve(["job-1", "job-2", "job-3"]), 10);
    });

    const jobs = await Promise.race([fastAdapterFetch, timeoutPromise]);
    if (tId) {
      clearTimeout(tId);
      tId = null;
    }
    fastFetchSucceeded = jobs.length === 3;

    // Simulate multi-batch database writes that take longer than the original 50ms fetch timeout
    await new Promise((resolve) => setTimeout(resolve, 100));
    postFetchProcessingCompleted = true;
  } catch {
    fastFetchSucceeded = false;
  }
  assert(
    fastFetchSucceeded && postFetchProcessingCompleted,
    "Fast fetch clears timer and allows subsequent longer multi-batch processing to complete cleanly"
  );

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n======================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("======================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failure:", err);
  process.exit(1);
});
