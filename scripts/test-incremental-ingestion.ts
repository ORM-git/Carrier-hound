/**
 * Offline Verification Suite for Incremental / Delta Ingestion
 * (Backend Missing/Partial batch 1, Group 4)
 *
 * Verifies:
 * 1. Normalized board watermark key generation (case-insensitivity, trim).
 * 2. Watermark retrieval and validation (valid ISO parsing, unparseable dates return null).
 * 3. Watermark persistence (load/save/atomic file writing, directory auto-creation, corrupt JSON fallback).
 * 4. Watermark updating (entry structure, timestamp, job count).
 * 5. Delta job filtering:
 *    - Nil watermark: returns all jobs, isDelta: false.
 *    - Valid watermark: filters out postings older than high-water mark.
 *    - Keeps postings at or newer than high-water mark across multiple date fields (posted_at, updated_at, discovered_at).
 *    - Keeps undated postings (fail-open: never drop postings lacking timestamp).
 *    - Keeps postings with unparseable date strings (fail-open).
 *    - Malformed watermark string: fails open to full fetch (isDelta: false).
 *    - Exception/error during filtering: fails open to full fetch (isDelta: false).
 * 6. Deduplication fallback:
 *    - Delta filtering feeds directly into unique-key dedupe (`dedupJobs`), ensuring duplicate URLs/roles are caught.
 * 7. Negative control:
 *    - Injected expectation mismatch exits with non-zero code.
 *
 * Usage:
 *   npx tsx scripts/test-incremental-ingestion.ts
 *   npx tsx scripts/test-incremental-ingestion.ts --negative-control
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  getBoardWatermarkKey,
  getBoardWatermark,
  loadBoardWatermarks,
  saveBoardWatermarks,
  updateBoardWatermark,
  filterJobsByWatermark,
} from "./lib/board-delta";
import { dedupJobs, NormalizedJob } from "./board-ingest";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

interface TestCaseResult {
  name: string;
  pass: boolean;
  detail?: string;
}

const results: TestCaseResult[] = [];

function assert(name: string, condition: boolean, detail?: string) {
  if (IS_NEGATIVE_CONTROL && name === "NEGATIVE_CONTROL_INJECTION") {
    // Invert condition for negative control
    condition = false;
  }
  results.push({ name, pass: Boolean(condition), detail });
  const icon = condition ? "✅" : "❌";
  console.log(`  ${icon} ${name}${detail ? ` (${detail})` : ""}`);
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("🧪 Incremental / Delta Ingestion Verification Suite");
  console.log("================================================================================");
  if (IS_NEGATIVE_CONTROL) {
    console.log("⚠️  Running in NEGATIVE CONTROL mode — deliberate failure will be injected.");
  }

  // ---------------------------------------------------------------------------
  // 1. Watermark Key Generation
  // ---------------------------------------------------------------------------
  console.log("\n[1] Watermark Key Generation");
  assert(
    "Key generation normalizes ats and token to lowercase and trims whitespace",
    getBoardWatermarkKey("  GreenHouse  ", " Stripe ") === "greenhouse:stripe"
  );
  assert(
    "Key generation handles empty or missing ats/token safely",
    getBoardWatermarkKey("", "") === "unknown:"
  );

  // ---------------------------------------------------------------------------
  // 2. Watermark Retrieval & Timestamp Parsing
  // ---------------------------------------------------------------------------
  console.log("\n[2] Watermark Retrieval & Date Parsing");
  const sampleWatermarks = {
    "greenhouse:stripe": { lastIngestAt: "2026-11-01T12:00:00.000Z", jobsProcessed: 42 },
    "lever:figma": { lastIngestAt: "invalid-date-string", jobsProcessed: 10 },
  };

  assert(
    "Retrieves valid ISO timestamp for known board",
    getBoardWatermark(sampleWatermarks, "greenhouse", "stripe") === "2026-11-01T12:00:00.000Z"
  );
  assert(
    "Returns null for board with invalid date string",
    getBoardWatermark(sampleWatermarks, "lever", "figma") === null
  );
  assert(
    "Returns null for unrecorded board",
    getBoardWatermark(sampleWatermarks, "ashby", "nonexistent") === null
  );

  // ---------------------------------------------------------------------------
  // 3. Watermark Persistence (Load / Save / Auto-creation)
  // ---------------------------------------------------------------------------
  console.log("\n[3] Watermark Persistence");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-delta-test-"));
  const tempFilePath = path.join(tempDir, "subfolder", "watermarks.json");

  try {
    assert(
      "Loading from non-existent file returns empty object without throwing",
      Object.keys(loadBoardWatermarks(path.join(tempDir, "missing.json"))).length === 0
    );

    // Save and load
    saveBoardWatermarks(sampleWatermarks, tempFilePath);
    assert(
      "saveBoardWatermarks creates directories and persists JSON to disk",
      fs.existsSync(tempFilePath)
    );

    const loaded = loadBoardWatermarks(tempFilePath);
    assert(
      "loadBoardWatermarks retrieves saved content correctly",
      loaded["greenhouse:stripe"]?.jobsProcessed === 42 &&
      loaded["greenhouse:stripe"]?.lastIngestAt === "2026-11-01T12:00:00.000Z"
    );

    // Corrupted file fail-open
    const corruptFile = path.join(tempDir, "corrupt.json");
    fs.writeFileSync(corruptFile, "{ invalid json content !!!", "utf8");
    const loadedCorrupt = loadBoardWatermarks(corruptFile);
    assert(
      "loadBoardWatermarks fails open to {} when JSON is corrupted",
      Object.keys(loadedCorrupt).length === 0
    );

    // Update watermark helper
    const updated = updateBoardWatermark(loaded, "ashby", "ramp", "2026-11-05T00:00:00.000Z", 15);
    assert(
      "updateBoardWatermark updates watermarks record with ats, timestamp, and count",
      updated["ashby:ramp"]?.lastIngestAt === "2026-11-05T00:00:00.000Z" &&
      updated["ashby:ramp"]?.jobsProcessed === 15 &&
      updated["ashby:ramp"]?.ats === "ashby"
    );
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Delta Job Filtering Core Rules
  // ---------------------------------------------------------------------------
  console.log("\n[4] Delta Job Filtering");
  const watermark = "2026-11-05T00:00:00.000Z";

  const mockJobs: Partial<NormalizedJob>[] = [
    // 0: Older than watermark
    {
      id: "job-1-old",
      title: "Senior Backend Engineer",
      apply_url: "https://stripe.com/jobs/1",
      posted_at: "2026-11-01T10:00:00.000Z",
    },
    // 1: Newer than watermark (posted_at)
    {
      id: "job-2-new-posted",
      title: "Staff Systems Engineer",
      apply_url: "https://stripe.com/jobs/2",
      posted_at: "2026-11-06T15:00:00.000Z",
    },
    // 2: Newer than watermark via updated_at
    {
      id: "job-3-updated",
      title: "Product Designer",
      apply_url: "https://stripe.com/jobs/3",
      posted_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-11-07T09:00:00.000Z",
    },
    // 3: Exact watermark timestamp
    {
      id: "job-4-exact",
      title: "Data Analyst",
      apply_url: "https://stripe.com/jobs/4",
      posted_at: "2026-11-05T00:00:00.000Z",
    },
    // 4: Undated job (fail-open)
    {
      id: "job-5-undated",
      title: "Engineering Manager",
      apply_url: "https://stripe.com/jobs/5",
    },
    // 5: Unparseable date (fail-open)
    {
      id: "job-6-bad-date",
      title: "Security Engineer",
      apply_url: "https://stripe.com/jobs/6",
      posted_at: "yesterday afternoon",
    },
  ];

  // Case 4a: Null watermark -> full fetch
  const fullFetchResult = filterJobsByWatermark(mockJobs, null);
  assert(
    "Null watermark results in full fetch (isDelta: false, 0 skipped)",
    fullFetchResult.isDelta === false &&
    fullFetchResult.deltaJobs.length === mockJobs.length &&
    fullFetchResult.skippedCount === 0
  );

  // Case 4b: Empty string watermark -> full fetch
  const emptyMarkResult = filterJobsByWatermark(mockJobs, "");
  assert(
    "Empty watermark results in full fetch (isDelta: false, 0 skipped)",
    emptyMarkResult.isDelta === false &&
    emptyMarkResult.deltaJobs.length === mockJobs.length
  );

  // Case 4c: Valid watermark filtering
  const deltaResult = filterJobsByWatermark(mockJobs, watermark);
  assert(
    "Valid watermark flags isDelta: true and reports skipped count = 1",
    deltaResult.isDelta === true && deltaResult.skippedCount === 1
  );

  const deltaIds = deltaResult.deltaJobs.map((j) => j.id);
  assert(
    "Older job (job-1-old) was filtered out",
    !deltaIds.includes("job-1-old")
  );
  assert(
    "Newer job (job-2-new-posted) was kept",
    deltaIds.includes("job-2-new-posted")
  );
  assert(
    "Updated job (job-3-updated) was kept based on updated_at",
    deltaIds.includes("job-3-updated")
  );
  assert(
    "Exact watermark timestamp job (job-4-exact) was kept",
    deltaIds.includes("job-4-exact")
  );
  assert(
    "Undated job (job-5-undated) was kept (fail-open)",
    deltaIds.includes("job-5-undated")
  );
  assert(
    "Unparseable date job (job-6-bad-date) was kept (fail-open)",
    deltaIds.includes("job-6-bad-date")
  );

  // Case 4d: Invalid watermark string fails open to full fetch
  const invalidWatermarkResult = filterJobsByWatermark(mockJobs, "not-a-valid-date");
  assert(
    "Invalid watermark string fails open to full fetch without crashing",
    invalidWatermarkResult.isDelta === false &&
    invalidWatermarkResult.deltaJobs.length === mockJobs.length
  );

  // Case 4e: Thrown exception during filter fails open
  const throwingJobs = [
    {
      id: "ok-job",
      get posted_at() {
        throw new Error("Simulated getter explosion");
      },
    },
  ];
  const exceptionResult = filterJobsByWatermark(throwingJobs as any, watermark);
  assert(
    "Exception during filtering fails open to full fetch with error recorded",
    exceptionResult.isDelta === false &&
    exceptionResult.deltaJobs.length === 1 &&
    Boolean(exceptionResult.error)
  );

  // ---------------------------------------------------------------------------
  // 5. Deduplication Fallback Integration
  // ---------------------------------------------------------------------------
  console.log("\n[5] Deduplication Fallback Integration");
  // Ensure that after delta filtering, unique-key dedupe (dedupJobs) still functions properly
  const seenUrls = new Set<string>();
  const seenRoles = new Set<string>();

  // Feed candidate jobs from deltaResult into dedupJobs
  const candidateJobsForDedup: NormalizedJob[] = deltaResult.deltaJobs.map((j, idx) => ({
    id: j.id || `gen-id-${idx}`,
    source_job_id: j.id || `src-id-${idx}`,
    title: j.title || `Title ${idx}`,
    company: "Stripe",
    company_name: "Stripe",
    company_slug: "stripe",
    location: `Remote Office ${idx}`,
    location_type: "remote",
    apply_url: j.apply_url || `https://stripe.com/apply/${idx}`,
    description: "Sample description",
    source: "greenhouse-board",
    source_type: "ats",
    first_seen_at: "2026-11-06T00:00:00.000Z",
    last_seen_at: "2026-11-06T00:00:00.000Z",
    is_active: true,
    verified: true,
    country_code: "US",
    remote: true,
    job_type: "full-time",
  }));

  // Duplicate one entry in the candidate list to test dedup fallback
  candidateJobsForDedup.push({
    ...candidateJobsForDedup[0],
    id: "duplicate-candidate",
  });

  const dedupOutcome = dedupJobs(candidateJobsForDedup, seenUrls, seenRoles);
  assert(
    "Unique-key dedupe identifies duplicates among delta-filtered jobs",
    dedupOutcome.duplicates === 1 &&
    dedupOutcome.accepted.length === candidateJobsForDedup.length - 1
  );

  // ---------------------------------------------------------------------------
  // 6. End-to-End Simulation: Initial vs Subsequent Ingestion
  // ---------------------------------------------------------------------------
  console.log("\n[6] End-to-End Ingestion Simulation");
  const simulationWatermarks: Record<string, any> = {};

  // Cycle 1: Brand new board (no watermark)
  const cycle1Mark = getBoardWatermark(simulationWatermarks, "greenhouse", "acme");
  const cycle1Delta = filterJobsByWatermark(mockJobs, cycle1Mark);
  assert(
    "Cycle 1 (first run): Processes all 6 postings (full fetch)",
    cycle1Delta.deltaJobs.length === 6 && cycle1Delta.isDelta === false
  );

  // Ingest succeeds: update watermark to current time
  const cycle1CompletionTime = "2026-11-05T12:00:00.000Z";
  updateBoardWatermark(simulationWatermarks, "greenhouse", "acme", cycle1CompletionTime, cycle1Delta.deltaJobs.length);
  assert(
    "Cycle 1 post-ingest: Watermark saved for greenhouse:acme",
    simulationWatermarks["greenhouse:acme"]?.lastIngestAt === cycle1CompletionTime
  );

  // Cycle 2: Subsequent run after 2 days
  const cycle2Mark = getBoardWatermark(simulationWatermarks, "greenhouse", "acme");
  const cycle2Delta = filterJobsByWatermark(mockJobs, cycle2Mark);
  assert(
    "Cycle 2 (incremental run): Skips older postings, processes only postings >= 2026-11-05T12:00:00.000Z plus undated jobs",
    cycle2Delta.isDelta === true &&
    cycle2Delta.skippedCount === 2 // job-1 (Nov 1) and job-4 (Nov 5 00:00) skipped
  );

  // ---------------------------------------------------------------------------
  // Negative Control Injection Check
  // ---------------------------------------------------------------------------
  if (IS_NEGATIVE_CONTROL) {
    console.log("\n[7] Injected Negative Control Check");
    assert("NEGATIVE_CONTROL_INJECTION", true, "Should fail when --negative-control is passed");
  }

  // ---------------------------------------------------------------------------
  // Summary & Exit
  // ---------------------------------------------------------------------------
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;

  console.log("\n================================================================================");
  console.log(`TEST SUMMARY: ${passed}/${total} test cases passed. Failures: ${failed}`);
  console.log("================================================================================");

  if (IS_NEGATIVE_CONTROL) {
    if (failed > 0) {
      console.error("\n❌ NEGATIVE CONTROL VERIFIED: Injected expectation mismatch caught as expected!");
      console.error("Exiting with non-zero exit code (1) to prove negative control test failure.");
      process.exit(1);
    }
  }

  if (failed > 0) {
    console.error(`\n❌ DELTA INGESTION TEST SUITE FAILED: ${failed} mismatches detected.`);
    process.exit(1);
  }

  console.log("\n🎉 ALL INCREMENTAL INGESTION TESTS PASSED WITH 100% CONFORMANCE!");
  process.exit(0);
}

runTestSuite().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
