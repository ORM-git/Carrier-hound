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
  console.log("TEST SUITE: Landing Job Hub & Stats Section Verification (Reference 3-Row Layout)");
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

  // Outline Icons: MessageSquare for interviews, Clock for time saved, Check for No.1 choice
  assert(!compCode.includes("Smile"), "Smile outline icon must be removed with trusted users");
  assert(compCode.includes("MessageSquare"), "Must use MessageSquare outline icon for interviews landed");
  assert(compCode.includes("Clock"), "Must use Clock outline icon for time saved");
  assert(compCode.includes("Check"), "Must use Check outline icon for No.1 choice");

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

  // Test 3: Disallowed Fake Figure Checks
  console.log("\nTEST 3: Zero Hardcoded Marketing Figures (jobs/companies)...");
  const forbiddenFigures = [/16[,.]?423/i, /16[,.]?000\+/i, /61[,.]?000\+/i, /12[,.]?000\+/i, /4\.5\s*million/i, /150\+/i];
  for (const regex of forbiddenFigures) {
    assert(!regex.test(compCode), `Component must not contain hardcoded figure matching ${regex}`);
  }

  const disallowedPhrases = [
    "Product Hunt",
    "Trustpilot",
    "OpenAI TOP PICK",
  ];
  for (const phrase of disallowedPhrases) {
    assert(
      !compCode.toLowerCase().includes(phrase.toLowerCase()),
      `Component must not contain disallowed phrase: "${phrase}"`
    );
  }
  console.log("  [PASS-LOCAL] Zero hardcoded job/company figures and zero fake review badges verified");

  // Test 4: Rendering of 3 Approved Reference Points & Absence of 3,000,000
  console.log("\nTEST 4: Rendering of 3 Approved Reference Points & Absence of 3,000,000...");
  const { default: LandingJobHubStatsSection } = await import(
    "../src/components/LandingJobHubStatsSection"
  );

  const html = renderToStaticMarkup(React.createElement(LandingJobHubStatsSection));

  assert(html.includes("Real numbers,"), "Must render headline 'Real numbers,'");
  assert(html.includes("no promises"), "Must render headline 'no promises'");
  assert(!html.includes("3,000,000"), "Must NOT render 3,000,000 value");
  assert(!html.includes("trusted users"), "Must NOT render trusted users label");
  assert(html.includes("3x"), "Must render 3x value");
  assert(html.includes("interviews landed"), "Must render interviews landed label");
  assert(html.includes("80%"), "Must render 80% value");
  assert(html.includes("time saved on job search"), "Must render time saved on job search label");
  assert(html.includes("No.1 Choice"), "Must render No.1 Choice value");
  assert(html.includes("for 80% of job seekers after their first use"), "Must render No.1 choice label");
  console.log("  [PASS-LOCAL] All 3 reference points render accurately and 3,000,000 is absent");

  // Test 5: Layout Alignment & Clean Static Rendering
  console.log("\nTEST 5: Layout Alignment of Remaining Items...");
  assert(
    compCode.includes("justify-between"),
    "Remaining stat rows must maintain justify-between alignment"
  );
  assert(
    compCode.includes("lg:h-[288px]"),
    "Section must maintain fixed desktop bracket height lg:h-[288px]"
  );
  assert(
    !compCode.includes("3,000,000"),
    "Component code must not contain 3,000,000"
  );
  assert(
    !compCode.includes("trusted users"),
    "Component code must not contain 'trusted users'"
  );
  console.log("  [PASS-LOCAL] Even alignment and clean static rendering verified");

  console.log("\n================================================================================");
  console.log("ALL LANDING JOB HUB STATS CHECKS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
