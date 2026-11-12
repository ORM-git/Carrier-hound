import fs from "fs";
import path from "path";
import assert from "assert";
import { spawnSync } from "child_process";

/**
 * CareerMonke Landing Feature Visuals Verification Suite
 * Verifies:
 * 1. src/app/page.tsx features section with 4 steps ("The whole hunt, in one place").
 * 2. Step 1: Interactive 3D particle globe canvas (#globe, data-run="city", city selection).
 * 3. Step 2: Automated career pages scanner (data-run="pages").
 * 4. Step 3: ATS resume diff tailoring card (data-run="tailor").
 * 5. Step 4: Role match score card (data-run="match").
 * 6. src/components/landing/careermonke-landing-runtime.ts runtime controller and clean cleanup.
 * 7. Negative control verification.
 */

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-landing-feature-visuals.ts", "--negative-control"],
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

function runSuite() {
  console.log("================================================================================");
  console.log("       LANDING FEATURE VISUALS & RUNTIME VERIFICATION SUITE                     ");
  console.log("================================================================================\n");

  if (process.argv.includes("--negative-control")) {
    console.log("  [NEGATIVE CONTROL] Inducing intentional assertion failure...");
    assert.strictEqual("feature-visuals", "intentional-failure-mode");
    process.exit(0);
  }

  runNegativeControlSubprocess();

  const root = process.cwd();
  const pagePath = path.join(root, "src", "app", "page.tsx");
  const runtimePath = path.join(root, "src", "components", "landing", "careermonke-landing-runtime.ts");

  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  assert.ok(fs.existsSync(runtimePath), "careermonke-landing-runtime.ts must exist");

  const pageContent = fs.readFileSync(pagePath, "utf8");
  const runtimeContent = fs.readFileSync(runtimePath, "utf8");

  // 1. Heading & Four Steps Structure
  assert.ok(
    pageContent.includes("The whole hunt, in one place"),
    "page.tsx must contain features section heading 'The whole hunt, in one place'"
  );

  const expectedSteps = [
    "Explore jobs by city",
    "Jobs from career pages",
    "A resume for every role",
    "Personalized matches",
  ];
  for (const step of expectedSteps) {
    assert.ok(
      pageContent.includes(step),
      `Features section must include step: "${step}"`
    );
  }

  // 2. Step 1: Globe Canvas
  assert.ok(pageContent.includes('id="globe"'), "Step 1 must contain canvas id='globe'");
  assert.ok(pageContent.includes('data-run="city"'), "Step 1 must have data-run='city'");
  assert.ok(pageContent.includes('href="/radar"'), "Step 1 must link to /radar");

  // 3. Step 2: Scanner
  assert.ok(pageContent.includes('data-run="pages"'), "Step 2 must have data-run='pages'");

  // 4. Step 3: Resume Tailor
  assert.ok(pageContent.includes('data-run="tailor"'), "Step 3 must have data-run='tailor'");

  // 5. Step 4: Match Score
  assert.ok(pageContent.includes('data-run="match"'), "Step 4 must have data-run='match'");

  // 6. Runtime Controller Verification
  assert.ok(
    runtimeContent.includes("initCareerMonkeLanding"),
    "Runtime must export initCareerMonkeLanding"
  );
  assert.ok(
    runtimeContent.includes("RUN: Record<string"),
    "Runtime must contain RUN dispatch dictionary for city, pages, tailor, match"
  );
  assert.ok(
    runtimeContent.includes("cardObservers.forEach"),
    "Runtime must provide cleanup for intersection observers"
  );

  console.log("  [PASS-LOCAL] All 4 landing feature visuals and runtime assertions passed cleanly.");
}

runSuite();
