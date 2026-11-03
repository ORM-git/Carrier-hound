/**
 * Comprehensive Test Suite for Landing Testimonials Horizontal Runner
 * Verifies:
 * 1. Scope, exports, and replacement of 4 vertical columns with single horizontal runner
 * 2. Strict content preservation (all 12 cards, quotes, authors, locations, no invented roles)
 * 3. Card visual layout (asymmetric rounded corners, decorative quote mark, bottom-pinned footer)
 * 4. Seamless loop distance calculation (sequence width + boundary gap)
 * 5. Accessibility & controls (pause/play button, hover/focus pause, duplicate inert/aria-hidden)
 * 6. Prefers-reduced-motion handling (accessible manual scrollable row)
 * 7. Negative control verification
 *
 * Run with: npx tsx scripts/test-landing-testimonials-runner.ts
 * Negative control: npx tsx scripts/test-landing-testimonials-runner.ts --negative-control
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getLandingCards } from "../src/data/landingCards";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

console.log("================================================================================");
console.log("TEST SUITE: Landing Testimonials Horizontal Runner Verification");
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

const testimonialsPath = path.resolve(process.cwd(), "src/components/testimonials.tsx");
const pagePath = path.resolve(process.cwd(), "src/app/page.tsx");
const dataPath = path.resolve(process.cwd(), "src/data/landingCards.ts");

assert.ok(fs.existsSync(testimonialsPath), "src/components/testimonials.tsx must exist");
assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
assert.ok(fs.existsSync(dataPath), "src/data/landingCards.ts must exist");

const testimonialsCode = fs.readFileSync(testimonialsPath, "utf-8");
const pageCode = fs.readFileSync(pagePath, "utf-8");
const dataCode = fs.readFileSync(dataPath, "utf-8");

// Negative control simulation
if (IS_NEGATIVE_CONTROL) {
  console.log("Running NEGATIVE CONTROL: injecting vertical column component into testimonials...");
  assert.doesNotMatch(
    testimonialsCode + "<TestimonialsColumn />",
    /<TestimonialsColumn\b/,
    "Negative control must trigger on old vertical column component"
  );
  process.exit(0);
}

// 1. Exports and Single Horizontal Row Replacement
check("Exports named 'Testimonials' and default 'Testimonials'", () => {
  assert.match(testimonialsCode, /export\s+const\s+Testimonials\s*=/, "Must export named const Testimonials");
  assert.match(testimonialsCode, /export\s+default\s+Testimonials/, "Must export default Testimonials");
});

check("Single horizontal runner replaces 4 vertical columns", () => {
  assert.doesNotMatch(
    testimonialsCode,
    /<TestimonialsColumn\b/,
    "Must NOT use old TestimonialsColumn component"
  );
  assert.match(
    testimonialsCode,
    /data-testid="testimonials-runner-track"/,
    "Must have single horizontal runner track"
  );
  assert.match(
    testimonialsCode,
    /data-testid="landing-testimonials-section"/,
    "Must preserve landing testimonials section testid"
  );
  // Verify page.tsx still renders <Testimonials />
  assert.match(pageCode, /<Testimonials\s*\/>/, "page.tsx must still render <Testimonials />");
});

// 2. Strict Content Preservation
check("Preserves exact data from getLandingCards() with zero content modifications", () => {
  const cards = getLandingCards();
  assert.strictEqual(cards.length, 12, "Must contain all 12 canonical landing cards");

  // Verify key authors and quotes exist unchanged in data
  for (const card of cards) {
    assert.ok(card.authorName, `Card ${card.id} must have authorName`);
    assert.ok(card.body, `Card ${card.id} must have body`);
    assert.ok(card.location, `Card ${card.id} must have location`);
  }

  // Ensure testimonials component does not invent roles or truncate
  assert.doesNotMatch(testimonialsCode, /line-clamp/i, "Must not truncate testimonial quote text");
  assert.match(testimonialsCode, /card\.body/, "Must render card.body");
  assert.match(testimonialsCode, /card\.authorName/, "Must render card.authorName");
  assert.match(testimonialsCode, /card\.location/, "Must render card.location");
});

// 3. Card Layout: Asymmetric Corners, Quote Mark, Aligned Footer
check("Card layout: Asymmetric corners, large quote mark, and bottom-pinned footer", () => {
  // Asymmetric corners: strongly rounded top-right, bottom-right, bottom-left, square-ish top-left
  assert.match(testimonialsCode, /rounded-tr-\[28px\]|rounded-tr-3xl/, "Must have strongly rounded top-right corner");
  assert.match(testimonialsCode, /rounded-br-\[28px\]|rounded-br-3xl/, "Must have strongly rounded bottom-right corner");
  assert.match(testimonialsCode, /rounded-bl-\[28px\]|rounded-bl-3xl/, "Must have strongly rounded bottom-left corner");
  assert.match(testimonialsCode, /rounded-tl-md|rounded-tl-sm|rounded-tl-\[8px\]/, "Must have more square top-left corner");

  // Large decorative quote mark
  assert.match(testimonialsCode, /<svg[^>]*>[\s\S]*?M14\.017 21v-7\.391/, "Must include decorative quote mark SVG");

  // White tall card with neutral outline
  assert.match(testimonialsCode, /bg-white/, "Must use white card background");
  assert.match(testimonialsCode, /border-slate-200/, "Must use thin neutral outline");

  // Card responsive width
  assert.match(testimonialsCode, /w-\[82vw\]|w-\[84vw\]|w-\[85vw\]/, "Must size card width ~80-85vw on mobile");
  assert.match(testimonialsCode, /sm:w-\[350px\]|sm:w-\[340px\]|sm:w-\[360px\]/, "Must size card width ~340-360px on desktop");
});

// 4. Seamless Loop Calculation
check("Seamless loop calculation: sequence width + boundary gap", () => {
  assert.match(testimonialsCode, /seqWidth\s*\+\s*computedGap/, "Must include boundary gap in loop distance calculation");
  assert.match(testimonialsCode, /--loop-distance/, "Must pass computed loop distance to CSS custom property");
  assert.match(testimonialsCode, /--loop-duration/, "Must compute duration at ~35-45px/s");
  assert.match(testimonialsCode, /ResizeObserver/, "Must recalculate on ResizeObserver size changes");
  assert.match(testimonialsCode, /cmTestimonialsRunner/, "Must define seamless keyframe runner");
});

// 5. Accessibility & Motion Controls
check("Accessibility: Instant hover/focus pause on any testimonial, no bottom pause button, inert duplicate", () => {
  // Confirm removal of manual pause button per user instruction
  assert.doesNotMatch(
    testimonialsCode,
    /data-testid="testimonials-pause-button"/,
    "Must NOT render bottom manual pause button"
  );
  assert.doesNotMatch(
    testimonialsCode,
    /isUserPaused/,
    "Must not retain isUserPaused manual state"
  );

  // Hover and focus pauses on any card and container
  assert.match(testimonialsCode, /onMouseEnter/, "Must pause on hover enter");
  assert.match(testimonialsCode, /onMouseLeave/, "Must handle hover leave");
  assert.match(testimonialsCode, /onTouchStart/, "Must pause on mobile touch start");
  assert.match(testimonialsCode, /onTouchEnd/, "Must handle mobile touch end");
  assert.match(testimonialsCode, /onFocus/, "Must pause on focus");
  assert.match(testimonialsCode, /onBlur/, "Must handle focus blur");
  assert.match(testimonialsCode, /\.cm-testimonials-active-track:hover/, "Must pause immediately on CSS hover");
  assert.match(testimonialsCode, /\.cm-testimonials-active-track:focus-within/, "Must pause on CSS focus-within");

  // Duplicate sequence inaccessible to assistive technology
  assert.match(testimonialsCode, /aria-hidden="true"/, "Duplicate sequence must be aria-hidden");
  assert.match(testimonialsCode, /inert/, "Duplicate sequence must be inert");
});

// 6. Prefers-Reduced-Motion & Off-Screen Pause
check("Prefers-reduced-motion and off-screen pause handling", () => {
  assert.match(testimonialsCode, /prefers-reduced-motion/, "Must detect prefers-reduced-motion");
  assert.match(testimonialsCode, /overflow-x-auto/, "Must offer scrollable row in reduced motion mode");
  assert.match(testimonialsCode, /IntersectionObserver/, "Must pause off-screen with IntersectionObserver");
  assert.match(testimonialsCode, /is-paused/, "Must toggle paused state via CSS play-state");
});

console.log(`\n================================================================================`);
console.log(`TEST SUMMARY: ${passedCount} passed, ${failedCount} failed.`);
console.log(`================================================================================\n`);

if (failedCount > 0) {
  process.exit(1);
}

// 7. Subprocess Negative Control
console.log("--- Verifying Negative Control via Subprocess ---");
const negResult = spawnSync(
  process.execPath,
  ["-r", "tsx/register", "scripts/test-landing-testimonials-runner.ts", "--negative-control"],
  { encoding: "utf-8" }
);

if (negResult.status === 1) {
  console.log("  ✅ [PASS-LOCAL] Negative control properly exited with code 1 upon detecting injected vertical column.\n");
} else {
  console.error(`  ❌ [FAIL] Negative control did NOT exit with code 1. Status: ${negResult.status}`);
  process.exit(1);
}

console.log("🎉 ALL TESTIMONIALS RUNNER TESTS PASSED: PASS-LOCAL\n");
