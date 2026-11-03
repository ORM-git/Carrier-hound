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
  console.log("TEST SUITE: Landing Job Hub & Real Stats Section Verification (3-Row Layout)");
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

  // Center Dotted connector: exactly one connected root dot and curved bracket paths
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
  assert(
    compCode.includes("aria-hidden"),
    "Connector must be marked aria-hidden"
  );

  // Strictly NO "Companies scanned" row
  assert(
    !compCode.includes("Companies scanned"),
    "Must NOT show 'Companies scanned' label in this section"
  );

  // Outline Icons: briefcase for total jobs, sparkles for new today, percent for salary
  assert(compCode.includes("Briefcase"), "Must use Briefcase outline icon for total jobs");
  assert(compCode.includes("Sparkles"), "Must use Sparkles outline icon for new jobs today");
  assert(compCode.includes("Percent"), "Must use Percent outline icon for zero salary cut");

  // Long dotted horizontal leader lines
  assert(
    compCode.includes("border-dotted"),
    "Stat rows must feature long dotted horizontal leader lines (border-dotted)"
  );

  // Circular outline icons (no square cards, no card containers)
  assert(
    compCode.includes("rounded-full border border-blue-300"),
    "Must use thin blue circular outline around icons"
  );
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

  // Test 4: Real Data Rendering, Neutral Placeholders, and 0 Display
  console.log("\nTEST 4: Real Data Rendering & Neutral Placeholders...");
  const { default: LandingJobHubStatsSection } = await import(
    "../src/components/LandingJobHubStatsSection"
  );

  // Case A: Full stats
  const fullHtml = renderToStaticMarkup(
    React.createElement(LandingJobHubStatsSection, {
      initialStats: {
        totalJobs: 1420,
        jobsToday: 38,
      },
    })
  );

  assert(fullHtml.includes("Real numbers,"), "Must render headline 'Real numbers,'");
  assert(fullHtml.includes("no promises"), "Must render headline 'no promises'");
  assert(fullHtml.includes("1,420"), "Must render formatted totalJobs 1,420");
  assert(fullHtml.includes("Total jobs"), "Must render Total jobs label");
  assert(fullHtml.includes("38"), "Must render formatted jobsToday 38");
  assert(fullHtml.includes("New jobs today"), "Must render New jobs today label");
  assert(!fullHtml.includes("Companies scanned"), "Companies scanned row must NOT be present");
  assert(fullHtml.includes("0%"), "Must render static 0% cut of salary");
  assert(fullHtml.includes("cut of your salary, ever"), "Must render cut of salary label");
  console.log("  [PASS-LOCAL] Full real stats render accurately with comma formatting and no Companies scanned");

  // Case B: jobsToday === 0 -> MUST DISPLAY 0 (Prompt requirement: "A successful jobsToday: 0 response MUST display 0")
  const zeroTodayHtml = renderToStaticMarkup(
    React.createElement(LandingJobHubStatsSection, {
      initialStats: {
        totalJobs: 1420,
        jobsToday: 0,
      },
    })
  );

  assert(zeroTodayHtml.includes("Total jobs"), "Total jobs row must remain visible");
  assert(zeroTodayHtml.includes("New jobs today"), "New jobs today row must be visible");
  assert(zeroTodayHtml.includes(">0<"), "New jobs today MUST display 0 when jobsToday is 0");
  console.log("  [PASS-LOCAL] Strict rule verified: jobsToday: 0 response displays 0");

  // Case C: Partial stats (totalJobs missing/null) -> renders neutral placeholder "—"
  const partialHtml = renderToStaticMarkup(
    React.createElement(LandingJobHubStatsSection, {
      initialStats: {
        totalJobs: null,
        jobsToday: 25,
      },
    })
  );

  assert(partialHtml.includes("Total jobs"), "Total jobs row must remain visible");
  assert(partialHtml.includes("New jobs today"), "New jobs today row must remain visible");
  assert(partialHtml.includes("—"), "Missing/null metric must display neutral placeholder '—'");
  console.log("  [PASS-LOCAL] Neutral placeholder '—' verified for missing/null metric");

  // Case D: API Error / Missing stats -> renders neutral placeholder "—" for dynamic metrics
  const errorHtml = renderToStaticMarkup(
    React.createElement(LandingJobHubStatsSection, {
      initialStats: {
        totalJobs: null,
        jobsToday: null,
      },
    })
  );
  assert(errorHtml.includes("—"), "During error/null state, dynamic stats must display placeholder '—'");
  assert(errorHtml.includes("0%"), "Static 0% remains visible during error state");
  console.log("  [PASS-LOCAL] API error state verified with neutral placeholders");

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
