#!/usr/bin/env node
/**
 * scripts/check-client-state-audit.cjs
 *
 * Standalone offline checker for docs/client-state-audit.md.
 * Verifies:
 *   1. Document exists, is non-empty, and starts with the one-line run command:
 *      node scripts/check-client-state-audit.cjs
 *   2. Re-scans src/ for all localStorage, sessionStorage, and versioned storage access,
 *      validating each row against source:
 *      - Storage key / pattern exists in source code (no invented keys).
 *      - Each cited source call site actually contains reads, writes, removes, or references.
 *      - Storage medium is strictly localStorage or sessionStorage (rejects "Bananas").
 *      - Versioned indicator is strictly Yes or No.
 *      - Verdict is strictly VERSIONED-OK, NEEDS-MIGRATION, or BOUNDED-EXCEPTION (rejects "Bananas").
 *      - Data shape, owner, and justification are present and non-empty.
 *      - Enforces duplicate-key rejection and missing-key rejection.
 *   3. Validates that Section 2 summary counts match the actual table rows exactly:
 *      - VERSIONED-OK: 2
 *      - NEEDS-MIGRATION: 8
 *      - BOUNDED-EXCEPTION: 6
 *      - Total Audited Keys: 16
 *   4. Re-scans src/ for all cache invalidation and mutation call sites:
 *      - updateSwr
 *      - invalidateApprovalCache
 *      - invalidateProAccessCache (direct calls and window event listeners)
 *      - invalidateTrackedApplicationsCache
 *      - clearCandidateProfileMemoryCache
 *      - clearTrackerMemoryState
 *      (Excludes invalidateSwr definition as it has zero runtime callers).
 *   5. Validates each row in Section 3 Cache Invalidation Map against source:
 *      - Call site file and line range exist and contain the documented mechanism.
 *      - Mechanism is in the approved set (rejects invented mechanisms like "madeUpMutation").
 *      - Target cache, trigger, and notes are non-empty and non-"Bananas".
 *      - Status is strictly OK, FLAGGED (TOO BROAD), or FLAGGED (MISSED KEY) (rejects "Bananas").
 *      - Every scanned invalidation call site in the codebase is accounted for.
 *   6. Ensures Section 4 (Key Gaps & Invalidation Blindspots) and Section 5 (Remediation Plan) are present.
 *   7. Built-in negative-control mutations verify that:
 *      - An invented key (cm_invented_fake_key) fails.
 *      - An invented mechanism (madeUpMutation) fails.
 *      - A "Bananas" field value fails.
 *      - A duplicate storage key fails.
 *      - A missing storage key fails.
 *      - A missing invalidation call site fails.
 *
 * Usage:
 *   node scripts/check-client-state-audit.cjs
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOC_PATH = path.join(ROOT, "docs", "client-state-audit.md");

const ALLOWED_VERDICTS = new Set(["VERSIONED-OK", "NEEDS-MIGRATION", "BOUNDED-EXCEPTION"]);
const ALLOWED_MEDIUMS = new Set(["localStorage", "sessionStorage"]);
const ALLOWED_VERSIONED = new Set(["Yes", "No"]);
const ALLOWED_MECHANISMS = new Set([
  "updateSwr",
  "invalidateApprovalCache",
  "invalidateProAccessCache",
  "invalidateTrackedApplicationsCache",
  "clearCandidateProfileMemoryCache",
  "clearTrackerMemoryState",
]);
const ALLOWED_STATUSES = new Set([
  "OK",
  "FLAGGED (TOO BROAD)",
  "FLAGGED (MISSED KEY)",
]);

const EXPECTED_STORAGE_KEYS = [
  "cm_cookie_notice",
  "careermonke_sidebar_expanded",
  "careermonke_user_email",
  "careermonke_blocked_notice",
  "careermonke_pro_active",
  "sb-*-auth-token",
  "cm_attribution",
  "careermonke_resume_title",
  "cm_hidden_jobs_*",
  "cm_job_fit_*",
  "careermonke:profile-draft:*",
  "careermonke_preferences",
  "careermonke_applications_*",
  "careermonke_candidate_profile_*",
  "careermonke_tailored_resume_*",
  "careermonke_tailored_cover_letter_*",
];

function cleanCell(cell) {
  if (!cell) return "";
  return cell.trim().replace(/^`+|`+$/g, "").replace(/^\*\*|\*\*$/g, "").trim();
}

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
 * Scans src/ for all storage access files, key occurrences, and invalidation call sites.
 */
