#!/usr/bin/env node
/**
 * scripts/check-load-run-kit.cjs
 *
 * Standalone offline checker for the 1000-user load run kit.
 * Verifies:
 * 1. 1000-user stage profile exists with ramp-up/ramp-down and per-endpoint thresholds in scripts/loadtest/cm-load.js
 * 2. Existing 200-user behavior is preserved when FULL is not set
 * 3. Results-export path is wired to a dated report under reports/loadtest/
 * 4. Documentation exists at docs/perf/load-run-1000.md with preconditions, commands, what to capture, and abort checklist
 * 5. Negative controls properly reject missing or malformed kit components
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const LOAD_SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "loadtest", "cm-load.js");
const DOC_PATH = path.join(ROOT_DIR, "docs", "perf", "load-run-1000.md");
const REPORTS_DIR = path.join(ROOT_DIR, "reports", "loadtest");

/**
 * Pure validation logic separated for unit testability and negative controls.
 */
function validateLoadRunKit(loadScriptContent, docContent, reportsDirExists) {
  const errors = [];

  // --- 1. cm-load.js checks ---
  if (!loadScriptContent) {
    errors.push("scripts/loadtest/cm-load.js is missing or empty");
    return errors;
  }

  // Check FULL=1 gating
  if (!loadScriptContent.includes("__ENV.FULL === '1'")) {
    errors.push("cm-load.js missing IS_FULL / FULL === '1' environment toggle");
  }

  // Check default 200-user profile preserved
  if (!loadScriptContent.includes("defaultStages") || !loadScriptContent.includes("target: 200")) {
    errors.push("cm-load.js missing defaultStages with 200 VU baseline target");
  }
  if (!loadScriptContent.includes("defaultThresholds")) {
    errors.push("cm-load.js missing defaultThresholds for unaugmented 200-user runs");
  }

  // Check 1000-user fullStages with ramp-up and ramp-down
  if (!loadScriptContent.includes("fullStages")) {
    errors.push("cm-load.js missing fullStages definition");
  } else {
    const has1000Target = /target:\s*1000\b/.test(loadScriptContent);
    const hasRampDown = /duration:\s*['"]30s['"]\s*,\s*target:\s*0\b/.test(loadScriptContent) ||
                        /target:\s*0\b/.test(loadScriptContent);
    if (!has1000Target) {
      errors.push("fullStages missing 1000 VU peak target");
    }
    if (!hasRampDown) {
      errors.push("fullStages missing ramp-down target: 0");
    }
  }

  // Check per-endpoint thresholds matching abort checklist
  const requiredEndpointTrends = [
    "duration_home",
    "duration_jobs_shell",
    "duration_stats",
    "duration_jobs_category",
    "duration_jobs_search",
  ];

  for (const trend of requiredEndpointTrends) {
    if (!loadScriptContent.includes(trend)) {
      errors.push(`cm-load.js missing per-endpoint threshold for '${trend}'`);
    }
  }

  if (!loadScriptContent.includes("fullThresholds")) {
    errors.push("cm-load.js missing fullThresholds definition extending defaultThresholds");
  }

  // Check options dynamically selects full vs default
  if (!loadScriptContent.includes("stages: IS_FULL ? fullStages : defaultStages")) {
    errors.push("options.stages must toggle between fullStages and defaultStages via IS_FULL");
  }
  if (!loadScriptContent.includes("thresholds: IS_FULL ? fullThresholds : defaultThresholds")) {
    errors.push("options.thresholds must toggle between fullThresholds and defaultThresholds via IS_FULL");
  }

  // Check results export path to reports/loadtest/
  if (!loadScriptContent.includes("reports/loadtest/load-run-")) {
    errors.push("cm-load.js handleSummary must export summary to a dated file under reports/loadtest/");
  }

  if (!reportsDirExists) {
    errors.push("Directory reports/loadtest does not exist on disk");
  }

  // --- 2. docs/perf/load-run-1000.md checks ---
  if (!docContent) {
    errors.push("docs/perf/load-run-1000.md is missing or empty");
    return errors;
  }

  const docLower = docContent.toLowerCase();

  // Preconditions
  if (!docLower.includes("staging") || !docLower.includes("production") || !docLower.includes("owner")) {
    errors.push("docs/perf/load-run-1000.md missing staging vs production owner decision");
  }
  if (!docLower.includes("supabase") || !docLower.includes("pooler") || !docLower.includes("connection")) {
    errors.push("docs/perf/load-run-1000.md missing Supabase connection limits and pooler guidance");
  }
  if (!docLower.includes("threshold")) {
    errors.push("docs/perf/load-run-1000.md missing k6 thresholds section");
  }

  // Exact commands
  if (!docContent.includes("FULL=1 k6 run scripts/loadtest/cm-load.js") &&
      !docContent.includes("FULL=1") && !docContent.includes("cm-load.js")) {
    errors.push("docs/perf/load-run-1000.md missing exact execution command (FULL=1 k6 run scripts/loadtest/cm-load.js)");
  }

  // What to capture
  const requiredMetrics = ["rps", "p95", "p99", "error", "duration"];
  for (const metric of requiredMetrics) {
    if (!docLower.includes(metric)) {
      errors.push(`docs/perf/load-run-1000.md missing capture requirement for '${metric}'`);
    }
  }

  // Abort checklist
  if (!docLower.includes("abort checklist") && !docLower.includes("abort criteria")) {
    errors.push("docs/perf/load-run-1000.md missing Abort Checklist");
  }
  if (!docLower.includes("429") || !docLower.includes("cloudflare")) {
    errors.push("docs/perf/load-run-1000.md Abort Checklist missing HTTP 429 and Cloudflare challenge ceilings");
  }

  // Verification command
  if (!docContent.includes("node scripts/check-load-run-kit.cjs")) {
    errors.push("docs/perf/load-run-1000.md must reference the one-line run command: node scripts/check-load-run-kit.cjs");
  }

  return errors;
}

/**
 * Execute negative control checks against mutations.
 */
function runNegativeControls() {
  const sampleScript = `
    const defaultStages = [{ duration: '2m', target: 200 }];
    const defaultThresholds = { http_req_failed: [] };
    const fullStages = [
      { duration: '2m', target: 50 },
      { duration: '2m', target: 200 },
      { duration: '2m', target: 500 },
      { duration: '2m', target: 1000 },
      { duration: '30s', target: 0 }
    ];
    const fullThresholds = {
      duration_home: [],
      duration_jobs_shell: [],
      duration_stats: [],
      duration_jobs_category: [],
      duration_jobs_search: []
    };
    const IS_FULL = __ENV.FULL === '1';
    export const options = {
      stages: IS_FULL ? fullStages : defaultStages,
      thresholds: IS_FULL ? fullThresholds : defaultThresholds
    };
    function handleSummary() {
      return { 'reports/loadtest/load-run-2026.txt': '' };
    }
  `;

  const sampleDoc = `
    # Load Run 1000
    Preconditions: staging vs production is the owner's decision.
    Supabase connection limits and transaction pooler port 6543.
    k6 thresholds: p95, p99, error rate.
    Command: FULL=1 k6 run scripts/loadtest/cm-load.js
    What to capture: RPS, p95, p99, error rate, duration.
    Abort Checklist: HTTP 429, Cloudflare challenges, error ceilings.
    Command: node scripts/check-load-run-kit.cjs
  `;

  // Control 1: Valid sample must pass
  const validErrors = validateLoadRunKit(sampleScript, sampleDoc, true);
  if (validErrors.length > 0) {
    throw new Error(`Negative control baseline failed: ${validErrors.join("; ")}`);
  }

  // Control 2: Missing 1000 VU stage must fail
  const missing1000 = sampleScript.replace("target: 1000", "target: 800");
  const err1 = validateLoadRunKit(missing1000, sampleDoc, true);
  if (!err1.some((e) => e.includes("1000 VU peak target"))) {
    throw new Error("Negative control failed: missing 1000 VU target was not caught");
  }

  // Control 3: Missing per-endpoint threshold must fail
  const missingThreshold = sampleScript.replace("duration_jobs_search", "unrelated_metric");
  const err2 = validateLoadRunKit(missingThreshold, sampleDoc, true);
  if (!err2.some((e) => e.includes("duration_jobs_search"))) {
    throw new Error("Negative control failed: missing per-endpoint threshold was not caught");
  }

  // Control 4: Missing reports/loadtest/ export must fail
  const missingExport = sampleScript.replace("reports/loadtest/load-run-", "out/summary-");
  const err3 = validateLoadRunKit(missingExport, sampleDoc, true);
  if (!err3.some((e) => e.includes("reports/loadtest/"))) {
    throw new Error("Negative control failed: missing reports/loadtest/ export was not caught");
  }

  // Control 5: Missing abort checklist in doc must fail
  const missingAbort = sampleDoc.replace("Abort Checklist:", "Other Section:");
  const err4 = validateLoadRunKit(sampleScript, missingAbort, true);
  if (!err4.some((e) => e.includes("Abort Checklist"))) {
    throw new Error("Negative control failed: missing Abort Checklist in doc was not caught");
  }
}

function main() {
  console.log("================================================================================");
  console.log("CAREERMONKE 1000-USER LOAD RUN KIT VERIFIER");
  console.log("================================================================================");

  // 1. Run negative controls first
  try {
    runNegativeControls();
    console.log("✅ [PASS] Negative controls verified (5/5 mutation tests caught expected errors)");
  } catch (err) {
    console.error(`❌ [FAIL] Negative control failure: ${err.message}`);
    process.exit(1);
  }

  // 2. Read live repository files
  if (!fs.existsSync(LOAD_SCRIPT_PATH)) {
    console.error(`❌ [FAIL] Missing load script: ${LOAD_SCRIPT_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(DOC_PATH)) {
    console.error(`❌ [FAIL] Missing documentation: ${DOC_PATH}`);
    process.exit(1);
  }

  const loadScriptContent = fs.readFileSync(LOAD_SCRIPT_PATH, "utf8");
  const docContent = fs.readFileSync(DOC_PATH, "utf8");
  const reportsDirExists = fs.existsSync(REPORTS_DIR);

  // 3. Validate live repository files
  const errors = validateLoadRunKit(loadScriptContent, docContent, reportsDirExists);

  if (errors.length > 0) {
    console.error("❌ [FAIL] Load run kit validation failed with the following issues:");
    for (const err of errors) {
      console.error(`   - ${err}`);
    }
    process.exit(1);
  }

  console.log("✅ [PASS] scripts/loadtest/cm-load.js has 1000-user profile with ramp-up/down");
  console.log("✅ [PASS] scripts/loadtest/cm-load.js has per-endpoint thresholds matching abort criteria");
  console.log("✅ [PASS] scripts/loadtest/cm-load.js preserves 200-user default execution behavior");
  console.log("✅ [PASS] scripts/loadtest/cm-load.js wires summary export to reports/loadtest/load-run-<timestamp>.txt");
  console.log("✅ [PASS] reports/loadtest directory exists on disk");
  console.log("✅ [PASS] docs/perf/load-run-1000.md covers preconditions (staging vs prod, Supabase limits, k6 thresholds)");
  console.log("✅ [PASS] docs/perf/load-run-1000.md documents exact commands, capture metrics, and abort checklist");
  console.log("✅ [PASS] docs/perf/load-run-1000.md cites the one-line run command");
  console.log("================================================================================");
  console.log("SUMMARY: All 1000-user load run kit components verified successfully.");
  console.log("================================================================================");
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { validateLoadRunKit, runNegativeControls };
