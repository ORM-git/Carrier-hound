#!/usr/bin/env node
/** Metadata inventory, not a legal compatibility verdict. No network calls. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Only exact, uncomplicated identifiers are grouped as routine notice review.
// All others remain manual-review items; OR/AND expressions are not resolved.
const ROUTINE_NOTICE_REVIEW = new Set([
  "MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
  "CC0-1.0", "Unlicense", "BlueOak-1.0.0", "Python-2.0",
]);

/**
 * Checks if a single license identifier matches strong-copyleft licenses:
 * GPL-2.0, GPL-3.0, AGPL, SSPL, Commons-Clause.
 */
export function isCopyleftIdentifier(license) {
  if (!license || typeof license !== "string") return false;
  const clean = license.trim().replace(/^\(|\)$/g, "");
  return (
    /\b(GPL-2\.0|GPL-3\.0|AGPL(-\d+(\.\d+)?)?|SSPL(-\d+(\.\d+)?)?)\b/i.test(clean) ||
    /Commons-Clause/i.test(clean)
  );
}

/**
 * Evaluates whether a license expression imposes strong-copyleft obligations.
 * Under dual-licensing (OR), if at least one branch is non-copyleft (e.g. MIT OR GPL-3.0),
 * the licensee can choose the permissive option. Under combined licensing (AND), any
 * copyleft component binds the overall work.
 */
export function isStrongCopyleft(license) {
  if (!license || typeof license !== "string") return false;
  const trimmed = license.trim();
  if (trimmed === "UNKNOWN") return false;

  // Handle compound OR expressions
  if (trimmed.includes(" OR ")) {
    const inner = trimmed.replace(/^\((.*)\)$/, "$1");
    const parts = inner.split(/\s+OR\s+/i);
    return parts.every((p) => isStrongCopyleft(p.trim()));
  }

  // Handle compound AND expressions
  if (trimmed.includes(" AND ")) {
    const inner = trimmed.replace(/^\((.*)\)$/, "$1");
    const parts = inner.split(/\s+AND\s+/i);
    return parts.some((p) => isStrongCopyleft(p.trim()));
  }

  return isCopyleftIdentifier(trimmed);
}

/**
 * Evaluates dependency inventory report against the OSS license policy:
 * - Fails on strong-copyleft in runtime dependencies
 * - Warns on strong-copyleft in dev dependencies
 * - Warns on UNKNOWN licenses
 */
export function evaluateLicensePolicy(report) {
  const runtimeCopyleft = [];
  const devCopyleft = [];
  const unknownLicenses = [];

  for (const entry of report.entries) {
    if (entry.license === "UNKNOWN") {
      unknownLicenses.push(entry);
    }
    if (isStrongCopyleft(entry.license)) {
      if (entry.scope === "runtime-or-shared") {
        runtimeCopyleft.push(entry);
      } else {
        devCopyleft.push(entry);
      }
    }
  }

  return {
    passed: runtimeCopyleft.length === 0,
    runtimeCopyleft,
    devCopyleft,
    unknownLicenses,
  };
}

export function inventory(lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error("Expected npm lockfile v3 packages");
  const entries = Object.entries(lock.packages)
    .filter(([location, item]) => location && !item.link)
    .map(([location, item]) => {
      const license = typeof item.license === "string" && item.license.trim() ? item.license.trim() : "UNKNOWN";
      return {
        location,
        version: item.version ?? "UNKNOWN",
        license,
        scope: item.dev ? "development" : "runtime-or-shared",
        review: ROUTINE_NOTICE_REVIEW.has(license) ? "notice-review" : "manual-review",
      };
    }).sort((a, b) => a.location.localeCompare(b.location));
  return {
    purpose: "Dependency metadata inventory only. License texts, attribution requirements and compatibility are not verified.",
    dependencyCount: entries.length,
    missingMetadataCount: entries.filter((entry) => entry.license === "UNKNOWN").length,
    manualReviewCount: entries.filter((entry) => entry.review === "manual-review").length,
    licenses: Object.fromEntries([...new Set(entries.map((entry) => entry.license))].sort().map((license) => [license, entries.filter((entry) => entry.license === license).length])),
    entries,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = inventory(JSON.parse(readFileSync("package-lock.json", "utf8")));
    if (process.argv.includes("--check")) {
      const policy = evaluateLicensePolicy(report);

      if (policy.unknownLicenses.length > 0) {
        console.warn(`[WARN] UNKNOWN license detected (${policy.unknownLicenses.length} package${policy.unknownLicenses.length === 1 ? "" : "s"}):`);
        for (const e of policy.unknownLicenses) {
          console.warn(`  - ${e.location}@${e.version} (${e.scope})`);
        }
      }

      if (policy.devCopyleft.length > 0) {
        console.warn(`[WARN] Copyleft license in development dependency (${policy.devCopyleft.length} package${policy.devCopyleft.length === 1 ? "" : "s"}):`);
        for (const e of policy.devCopyleft) {
          console.warn(`  - ${e.location}@${e.version} [${e.license}]`);
        }
      }

      if (!policy.passed) {
        console.error(`[FAIL] Strong-copyleft license in runtime dependency (${policy.runtimeCopyleft.length} violation${policy.runtimeCopyleft.length === 1 ? "" : "s"}):`);
        for (const e of policy.runtimeCopyleft) {
          console.error(`  - ${e.location}@${e.version} [${e.license}]`);
        }
        process.exitCode = 1;
      } else {
        console.log(`[PASS] OSS license check passed: 0 strong-copyleft runtime dependencies (${report.dependencyCount} total packages evaluated).`);
      }
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
