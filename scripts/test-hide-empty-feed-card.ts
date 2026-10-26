import assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JobPreview from "../src/components/JobPreview";
import { Job } from "../src/data/jobs";

async function runHideEmptyFeedCardSuite() {
  console.log("================================================================================");
  console.log("         CAREERMONKE HIDE EMPTY FEED CARD TEST SUITE VERIFICATION               ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("\n[NEGATIVE CONTROL MODE] Proving assertions fail with non-zero exit on invalid condition...\n");
    // Deliberately assert that empty jobs renders feed card markup
    const emptyJobsMarkup = renderToStaticMarkup(
      React.createElement(JobPreview, { jobs: [], title: "Test Empty Feed" })
    );
    assert.ok(
      emptyJobsMarkup.length > 0,
      "Negative control expected mismatch: Empty jobs array MUST produce zero markup."
    );
    return;
  }

  const sampleJob: Job = {
    id: "test-job-uuid-1",
    title: "Senior Remote Infrastructure Engineer",
    company: "Stripe",
    location: "Remote (US)",
    date: "Today",
    salary: "$180,000 - $220,000",
    category: "engineering",
    remote: true,
    directSource: true,
    applyUrl: "https://stripe.com/jobs/apply/infra-1",
  };

  // ---------------------------------------------------------------------------
  // TEST 1: JobPreview Component with EMPTY jobs -> Returns NULL (Zero Markup)
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying JobPreview returns null when jobs array is empty...");
  const emptyMarkup = renderToStaticMarkup(
    React.createElement(JobPreview, {
      jobs: [],
      title: "Real-Time Engineering Feed",
    })
  );
  assert.strictEqual(emptyMarkup, "", "JobPreview with empty array must render empty string (null)");

  const nullJobsMarkup = renderToStaticMarkup(
    React.createElement(JobPreview, {
      jobs: null as any,
      title: "Real-Time Engineering Feed",
    })
  );
  assert.strictEqual(nullJobsMarkup, "", "JobPreview with null jobs must render empty string (null)");
  console.log("  -> [PASS-LOCAL] Empty/null jobs: Exactly zero DOM markup rendered.");

  // ---------------------------------------------------------------------------
  // TEST 2: JobPreview Component with POPULATED jobs -> Renders full feed card
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying JobPreview renders normally when jobs exist...");
  const populatedMarkup = renderToStaticMarkup(
    React.createElement(JobPreview, {
      jobs: [sampleJob],
      title: "Real-Time Engineering Feed",
      subtitle: "Scraped from employer subdomains",
      limit: 5,
    })
  );
  assert.ok(populatedMarkup.includes("Real-Time Engineering Feed"), "Title must be present");
  assert.ok(populatedMarkup.includes("Senior Remote Infrastructure Engineer"), "Job title must be present");
  assert.ok(populatedMarkup.includes("Stripe"), "Company name must be present");
  assert.ok(populatedMarkup.includes("$180,000 - $220,000"), "Salary chip must be present");
  assert.ok(populatedMarkup.includes("Feed snapshot • Just now UTC"), "Status dot text must be present");
  console.log("  -> [PASS-LOCAL] Populated jobs: Rendered full feed card with all expected elements.");

  // ---------------------------------------------------------------------------
  // TEST 3: /remote/jobs/[category] page source guard verification
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying /remote/jobs/[category] guards JobPreview when sampleJobs is empty...");
  const categoryPagePath = path.resolve(process.cwd(), "src/app/remote/jobs/[category]/page.tsx");
  const categorySource = fs.readFileSync(categoryPagePath, "utf-8");

  // Verify that JobPreview is guarded by sampleJobs.length > 0
  const hasCategoryGuard =
    categorySource.includes("sampleJobs && sampleJobs.length > 0 && (") ||
    categorySource.includes("sampleJobs.length > 0 && (");
  assert.ok(
    hasCategoryGuard,
    "src/app/remote/jobs/[category]/page.tsx must conditionally guard <JobPreview> with sampleJobs.length > 0"
  );
  // Verify no fake placeholder or new copy was added
  assert.ok(
    !categorySource.includes("No openings right now"),
    "Category page must NOT add new placeholder copy when empty"
  );
  console.log("  -> [PASS-LOCAL] /remote/jobs/[category]: Conditional guard present; 0 placeholder copy.");

  // ---------------------------------------------------------------------------
  // TEST 4: /remote/[slug]/titles page source guard verification
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Verifying /remote/[slug]/titles guards JobPreview when roleJobs is empty...");
  const titlesPagePath = path.resolve(process.cwd(), "src/app/remote/[slug]/titles/page.tsx");
  const titlesSource = fs.readFileSync(titlesPagePath, "utf-8");

  // Verify that JobPreview is guarded by roleJobs.length > 0
  const hasTitlesGuard =
    titlesSource.includes("roleJobs && roleJobs.length > 0 && (") ||
    titlesSource.includes("roleJobs.length > 0 && (");
  assert.ok(
    hasTitlesGuard,
    "src/app/remote/[slug]/titles/page.tsx must conditionally guard <JobPreview> with roleJobs.length > 0"
  );
  // Verify no fake placeholder or new copy was added
  assert.ok(
    !titlesSource.includes("No openings right now"),
    "Titles page must NOT add new placeholder copy when empty"
  );
  console.log("  -> [PASS-LOCAL] /remote/[slug]/titles: Conditional guard present; 0 placeholder copy.");

  // ---------------------------------------------------------------------------
  // TEST 5: Subprocess Negative Control Verification
  // ---------------------------------------------------------------------------
  console.log("\nTest 5: Confirming negative control fails with non-zero exit code...");
  const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
    encoding: "utf-8",
    env: process.env,
  });

  assert.notStrictEqual(
    negResult.status,
    0,
    "Negative control MUST exit with non-zero exit code when invalid condition is asserted!"
  );
  console.log(`  -> [PASS-LOCAL] Negative control exited non-zero (${negResult.status}) as expected.`);

  console.log("\n================================================================================");
  console.log("       ALL HIDE EMPTY FEED CARD TESTS PASSED SUCCESSFULLY [PASS-LOCAL]          ");
  console.log("================================================================================");
}

runHideEmptyFeedCardSuite().catch((err) => {
  console.error("\n[FAIL] Hide Empty Feed Card Suite Error:\n", err);
  process.exit(1);
});
