/**
 * scripts/test-cold-start-kit.ts
 *
 * Offline guard test suite verifying the Netlify Functions Cold Start measurement kit:
 * 1. scripts/measure-cold-starts.ts exists and parses cleanly.
 * 2. Endpoint catalog contains strictly GET endpoints (zero mutating routes).
 * 3. Every endpoint in the catalog is thoroughly documented in docs/perf/cold-starts.md.
 * 4. Script safely defaults to --dry-run mode when executed without flags.
 * 5. Script enforces polite rate limiting (>= 1000ms delay, bounded small N).
 * 6. Percentile and cold delta statistical calculations are mathematically accurate.
 * 7. docs/perf/cold-starts.md exists and contains all required sections (catalog, run guide, delta interpretation, dated results log).
 * 8. Subprocess dry-run execution produces expected output and exits with code 0.
 *
 * Run: npx tsx scripts/test-cold-start-kit.ts
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  COLD_START_ENDPOINT_CATALOG,
  RATE_LIMIT_DELAY_MS,
  DEFAULT_REQUESTS_PER_ENDPOINT,
  DEFAULT_BASE_URL,
  parseCliArgs,
  calculateLatencyStats,
} from "./measure-cold-starts";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, details?: string) {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name}${details ? ` -> ${details}` : ""}`);
  }
}

console.log("================================================================================");
console.log("      NETLIFY FUNCTIONS COLD START KIT OFFLINE GUARD TEST                       ");
console.log("================================================================================\n");

// -----------------------------------------------------------------------------
// 1. File Existence Checks
// -----------------------------------------------------------------------------
console.log("--- 1. File Existence & Structure ---");
const SCRIPT_PATH = path.join("scripts", "measure-cold-starts.ts");
const DOC_PATH = path.join("docs", "perf", "cold-starts.md");

check("scripts/measure-cold-starts.ts exists", fs.existsSync(SCRIPT_PATH));
check("docs/perf/cold-starts.md exists", fs.existsSync(DOC_PATH));

// -----------------------------------------------------------------------------
// 2. Catalog Safety Verification: Strictly GET Only
// -----------------------------------------------------------------------------
console.log("\n--- 2. Catalog Safety Verification ---");
check(
  "catalog contains at least 3 representative endpoints",
  Array.isArray(COLD_START_ENDPOINT_CATALOG) && COLD_START_ENDPOINT_CATALOG.length >= 3
);

const allMethodsGet = COLD_START_ENDPOINT_CATALOG.every((entry) => entry.method === "GET");
check("100% of catalog entries use strictly GET method", allMethodsGet);

const MUTATING_METHODS = ["POST", "PUT", "DELETE", "PATCH"];
const hasMutatingMethods = COLD_START_ENDPOINT_CATALOG.some((entry) =>
  MUTATING_METHODS.includes(entry.method.toUpperCase())
);
check("zero mutating routes in catalog (no POST, PUT, DELETE, PATCH)", !hasMutatingMethods);

const allPathsValid = COLD_START_ENDPOINT_CATALOG.every(
  (entry) => typeof entry.path === "string" && entry.path.startsWith("/")
);
check("all catalog paths start with leading slash", allPathsValid);

// Verify catalog covers representative tiers
const tiers = new Set(COLD_START_ENDPOINT_CATALOG.map((e) => e.tier));
check("catalog covers minimal baseline tier", tiers.has("minimal"));
check("catalog covers lightweight data tier", tiers.has("lightweight"));
check("catalog covers feed tier", tiers.has("feed"));
check("catalog covers search/curated tiers", tiers.has("search") || tiers.has("curated"));

// -----------------------------------------------------------------------------
// 3. Documentation Parity with Script Catalog
// -----------------------------------------------------------------------------
console.log("\n--- 3. Documentation Parity with Script Catalog ---");
const docContent = fs.readFileSync(DOC_PATH, "utf8");

for (const entry of COLD_START_ENDPOINT_CATALOG) {
  // Extract path without query parameters for matching
  const basePath = entry.path.split("?")[0];
  const isDocumented = docContent.includes(basePath);
  check(`doc mentions catalog endpoint '${entry.name}' (${basePath})`, isDocumented);
}

// -----------------------------------------------------------------------------
// 4. Rate Limiting & Safety Parameters
// -----------------------------------------------------------------------------
console.log("\n--- 4. Rate Limiting & Safety Bounds ---");
check(
  "rate-limit delay is polite (>= 1000ms between requests)",
  typeof RATE_LIMIT_DELAY_MS === "number" && RATE_LIMIT_DELAY_MS >= 1000
);

check(
  "default request count is small and bounded (<= 10 requests)",
  typeof DEFAULT_REQUESTS_PER_ENDPOINT === "number" &&
    DEFAULT_REQUESTS_PER_ENDPOINT >= 1 &&
    DEFAULT_REQUESTS_PER_ENDPOINT <= 10
);

check(
  "default base URL points to production Netlify deploy",
  typeof DEFAULT_BASE_URL === "string" && DEFAULT_BASE_URL.includes("netlify.app")
);

// -----------------------------------------------------------------------------
// 5. CLI Argument Parsing & Dry-Run Default
// -----------------------------------------------------------------------------
console.log("\n--- 5. CLI Argument Parsing & Dry-Run Defaults ---");

// Default invocation (no flags) must default to dryRun = true
const defaultOpts = parseCliArgs([]);
check("default invocation (no flags) defaults to dryRun: true", defaultOpts.dryRun === true);

// Explicit --dry-run flag
const dryRunOpts = parseCliArgs(["--dry-run"]);
check("--dry-run flag sets dryRun: true", dryRunOpts.dryRun === true);

// Explicit --live flag
const liveOpts = parseCliArgs(["--live"]);
check("--live flag sets dryRun: false", liveOpts.dryRun === false);

// Base URL parsing with space and equals
const baseUrlSpace = parseCliArgs(["--base-url", "https://example.com/"]);
check(
  "--base-url with space parses and strips trailing slash",
  baseUrlSpace.baseUrl === "https://example.com"
);

const baseUrlEquals = parseCliArgs(["--base-url=https://custom-domain.com/"]);
check(
  "--base-url=value parses and strips trailing slash",
  baseUrlEquals.baseUrl === "https://custom-domain.com"
);

// Requests count parsing
const requestsSpace = parseCliArgs(["--requests", "7"]);
check("--requests N sets requestsPerEndpoint to 7", requestsSpace.requestsPerEndpoint === 7);

// -----------------------------------------------------------------------------
// 6. Statistical Calculations (min, p50, p95, max, cold delta)
// -----------------------------------------------------------------------------
console.log("\n--- 6. Statistical Calculations Unit Tests ---");

// Empty input
const emptyStats = calculateLatencyStats([]);
check("empty latencies returns zero stats", emptyStats.min === 0 && emptyStats.sampleCount === 0);

// Single sample
const singleStats = calculateLatencyStats([450]);
check("single sample has min === max === p50 === 450", singleStats.min === 450 && singleStats.p50 === 450);
check("single sample cold delta is 0", singleStats.coldDelta === 0);

// Multi-sample test case: [1000, 200, 220, 210, 250]
// Sorted: [200, 210, 220, 250, 1000]
// N = 5
// p50 index: ceil(0.50 * 5) - 1 = 3 - 1 = 2 -> 220
// p95 index: ceil(0.95 * 5) - 1 = 5 - 1 = 4 -> 1000
// min = 200, max = 1000
// firstHit = 1000
// warmSamples = [200, 220, 210, 250], avg = 880 / 4 = 220
// coldDelta = 1000 - 220 = 780
const multiSamples = [1000, 200, 220, 210, 250];
const multiStats = calculateLatencyStats(multiSamples);

check("multi-sample min is correctly 200ms", multiStats.min === 200);
check("multi-sample max is correctly 1000ms", multiStats.max === 1000);
check("multi-sample p50 (median) is correctly 220ms", multiStats.p50 === 220);
check("multi-sample p95 is correctly 1000ms", multiStats.p95 === 1000);
check("multi-sample firstHit is correctly 1000ms", multiStats.firstHit === 1000);
check("multi-sample warmAvg is correctly 220ms", multiStats.warmAvg === 220);
check("multi-sample cold delta is correctly 780ms (firstHit - p50)", multiStats.coldDelta === 780);

// -----------------------------------------------------------------------------
// 7. Documentation Content & Structure Verification
// -----------------------------------------------------------------------------
console.log("\n--- 7. Documentation Content Verification ---");

check("docs has Endpoint Catalog & Representative Tiers section", docContent.includes("Endpoint Catalog"));
check("docs has How to Run section", docContent.includes("How to Run"));
check("docs documents default dry-run mode", docContent.includes("dry-run") || docContent.includes("Dry-Run"));
check("docs documents live measurement mode", docContent.includes("--live"));
check("docs documents rate limiting and polite backoff", docContent.includes("Rate Limiting") || docContent.includes("Polite"));
check("docs has How to Read Cold vs Warm Deltas section", docContent.includes("Cold vs Warm"));
check("docs defines cold delta formula", docContent.includes("Cold Delta") && docContent.includes("p50"));
check("docs has Dated Results-Log Section", docContent.includes("Dated Results-Log") || docContent.includes("Benchmark Run"));
check("docs results log includes date stamp", /\b2026-\d{2}-\d{2}\b/.test(docContent));
check("docs includes target SLO bounds", docContent.includes("SLO") || docContent.includes("Target"));

// -----------------------------------------------------------------------------
// 8. Subprocess Dry-Run Execution Test
// -----------------------------------------------------------------------------
console.log("\n--- 8. Subprocess Dry-Run Execution ---");

const child = spawnSync(
  process.execPath,
  ["-r", "tsx", path.resolve(SCRIPT_PATH)],
  { encoding: "utf8" }
);

check("subprocess measure-cold-starts (default) exits with code 0", child.status === 0);
check("subprocess output confirms DRY-RUN execution mode", child.stdout?.includes("DRY-RUN"));
check(
  "subprocess prints all cataloged endpoints in dry-run output",
  COLD_START_ENDPOINT_CATALOG.every((e) => child.stdout?.includes(e.name))
);

// -----------------------------------------------------------------------------
// Summary & Final Exit
// -----------------------------------------------------------------------------
console.log(`\n================================================================================`);
console.log(`AUDIT SUMMARY: ${passed} passed, ${failed} failed`);
console.log(`================================================================================`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All cold-start kit guard checks passed successfully.");
  process.exit(0);
}
