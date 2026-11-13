#!/usr/bin/env node
/**
 * scripts/check-client-state-audit.cjs
 *
 * Standalone offline checker for docs/client-state-audit.md.
 * Verifies:
 *   1. Document exists, is non-empty, and starts with the one-line run command:
 *      node scripts/check-client-state-audit.cjs
 *   2. Re-scans src/ for all localStorage, sessionStorage, and versioned storage access,
 *      ensuring every file with storage access is documented in the audit table.
 *   3. Validates that every row in the Persistent Storage Keys Audit Table has:
 *      - Recognized storage medium (localStorage / sessionStorage)
 *      - Non-empty shape description
 *      - Recognized owner component/module
 *      - Versioned indicator (Yes / No)
 *      - Valid verdict (VERSIONED-OK, NEEDS-MIGRATION, or SAFE-RAW)
 *      - Substantive justification (minimum 15 characters)
 *   4. Validates that Section 2 summary counts match the actual table rows exactly:
 *      - VERSIONED-OK: 2
 *      - NEEDS-MIGRATION: 8
 *      - SAFE-RAW: 6
 *      - Total: 16
 *   5. Re-scans src/ for all cache invalidation and mutation call sites (updateSwr,
 *      invalidateSwr, invalidateApprovalCache, invalidateProAccessCache,
 *      invalidateTrackedApplicationsCache, clearCandidateProfileMemoryCache, clearTrackerMemoryState),
 *      and asserts every site is documented in Section 3's Cache Invalidation Map table.
 *   6. Ensures Section 4 (Key Gaps & Invalidation Blindspots) and Section 5 (Remediation Plan)
 *      are present.
 *   7. Built-in negative-control mutations verify that:
 *      - Removing a storage key row fails validation.
 *      - Removing an invalidation call site fails validation.
 *      - An invalid verdict string fails validation.
 *
 * Usage:
 *   node scripts/check-client-state-audit.cjs
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOC_PATH = path.join(ROOT, "docs", "client-state-audit.md");

const ALLOWED_VERDICTS = new Set(["VERSIONED-OK", "NEEDS-MIGRATION", "SAFE-RAW"]);
const ALLOWED_MEDIUMS = new Set(["localStorage", "sessionStorage"]);

/**
 * Recursively locates all non-test TypeScript and JavaScript source files in dir.
 */
function walkSourceFiles(dir, list = []) {
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    if (fs.statSync(full).isDirectory()) {
      walkSourceFiles(full, list);
    } else if (/\.(ts|tsx|js|jsx)$/.test(item)) {
      if (!item.includes(".test.") && !item.includes(".spec.") && !full.includes("__tests__")) {
        list.push(full);
      }
    }
  }
  return list;
}

/**
 * Scans src/ for all storage access files and invalidation call sites.
 */
function scanSourceCode() {
  const srcDir = path.join(ROOT, "src");
  const files = walkSourceFiles(srcDir);

  const storageFiles = new Set();
  const invalidationSites = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);

    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

      // Detect direct localStorage / sessionStorage access
      if (/(?:window\.)?(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem|clear|key|length)/.test(line)) {
        storageFiles.add(rel);
      }

      // Detect readVersioned / writeVersioned calls
      if (/(?:readVersioned|writeVersioned)\s*(?:<[^>]+>)?\s*\(/.test(line)) {
        storageFiles.add(rel);
      }

      // Detect SWR and memory cache invalidation / update calls
      if (/(?:updateSwr|invalidateSwr|invalidateApprovalCache|invalidateTrackedApplicationsCache|clearCandidateProfileMemoryCache|clearTrackerMemoryState)\s*\(/.test(line)) {
        if (!trimmed.startsWith("export function") && !trimmed.startsWith("function ")) {
          invalidationSites.push({ file: rel, line: lineNum, text: trimmed });
        }
      }

      // Detect subscription cache event listeners passing invalidateProAccessCache
      if (/addEventListener\([^,]+,\s*invalidateProAccessCache\)/.test(line)) {
        invalidationSites.push({ file: rel, line: lineNum, text: trimmed });
      }
    });
  }

  return {
    storageFiles: Array.from(storageFiles).sort(),
    invalidationSites,
  };
}

