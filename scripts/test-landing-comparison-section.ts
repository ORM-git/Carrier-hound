import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = process.cwd();
const isNegativeControl = process.argv.includes("--negative-control");

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-landing-comparison-section.ts", "--negative-control"],
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

async function runTests() {
  console.log("================================================================================");
  console.log("       LANDING COMPARISON SECTION VERIFICATION SUITE                            ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Inducing intentional assertion failure...");
    assert.strictEqual("actual", "intentional-comparison-failure");
    return;
  }

  runNegativeControlSubprocess();

  const pagePath = path.resolve(ROOT, "src", "app", "page.tsx");
  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  const pageSrc = fs.readFileSync(pagePath, "utf8");

  // 1. Heading
  console.log("Test 1: Heading & comparison section wrapper...");
  assert.ok(
    pageSrc.includes("The Usual Grind vs The CareerMonke Way"),
    "Must include heading 'The Usual Grind vs The CareerMonke Way'"
  );
  assert.ok(
    pageSrc.includes('id="vs"'),
    "Must include comparison table with id='vs'"
  );
  console.log("  -> [PASS-LOCAL] Comparison heading and table element verified.");

  // 2. All 5 Comparison Rows
  console.log("\nTest 2: Verifying 5 comparison criteria rows...");
  const expectedRows = [
    ["800+ applicants per listing", "Under 20 applicants, direct"],
    ["Hours tailoring every bullet", "1-tap ATS-matched resume"],
    ["Resumes lost in black holes", "Instant keyword match score"],
    ["Ghost and expired reposts", "Live from verified career sites"],
    ["Auto-rejected in 10 minutes", "Seen by recruiters early"],
  ];

  for (const [usual, monke] of expectedRows) {
    assert.ok(pageSrc.includes(usual), `Must include usual criterion "${usual}"`);
    assert.ok(pageSrc.includes(monke), `Must include monke criterion "${monke}"`);
  }
  console.log("  -> [PASS-LOCAL] All 5 comparison criteria rows verified with 100% fidelity.");

  // 3. No Heavy GIF in page.tsx (Performance Rule)
  console.log("\nTest 3: Zero heavy comparison GIF in landing page (light first load)...");
  assert.ok(
    !pageSrc.includes("careermonke-comparison-boxes.gif"),
    "page.tsx must not load heavy careermonke-comparison-boxes.gif (lightweight SVG/CSS table only)"
  );
  console.log("  -> [PASS-LOCAL] Confirmed no heavy comparison GIF on landing route.");

  console.log("\n================================================================================");
  console.log("ALL LANDING COMPARISON SECTION TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
