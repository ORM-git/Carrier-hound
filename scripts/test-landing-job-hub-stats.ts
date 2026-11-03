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
  console.log("TEST SUITE: Landing Job Hub & Real Stats Section Verification (Single Wide Layout)");
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

  // Test 2: Component Structure, Headings, Icons & Single Wide Layout
  console.log("\nTEST 2: Headings, Dotted Connector, Icons, Brand Styling & Mascot...");
  const compPath = path.resolve(process.cwd(), "src/components/LandingJobHubStatsSection.tsx");
  assert(fs.existsSync(compPath), "LandingJobHubStatsSection.tsx must exist");
  const compCode = fs.readFileSync(compPath, "utf8");

  // Left Headline: Real numbers, no promises (2 lines, uppercase, navy #090E34)
  assert(
    compCode.includes("Real numbers,") && compCode.includes("no promises"),
    "Left column must have 2-line headline 'Real numbers, no promises'"
  );
  assert(
    compCode.includes("uppercase"),
    "Headline must be styled with uppercase"
  );
  assert(
    compCode.includes("text-[#090E34]"),
    "Headline and numbers must use navy #090E34 token"
  );

  // Dot at right edge of headline
  assert(
    compCode.includes("rounded-full bg-[#2563EB]"),
    "Headline must have a small blue dot at its right edge"
  );

  // Center Dotted connector with bracket/curved split and arrowhead
  assert(
    compCode.includes("DottedConnector"),
    "Component must include DottedConnector"
  );
  assert(
    compCode.includes("strokeDasharray"),
    "Connector must use dotted stroke (strokeDasharray)"
  );
  assert(
    compCode.includes("<polygon"),
    "Connector must feature arrowhead polygons pointing to stat rows"
  );
  assert(
    compCode.includes("hidden lg:flex"),
    "Connector must be hidden on mobile (hidden lg:flex)"
  );

  // Outline Icons: building for companies, briefcase for total jobs, sparkles/clock for new today
  assert(compCode.includes("Building2"), "Must use Building2 outline icon for companies");
  assert(compCode.includes("Briefcase"), "Must use Briefcase outline icon for total jobs");
  assert(
    compCode.includes("Sparkles") || compCode.includes("Clock"),
    "Must use Sparkles or Clock outline icon for new jobs today"
  );

  // Long dotted horizontal line
  assert(
    compCode.includes("border-dotted"),
    "Stat rows must feature long dotted horizontal leader lines (border-dotted)"
  );

  // Single wide section, no two-card boxes, no card borders
  assert(
    !compCode.includes("grid-cols-2") && !compCode.includes("rounded-3xl p-6 sm:p-8 lg:p-10 shadow-xs flex flex-col justify-between"),
    "Must not use two-card boxes or card border containers"
  );

  // Mascot appears once
  const brandIconMatches = compCode.match(/<BrandIcon/g);
  assert.strictEqual(
    brandIconMatches?.length,
    1,
    `Mascot (BrandIcon) must appear exactly once in the section, found: ${brandIconMatches?.length}`
  );

  // Brand colors & responsive classes
  assert(compCode.includes("#EFF6FF"), "Must use light background token #EFF6FF");
  assert(compCode.includes("#2563EB"), "Must use brand blue #2563EB accents");
  assert(compCode.includes("text-[40px]"), "Mobile must render 40px numbers (text-[40px])");
  console.log("  [PASS-LOCAL] Single wide layout, headline, dotted connector, icons, mascot, and brand styling verified");

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

  // Test 4: Real Data Rendering & Strict Selective Row Hiding
  console.log("\nTEST 4: Real Data Rendering & Selective Row Hiding (Jobs Today = 0 must NOT show)...");
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
      },
    })
  );

  assert(fullHtml.includes("Real numbers,"), "Must render headline 'Real numbers,'");
  assert(fullHtml.includes("no promises"), "Must render headline 'no promises'");
  assert(fullHtml.includes("1,420"), "Must render formatted totalJobs 1,420");
  assert(fullHtml.includes("Total jobs"), "Must render Total jobs label");
  assert(fullHtml.includes("38"), "Must render formatted jobsToday 38");
  assert(fullHtml.includes("New jobs today"), "Must render New jobs today label");
  assert(fullHtml.includes("450"), "Must render formatted companies 450");
  assert(fullHtml.includes("Companies scanned"), "Must render Companies scanned label");
  console.log("  [PASS-LOCAL] Full real stats render accurately with comma formatting");

  // Case B: jobsToday === 0 -> MUST HIDE (prompt requirement: "new jobs today must not show 0")
  const zeroTodayHtml = renderToStaticMarkup(
    React.createElement(LandingJobHubStatsSection, {
      initialStats: {
        totalJobs: 1420,
        jobsToday: 0,
        companies: 450,
      },
    })
  );

  assert(zeroTodayHtml.includes("Companies scanned"), "Companies row must remain visible");
  assert(zeroTodayHtml.includes("Total jobs"), "Total jobs row must remain visible");
  assert(
    !zeroTodayHtml.includes("New jobs today"),
    "New jobs today must be strictly HIDDEN when value is 0"
  );
  console.log("  [PASS-LOCAL] Strict rule verified: new jobs today is HIDDEN when value is 0");

  // Case C: Partial stats (companies missing/null)
  const partialHtml = renderToStaticMarkup(
    React.createElement(LandingJobHubStatsSection, {
      initialStats: {
        totalJobs: 1420,
        jobsToday: 25,
        companies: null,
      },
    })
  );

  assert(partialHtml.includes("Total jobs"), "Total jobs row must remain visible");
  assert(partialHtml.includes("New jobs today"), "New jobs today row must remain visible");
  assert(!partialHtml.includes("Companies scanned"), "Companies row must be hidden when null");
  console.log("  [PASS-LOCAL] Missing/null metric row is excluded cleanly");

  // Case D: All fail / unavailable -> render nothing (empty box avoided)
  const emptyHtml = renderToStaticMarkup(
    React.createElement(LandingJobHubStatsSection, {
      initialStats: {
        totalJobs: null,
        jobsToday: 0,
        companies: null,
      },
    })
  );
  assert.strictEqual(
    emptyHtml,
    "",
    "When all stats are missing or 0, component must return null (render empty string, no empty box)"
  );
  console.log("  [PASS-LOCAL] Fail-safe verified: renders nothing when all stats fail/missing/zero");

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