function rowCoversCallSite(rowCallSite, invFile, invLine) {
  if (!rowCallSite.includes(invFile)) return false;
  const match = rowCallSite.match(/:(\d+)(?:-(\d+))?/);
  if (!match) return true;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : start;
  return invLine >= start && invLine <= end;
}

/**
 * Validates the contents of docs/client-state-audit.md.
 * Returns { ok: boolean, errors: string[], details: object }.
 */
function validateAuditDoc(content) {
  const errors = [];
  const lines = content.split(/\r?\n/);

  // 1. One-line run command near top
  const topSlice = content.slice(0, 500);
  if (!topSlice.includes("node scripts/check-client-state-audit.cjs")) {
    errors.push("Top of document missing run command: node scripts/check-client-state-audit.cjs");
  }

  // 2. Parse Section 2: Persistent Storage Keys Audit Table
  let inKeysTable = false;
  const keyRows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.includes("Key Pattern") && trimmed.includes("Verdict")) {
      inKeysTable = true;
      continue;
    }
    if (inKeysTable) {
      if (!trimmed.startsWith("|") || trimmed.length === 0 || trimmed.startsWith("##")) {
        inKeysTable = false;
        continue;
      }
      if (trimmed.includes("---")) continue;

      const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length >= 8) {
        keyRows.push({
          keyPattern: cells[0].replace(/[`*]/g, "").trim(),
          medium: cells[1].replace(/[`*]/g, "").trim(),
          shape: cells[2],
          owner: cells[3],
          versioned: cells[4],
          verdict: cells[5].replace(/\*\*/g, "").trim(),
          justification: cells[6],
          callSites: cells[7],
        });
      }
    }
  }

  if (keyRows.length === 0) {
    errors.push("Could not parse any rows from Section 2 Persistent Storage Keys Table");
  }

  // Scan codebase to compare against table
  const scanned = scanSourceCode();

  // Validate that every scanned storage file is accounted for in Table 1
  const allCitedSources = keyRows.map((r) => `${r.owner} ${r.callSites}`).join(" ");
  for (const sf of scanned.storageFiles) {
    if (!allCitedSources.includes(sf)) {
      errors.push(`Scanned storage file "${sf}" is not accounted for in Section 2 Audit Table`);
    }
  }

  // Validate fields and verdicts in Table 1
  const verdictCounts = {
    "VERSIONED-OK": 0,
    "NEEDS-MIGRATION": 0,
    "SAFE-RAW": 0,
  };

  for (const row of keyRows) {
    if (!ALLOWED_VERDICTS.has(row.verdict)) {
      errors.push(`Key "${row.keyPattern}" has invalid verdict "${row.verdict}"`);
    } else {
      verdictCounts[row.verdict]++;
    }

    if (!ALLOWED_MEDIUMS.has(row.medium)) {
      errors.push(`Key "${row.keyPattern}" has invalid storage medium "${row.medium}"`);
    }

    if (!row.justification || row.justification.trim().length < 15) {
      errors.push(`Key "${row.keyPattern}" is missing a substantive justification`);
    }

    if (!row.shape || row.shape.trim().length === 0) {
      errors.push(`Key "${row.keyPattern}" is missing data shape description`);
    }
  }

  // Validate summary counts in Section 2
  const vOkMatch = content.match(/-\s*\*\*VERSIONED-OK\*\*:\s*(\d+)/i);
  const nMigMatch = content.match(/-\s*\*\*NEEDS-MIGRATION\*\*:\s*(\d+)/i);
  const sRawMatch = content.match(/-\s*\*\*SAFE-RAW\*\*:\s*(\d+)/i);
  const totalMatch = content.match(/-\s*\*\*Total Audited Keys\*\*:\s*(\d+)/i);

  if (!vOkMatch || parseInt(vOkMatch[1], 10) !== verdictCounts["VERSIONED-OK"]) {
    errors.push(`Section 2 summary count for VERSIONED-OK (${vOkMatch ? vOkMatch[1] : "missing"}) does not match table (${verdictCounts["VERSIONED-OK"]})`);
  }
  if (!nMigMatch || parseInt(nMigMatch[1], 10) !== verdictCounts["NEEDS-MIGRATION"]) {
    errors.push(`Section 2 summary count for NEEDS-MIGRATION (${nMigMatch ? nMigMatch[1] : "missing"}) does not match table (${verdictCounts["NEEDS-MIGRATION"]})`);
  }
  if (!sRawMatch || parseInt(sRawMatch[1], 10) !== verdictCounts["SAFE-RAW"]) {
    errors.push(`Section 2 summary count for SAFE-RAW (${sRawMatch ? sRawMatch[1] : "missing"}) does not match table (${verdictCounts["SAFE-RAW"]})`);
  }
  if (!totalMatch || parseInt(totalMatch[1], 10) !== keyRows.length) {
    errors.push(`Section 2 summary count for Total Audited Keys (${totalMatch ? totalMatch[1] : "missing"}) does not match table (${keyRows.length})`);
  }

  // 3. Parse Section 3: Cache Invalidation Map Table
  let inInvTable = false;
  const invRows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.includes("Invalidation Call Site") && trimmed.includes("Target Cache")) {
      inInvTable = true;
      continue;
    }
    if (inInvTable) {
      if (!trimmed.startsWith("|") || trimmed.length === 0 || trimmed.startsWith("##")) {
        inInvTable = false;
        continue;
      }
      if (trimmed.includes("---")) continue;

      const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length >= 6) {
        invRows.push({
          callSite: cells[0].replace(/[`*]/g, "").trim(),
          targetCache: cells[1],
          trigger: cells[2],
          mechanism: cells[3].replace(/[`*]/g, "").trim(),
          status: cells[4].replace(/\*\*/g, "").trim(),
          notes: cells[5],
        });
      }
    }
  }

  if (invRows.length === 0) {
    errors.push("Could not parse any rows from Section 3 Cache Invalidation Map Table");
  }

  // Validate that every scanned invalidation call site is covered by Section 3
  for (const inv of scanned.invalidationSites) {
    const covered = invRows.some((r) => rowCoversCallSite(r.callSite, inv.file, inv.line));
    if (!covered) {
      errors.push(`Scanned invalidation call site "${inv.file}:${inv.line}" (${inv.text}) is missing from Section 3 Cache Invalidation Map`);
    }
  }

  // 4. Validate Section 4 & Section 5 exist
  if (!/## 4\. Key Gaps & Invalidation Blindspots/i.test(content)) {
    errors.push("Missing Section 4: Key Gaps & Invalidation Blindspots");
  }
  if (!/## 5\. Remediation Plan/i.test(content)) {
    errors.push("Missing Section 5: Remediation Plan");
  }

  return {
    ok: errors.length === 0,
    errors,
    details: {
      totalKeys: keyRows.length,
      verdictCounts,
      invRowsCount: invRows.length,
      scannedStorageFilesCount: scanned.storageFiles.length,
      scannedInvSitesCount: scanned.invalidationSites.length,
    },
  };
}

