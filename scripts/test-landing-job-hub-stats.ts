import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const isNegativeControl = process.argv.includes("--negative-control");

if (isNegativeControl) {
  // Negative control must fail by asserting a deliberate contradiction
  console.log("Running negative control mode...");
  assert.strictEqual("intentional_failure", "must_fail", "Negative control triggered failure");
  process.exit(0);
}

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-landing-job-hub-stats.ts", "--negative-control"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    }
  );
  assert.notStrictEqual(
    res.status,
    0,
    `Expected negative control subprocess to exit non-zero, but got status=${res.status}`
  );
  console.log("  [PASS-LOCAL] Negative control '--negative-control' exited non-zero as expected");
}

async function main() {
  console.log("================================================================================");
  console.log("TEST SUITE: Landing Job Hub & Real Stats Section Verification");
  console.log("================================================================================\n");

  // Run negative control verification first
  runNegativeControlSubprocess();

  // Test 1: Page Placement in src/app/page.tsx
  console.log("\nTEST 1: Section Placement in src/app/page.tsx...");
  const pagePath = path.resolve(process.cwd(), "src/app/page.tsx");
  const pageContent = fs.readFileSync(pagePath, "utf8");

  assert(
    pageContent.includes("LandingJobHubStatsSection"),
    "src/app/page.tsx must import and render LandingJobHubStatsSection"
  );

  const topArtifactIdx = pageContent.indexOf("<LandingTopArtifact");
  const jobHubStatsIdx = pageContent.indexOf("<LandingJobHubStatsSection");
  const featuresIdx = pageContent.indexOf("<LandingFeaturesSection");

  assert(topArtifactIdx !== -1, "LandingTopArtifact must be present in src/app/page.tsx");
  assert(jobHubStatsIdx !== -1, "LandingJobHubStatsSection must be present in src/app/page.tsx");
  assert(featuresIdx !== -1, "LandingFeaturesSection must be present in src/app/page.tsx");

  assert(
    topArtifactIdx < jobHubStatsIdx,
    "LandingJobHubStatsSection must be placed directly BELOW LandingTopArtifact"
  );
  assert(
    jobHubStatsIdx < featuresIdx,
    "LandingJobHubStatsSection must be placed ABOVE LandingFeaturesSection"
  );
  console.log("  [PASS-LOCAL] LandingJobHubStatsSection is positioned directly below LandingTopArtifact and above LandingFeaturesSection");

  // Test 2: Component Structure, Headings & Mascot Appearance
  console.log("\nTEST 2: Headings, Running Person Icon, Brand Styling & Mascot...");
  const compPath = path.resolve(process.cwd(), "src/components/LandingJobHubStatsSection.tsx");
  assert(fs.existsSync(compPath), "LandingJobHubStatsSection.tsx must exist");
  const compCode = fs.readFileSync(compPath, "utf8");

  // Headings
  assert(
    compCode.includes("Real numbers, no promises"),
    "Block 1 must have heading 'Real numbers, no promises'"
  );
  assert(
    compCode.includes("Access a growing job hub"),
    "Block 2 must have heading 'Access a growing job hub'"
  );

  // Dashed leader line & outline icon
  assert(
    compCode.includes("border-dashed"),
    "Rows must use thin dashed leader lines (border-dashed)"
  );
  assert(
    compCode.includes("RunningPersonIcon"),
    "Block 2 must use a running-person style outline icon"
  );

  // Mascot appears once
  const brandIconMatches = compCode.match(/<BrandIcon/g);
  assert.strictEqual(
    brandIconMatches?.length,
    1,
    `Mascot (BrandIcon) must appear exactly once in the section, found: ${brandIconMatches?.length}`
  );

  // Brand colors & Inter font
  assert(compCode.includes("#EFF6FF"), "Must use light blue #EFF6FF background token");
  assert(compCode.includes("#2563EB"), "Must use brand blue #2563EB accents");
  assert(compCode.includes("#090E34"), "Must use navy #090E34 text");

  // Responsive classes: mobile 40px numbers, single col, desktop 2 cols
  assert(compCode.includes("text-[40px]"), "Mobile must render 40px numbers (text-[40px])");
  assert(compCode.includes("grid-cols-1"), "Must use single column layout on mobile (grid-cols-1)");
  assert(compCode.includes("lg:grid-cols-2"), "Must use two columns on desktop (lg:grid-cols-2)");
  console.log("  [PASS-LOCAL] Headings, RunningPersonIcon, mascot, brand colors, and responsive classes verified");

  // Test 3: Disallowed Marketing Claims & Fake Figure Checks
  console.log("\nTEST 3: Zero Hardcoded Marketing Figures & Disallowed Claims...");
  const forbiddenFigures = [/16[,.]?423/i, /16[,.]?000\+/i, /61[,.]?000\+/i, /12[,.]?000\+/i, /4\.5\s*million/i, /150\+/i];
  for (const regex of forbiddenFigures) {
    assert(!regex.test(compCode), `Component must not contain hardcoded figure matching ${regex}`);
  }

  const disallowedPhrases = [
    "trusted users",
    "interviews landed",
    "time saved",
    "No.1 choice",
    "Product Hunt",
    "Trustpilot",
    "OpenAI",
  ];
  for (const phrase of disallowedPhrases) {
    assert(
      !compCode.toLowerCase().includes(phrase.toLowerCase()),
      `Component must not contain disallowed phrase: "${phrase}"`
    );
  }
  console.log("  [PASS-LOCAL] Zero hardcoded figures and zero disallowed claims verified");

  // Test 4: Real Data Rendering & Row Hiding on Missing Stats
  console.log("\nTEST 4: Real Data Rendering & Selective Row Hiding...");
  const { default: LandingJobHubStatsSection } = await import(
    "../src/components/LandingJobHubStatsSection"
  );

  // Case A: Full stats
  const fullHtml = renderToStaticMarkup(
    React.createElement(LandingJobHubStatsSection, {
      initialStats: {
        totalJobs: 1420,
        jobsToday: 38,
        companies: 450,
        countries: 24,
      },
    })
  );

  assert(fullHtml.includes("Real numbers, no promises"), "Must render Block 1");
  assert(fullHtml.includes("Access a growing job hub"), "Must render Block 2");
  assert(fullHtml.includes("1,420"), "Must render formatted totalJobs 1,420");
  assert(fullHtml.includes("Total jobs"), "Must render Total jobs label");
  assert(fullHtml.includes("38"), "Must render formatted jobsToday 38");
  assert(fullHtml.includes("New jobs today"), "Must render New jobs today label");
  assert(fullHtml.includes("450"), "Must render formatted companies 450");
  assert(fullHtml.includes("Companies scanned"), "Must render Companies scanned label");
  assert(fullHtml.includes("24"), "Must render formatted countries 24");
  assert(fullHtml.includes("Countries covered"), "Must render Countries covered label");
  console.log("  [PASS-LOCAL] Full real stats render accurately with comma formatting");

  // Case B: Partial stats (countries missing)
  const partialHtml = renderToStaticMarkup(
    React.createElement(LandingJobHubStatsSection, {
      initialStats: {
        totalJobs: 1420,
        jobsToday: 38,
        companies: 450,
        countries: null,
      },
    })
  );

  assert(partialHtml.includes("Companies scanned"), "Companies row must remain visible");
  assert(!partialHtml.includes("Countries covered"), "Countries row must be hidden when missing/null");
  console.log("  [PASS-LOCAL] Row hiding verified: missing/null metric row is excluded cleanly");

  // Case C: All fail / unavailable -> render nothing (empty box avoided)
  const emptyHtml = renderToStaticMarkup(
    React.createElement(LandingJobHubStatsSection, {
      initialStats: {
        totalJobs: null,
        jobsToday: null,
        companies: null,
        countries: null,
      },
    })
  );
  assert.strictEqual(
    emptyHtml,
    "",
    "When all stats are missing or fetch fails, component must return null (render empty string, no empty box)"
  );
  console.log("  [PASS-LOCAL] Fail-safe verified: renders nothing when all stats fail/missing");

  // Test 5: Reduced-Motion Path
  console.log("\nTEST 5: Prefers-Reduced-Motion Inspection...");
  assert(
    compCode.includes("prefers-reduced-motion"),
    "Component must check prefers-reduced-motion media query"
  );
  assert(
    compCode.includes("prefersReducedMotion"),
    "Component must handle prefersReducedMotion flag"
  );
  console.log("  [PASS-LOCAL] Prefers-reduced-motion check verified");

  console.log("\n================================================================================");
  console.log("ALL LANDING JOB HUB STATS CHECKS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
