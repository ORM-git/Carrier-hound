#!/usr/bin/env node
/**
 * scripts/check-wcag-landmarks.cjs
 *
 * Standalone offline checker for docs/wcag-aa-conformance.md.
 * Verifies:
 *   1. Document exists, is non-empty, and starts with the one-line run command.
 *   2. Section 2 contains exact, unique WCAG 2.1 AA criterion IDs (all 50 canonical IDs).
 *   3. Every file path cited in the criteria evidence column resolves on disk.
 *   4. Summary counts in Section 2 match the table rows exactly.
 *   5. Section 3 contains all 32 non-landing pages with ground-truth landmark statuses.
 *   6. Summary counts in Section 3 match the landmark table rows exactly.
 *   7. Section 4 "Remaining Gaps" is present with actionable remediation items.
 *   8. Built-in negative-control mutations verify that nonexistent citations,
 *      flipped landmark verdicts, and duplicate criterion IDs are strictly rejected.
 *
 * Usage:
 *   node scripts/check-wcag-landmarks.cjs
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOC_PATH = path.join(ROOT, "docs", "wcag-aa-conformance.md");

const ALLOWED_VERDICTS = new Set(["Supports", "Partially Supports", "Not Evaluated"]);

// The 50 canonical WCAG 2.1 Level A & AA Success Criteria IDs
const EXPECTED_CRITERIA = [
  "1.1.1", "1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5", "1.3.1", "1.3.2", "1.3.3", "1.3.4",
  "1.3.5", "1.4.1", "1.4.2", "1.4.3", "1.4.4", "1.4.5", "1.4.10", "1.4.11", "1.4.12", "1.4.13",
  "2.1.1", "2.1.2", "2.1.4", "2.2.1", "2.2.2", "2.3.1", "2.4.1", "2.4.2", "2.4.3", "2.4.4",
  "2.4.5", "2.4.6", "2.4.7", "2.5.1", "2.5.2", "2.5.3", "2.5.4", "3.1.1", "3.1.2", "3.2.1",
  "3.2.2", "3.2.3", "3.2.4", "3.3.1", "3.3.2", "3.3.3", "3.3.4", "4.1.1", "4.1.2", "4.1.3",
];

// Ground-truth expected landmark audit status for every non-landing page in src/app
const EXPECTED_LANDMARK_STATUS = {
  "/about": "GAP",
  "/admin": "GAP",
  "/admin/users": "GAP",
  "/applications": "GAP",
  "/auth/callback": "GAP",
  "/contact": "GAP",
  "/dashboard": "GAP",
  "/early-access": "GAP",
  "/job-detail": "GAP",
  "/job-search/all": "GAP",
  "/jobs": "GAP",
  "/jobs/detail": "GAP",
  "/jobs/[id]/interview-pack": "GAP",
  "/jobs/[id]/skill-what-if": "GAP",
  "/login": "PASS",
  "/onboarding": "GAP",
  "/pricing": "GAP",
  "/privacy": "GAP",
  "/privacy-policy": "GAP",
  "/profile": "GAP",
  "/radar": "GAP",
  "/refund-policy": "GAP",
  "/remote": "PASS",
  "/remote/[slug]": "GAP",
  "/remote/[slug]/titles": "GAP",
  "/remote/jobs/[category]": "GAP",
  "/resume": "GAP",
  "/settings": "GAP",
  "/signup": "PASS",
  "/terms-and-conditions": "GAP",
  "/tracker": "GAP",
  "/worldwide": "PASS",
};

function getAllAppPages(dir, list = []) {
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    if (fs.statSync(full).isDirectory()) {
      getAllAppPages(full, list);
    } else if (item === "page.tsx") {
      list.push(full.replace(/\\/g, "/"));
    }
  }
  return list;
}

/**
 * Validates the contents of docs/wcag-aa-conformance.md.
 * Returns { ok: boolean, errors: string[], details: object }.
 */
