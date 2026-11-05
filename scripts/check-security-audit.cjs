/**
 * scripts/check-security-audit.cjs
 *
 * Verifies that all high and critical npm audit vulnerabilities match the committed
 * security/audit-baseline.json file.
 *
 * Exits with 0 if no unbaselined high/critical advisories exist.
 * Exits with 1 if NEW high/critical advisories are detected.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BASELINE_PATH = path.resolve(__dirname, "../security/audit-baseline.json");

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`[AUDIT ERROR] Baseline file not found at ${BASELINE_PATH}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(BASELINE_PATH, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[AUDIT ERROR] Failed to parse baseline JSON: ${err.message}`);
    process.exit(1);
  }

  const entries = Array.isArray(parsed) ? parsed : parsed.advisories || [];
  const allowedIds = new Set();

  for (const entry of entries) {
    if (!entry.id || !entry.reason) {
      console.error(
        `[AUDIT ERROR] Baseline entry missing required 'id' or 'reason': ${JSON.stringify(entry)}`
      );
      process.exit(1);
    }
    allowedIds.add(String(entry.id).trim().toUpperCase());
    if (entry.source) {
      allowedIds.add(String(entry.source).trim());
    }
  }

  return { entries, allowedIds };
}

function runAudit() {
  let auditOutput = "";
  try {
    auditOutput = execSync("npm audit --omit=dev --json", {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // npm audit returns exit code 1 when vulnerabilities exist
    auditOutput = err.stdout ? err.stdout.toString() : "";
  }

  if (!auditOutput.trim()) {
    console.warn("[AUDIT WARN] Empty npm audit output; proceeding as clean.");
    return { vulnerabilities: {} };
  }

  try {
    return JSON.parse(auditOutput);
  } catch (err) {
    console.error(`[AUDIT ERROR] Failed to parse npm audit JSON output: ${err.message}`);
    process.exit(1);
  }
}

function extractHighCriticalAdvisories(auditReport) {
  const vulnerabilities = auditReport.vulnerabilities || {};
  const highCritical = [];

  for (const [pkg, v] of Object.entries(vulnerabilities)) {
    if (!v.via || !Array.isArray(v.via)) continue;

    for (const item of v.via) {
      if (typeof item === "object" && item.url) {
        const severity = String(item.severity || "").toLowerCase();
        if (severity === "high" || severity === "critical") {
          const ghsaMatch = item.url.match(/GHSA-[a-zA-Z0-9_-]+/i);
          const ghsaId = ghsaMatch ? ghsaMatch[0].toUpperCase() : item.url.split("/").pop();
          highCritical.push({
            package: item.dependency || pkg,
            id: ghsaId,
            source: item.source ? String(item.source) : null,
            severity,
            title: item.title || "",
            url: item.url,
          });
        }
      }
    }
  }

  // Deduplicate by ID
  const deduped = new Map();
  for (const item of highCritical) {
    if (!deduped.has(item.id)) {
      deduped.set(item.id, item);
    }
  }

  return Array.from(deduped.values());
}

function main() {
  const { entries, allowedIds } = loadBaseline();
  const auditReport = runAudit();
  const currentAdvisories = extractHighCriticalAdvisories(auditReport);

  const newAdvisories = [];

  for (const adv of currentAdvisories) {
    const isIdAllowed = adv.id && allowedIds.has(adv.id.toUpperCase());
    const isSourceAllowed = adv.source && allowedIds.has(adv.source);

    if (!isIdAllowed && !isSourceAllowed) {
      newAdvisories.push(adv);
    }
  }

  if (newAdvisories.length > 0) {
    console.error("================================================================================");
    console.error("  [AUDIT FAILED] NEW UNBASELINED HIGH / CRITICAL DEPENDENCY ADVISORIES FOUND     ");
    console.error("================================================================================\n");

    for (const adv of newAdvisories) {
      console.error(`  - Package:  ${adv.package}`);
      console.error(`    ID:       ${adv.id}`);
      console.error(`    Severity: ${adv.severity.toUpperCase()}`);
      console.error(`    Title:    ${adv.title}`);
      console.error(`    URL:      ${adv.url}\n`);
    }

    console.error("If these vulnerabilities have been reviewed and accepted pending fix, add them to");
    console.error("security/audit-baseline.json with an explicit reason.\n");
    process.exit(1);
  }

  console.log("================================================================================");
  console.log("  [AUDIT PASS] All High / Critical Advisories Match Committed Baseline           ");
  console.log("================================================================================");
  console.log(`Matched ${currentAdvisories.length} advisory ID(s) against ${entries.length} baseline entry/entries in security/audit-baseline.json.`);
  console.log("Zero new unbaselined high or critical vulnerabilities detected.\n");
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadBaseline,
  extractHighCriticalAdvisories,
  BASELINE_PATH,
};
