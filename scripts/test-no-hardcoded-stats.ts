/**
 * CareerMonke Real Stats Verification Suite
 * Enforces zero hardcoded marketing numbers for jobs and companies.
 * Ensures all job/company figures are dynamically sourced from /api/stats with safe, figure-free fallbacks.
 *
 * Run with: npx tsx scripts/test-no-hardcoded-stats.ts
 * Run negative control: npx tsx scripts/test-no-hardcoded-stats.ts --negative-control
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

console.log("================================================================================");
console.log("TEST SUITE: Zero Hardcoded Marketing Numbers & Dynamic Stats Verification");
console.log("================================================================================\n");

let passedCount = 0;
let failedCount = 0;

function check(desc: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ [PASS-LOCAL] ${desc}`);
    passedCount++;
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${desc}: ${err.message}`);
    failedCount++;
  }
}

// Prohibited hardcoded marketing patterns for jobs, companies, and sample job cards
const FORBIDDEN_PATTERNS: { pattern: RegExp; desc: string }[] = [
  { pattern: /16[,.]?423/g, desc: "Stale hardcoded job count 16,423" },
  { pattern: /16[,.]?000\+/g, desc: "Fabricated 16,000+ job marketing count" },
  { pattern: /61[,.]?000\+/g, desc: "Fabricated 61,000+ job count" },
  { pattern: /12[,.]?000\+\s*(?:top\s+)?(?:tech\s+)?(?:software\s+)?(?:and\s+product\s+)?companies/gi, desc: "Fabricated 12,000+ companies count" },
  { pattern: /4\.5\s*million(?:\s+hidden\s+jobs)?/gi, desc: "Fabricated 4.5 million jobs claim" },
  { pattern: /150\+\s*(?:verified\s+)?(?:companies|employers)/gi, desc: "Hardcoded 150+ companies marketing count" },
  { pattern: /FALLBACK_TOTAL_JOBS\s*=\s*16/g, desc: "Fake hardcoded fallback job count constant" },
  { pattern: /FALLBACK_COMPANIES_SCANNED\s*=\s*500/g, desc: "Fake hardcoded fallback company count constant" },
  { pattern: /totalCorpus:\s*16423/g, desc: "Hardcoded totalCorpus in top10 response" },
  { pattern: /Tenable/g, desc: "Hardcoded sample job company 'Tenable'" },
  { pattern: /106,000/g, desc: "Hardcoded sample job salary '106,000'" },
  { pattern: /141,333/g, desc: "Hardcoded sample job salary '141,333'" },
];

function scanDirectories(dirList: string[]): { file: string; line: number; match: string; patternDesc: string }[] {
  const violations: { file: string; line: number; match: string; patternDesc: string }[] = [];

  function walk(currentPath: string) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".next" && entry.name !== "out") {
          walk(fullPath);
        }
      } else if (
        entry.name.endsWith(".tsx") ||
        entry.name.endsWith(".ts")
      ) {
        // Skip this test script itself
        if (fullPath.includes("test-no-hardcoded-stats")) continue;

        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content.split("\n");
        lines.forEach((lineText, idx) => {
          for (const rule of FORBIDDEN_PATTERNS) {
            rule.pattern.lastIndex = 0;
            if (rule.pattern.test(lineText)) {
              violations.push({
                file: fullPath,
                line: idx + 1,
                match: lineText.trim(),
                patternDesc: rule.desc,
              });
            }
          }
        });
      }
    }
  }

  for (const dir of dirList) {
    if (fs.existsSync(dir)) {
      walk(dir);
    }
  }

  return violations;
}

// -----------------------------------------------------------------------------
// SECTION 1: Static Codebase Audit (Landing, Jobs, Pricing, Guides, Components)
// -----------------------------------------------------------------------------
console.log("--- SECTION 1: Codebase Scan for Hardcoded Marketing Figures ---");

check("No prohibited hardcoded numbers found in src/app, src/components, src/data, or netlify/", () => {
  const targetDirs = [
    path.resolve(process.cwd(), "src", "app"),
    path.resolve(process.cwd(), "src", "components"),
    path.resolve(process.cwd(), "src", "data", "guides"),
    path.resolve(process.cwd(), "netlify", "functions"),
  ];

  const foundViolations = scanDirectories(targetDirs);

  if (foundViolations.length > 0) {
    const details = foundViolations
      .map((v) => `  [VIOLATION] ${v.file}:${v.line} (${v.patternDesc}) => "${v.match}"`)
      .join("\n");
    throw new Error(`Detected ${foundViolations.length} hardcoded marketing figure(s):\n${details}`);
  }
  assert.strictEqual(foundViolations.length, 0);
});

// -----------------------------------------------------------------------------
// SECTION 2: Dynamic Live Stats Fallback Contract
// -----------------------------------------------------------------------------
console.log("\n--- SECTION 2: Stats Hook & Fallback Contract ---");

check("GlobeLiveStats fallback renders NO fake numbers when API stats are null", () => {
  const globePath = path.resolve(process.cwd(), "src", "components", "GlobeLiveStats.tsx");
  const content = fs.readFileSync(globePath, "utf8");

  assert.strictEqual(
    content.includes("FALLBACK_TOTAL_JOBS = 16423"),
    false,
    "GlobeLiveStats must not define 16423 fallback constant"
  );
  assert.strictEqual(
    content.includes("FALLBACK_COMPANIES_SCANNED = 500"),
    false,
    "GlobeLiveStats must not define 500 fallback constant"
  );
  assert.ok(
    content.includes("displayTotalJobs !== null") && content.includes('"—"'),
    "GlobeLiveStats must display '—' or non-fake fallback when totalJobs is null"
  );
});

check("AvatarStack renders verified hidden jobs without fake count when jobsCount is omitted", () => {
  const avatarPath = path.resolve(process.cwd(), "src", "components", "AvatarStack.tsx");
  const content = fs.readFileSync(avatarPath, "utf8");

  assert.strictEqual(
    content.includes('"4.5 million"'),
    false,
    "AvatarStack must not default to '4.5 million' hidden jobs"
  );
  assert.ok(
    content.includes('"verified "'),
    "AvatarStack must fallback to 'verified hidden jobs' when jobsCount is undefined"
  );
});

check("TopTenCompatibleJobs uses dynamic active jobs count rather than hardcoded 16,423", () => {
  const topTenPath = path.resolve(process.cwd(), "src", "components", "dashboard", "TopTenCompatibleJobs.tsx");
  const content = fs.readFileSync(topTenPath, "utf8");

  assert.strictEqual(
    content.includes("16,423"),
    false,
    "TopTenCompatibleJobs must not contain hardcoded 16,423"
  );
  assert.ok(
    content.includes("useLiveStats"),
    "TopTenCompatibleJobs must import and use useLiveStats"
  );
});

check("Top 10 server routes compute real active corpus dynamically from jobs_public", () => {
  const routePath = path.resolve(process.cwd(), "src", "app", "api", "jobs", "top10", "route.ts");
  const content = fs.readFileSync(routePath, "utf8");

  assert.strictEqual(
    content.includes("totalCorpus: 16423"),
    false,
    "API top10 route must not hardcode totalCorpus to 16423"
  );
  assert.ok(
    content.includes("from(\"jobs_public\")"),
    "API top10 route must query jobs_public for active count"
  );
});

check("Landing source contains no hardcoded sample jobs (Tenable, 106,000, 141,333) and uses clear sample illustration", () => {
  const landingPath = path.resolve(process.cwd(), "src", "app", "page.tsx");
  const demoPath = path.resolve(process.cwd(), "src", "components", "LandingInteractiveDemoSection.tsx");
  const landingContent = fs.readFileSync(landingPath, "utf8");
  const demoContent = fs.readFileSync(demoPath, "utf8");
  const combined = `${landingContent}\n${demoContent}`;

  for (const forbidden of ["Tenable", "106,000", "141,333", "Cribl", "Interface AI", "November 14, 2024"]) {
    assert.strictEqual(
      combined.includes(forbidden),
      false,
      `Landing source must not contain hardcoded sample job string "${forbidden}"`
    );
  }

  assert.ok(
    demoContent.includes("Illustration - sample data"),
    "Landing demo must clearly label sample data as illustration"
  );
  assert.ok(
    !demoContent.includes('"Verified Employer"'),
    "Landing demo must not contain 'Verified Employer'"
  );
});

// -----------------------------------------------------------------------------
// SECTION 3: Negative Control
// -----------------------------------------------------------------------------
if (IS_NEGATIVE_CONTROL) {
  console.log("\n--- EXECUTING NEGATIVE CONTROL INJECTION ---");
  // Deliberately simulate encountering prohibited hardcoded marketing numbers and sample job strings
  const simulatedSamples = [
    "<span>Explore 61,000+ Verified Jobs</span>",
    "<p>Tenable, Inc.</p>",
    "<span>$106,000 - $141,333</span>",
  ];
  const allDetected = simulatedSamples.every((sample) =>
    FORBIDDEN_PATTERNS.some((rule) => {
      rule.pattern.lastIndex = 0;
      return rule.pattern.test(sample);
    })
  );

  if (allDetected) {
    console.error("❌ NEGATIVE CONTROL TRIGGERED: Intentionally injected hardcoded strings ('61,000+', 'Tenable', '106,000', '141,333') were detected!");
    process.exit(1);
  } else {
    process.exit(0);
  }
}

console.log("\n================================================================================");
console.log(`TEST SUMMARY: ${passedCount} passed, ${failedCount} failed.`);
console.log("================================================================================");

if (failedCount > 0) {
  console.error(`❌ Suite failed with ${failedCount} failure(s).`);
  process.exit(1);
}

// Subprocess negative control verification
console.log("\n--- Verifying Negative Control via Subprocess ---");
const negProcess = spawnSync(
  process.execPath,
  ["-r", "tsx/register", "scripts/test-no-hardcoded-stats.ts", "--negative-control"],
  { encoding: "utf-8" }
);

if (negProcess.status === 1) {
  console.log("  ✅ [PASS-LOCAL] Negative control properly exited with code 1 upon detecting injected hardcoded number.");
} else {
  console.error(`  ❌ [FAIL] Negative control did NOT exit with code 1. Status: ${negProcess.status}`);
  process.exit(1);
}

console.log("\n🎉 ALL REAL NUMBERS & ANTI-FABRICATION AUDITS PASSED: PASS-LOCAL\n");
process.exit(0);
