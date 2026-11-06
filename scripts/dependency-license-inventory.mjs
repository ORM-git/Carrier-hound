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
    console.log(JSON.stringify(report, null, 2));
    // Opt-in review gate. Routine notice-review is never equivalent to approval.
    if (process.argv.includes("--check") && report.manualReviewCount) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