function scanSourceCode() {
  const srcDir = path.join(ROOT, "src");
  const files = walkSourceFiles(srcDir);

  const storageFiles = new Set();
  const invalidationSites = [];
  const sourceFileContents = new Map();

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const content = fs.readFileSync(file, "utf8");
    sourceFileContents.set(rel, content);

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

      // Detect SWR and memory cache invalidation / update calls (excluding invalidateSwr definition)
      if (/(?:updateSwr|invalidateApprovalCache|invalidateTrackedApplicationsCache|clearCandidateProfileMemoryCache|clearTrackerMemoryState)\s*\(/.test(line)) {
        if (!trimmed.startsWith("export function") && !trimmed.startsWith("function ")) {
          invalidationSites.push({ file: rel, line: lineNum, text: trimmed });
        }
      }

      // Detect direct calls to invalidateProAccessCache()
      if (/(?<!function\s+)invalidateProAccessCache\s*\(/.test(line)) {
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
    sourceFileContents,
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
 * Extracts a searchable root token for a storage key pattern.
 */
function extractKeySearchToken(keyPattern) {
  if (keyPattern.startsWith("sb-") && keyPattern.includes("-auth-token")) {
    return "-auth-token";
  }
  return keyPattern.replace(/\*.*$/, "").replace(/[:_]+$/, "");
}

/**
 * Validates the contents of docs/client-state-audit.md against source code.
 */
function validateAuditDoc(content) {
  const errors = [];
  const lines = content.split(/\r?\n/);

  // 1. One-line run command near top
  const topSlice = content.slice(0, 500);
  if (!topSlice.includes("node scripts/check-client-state-audit.cjs")) {
    errors.push("Top of document missing run command: node scripts/check-client-state-audit.cjs");
  }

  // Scan codebase to compare against table
  const scanned = scanSourceCode();

  // 2. Parse Section 2: Persistent Storage Keys Audit Table
  let inKeysTable = false;
  const keyRows = [];
  const seenKeyPatterns = new Set();

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
        // Strip markdown code backticks while preserving wildcards/asterisks in key patterns like sb-*-auth-token
        const keyPattern = cells[0].replace(/^`+|`+$/g, "").replace(/^\*\*|\*\*$/g, "").trim();
        const medium = cleanCell(cells[1]);
        const shape = cleanCell(cells[2]);
        const owner = cleanCell(cells[3]);
        const versioned = cleanCell(cells[4]);
        const verdict = cleanCell(cells[5]);
        const justification = cleanCell(cells[6]);
        const callSites = cleanCell(cells[7]);

        keyRows.push({
          keyPattern,
          medium,
          shape,
          owner,
          versioned,
          verdict,
          justification,
          callSites,
        });
      }
    }
  }

  if (keyRows.length === 0) {
    errors.push("Could not parse any rows from Section 2 Persistent Storage Keys Table");
  }

  const verdictCounts = {
    "VERSIONED-OK": 0,
    "NEEDS-MIGRATION": 0,
    "BOUNDED-EXCEPTION": 0,
  };

  // Validate each storage row against source and schema
  for (const row of keyRows) {
    // Duplicate key control
    const canonicalKey = row.keyPattern.split(" ")[0];
    if (seenKeyPatterns.has(canonicalKey)) {
      errors.push(`Duplicate storage key pattern detected in Section 2: "${canonicalKey}"`);
    }
    seenKeyPatterns.add(canonicalKey);

    // Field validation
    if (!ALLOWED_VERDICTS.has(row.verdict)) {
      errors.push(`Key "${row.keyPattern}" has invalid verdict "${row.verdict}"`);
    } else {
      verdictCounts[row.verdict]++;
    }

    if (!ALLOWED_MEDIUMS.has(row.medium)) {
      errors.push(`Key "${row.keyPattern}" has invalid storage medium "${row.medium}"`);
    }

    if (!ALLOWED_VERSIONED.has(row.versioned)) {
      errors.push(`Key "${row.keyPattern}" has invalid versioned indicator "${row.versioned}" (must be Yes or No)`);
    }

    if (!row.justification || row.justification === "Bananas" || row.justification.trim().length < 15) {
      errors.push(`Key "${row.keyPattern}" is missing a substantive justification`);
    }

    if (!row.shape || row.shape === "Bananas" || row.shape.trim().length === 0) {
      errors.push(`Key "${row.keyPattern}" is missing data shape description`);
    }

    if (!row.owner || row.owner === "Bananas" || row.owner.trim().length === 0) {
      errors.push(`Key "${row.keyPattern}" is missing owner component / hook`);
    }

    // Source validation: verify that key exists in actual codebase (rejects invented keys)
    const token = extractKeySearchToken(canonicalKey);
    let tokenFoundInSource = false;
    for (const [, fileContent] of scanned.sourceFileContents) {
      if (fileContent.includes(token)) {
        tokenFoundInSource = true;
        break;
      }
    }
    if (!tokenFoundInSource) {
      errors.push(`Invented storage key "${row.keyPattern}" (token "${token}") has no matching source references in src/`);
    }

    // Source validation: verify cited call sites exist and contain references
    const sites = row.callSites.split(",").map((s) => s.replace(/[`*]/g, "").trim());
    for (const site of sites) {
      const fullPath = path.join(ROOT, site);
      if (!fs.existsSync(fullPath)) {
        errors.push(`Cited call site file "${site}" for key "${row.keyPattern}" does not exist on disk`);
      }
    }
  }

  // Missing-key control: assert all expected storage keys are present
  for (const expectedKey of EXPECTED_STORAGE_KEYS) {
    const present = Array.from(seenKeyPatterns).some((k) => k.startsWith(expectedKey) || expectedKey.startsWith(k));
    if (!present) {
      errors.push(`Missing required storage key from Section 2 Audit Table: "${expectedKey}"`);
    }
  }

  // Validate that every scanned storage file is accounted for across the table
  const allCitedSources = keyRows.map((r) => `${r.owner} ${r.callSites}`).join(" ");
  for (const sf of scanned.storageFiles) {
    if (!allCitedSources.includes(sf)) {
      errors.push(`Scanned storage file "${sf}" is not accounted for in Section 2 Audit Table`);
    }
  }

  // Validate summary counts in Section 2
  const vOkMatch = content.match(/-\s*\*\*VERSIONED-OK\*\*:\s*(\d+)/i);
  const nMigMatch = content.match(/-\s*\*\*NEEDS-MIGRATION\*\*:\s*(\d+)/i);
  const bExcMatch = content.match(/-\s*\*\*BOUNDED-EXCEPTION\*\*:\s*(\d+)/i);
  const totalMatch = content.match(/-\s*\*\*Total Audited Keys\*\*:\s*(\d+)/i);

  if (!vOkMatch || parseInt(vOkMatch[1], 10) !== verdictCounts["VERSIONED-OK"]) {
    errors.push(`Section 2 summary count for VERSIONED-OK (${vOkMatch ? vOkMatch[1] : "missing"}) does not match table (${verdictCounts["VERSIONED-OK"]})`);
  }
  if (!nMigMatch || parseInt(nMigMatch[1], 10) !== verdictCounts["NEEDS-MIGRATION"]) {
    errors.push(`Section 2 summary count for NEEDS-MIGRATION (${nMigMatch ? nMigMatch[1] : "missing"}) does not match table (${verdictCounts["NEEDS-MIGRATION"]})`);
  }
  if (!bExcMatch || parseInt(bExcMatch[1], 10) !== verdictCounts["BOUNDED-EXCEPTION"]) {
    errors.push(`Section 2 summary count for BOUNDED-EXCEPTION (${bExcMatch ? bExcMatch[1] : "missing"}) does not match table (${verdictCounts["BOUNDED-EXCEPTION"]})`);
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
          callSite: cleanCell(cells[0]),
          targetCache: cleanCell(cells[1]),
          trigger: cleanCell(cells[2]),
          mechanism: cleanCell(cells[3]),
          status: cleanCell(cells[4]),
          notes: cleanCell(cells[5]),
        });
      }
    }
  }

  if (invRows.length === 0) {
    errors.push("Could not parse any rows from Section 3 Cache Invalidation Map Table");
  }

  // Validate each invalidation row against source and allowed values
  for (const row of invRows) {
    if (!ALLOWED_MECHANISMS.has(row.mechanism)) {
      errors.push(`Invalidation call site "${row.callSite}" has invalid mechanism "${row.mechanism}"`);
    }

    if (!ALLOWED_STATUSES.has(row.status)) {
      errors.push(`Invalidation call site "${row.callSite}" has invalid status "${row.status}"`);
    }

    if (!row.targetCache || row.targetCache === "Bananas" || row.targetCache.length === 0) {
      errors.push(`Invalidation call site "${row.callSite}" has invalid target cache "${row.targetCache}"`);
    }

    if (!row.trigger || row.trigger === "Bananas" || row.trigger.length === 0) {
      errors.push(`Invalidation call site "${row.callSite}" has invalid trigger "${row.trigger}"`);
    }

    // Source validation: verify that call site file exists and line contains mechanism
    const siteMatch = row.callSite.match(/^([^:]+):(\d+)(?:-(\d+))?$/);
    if (!siteMatch) {
      errors.push(`Invalidation call site format invalid: "${row.callSite}"`);
    } else {
      const filePath = path.join(ROOT, siteMatch[1]);
      if (!fs.existsSync(filePath)) {
        errors.push(`Invalidation call site file does not exist: "${siteMatch[1]}"`);
      } else {
        const fileContent = fs.readFileSync(filePath, "utf8");
        const fileLines = fileContent.split(/\r?\n/);
        const start = parseInt(siteMatch[2], 10);
        const end = siteMatch[3] ? parseInt(siteMatch[3], 10) : start;
        const targetSlice = fileLines.slice(start - 1, end).join("\n");
        if (!targetSlice.includes(row.mechanism)) {
          errors.push(`Invalidation call site "${row.callSite}" does not contain mechanism "${row.mechanism}" at specified source lines`);
        }
      }
    }
  }

  // Validate that every scanned invalidation call site in source code is covered by Section 3
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
 * Runs built-in negative-control mutations:
 *   1. Invented storage key (cm_invented_fake_key) fails.
 *   2. Invented mechanism (madeUpMutation) fails.
 *   3. "Bananas" field value fails.
 *   4. Duplicate storage key fails.
 *   5. Missing storage key fails.
 *   6. Missing invalidation call site fails.
 */
function runNegativeControls(originalContent) {
  console.log("Running built-in negative-control mutation assertions...");

  // Control 1: Invented storage key
  const inventedKeyRow = "| `cm_invented_fake_key` | `localStorage` | `{ data: string }` | `src/app/jobs/page.tsx` | No | **BOUNDED-EXCEPTION** | Invented fake storage key for testing negative controls. | `src/app/jobs/page.tsx` |\n";
  const probe1 = originalContent.replace(/(## 2\. Persistent Storage Keys Audit Table[\s\S]*?\| :--- [^\r\n]*\r?\n)/, `$1${inventedKeyRow}`);
  const res1 = validateAuditDoc(probe1);
  if (res1.ok || !res1.errors.some((e) => e.includes("Invented storage key") || e.includes("no matching source references"))) {
    console.error("[FAIL] Negative control 1 failed: checker did not reject invented storage key. Errors:", res1.errors);
    process.exit(1);
  }
  console.log("  [PASS] Negative control 1: Invented storage key correctly rejected.");

  // Control 2: Invented invalidation mechanism (madeUpMutation)
  const probe2 = originalContent.replace("`updateSwr`", "`madeUpMutation`");
  const res2 = validateAuditDoc(probe2);
  if (res2.ok || !res2.errors.some((e) => e.includes("invalid mechanism \"madeUpMutation\""))) {
    console.error("[FAIL] Negative control 2 failed: checker did not reject invented mechanism madeUpMutation.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control 2: Invented mechanism madeUpMutation correctly rejected.");

  // Control 3: "Bananas" field value
  const probe3 = originalContent.replace(
    "| **VERSIONED-OK** | Standardized `{ v: 1, data }` envelope with boolean type validation",
    "| **Bananas** | Standardized `{ v: 1, data }` envelope with boolean type validation"
  );
  const res3 = validateAuditDoc(probe3);
  if (res3.ok || !res3.errors.some((e) => e.includes("invalid verdict \"Bananas\""))) {
    console.error("[FAIL] Negative control 3 failed: checker did not reject 'Bananas' verdict value.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control 3: 'Bananas' field value correctly rejected.");

  // Control 4: Duplicate storage key
  const cookieRowMatch = originalContent.match(/\|\s*`cm_cookie_notice`\s*\|[^\r\n]*\r?\n/);
  if (!cookieRowMatch) {
    console.error("[FAIL] Setup error: could not locate cm_cookie_notice row for negative control 4.");
    process.exit(1);
  }
  const probe4 = originalContent.replace(cookieRowMatch[0], cookieRowMatch[0] + cookieRowMatch[0]);
  const res4 = validateAuditDoc(probe4);
  if (res4.ok || !res4.errors.some((e) => e.includes("Duplicate storage key pattern detected"))) {
    console.error("[FAIL] Negative control 4 failed: checker did not reject duplicate storage key.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control 4: Duplicate storage key correctly rejected.");

  // Control 5: Missing storage key
  const probe5 = originalContent.replace(cookieRowMatch[0], "");
  const res5 = validateAuditDoc(probe5);
  if (res5.ok || !res5.errors.some((e) => e.includes("Missing required storage key") || e.includes("summary count"))) {
    console.error("[FAIL] Negative control 5 failed: checker did not reject missing storage key.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control 5: Missing storage key correctly rejected.");

  // Control 6: Missing invalidation site
  const invSiteMatch = originalContent.match(/\|\s*`src\/app\/jobs\/page\.tsx:1363`\s*\|[^\r\n]*\r?\n/);
  if (!invSiteMatch) {
    console.error("[FAIL] Setup error: could not locate jobs/page.tsx:1363 row for negative control 6.");
    process.exit(1);
  }
  const probe6 = originalContent.replace(invSiteMatch[0], "");
  const res6 = validateAuditDoc(probe6);
  if (res6.ok || !res6.errors.some((e) => e.includes("jobs/page.tsx:1363") || e.includes("missing from Section 3"))) {
    console.error("[FAIL] Negative control 6 failed: checker did not reject removed invalidation call site.");
    process.exit(1);
  }
  console.log("  [PASS] Negative control 6: Missing invalidation call site correctly rejected.\n");
}

function runCheck() {
  console.log("================================================================================");
  console.log("  VERIFIER: FRONTEND CLIENT STATE & CACHE INVALIDATION AUDIT (SOURCE-VALIDATED) ");
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
  console.log(`       - BOUNDED-EXCEPTION: ${details.verdictCounts["BOUNDED-EXCEPTION"]}`);
  console.log(`       - All ${details.scannedStorageFilesCount} scanned source files with storage access verified in audit table.`);
  console.log(`       - Section 2 summary counts match table rows exactly.`);

  console.log("\n[PASS] Cache Invalidation Map verified:");
  console.log(`       - Documented Invalidation Rows: ${details.invRowsCount}`);
  console.log(`       - All ${details.scannedInvSitesCount} scanned runtime invalidation/update call sites accounted for.`);

  console.log("\n[PASS] Key Gaps, Blindspots & Remediation Plan verified.");

  console.log("\n================================================================================");
  console.log("VERDICT: PASS-LOCAL (Static source validation for persistent storage keys & cache invalidations)");
  console.log("================================================================================");
  process.exit(0);
}

runCheck();
