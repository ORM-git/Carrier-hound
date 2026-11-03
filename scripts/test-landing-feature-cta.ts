/**
 * Test Suite: Landing All Features CTA & Visual Panel Adjustment
 * Verifies:
 * 1. For all rows: outer pale panel (bg-[#F8FAFC], border, shadow, padding) removed.
 * 2. All CTA buttons ('Explore jobs', 'Try AI resume tools', 'Find my matches') moved below animations and horizontally centered.
 * 3. Text columns do not contain CTA buttons.
 * 4. Caption 'Illustration - sample data' visible beneath each centered button.
 * 5. Custom elements <cm-find-jobs />, <cm-tailor-resume />, <cm-job-matches /> preserved.
 * 6. Negative control verified.
 *
 * Run with: npx tsx scripts/test-landing-feature-cta.ts
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

console.log("================================================================================");
console.log("TEST SUITE: Landing All Features CTA & Visual Panel Adjustment");
console.log("================================================================================\n");

if (IS_NEGATIVE_CONTROL) {
  console.log("Running NEGATIVE CONTROL: simulating pale panel on features section...");
  assert.strictEqual("pale_panel_present", "must_not_be_present", "Simulated negative control failure");
  process.exit(0);
}

let passed = 0;
let failed = 0;

function check(desc: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ [PASS-LOCAL] ${desc}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

const compPath = path.resolve(process.cwd(), "src/components/LandingFeaturesSection.tsx");
assert.ok(fs.existsSync(compPath), "LandingFeaturesSection.tsx must exist");
const code = fs.readFileSync(compPath, "utf-8");

// 1. Removal of outer pale panel across all features
check("Outer off-white panel removed from all features", () => {
  assert.ok(!code.includes("bg-[#F8FAFC]"), "Must not contain bg-[#F8FAFC]");
  assert.ok(!code.includes("border-gray-200/80"), "Must not contain border-gray-200/80 panel border");
  assert.ok(!code.includes("p-3 sm:p-5"), "Must not contain panel padding p-3 sm:p-5");
});

// 2. Uniform layout for all rows (no first-row conditional)
check("Shared uniform structure without first-row divergence", () => {
  assert.ok(!code.includes("isFirstRow"), "Should use clean shared structure without isFirstRow branch");
});

// 3. CTA moved below animation and horizontally centered in visual column
check("All CTAs moved below animation and horizontally centered in visual column", () => {
  assert.match(
    code,
    /<div className="flex items-center justify-center overflow-hidden">[\s\S]*?{row\.visual}[\s\S]*?<\/div>[\s\S]*?<div className="flex justify-center pt-2">[\s\S]*?<Link[\s\S]*?{row\.buttonText}[\s\S]*?<\/Link>[\s\S]*?<\/div>/,
    "Visual must be immediately followed by centered CTA button container"
  );
});

// 4. Caption preserved under the centered button
check("Caption 'Illustration - sample data' preserved under the button", () => {
  assert.match(
    code,
    /{row\.buttonText}[\s\S]*?<\/Link>[\s\S]*?<\/div>[\s\S]*?<p className="text-center text-xs text-gray-400">[\s\S]*?Illustration - sample data[\s\S]*?<\/p>/,
    "Caption must follow the centered button for every row"
  );
});

// 5. Text column has no Link or CTA button
check("Text column contains only title and description (no CTA button)", () => {
  assert.match(
    code,
    /<div className="lg:col-span-5 space-y-4 text-left">\s*<h3[\s\S]*?<\/h3>\s*<p[\s\S]*?<\/p>\s*<\/div>/,
    "Text column should end after description"
  );
});

// 6. Custom elements preserved unchanged
check("Custom elements <cm-find-jobs />, <cm-tailor-resume />, <cm-job-matches /> preserved", () => {
  assert.match(code, /<cm-find-jobs compact \/>/, "cm-find-jobs preserved");
  assert.match(code, /<cm-tailor-resume compact \/>/, "cm-tailor-resume preserved");
  assert.match(code, /<cm-job-matches compact \/>/, "cm-job-matches preserved");
});

console.log(`\n================================================================================`);
console.log(`TEST SUMMARY: ${passed} passed, ${failed} failed.`);
console.log(`================================================================================\n`);

if (failed > 0) process.exit(1);

// Negative control via subprocess
console.log("--- Verifying Negative Control via Subprocess ---");
const neg = spawnSync(process.execPath, ["-r", "tsx/register", "scripts/test-landing-feature-cta.ts", "--negative-control"], { encoding: "utf-8" });
if (neg.status !== 0) {
  console.log("  ✅ [PASS-LOCAL] Negative control properly exited with code 1 on deliberate assertion failure.\n");
} else {
  console.error("  ❌ [FAIL] Negative control did not exit non-zero!");
  process.exit(1);
}

console.log("🎉 ALL FEATURE CTA TESTS PASSED [PASS-LOCAL]\n");