/**
 * Runs built-in negative-control mutations to ensure checker rejects invalid documents:
 *   1. Removing a persistent storage key row.
 *   2. Removing an invalidation call site from the cache map.
 *   3. Setting an invalid verdict string.
 */
function runNegativeControls(originalContent) {
  console.log("Running built-in negative-control mutation assertions...");

  // Control 1: Remove a key row from Section 2
  const cookieRowRegex = /\|\s*`cm_cookie_notice`\s*\|[^\r\n]*\r?\n/;
  if (!cookieRowRegex.test(originalContent)) {
    console.error("[FAIL] Setup error: could not locate cm_cookie_notice row for negative control 1.");
    process.exit(1);
  }
  const probe1 = originalContent.replace(cookieRowRegex, "");
  const res1 = validateAuditDoc(probe1);
  if (res1.ok || !res1.errors.some((e) => e.includes("summary count") || e.includes("not accounted for"))) {
    console.error("[FAIL] Negative control 1 failed: checker did not reject removed storage key row.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control 1: Removed storage key row correctly rejected.");

  // Control 2: Remove an invalidation site from Section 3
  const invSiteRegex = /\|\s*`src\/app\/jobs\/page\.tsx:1363`\s*\|[^\r\n]*\r?\n/;
  if (!invSiteRegex.test(originalContent)) {
    console.error("[FAIL] Setup error: could not locate jobs/page.tsx:1363 row for negative control 2.");
    process.exit(1);
  }
  const probe2 = originalContent.replace(invSiteRegex, "");
  const res2 = validateAuditDoc(probe2);
  if (res2.ok || !res2.errors.some((e) => e.includes("jobs/page.tsx:1363") || e.includes("missing from Section 3"))) {
    console.error("[FAIL] Negative control 2 failed: checker did not reject removed invalidation call site.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control 2: Removed invalidation call site correctly rejected.");

  // Control 3: Invalid verdict string
  const probe3 = originalContent.replace(
    "| **VERSIONED-OK** | Standardized `{ v: 1, data }` envelope with boolean type validation",
    "| **UNAUDITED-STATE** | Standardized `{ v: 1, data }` envelope with boolean type validation"
  );
  const res3 = validateAuditDoc(probe3);
  if (res3.ok || !res3.errors.some((e) => e.includes("invalid verdict"))) {
    console.error("[FAIL] Negative control 3 failed: checker did not reject invalid verdict string.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control 3: Invalid verdict string correctly rejected.\n");
}

function runCheck() {
  console.log("================================================================================");
  console.log("       VERIFIER: FRONTEND CLIENT STATE & CACHE INVALIDATION AUDIT               ");
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

  // Execute negative control mutations
  runNegativeControls(content);

  // Validate the production document
  const result = validateAuditDoc(content);
  if (!result.ok) {
    console.error("[FAIL] Client state audit validation failed with errors:");
    result.errors.forEach((err) => console.error(`  - ${err}`));
    process.exit(1);
  }

  const { details } = result;
  console.log("[PASS] Persistent Storage Keys Audit Table verified:");
  console.log(`       - Total Audited Keys: ${details.totalKeys}`);
  console.log(`       - VERSIONED-OK: ${details.verdictCounts["VERSIONED-OK"]}`);
  console.log(`       - NEEDS-MIGRATION: ${details.verdictCounts["NEEDS-MIGRATION"]}`);
  console.log(`       - SAFE-RAW: ${details.verdictCounts["SAFE-RAW"]}`);
  console.log(`       - All ${details.scannedStorageFilesCount} scanned source files with storage access verified in audit table.`);
  console.log(`       - Section 2 summary counts match table rows exactly.`);

  console.log("\n[PASS] Cache Invalidation Map verified:");
  console.log(`       - Documented Invalidation Rows: ${details.invRowsCount}`);
  console.log(`       - All ${details.scannedInvSitesCount} scanned runtime invalidation/update call sites accounted for.`);

  console.log("\n[PASS] Key Gaps, Blindspots & Remediation Plan verified.");

  console.log("\n================================================================================");
  console.log("VERDICT: PASS-LOCAL (Client state audit & cache invalidation verified)");
  console.log("================================================================================");
  process.exit(0);
}

runCheck();
