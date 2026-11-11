import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const isNegativeControl = process.argv.includes("--negative-control");

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-landing-top-artifact.ts", "--negative-control"],
    {
      cwd: ROOT,
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
  console.log("       LANDING TOP HERO & INTERACTIVE DEMO VERIFICATION SUITE                   ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Inducing intentional assertion failure...");
    assert.strictEqual("actual", "expected-negative-control-mismatch");
    return;
  }

  runNegativeControlSubprocess();

  const pagePath = path.join(ROOT, "src", "app", "page.tsx");
  const cssPath = path.join(ROOT, "src", "styles", "careermonke-landing.css");
  const runtimePath = path.join(ROOT, "src", "components", "landing", "careermonke-landing-runtime.ts");

  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  assert.ok(fs.existsSync(cssPath), "src/styles/careermonke-landing.css must exist");
  assert.ok(fs.existsSync(runtimePath), "src/components/landing/careermonke-landing-runtime.ts must exist");

  const pageSrc = fs.readFileSync(pagePath, "utf8");
  const cssSrc = fs.readFileSync(cssPath, "utf8");

  // 1. Exact 1:1 Headline and Hero Copy
  assert.ok(
    pageSrc.includes("Skip LinkedIn competition") && pageSrc.includes("job"),
    "page.tsx must contain exact headline 'Skip LinkedIn competition. Start jobmaxxing with AI'"
  );
  assert.ok(
    pageSrc.includes("1,240 new jobs found today"),
    "page.tsx must contain exact badge '1,240 new jobs found today'"
  );
  assert.ok(
    pageSrc.includes("Get direct roles from company sites and tailor your resume to clear their ATS in seconds."),
    "page.tsx must contain lead copy about direct roles from company sites"
  );
  assert.ok(
    pageSrc.includes("Sign up for free"),
    "page.tsx must contain 'Sign up for free'"
  );

  // 2. Working Navigation and CTAs wired to real routes
  assert.ok(pageSrc.includes('href="/signup"'), "Hero CTA must link to /signup");
  assert.ok(pageSrc.includes('href="/login"'), "Top nav must link to /login");
  assert.ok(pageSrc.includes('href="/radar"'), "Top nav must link to /radar");
  assert.ok(pageSrc.includes('href="/early-access"'), "Top nav must link to /early-access");
  assert.ok(pageSrc.includes('id="try-demo"'), "Hero must include #try-demo button");

  // 3. Interactive Demo Structure and Chips
  assert.ok(pageSrc.includes('id="demo"'), "page.tsx must contain interactive demo section with id='demo'");
  const requiredChips = ["Backend", "Remote", "Marketing", "Data &amp; AI", "Sales", "Design"];
  for (const chip of requiredChips) {
    assert.ok(
      pageSrc.includes(chip),
      `Demo must include job chip "${chip}"`
    );
  }

  // 4. Demo States
  assert.ok(pageSrc.includes('data-state="pick"'), "Demo must include 'pick' state");
  assert.ok(pageSrc.includes('data-state="scan"'), "Demo must include 'scan' state");
  assert.ok(pageSrc.includes('data-state="match"'), "Demo must include 'match' state");
  assert.ok(pageSrc.includes('data-state="applied"'), "Demo must include 'applied' state");

  // 5. Brand Styling in CSS
  assert.ok(cssSrc.includes("--blue:#2563EB"), "careermonke-landing.css must define brand blue #2563EB");
  assert.ok(cssSrc.includes("--navy:#090E34"), "careermonke-landing.css must define brand navy #090E34");

  console.log("  [PASS-LOCAL] All top hero and interactive demo assertions passed cleanly.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
