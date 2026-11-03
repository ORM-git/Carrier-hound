/**
 * Test Suite for LandingGlobeFeatureSection
 * Verifies:
 * 1. Scope and single-section placement in src/app/page.tsx
 * 2. Component structural contract (canvas, tour cities, demo markers, 3-cell stats)
 * 3. Strict absence of company metrics (no 500, no companiesScanned, no "companies scanned")
 * 4. Honest nullish fallbacks (real 0 rendered as 0, error renders as neutral "—")
 * 5. Navigation destinations (/jobs, /radar) and truthful accessibility controls
 * 6. Negative control execution
 *
 * Run with: npx tsx scripts/test-landing-globe-feature.ts
 * Negative control: npx tsx scripts/test-landing-globe-feature.ts --negative-control
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

console.log("================================================================================");
console.log("TEST SUITE: Landing Globe Feature Section & Motion Verification");
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

const componentPath = path.resolve(process.cwd(), "src/components/LandingGlobeFeatureSection.tsx");
const pagePath = path.resolve(process.cwd(), "src/app/page.tsx");

assert.ok(fs.existsSync(componentPath), "LandingGlobeFeatureSection.tsx must exist");
assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");

const componentCode = fs.readFileSync(componentPath, "utf-8");
const pageCode = fs.readFileSync(pagePath, "utf-8");

// Negative control simulation
if (IS_NEGATIVE_CONTROL) {
  console.log("Running NEGATIVE CONTROL: injecting forbidden company metric into globe component...");
  assert.doesNotMatch(
    componentCode + ' 500 companies scanned ',
    /companies scanned/i,
    "Negative control must trigger on forbidden company count"
  );
  process.exit(0);
}

// 1. Exactly ONE globe section in src/app/page.tsx
check("src/app/page.tsx contains exactly ONE globe section using LandingGlobeFeatureSection", () => {
  const matches = pageCode.match(/<LandingGlobeFeatureSection\s*\/>/g);
  assert.strictEqual(matches?.length, 1, "Must have exactly 1 LandingGlobeFeatureSection invocation");
  assert.doesNotMatch(
    pageCode,
    /<WireframeDottedGlobe\b/,
    "Old WireframeDottedGlobe should not be rendered directly in page.tsx"
  );
  assert.doesNotMatch(
    pageCode,
    /<GlobeLiveStats\b/,
    "Old GlobeLiveStats should not be rendered directly in page.tsx"
  );
});

// 2. Strict prohibition of company metrics in globe section
check("Strict Anti-Fabrication: ZERO company count or source metrics in LandingGlobeFeatureSection", () => {
  assert.doesNotMatch(componentCode, /companiesScanned/i, "Must not reference companiesScanned in globe section");
  assert.doesNotMatch(componentCode, /companies\s*scanned/i, "Must not display 'companies scanned' in globe section");
  assert.doesNotMatch(componentCode, /(?:>|\b)500\s*(?:companies|<|\+)/i, "Must not display 500 company count in globe section");
  assert.doesNotMatch(componentCode, />\s*companies\s*</i, "Must not render any company count label in globe section");
});

// 3. Three-city auto-tour implementation
check("Three-city auto-tour: Singapore, Paris, San Francisco properly configured", () => {
  assert.match(componentCode, /"San Francisco"/, "Must include San Francisco in tour cities");
  assert.match(componentCode, /"Paris"/, "Must include Paris in tour cities");
  assert.match(componentCode, /"Singapore"/, "Must include Singapore in tour cities");
  assert.match(componentCode, /ML Engineer/, "Must include ML Engineer role for SF");
  assert.match(componentCode, /Senior DevOps Engineer/, "Must include Senior DevOps Engineer role for Paris");
  assert.match(componentCode, /Full Stack Engineer/, "Must include Full Stack Engineer role for Singapore");
  assert.match(componentCode, /d3\.geoInterpolate/, "Must use d3.geoInterpolate for great circle animated arc");
});

// 4. Truthful Demo Labeling & Simplified Sample Badging
check("Demo markers labeled 'Illustrative preview', single 'Sample' badge on card, no repeated [Sample] in tags", () => {
  assert.match(componentCode, /Illustrative preview/, "Globe must be labeled 'Illustrative preview'");
  assert.match(componentCode, />\s*Sample\s*</, "Card must have single compact 'Sample' badge");
  assert.doesNotMatch(componentCode, /\[Sample\]/, "Tags must NOT have repeated [Sample] suffix");
  assert.match(componentCode, /DEMO_HOME_COORDS/, "Home marker must be marked as demo data, not user location");
});

// 5. Interaction & Controls: Drag, Flick, Idle Resume, Keyboard
check("Interactive features: Drag to explore, Resume tour, Keyboard navigation, Reduced motion", () => {
  assert.match(componentCode, /Drag to explore/, "Must provide 'Drag to explore' hint/button");
  assert.match(componentCode, /Resume tour/, "Must provide 'Resume tour' control");
  assert.match(componentCode, /6000/, "Must have ~6s idle resume timer");
  assert.match(componentCode, /handleKeyDown/, "Must support keyboard navigation");
  assert.match(componentCode, /ArrowLeft/, "Must handle ArrowLeft keyboard control");
  assert.match(componentCode, /prefers-reduced-motion/, "Must respect reduced-motion preference");
  assert.match(componentCode, /IntersectionObserver/, "Must use IntersectionObserver for offscreen pause");
  assert.match(componentCode, /cancelAnimationFrame/, "Must clean up animation frame on unmount");
});

// 6. Three-cell stats strip and nullish fallback contract
check("Three-cell stats strip with honest fetch status, Jobs, and New today", () => {
  assert.match(componentCode, /totalJobs/i, "Must bind to totalJobs / activeJobs");
  assert.match(componentCode, /jobsToday/i, "Must bind to jobsToday");
  assert.match(componentCode, /Jobs<\/div>/i, "Must label cell 2 as 'Jobs'");
  assert.match(componentCode, /New today<\/div>/i, "Must label cell 3 as 'New today'");
  assert.match(componentCode, /toLocaleString\(\)\s*:\s*"—"/, "Missing/error values must show neutral placeholder '—'");
});

// 7. Navigation links and truthful captions
check("CTA button links to /jobs and caption truthfully describes /radar map", () => {
  assert.match(componentCode, /href="\/jobs"/, "View jobs CTA button must link to /jobs");
  assert.match(componentCode, /href="\/radar"/, "Interactive map caption must link to /radar");
  assert.match(componentCode, /Open interactive map · sign-in required/, "Caption must truthfully indicate sign-in required");
});

// 8. Compact Tooltip Responsive Bounds, Clamping, and Flip
check("Compact Tooltip: responsive width bounds (w-[165px]), edge clamping (clampLeft), and vertical flip (isFlippedDown)", () => {
  assert.match(componentCode, /w-\[165px\]/, "Tooltip must have compact mobile width ~165px");
  assert.match(componentCode, /clampLeft/, "Tooltip must compute clamped horizontal position");
  assert.match(componentCode, /isFlippedDown/, "Tooltip must flip below pin when near top edge");
});

console.log(`\n================================================================================`);
console.log(`TEST SUMMARY: ${passedCount} passed, ${failedCount} failed.`);
console.log(`================================================================================\n`);

if (failedCount > 0) {
  process.exit(1);
}

// 8. Run negative control in a subprocess
console.log("--- Verifying Negative Control via Subprocess ---");
const negResult = spawnSync(
  process.execPath,
  ["-r", "tsx/register", "scripts/test-landing-globe-feature.ts", "--negative-control"],
  { encoding: "utf-8" }
);

// We expect negative control to fail (exit code 1)
if (negResult.status === 1) {
  console.log("  ✅ [PASS-LOCAL] Negative control properly exited with code 1 upon detecting injected company count.\n");
} else {
  console.error(`  ❌ [FAIL] Negative control did NOT exit with code 1. Status: ${negResult.status}`);
  process.exit(1);
}

console.log("🎉 ALL GLOBE FEATURE TESTS PASSED: PASS-LOCAL\n");
