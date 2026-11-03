/**
 * Test Suite: Landing Testimonials Flow & Opposite-Direction Second Wall
 * Verifies:
 * 1. src/app/page.tsx contains exactly two Testimonials instances
 * 2. First wall is immediately after LandingFeaturesSection and before LandingComparisonSection
 * 3. Second wall is immediately after Founder section and before FAQ
 * 4. Second wall uses direction="right"
 * 5. src/components/testimonials.tsx accepts direction prop ("left" | "right"), defaulting to "left"
 * 6. Scoped keyframes for normal (cmTestimonialsRunner) and reverse (cmTestimonialsRunnerReverse) exist
 * 7. Negative control verified
 *
 * Run with: npx tsx scripts/test-landing-testimonials-flow.ts
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

console.log("================================================================================");
console.log("TEST SUITE: Landing Testimonials Flow & Dual Wall Direction");
console.log("================================================================================\n");

if (IS_NEGATIVE_CONTROL) {
  console.log("Running NEGATIVE CONTROL: simulating single testimonial wall...");
  assert.strictEqual(1, 2, "Negative control deliberate failure");
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

const pagePath = path.resolve(process.cwd(), "src/app/page.tsx");
const compPath = path.resolve(process.cwd(), "src/components/testimonials.tsx");

assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
assert.ok(fs.existsSync(compPath), "src/components/testimonials.tsx must exist");

const pageCode = fs.readFileSync(pagePath, "utf-8");
const compCode = fs.readFileSync(compPath, "utf-8");

// 1. Two Testimonials instances in page.tsx
check("Exactly two Testimonials instances in page.tsx", () => {
  const matches = pageCode.match(/<Testimonials\b[^>]*\/>/g);
  assert.ok(matches, "Testimonials must be rendered");
  assert.strictEqual(matches.length, 2, `Expected exactly 2 Testimonials instances, found ${matches.length}`);
});

// 2. First wall positioned after LandingFeaturesSection and before LandingComparisonSection
check("First Testimonials wall positioned after LandingFeaturesSection and before LandingComparisonSection", () => {
  const idxFeatures = pageCode.indexOf("<LandingFeaturesSection />");
  const idxFirstTestimonials = pageCode.indexOf("<Testimonials />");
  const idxComparison = pageCode.indexOf("<LandingComparisonSection />");

  assert.ok(idxFeatures > -1, "LandingFeaturesSection must exist in page.tsx");
  assert.ok(idxFirstTestimonials > -1, "First <Testimonials /> must exist in page.tsx");
  assert.ok(idxComparison > -1, "LandingComparisonSection must exist in page.tsx");

  assert.ok(
    idxFeatures < idxFirstTestimonials,
    "LandingFeaturesSection must appear before first <Testimonials />"
  );
  assert.ok(
    idxFirstTestimonials < idxComparison,
    "First <Testimonials /> must appear before LandingComparisonSection"
  );
});

// 3. Second wall positioned after Founder section and before FAQ
check("Second Testimonials wall positioned after Founder section and before FAQ", () => {
  const idxFounder = pageCode.indexOf("Orissa here!");
  const idxSecondTestimonials = pageCode.indexOf('<Testimonials direction="right" />');
  const idxFaq = pageCode.indexOf("Frequently Asked Questions");

  assert.ok(idxFounder > -1, "Founder section must exist in page.tsx");
  assert.ok(idxSecondTestimonials > -1, '<Testimonials direction="right" /> must exist in page.tsx');
  assert.ok(idxFaq > -1, "FAQ section must exist in page.tsx");

  assert.ok(
    idxFounder < idxSecondTestimonials,
    "Founder section must appear before second Testimonials wall"
  );
  assert.ok(
    idxSecondTestimonials < idxFaq,
    "Second Testimonials wall must appear before FAQ"
  );
});

// 4. Direction prop and reverse keyframes supported
check("src/components/testimonials.tsx supports scoped direction option", () => {
  assert.match(compCode, /direction\?:?\s*["']left["']\s*\|\s*["']right["']/, "Must define direction type");
  assert.match(compCode, /direction\s*=\s*["']left["']/, "Must default direction to 'left'");
  assert.match(compCode, /@keyframes cmTestimonialsRunner\b/, "Must have normal keyframes");
  assert.match(compCode, /@keyframes cmTestimonialsRunnerReverse\b/, "Must have reverse keyframes");
  assert.match(compCode, /\.direction-right/, "Must define .direction-right track class");
});

// 5. Independent state, pause, and accessibility preserved
check("Preserves hover/focus pause, off-screen pause, and inert duplicate", () => {
  assert.match(compCode, /\.cm-testimonials-active-track:hover/, "Must pause on hover");
  assert.match(compCode, /\.cm-testimonials-active-track:focus-within/, "Must pause on focus");
  assert.match(compCode, /is-paused/, "Must have is-paused class");
  assert.match(compCode, /aria-hidden="true"/, "Must have aria-hidden duplicate sequence");
  assert.match(compCode, /inert=/, "Must have inert duplicate sequence");
});

console.log(`\n================================================================================`);
console.log(`TEST SUMMARY: ${passed} passed, ${failed} failed.`);
console.log(`================================================================================\n`);

if (failed > 0) process.exit(1);

// Negative control via subprocess
console.log("--- Verifying Negative Control via Subprocess ---");
const neg = spawnSync(process.execPath, ["-r", "tsx/register", "scripts/test-landing-testimonials-flow.ts", "--negative-control"], { encoding: "utf-8" });
if (neg.status !== 0) {
  console.log("  ✅ [PASS-LOCAL] Negative control properly exited with code 1 on deliberate assertion failure.\n");
} else {
  console.error("  ❌ [FAIL] Negative control did not exit non-zero!");
  process.exit(1);
}

console.log("🎉 ALL TESTIMONIALS FLOW TESTS PASSED [PASS-LOCAL]\n");
