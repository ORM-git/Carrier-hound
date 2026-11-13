/**
 * scripts/check-wcag-landmarks.cjs
 *
 * Standalone offline checker for docs/wcag-aa-conformance.md.
 * Verifies:
 *   1. docs/wcag-aa-conformance.md exists and is non-empty.
 *   2. Includes the one-line run command at the top.
 *   3. Contains the full WCAG 2.1 AA per-criterion table with only allowed verdicts
 *      ("Supports", "Partially Supports", "Not Evaluated") and evidence citations.
 *   4. Contains the per-page landmark audit table covering all 32 non-landing pages
 *      with strict PASS/GAP verdicts and identified gaps.
 *   5. Contains the "Remaining Gaps" section.
 *
 * Usage:
 *   node scripts/check-wcag-landmarks.cjs
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOC_PATH = path.join(ROOT, "docs", "wcag-aa-conformance.md");

const ALLOWED_VERDICTS = new Set(["Supports", "Partially Supports", "Not Evaluated"]);

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

function runCheck() {
  console.log("================================================================================");
  console.log("            STANDALONE CHECKER: WCAG 2.1 AA CONFORMANCE & LANDMARKS DOC         ");
  console.log("================================================================================\n");

  // 1. Doc exists
  if (!fs.existsSync(DOC_PATH)) {
    console.error(`[FAIL] Document not found at: ${DOC_PATH}`);
    process.exit(1);
  }
  console.log(`[PASS] Conformance document exists: docs/wcag-aa-conformance.md`);

  const content = fs.readFileSync(DOC_PATH, "utf8");
  if (content.trim().length === 0) {
    console.error("[FAIL] Document is empty.");
    process.exit(1);
  }

  // 2. Check for one-line run command near top
  const topSlice = content.slice(0, 500);
  if (!topSlice.includes("node scripts/check-wcag-landmarks.cjs")) {
    console.error("[FAIL] Top of document missing one-line run command: node scripts/check-wcag-landmarks.cjs");
    process.exit(1);
  }
  console.log(`[PASS] Run command documented at top of file.`);

  // 3. Verify WCAG 2.1 AA Per-Criterion Table
  const lines = content.split("\n");
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
      if (trimmed.includes("---")) continue; // separator line

      const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length >= 4) {
        // [Criterion, Level, Verdict, Evidence]
        criteriaRows.push({
          criterion: cells[0],
          level: cells[1],
          verdict: cells[2],
          evidence: cells[3],
        });
      }
    }
  }

  if (criteriaRows.length < 50) {
    console.error(`[FAIL] Expected at least 50 WCAG 2.1 AA criteria rows, found ${criteriaRows.length}`);
    process.exit(1);
  }

  const verdictCounts = {
    Supports: 0,
    "Partially Supports": 0,
    "Not Evaluated": 0,
    Invalid: 0,
  };

  const invalidRows = [];
  for (const row of criteriaRows) {
    // Strip bolding or formatting from verdict
    const cleanVerdict = row.verdict.replace(/\*\*/g, "").trim();
    if (!ALLOWED_VERDICTS.has(cleanVerdict)) {
      verdictCounts.Invalid++;
      invalidRows.push(`${row.criterion}: invalid verdict "${cleanVerdict}"`);
    } else {
      verdictCounts[cleanVerdict]++;
    }

    if (cleanVerdict !== "Not Evaluated" && (!row.evidence || row.evidence === "None" || row.evidence === "-")) {
      invalidRows.push(`${row.criterion}: ${cleanVerdict} missing evidence link/citation`);
    }
  }

  if (invalidRows.length > 0) {
    console.error(`[FAIL] Criteria table validation errors:\n  ${invalidRows.join("\n  ")}`);
    process.exit(1);
  }

  console.log(`[PASS] WCAG 2.1 AA Per-Criterion Table verified:`);
  console.log(`       - Total Criteria: ${criteriaRows.length}`);
  console.log(`       - Supports: ${verdictCounts.Supports}`);
  console.log(`       - Partially Supports: ${verdictCounts["Partially Supports"]}`);
  console.log(`       - Not Evaluated: ${verdictCounts["Not Evaluated"]}`);

  // 4. Verify Per-Page Landmarks Table
  const allAppPages = getAllAppPages(path.join(ROOT, "src", "app"));
  const nonLandingPages = allAppPages
    .filter((p) => !p.endsWith("src/app/page.tsx"))
    .map((p) => p.replace(ROOT.replace(/\\/g, "/") + "/", ""))
    .sort();

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
        // [Page Route, File Path, Main Landmark, Banner Header, Labeled Nav, Complementary Regions, Landmark Status, Identified GAPs]
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

  if (landmarkRows.length !== nonLandingPages.length) {
    console.error(`[FAIL] Landmark table row count (${landmarkRows.length}) does not match non-landing pages (${nonLandingPages.length})`);
    process.exit(1);
  }

  const landmarkFiles = new Set(landmarkRows.map((r) => r.filePath));
  const missingPages = nonLandingPages.filter((p) => !landmarkFiles.has(p));
  if (missingPages.length > 0) {
    console.error(`[FAIL] Landmark table missing pages:\n  ${missingPages.join("\n  ")}`);
    process.exit(1);
  }

  let passPages = 0;
  let gapPages = 0;
  for (const row of landmarkRows) {
    if (row.status === "PASS") passPages++;
    else if (row.status === "GAP") gapPages++;
    else {
      console.error(`[FAIL] Invalid landmark status "${row.status}" for ${row.filePath}`);
      process.exit(1);
    }
  }

  console.log(`[PASS] Landmark Table verified across all ${nonLandingPages.length} non-landing pages:`);
  console.log(`       - Landmark PASS: ${passPages}`);
  console.log(`       - Landmark GAP: ${gapPages}`);

  // 5. Remaining Gaps section exists
  if (!/Remaining Gaps/i.test(content)) {
    console.error("[FAIL] Document missing 'Remaining Gaps' section.");
    process.exit(1);
  }
  console.log(`[PASS] 'Remaining Gaps' section verified.`);

  console.log("\n================================================================================");
  console.log("VERDICT: PASS-LOCAL (All conformance and landmark doc assertions passed)");
  console.log("================================================================================");
  process.exit(0);
}

runCheck();