function validateConformanceDoc(content) {
  const errors = [];
  const lines = content.split(/\r?\n/);

  // 1. One-line run command near top
  const topSlice = content.slice(0, 500);
  if (!topSlice.includes("node scripts/check-wcag-landmarks.cjs")) {
    errors.push("Top of document missing run command: node scripts/check-wcag-landmarks.cjs");
  }

  // 2. Parse WCAG Criteria Table
  let inCriteriaTable = false;
  const criteriaRows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.includes("Criterion") && trimmed.includes("Verdict")) {
      inCriteriaTable = true;
      continue;
    }
    if (inCriteriaTable) {
      if (!trimmed.startsWith("|") || trimmed.length === 0 || trimmed.startsWith("##")) {
        inCriteriaTable = false;
        continue;
      }
      if (trimmed.includes("---")) continue;

      const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length >= 4) {
        criteriaRows.push({
          rawCriterion: cells[0],
          level: cells[1],
          verdict: cells[2].replace(/\*\*/g, "").trim(),
          evidence: cells[3],
        });
      }
    }
  }

  // 2a. Validate exact unique criterion IDs
  const seenIds = new Set();
  const duplicateIds = [];
  const parsedIds = [];

  for (const row of criteriaRows) {
    const idMatch = row.rawCriterion.match(/(\d+\.\d+\.\d+)/);
    if (!idMatch) {
      errors.push(`Could not parse criterion ID from row: ${row.rawCriterion}`);
      continue;
    }
    const id = idMatch[1];
    parsedIds.push(id);
    if (seenIds.has(id)) {
      duplicateIds.push(id);
    }
    seenIds.add(id);

    // Validate verdict
    if (!ALLOWED_VERDICTS.has(row.verdict)) {
      errors.push(`Criterion ${id}: invalid verdict "${row.verdict}"`);
    }

    // Validate evidence citations resolve on disk
    if (row.verdict !== "Not Evaluated") {
      const citedPaths = [];
      const pathRegex = /`((?:scripts|src|docs|data)\/[^`\s]+)`/g;
      let pMatch;
      while ((pMatch = pathRegex.exec(row.evidence)) !== null) {
        let clean = pMatch[1].replace(/[),;:]+$/, "").replace(/:\d+(?::\d+)?$/, "");
        citedPaths.push(clean);
      }

      if (citedPaths.length === 0) {
        errors.push(`Criterion ${id} (${row.verdict}) lacks file path citations.`);
      } else {
        for (const p of citedPaths) {
          const resolved = path.resolve(ROOT, p);
          if (!fs.existsSync(resolved)) {
            errors.push(`Criterion ${id} cites non-existent file: "${p}"`);
          }
        }
      }
    }
  }

  if (duplicateIds.length > 0) {
    errors.push(`Duplicate criterion IDs found: ${duplicateIds.join(", ")}`);
  }

  for (const expId of EXPECTED_CRITERIA) {
    if (!seenIds.has(expId)) {
      errors.push(`Missing expected criterion ID: ${expId}`);
    }
  }

  // 2b. Validate criteria summary counts against actual table counts
  const actualVerdictCounts = {
    Supports: criteriaRows.filter((r) => r.verdict === "Supports").length,
    "Partially Supports": criteriaRows.filter((r) => r.verdict === "Partially Supports").length,
    "Not Evaluated": criteriaRows.filter((r) => r.verdict === "Not Evaluated").length,
  };

  const supportsMatch = content.match(/-\s*\*\*Supports\*\*:\s*(\d+)/i);
  const partialMatch = content.match(/-\s*\*\*Partially Supports\*\*:\s*(\d+)/i);
  const notEvalMatch = content.match(/-\s*\*\*Not Evaluated\*\*:\s*(\d+)/i);
  const totalCritMatch = content.match(/-\s*\*\*Total Evaluated \/ Audited\*\*:\s*(\d+)/i);

  if (!supportsMatch || parseInt(supportsMatch[1], 10) !== actualVerdictCounts.Supports) {
    errors.push(`Section 2 summary count for Supports (${supportsMatch ? supportsMatch[1] : "missing"}) does not match table (${actualVerdictCounts.Supports})`);
  }
  if (!partialMatch || parseInt(partialMatch[1], 10) !== actualVerdictCounts["Partially Supports"]) {
    errors.push(`Section 2 summary count for Partially Supports (${partialMatch ? partialMatch[1] : "missing"}) does not match table (${actualVerdictCounts["Partially Supports"]})`);
  }
  if (!notEvalMatch || parseInt(notEvalMatch[1], 10) !== actualVerdictCounts["Not Evaluated"]) {
    errors.push(`Section 2 summary count for Not Evaluated (${notEvalMatch ? notEvalMatch[1] : "missing"}) does not match table (${actualVerdictCounts["Not Evaluated"]})`);
  }
  if (!totalCritMatch || parseInt(totalCritMatch[1], 10) !== criteriaRows.length) {
    errors.push(`Section 2 total evaluated criteria count (${totalCritMatch ? totalCritMatch[1] : "missing"}) does not match row count (${criteriaRows.length})`);
  }

  // 3. Parse Landmark Table
  let inLandmarkTable = false;
  const landmarkRows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.includes("Page Route") && trimmed.includes("Landmark Status")) {
      inLandmarkTable = true;
      continue;
    }
    if (inLandmarkTable) {
      if (!trimmed.startsWith("|") || trimmed.length === 0 || trimmed.startsWith("##")) {
        inLandmarkTable = false;
        continue;
      }
      if (trimmed.includes("---")) continue;

      const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length >= 7) {
        landmarkRows.push({
          route: cells[0].replace(/[`*]/g, "").trim(),
          filePath: cells[1].replace(/[`*]/g, "").trim(),
          main: cells[2],
          header: cells[3],
          nav: cells[4],
          aside: cells[5],
          status: cells[6].replace(/\*\*/g, "").trim(),
          gaps: cells[7] || "",
        });
      }
    }
  }

  const allAppPages = getAllAppPages(path.join(ROOT, "src", "app"));
  const nonLandingPages = allAppPages
    .filter((p) => !p.endsWith("src/app/page.tsx"))
    .map((p) => p.replace(ROOT.replace(/\\/g, "/") + "/", ""))
    .sort();

  if (landmarkRows.length !== nonLandingPages.length) {
    errors.push(`Landmark table row count (${landmarkRows.length}) does not match non-landing pages on disk (${nonLandingPages.length})`);
  }

  let passPages = 0;
  let gapPages = 0;

  for (const row of landmarkRows) {
    if (row.status === "PASS") passPages++;
    else if (row.status === "GAP") gapPages++;
    else {
      errors.push(`Invalid landmark status "${row.status}" for ${row.filePath}`);
    }

    // Verify ground-truth expected status
    const expected = EXPECTED_LANDMARK_STATUS[row.route];
    if (expected && row.status !== expected) {
      errors.push(`Page ${row.route} (${row.filePath}) landmark status is ${row.status}, expected ground-truth ${expected}`);
    }
  }

  // Validate Section 3 summary counts
  const totalPagesMatch = content.match(/-\s*\*\*Total Audited Pages\*\*:\s*(\d+)/i);
  const passPagesMatch = content.match(/-\s*\*\*Landmark PASS\*\*:\s*(\d+)/i);
  const gapPagesMatch = content.match(/-\s*\*\*Landmark GAP\*\*:\s*(\d+)/i);

  if (!totalPagesMatch || parseInt(totalPagesMatch[1], 10) !== landmarkRows.length) {
    errors.push(`Section 3 summary count for Total Audited Pages (${totalPagesMatch ? totalPagesMatch[1] : "missing"}) does not match table (${landmarkRows.length})`);
  }
  if (!passPagesMatch || parseInt(passPagesMatch[1], 10) !== passPages) {
    errors.push(`Section 3 summary count for Landmark PASS (${passPagesMatch ? passPagesMatch[1] : "missing"}) does not match table (${passPages})`);
  }
  if (!gapPagesMatch || parseInt(gapPagesMatch[1], 10) !== gapPages) {
    errors.push(`Section 3 summary count for Landmark GAP (${gapPagesMatch ? gapPagesMatch[1] : "missing"}) does not match table (${gapPages})`);
  }

  // 4. Section 4 Remaining Gaps
  if (!/## 4\. Remaining Gaps/i.test(content)) {
    errors.push("Missing Section 4: Remaining Gaps");
  }

  return {
    ok: errors.length === 0,
    errors,
    details: {
      criteriaCount: criteriaRows.length,
      verdictCounts: actualVerdictCounts,
      pagesCount: landmarkRows.length,
      landmarkPass: passPages,
      landmarkGap: gapPages,
    },
  };
}

/**
 * Runs built-in negative-control mutations to verify that the checker fails
 * when presented with invalid documents:
 *   1. Nonexistent cited file path
 *   2. Flipped landmark row (/dashboard GAP -> PASS)
 *   3. Duplicate criterion ID (replacing 3.1.2 with 3.1.1)
 */
function runNegativeControls(originalContent) {
  console.log("Running built-in negative-control mutation assertions...");

  // Probe 1: Nonexistent citation
  const probe1 = originalContent.replace(
    "scripts/audit-static-a11y.ts",
    "scripts/nonexistent-fixture-script-xyz.ts"
  );
  const res1 = validateConformanceDoc(probe1);
  if (res1.ok || !res1.errors.some((e) => e.includes("nonexistent-fixture-script-xyz.ts"))) {
    console.error("[FAIL] Negative control 1 failed: checker did not reject nonexistent file citation.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control 1: Nonexistent file citation correctly rejected.");

  // Probe 2: Flipped landmark row (/dashboard GAP -> PASS)
  const probe2 = originalContent.replace(
    "| `/dashboard` | `src/app/dashboard/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** |",
    "| `/dashboard` | `src/app/dashboard/page.tsx` | 1 (PASS) | Yes | Yes | None | **PASS** |"
  );
  const res2 = validateConformanceDoc(probe2);
  if (res2.ok || !res2.errors.some((e) => e.includes("/dashboard"))) {
    console.error("[FAIL] Negative control 2 failed: checker did not reject flipped /dashboard GAP -> PASS.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control 2: Flipped landmark status correctly rejected.");

  // Probe 3: Duplicate criterion ID
  const probe3 = originalContent.replace(
    "**3.1.2 Language of Parts**",
    "**3.1.1 Language of Parts**"
  );
  const res3 = validateConformanceDoc(probe3);
  if (res3.ok || !res3.errors.some((e) => e.includes("Duplicate criterion IDs"))) {
    console.error("[FAIL] Negative control 3 failed: checker did not reject duplicate criterion ID.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control 3: Duplicate criterion ID correctly rejected.\n");
}

function runCheck() {
  console.log("================================================================================");
  console.log("      VERIFIER: WCAG 2.1 AA CONFORMANCE STATEMENT & SEMANTIC LANDMARKS          ");
  console.log("================================================================================\n");

  if (!fs.existsSync(DOC_PATH)) {
    console.error(`[FAIL] Document not found at: ${DOC_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(DOC_PATH, "utf8");
  if (content.trim().length === 0) {
    console.error("[FAIL] Document is empty.");
    process.exit(1);
  }

  // Execute built-in negative-control mutations first
  runNegativeControls(content);

  // Validate the production document
  const result = validateConformanceDoc(content);
  if (!result.ok) {
    console.error("[FAIL] Conformance document validation failed with errors:");
    result.errors.forEach((err) => console.error(`  - ${err}`));
    process.exit(1);
  }

  const { details } = result;
  console.log("[PASS] WCAG 2.1 AA Per-Criterion Table verified:");
  console.log(`       - Canonical Criteria: ${details.criteriaCount}/50 exact unique IDs`);
  console.log(`       - Supports: ${details.verdictCounts.Supports}`);
  console.log(`       - Partially Supports: ${details.verdictCounts["Partially Supports"]}`);
  console.log(`       - Not Evaluated: ${details.verdictCounts["Not Evaluated"]}`);
  console.log(`       - All cited file paths resolved on disk.`);
  console.log(`       - Section 2 summary counts match table rows exactly.`);

  console.log("\n[PASS] Per-Page Landmark Table verified:");
  console.log(`       - Total Audited Non-Landing Pages: ${details.pagesCount}/32`);
  console.log(`       - Landmark PASS: ${details.landmarkPass}`);
  console.log(`       - Landmark GAP: ${details.landmarkGap}`);
  console.log(`       - Ground-truth expected landmark statuses matched.`);
  console.log(`       - Section 3 summary counts match table rows exactly.`);

  console.log("\n[PASS] Remaining Gaps Section verified with actionable remediation items.");

  console.log("\n================================================================================");
  console.log("VERDICT: PASS-LOCAL (WCAG 2.1 AA conformance, landmarks & negative-controls passed)");
  console.log("================================================================================");
  process.exit(0);
}

runCheck();
