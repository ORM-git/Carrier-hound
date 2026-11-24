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
    pageSrc.includes("The Usual Grind vs The Career Monke Way"),
    "Must include heading 'The Usual Grind vs The Career Monke Way'"
  );
  assert.ok(
    pageSrc.includes('id="vs"'),
    "Must include comparison table with id='vs'"
  );
  console.log("  -> [PASS-LOCAL] Comparison heading and table element verified.");

  // 2. All 5 Comparison Rows
  console.log("\nTest 2: Verifying 5 comparison criteria rows...");
  // Usual Grind column unchanged; only the five Career Monke Way cells were rewritten (owner request).
  const expectedRows = [
    ["800+ applicants per listing", "Jobs matched to your resume"],
    ["Hours tailoring every bullet", "See your percentage match score"],
    ["Resumes lost in black holes", "Verified employer job listings"],
    ["Ghost and expired reposts", "Filter jobs by role, location and work mode"],
    ["Auto-rejected in 10 minutes", "Apply on the employer's careers page"],
  ];

  for (const [usual, monke] of expectedRows) {
    assert.ok(pageSrc.includes(usual), `Must include usual criterion "${usual}"`);
    assert.ok(pageSrc.includes(monke), `Must include monke criterion "${monke}"`);
  }
  // Row pairing and order: cells read left-to-right, top-to-bottom, exactly these ten.
  const cells = Array.from(pageSrc.matchAll(/<span className="vx">\s*([^<]*?)\s*<\/span>/g), (m) => m[1]);
  assert.deepStrictEqual(cells, expectedRows.flat(), "Comparison cells must be exactly the five rows above, in order");
  for (const old of ["Under 20 applicants, direct", "1-tap ATS-matched resume", "Instant keyword match score", "From verified employers", "Seen by recruiters early"]) {
    assert.ok(!pageSrc.includes(old), `Replaced Career Monke cell must be gone: "${old}"`);
  }
  for (const monke of expectedRows.map((r) => r[1])) {
    assert.ok(
      !/\bAI\b|ATS|interview|guarantee|applicants?\b|\d+\s*minutes?|instant|faster|early/i.test(monke),
      `Career Monke cell must not make AI-resume, interview, guarantee, applicant-count or speed claims: "${monke}"`
    );
  }
  // Same five-row layout and icons: 10 cells, 10 icons, 5 ✕ and 5 ✓ badges.
  const vsTable = pageSrc.slice(pageSrc.indexOf('id="vs"'), pageSrc.indexOf("</table>"));
  assert.strictEqual((vsTable.match(/<tr>/g) || []).length, 6, "Comparison must keep 1 header row + 5 body rows");
  assert.strictEqual((vsTable.match(/className="vi"/g) || []).length, 10, "Comparison must keep all 10 icons");
  assert.strictEqual((vsTable.match(/className="vb no"/g) || []).length, 5, "Usual column keeps 5 ✕ badges");
  assert.strictEqual((vsTable.match(/className="vb ok"/g) || []).length, 5, "Career Monke column keeps 5 ✓ badges");
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
