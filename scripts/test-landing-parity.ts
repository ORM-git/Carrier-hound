import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const isNegativeControl = process.argv.includes("--negative-control");

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-landing-parity.ts", "--negative-control"],
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

async function runParityTests() {
  console.log("================================================================================");
  console.log("       LANDING 1:1 PARITY & FOUNDER PHOTO VERIFICATION SUITE                    ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Inducing intentional assertion failure...");
    assert.strictEqual("actual", "intentional-parity-failure");
    return;
  }

  runNegativeControlSubprocess();

  const pagePath = path.resolve(ROOT, "src", "app", "page.tsx");
  const cssPath = path.resolve(ROOT, "src", "styles", "careermonke-landing.css");
  const runtimePath = path.resolve(ROOT, "src", "components", "landing", "careermonke-landing-runtime.ts");
  const ownerImgPath = path.resolve(ROOT, "public", "owner.jpg");

  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  assert.ok(fs.existsSync(cssPath), "src/styles/careermonke-landing.css must exist");
  assert.ok(fs.existsSync(runtimePath), "src/components/landing/careermonke-landing-runtime.ts must exist");
  assert.ok(fs.existsSync(ownerImgPath), "public/owner.jpg must exist in repository");

  const pageSrc = fs.readFileSync(pagePath, "utf8");
  const cssSrc = fs.readFileSync(cssPath, "utf8");
  const ownerImgStat = fs.statSync(ownerImgPath);

  // 1. Founder photo asset verification
  console.log("Test 1: Founder photo asset integrity...");
  assert.ok(ownerImgStat.size > 50000, `public/owner.jpg must be a valid non-empty photo (got ${ownerImgStat.size} bytes)`);

  // 2. Founder Section 1:1 Parity and Exact Placement
  console.log("Test 2: Founder section markup & sequence placement...");
  const finalCtaIdx = pageSrc.indexOf('id="cta-h"');
  const founderIdx = pageSrc.indexOf('id="f-h"');
  const feedbackWallIdx = pageSrc.indexOf('id="w-h"');

  assert.ok(finalCtaIdx !== -1, "Final CTA section must be present");
  assert.ok(founderIdx !== -1, "Founder section must be present");
  assert.ok(feedbackWallIdx !== -1, "Feedback Wall section must be present");
  assert.ok(
    finalCtaIdx < founderIdx && founderIdx < feedbackWallIdx,
    "Founder section MUST be placed exactly between Final CTA and Feedback Wall"
  );

  // Founder content checks
  assert.ok(pageSrc.includes('src="/owner.jpg"'), "Founder image must point to /owner.jpg");
  assert.ok(
    pageSrc.includes('alt="Orissa Lee Patnaik, founder of CareerMonke"'),
    "Founder alt text must match 'Orissa Lee Patnaik, founder of CareerMonke'"
  );
  assert.ok(pageSrc.includes('width="64" height="64"'), "Founder image markup must define width 64 height 64");
  assert.ok(pageSrc.includes("Orissa here!"), "Founder heading must be 'Orissa here!'");
  assert.ok(
    pageSrc.includes("Orissa Lee Patnaik · Creator of CareerMonke"),
    "Founder role must be 'Orissa Lee Patnaik · Creator of CareerMonke'"
  );
  assert.ok(
    pageSrc.includes("Growing up in the US and living in India showed me job hunting is broken everywhere."),
    "Founder bio paragraph 1 must match"
  );
  assert.ok(
    pageSrc.includes("Broken software discards qualified people, and legacy sites make every role a cattle call. I built CareerMonke to cut through the noise and put your story in front of real people."),
    "Founder bio paragraph 2 must match"
  );
  assert.ok(
    pageSrc.includes('href="https://www.linkedin.com/in/orissa-patnaik-85071a1aa/"'),
    "Founder LinkedIn link must match"
  );
  assert.ok(
    pageSrc.includes('href="https://www.instagram.com/orissa.patnaik"'),
    "Founder Instagram link must match"
  );

  // 3. Founder CSS Styling & Dimensions
  console.log("Test 3: Founder styling across viewports...");
  assert.ok(cssSrc.includes(".founder{grid-template-columns:56px 1fr;gap:16px}"), "Founder mobile width must be 56px");
  assert.ok(cssSrc.includes(".founder img{width:56px;height:56px}"), "Founder mobile img size must be 56x56");
  assert.ok(cssSrc.includes(".founder{grid-template-columns:80px 1fr;gap:24px}"), "Founder desktop width must be 80px");
  assert.ok(cssSrc.includes(".founder img{width:80px;height:80px}"), "Founder desktop img size must be 80x80");

  // 4. Header, Hero, Demo, Stats, Comparison, Footer Section Sequence
  console.log("Test 4: Section-by-section sequence check...");
  const headerIdx = pageSrc.indexOf('<header');
  const heroIdx = pageSrc.indexOf('id="hero-h"');
  const demoIdx = pageSrc.indexOf('id="demo"');
  const statsIdx = pageSrc.indexOf('id="stats-note"');
  const featIdx = pageSrc.indexOf('id="feat-h"');
  const testIdx = pageSrc.indexOf('id="t-h"');
  const cmpIdx = pageSrc.indexOf('id="cmp-h"');
  const faqIdx = pageSrc.indexOf('id="q-h"');
  const contactIdx = pageSrc.indexOf('id="c-h"');
  const footerIdx = pageSrc.indexOf('<footer');

  const orderedIndices = [
    { name: "header", idx: headerIdx },
    { name: "hero", idx: heroIdx },
    { name: "demo", idx: demoIdx },
    { name: "stats", idx: statsIdx },
    { name: "features", idx: featIdx },
    { name: "testimonials", idx: testIdx },
    { name: "comparison", idx: cmpIdx },
    { name: "finalCta", idx: finalCtaIdx },
    { name: "founder", idx: founderIdx },
    { name: "feedbackWall", idx: feedbackWallIdx },
    { name: "faq", idx: faqIdx },
    { name: "contact", idx: contactIdx },
    { name: "footer", idx: footerIdx },
  ];

  for (let i = 0; i < orderedIndices.length - 1; i++) {
    const cur = orderedIndices[i];
    const nxt = orderedIndices[i + 1];
    assert.ok(cur.idx !== -1, `Section ${cur.name} must exist`);
    assert.ok(nxt.idx !== -1, `Section ${nxt.name} must exist`);
    assert.ok(
      cur.idx < nxt.idx,
      `Section sequence violation: ${cur.name} (idx=${cur.idx}) must precede ${nxt.name} (idx=${nxt.idx})`
    );
  }

  // 5. Stat metrics check (no changed numbers)
  console.log("Test 5: Stats laurels numbers and copy...");
  assert.ok(pageSrc.includes("<b>3x</b>"), "Stats must include 3x");
  assert.ok(pageSrc.includes("higher callback rate"), "Stats must include 'higher callback rate'");
  assert.ok(pageSrc.includes("<b>94%</b>"), "Stats must include 94%");
  assert.ok(pageSrc.includes("ATS keyword alignment"), "Stats must include 'ATS keyword alignment'");
  assert.ok(pageSrc.includes("<b>1,200+</b>"), "Stats must include 1,200+");
  assert.ok(pageSrc.includes("fresh roles <span className=\"sbr\">daily</span>"), "Stats must include 'fresh roles daily'");
  assert.ok(pageSrc.includes("*Based on early access user surveys"), "Stats must include survey note");

  console.log("\n✅ ALL LANDING PARITY & FOUNDER PHOTO TESTS PASSED!");
}

runParityTests().catch(err => {
  console.error(err);
  process.exit(1);
});
