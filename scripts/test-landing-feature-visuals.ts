import fs from "fs";
import path from "path";
import assert from "assert";
import { spawnSync } from "child_process";

/**
 * CareerMonke Landing Feature Visuals Verification Suite
 * Verifies:
 * 1. src/app/page.tsx features section with 3 steps ("The whole hunt, in one place"), ssampe@3386250.
 * 2. Step 1: Interactive 3D particle globe canvas (#globe, data-run="city", city selection).
 * 3. Step 2: Automated career pages scanner (data-run="pages").
 * 4. Step 3: Role match score card (data-run="match").
 * 5. The AI-resume panel (data-run="tailor") and the standalone Find Jobs block stay removed.
 * 6. src/components/landing/careermonke-landing-lower-runtime.ts runtime controller and clean cleanup.
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
  // Feature cards run in the lower-page runtime; the top fold runtime only sizes the job-card peek.
  const runtimePath = path.join(root, "src", "components", "landing", "careermonke-landing-lower-runtime.ts");

  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  assert.ok(fs.existsSync(runtimePath), "careermonke-landing-lower-runtime.ts must exist");

  const pageContent = fs.readFileSync(pagePath, "utf8");
  const runtimeContent = fs.readFileSync(runtimePath, "utf8");

  // 1. Heading & Four Steps Structure
  assert.ok(
    pageContent.includes("The whole hunt, in one place"),
    "page.tsx must contain features section heading 'The whole hunt, in one place'"
  );

  const expectedSteps = [
    "Explore jobs by city",
    "Verified employer jobs",
    "Personalized matches",
  ];
  for (const step of expectedSteps) {
    assert.ok(
      pageContent.includes(step),
      `Features section must include step: "${step}"`
    );
  }
  // Exactly three feature blocks, numbered 1-3, in this order.
  const stepIdx = expectedSteps.map((st) => pageContent.indexOf(st));
  assert.ok(stepIdx[0] < stepIdx[1] && stepIdx[1] < stepIdx[2], "Feature steps must keep the order city, verified, matches");
  assert.strictEqual((pageContent.match(/<li className="fxi">/g) || []).length, 3, "Features must have exactly 3 blocks");
  const nums = Array.from(pageContent.matchAll(/<span className="fnum" aria-hidden="true">\s*(\d)\s*<\/span>/g), (m) => m[1]);
  assert.deepStrictEqual(nums, ["1", "2", "3"], "Feature blocks must be numbered 1, 2, 3");

  // 2. Step 1: Globe Canvas
  assert.ok(pageContent.includes('id="globe"'), "Step 1 must contain canvas id='globe'");
  assert.ok(pageContent.includes('data-run="city"'), "Step 1 must have data-run='city'");
  assert.ok(pageContent.includes('href="/radar"'), "Step 1 must link to /radar");

  // 3. Step 2: Scanner
  assert.ok(pageContent.includes('data-run="pages"'), "Step 2 must have data-run='pages'");

  // 4. AI-resume panel and standalone Find Jobs block must stay removed (owner request)
  assert.ok(!pageContent.includes('data-run="tailor"'), "AI-resume panel (data-run='tailor') must not come back");
  assert.ok(!pageContent.includes("A resume for every role"), "AI-resume feature step must not come back");
  assert.ok(!/className="(hjs|fj-cards|fj-note)"|>\s*Find Jobs\s*</.test(pageContent), "Standalone Find Jobs block must not come back");

  // 5. Step 3: Match Score
  assert.ok(pageContent.includes('data-run="match"'), "Step 3 must have data-run='match'");

  // 6. Runtime Controller Verification
  assert.ok(
    runtimeContent.includes("export function initCareerMonkeLandingLower(root: HTMLElement)"),
    "Lower runtime must export initCareerMonkeLandingLower(root)"
  );
  assert.ok(
    runtimeContent.includes("RUN: Record<string"),
    "Runtime must contain RUN dispatch dictionary for city, pages, match"
  );
  assert.ok(
    runtimeContent.includes("cardObservers.forEach"),
    "Runtime must provide cleanup for intersection observers"
  );

  console.log("  [PASS-LOCAL] All 3 landing feature visuals and runtime assertions passed cleanly.");
}

runSuite();
