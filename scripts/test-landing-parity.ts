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
  // Lower page (stats .. footer) is ssampe@3386250 in its own scoped stylesheet; the top fold is careermonke-landing.css.
  const cssPath = path.resolve(ROOT, "src", "styles", "careermonke-landing-lower.css");
  const runtimePath = path.resolve(ROOT, "src", "components", "landing", "careermonke-landing-runtime.ts");
  const ownerImgPath = path.resolve(ROOT, "public", "owner.jpg");

  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  assert.ok(fs.existsSync(cssPath), "src/styles/careermonke-landing-lower.css must exist");
  assert.ok(fs.existsSync(runtimePath), "src/components/landing/careermonke-landing-runtime.ts must exist");
  assert.ok(fs.existsSync(ownerImgPath), "public/owner.jpg must exist in repository");

  // JSX wraps long copy across lines; compare copy on whitespace-normalised source.
  const pageSrc = fs.readFileSync(pagePath, "utf8").replace(/\{" "\}/g, " ").replace(/\s+/g, " ");
  const cssSrc = fs.readFileSync(cssPath, "utf8");
  const ownerImgStat = fs.statSync(ownerImgPath);

  // 1. Founder photo asset verification
  console.log("Test 1: Founder photo asset integrity...");
  assert.ok(ownerImgStat.size > 50000, `public/owner.jpg must be a valid non-empty photo (got ${ownerImgStat.size} bytes)`);

  // 2. Founder Section 1:1 Parity and Exact Placement
  console.log("Test 2: Founder section markup & sequence placement...");
  const finalCtaIdx = pageSrc.indexOf('id="cta-h"');
  const founderIdx = pageSrc.indexOf('id="fd-h"');
  const feedbackWallIdx = pageSrc.indexOf('id="w-h"');
  const reviewsIdx = pageSrc.indexOf('id="rv-h"');
  const faqHeadIdx = pageSrc.indexOf('id="q-h"');

  assert.ok(finalCtaIdx !== -1, "Final CTA section must be present");
  assert.ok(founderIdx !== -1, "Founder section must be present");
  assert.ok(feedbackWallIdx !== -1, "Feedback Wall section must be present");
  assert.ok(
    reviewsIdx < founderIdx && founderIdx < faqHeadIdx,
    "Founder section MUST be placed exactly between moving reviews and FAQs (ssampe@3386250 order)"
  );
  assert.ok(
    faqHeadIdx < feedbackWallIdx && feedbackWallIdx < finalCtaIdx,
    "Review wall MUST sit between FAQs and the lower Free preview"
  );

  // Company/logo strip placement check (directly between stats and the comparison table)
  const statsNoteIdx = pageSrc.indexOf('id="stats-note"');
  const tickerIdx = pageSrc.indexOf('<section className="ls" aria-label="Companies hiring now">');
  const cmpHeadingIdx = pageSrc.indexOf('id="cmp-h"');
  assert.ok(tickerIdx !== -1, "Company/logo strip must be rendered on homepage");
  assert.ok(!pageSrc.includes("<LandingJobsTickerStrip"), "Old LandingJobsTickerStrip must not be rendered");
  assert.ok(
    statsNoteIdx < tickerIdx && tickerIdx < cmpHeadingIdx,
    "Company/logo strip MUST be placed directly between the stats row and the comparison table"
  );

  // Founder content checks
  assert.ok(pageSrc.includes('src="/owner.jpg"'), "Founder image must point to /owner.jpg");
  assert.ok(
    pageSrc.includes('alt="Orissa Lee Patnaik, founder of Career Monke"'),
    "Founder alt text must match 'Orissa Lee Patnaik, founder of Career Monke'"
  );
  // Live careermonke.com founder card (owner request): 112x112 photo in a bordered card, socials below the bio.
  assert.ok(pageSrc.includes('width="112" height="112"'), "Founder image markup must define width 112 height 112");
  assert.ok(pageSrc.includes('<div className="founder">') && pageSrc.includes('<div className="founder-body">'), "Founder must use the live .founder card markup");
  assert.ok(pageSrc.includes("Orissa here!"), "Founder heading must be 'Orissa here!'");
  assert.ok(
    pageSrc.includes('<p className="role">Creator of Career Monke</p>'),
    "Founder role must be 'Creator of Career Monke'"
  );
  assert.ok(
    pageSrc.includes("Growing up in the US and living in India showed me the friction of job hunting is universal. Broken software discards qualified people, and legacy sites make every role a cattle call."),
    "Founder bio paragraph 1 must match"
  );
  assert.ok(
    pageSrc.includes("I built Career Monke to cut through the noise, give candidates leverage back, and land your story directly with real people without the unnecessary hollow hustle rhetoric."),
    "Founder bio paragraph 2 must match"
  );
  assert.ok(
    pageSrc.includes('href="https://www.linkedin.com/in/orissa-patnaik-85071a1aa/" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn"'),
    "Founder LinkedIn link must match"
  );
  assert.ok(
    pageSrc.includes('href="https://www.instagram.com/orissa.patnaik" target="_blank" rel="noopener noreferrer" aria-label="Instagram"'),
    "Founder Instagram link must match"
  );
  assert.ok(
    pageSrc.includes('href="mailto:support@careermonke.com" aria-label="Email"'),
    "Founder Email link must match"
  );
  // Founder stat row removed (live has none) - no placeholder labels, no invented numbers.
  assert.ok(!pageSrc.includes('className="fd-stats"') && !pageSrc.includes("[00K+]") && !pageSrc.includes("PLACEHOLDER"), "Founder stat row and placeholders must be gone");
  assert.ok(!/github\.com/i.test(pageSrc), "Footer GitHub link must not come back");
  assert.ok(pageSrc.includes("Free preview"), "Free preview CTA heading must exist");
  assert.ok(pageSrc.includes("View Jobs"), "Free preview CTA must include 'View Jobs'");
  assert.ok(pageSrc.includes("See my Ideal Match"), "Free preview CTA must include 'See my Ideal Match'");

  // 3. Founder CSS Styling & Dimensions
  console.log("Test 3: Founder styling across viewports...");
  // Live founder card: centered bordered card on phones (88px photo), photo-left 100px 1fr grid on desktop.
  assert.ok(cssSrc.includes("grid-template-columns:1fr;justify-items:center;text-align:center"), "Founder mobile card must stack photo above text");
  assert.ok(cssSrc.includes(".landing-wrapper .founder img{width:88px;height:88px"), "Founder mobile img size must be 88x88");
  assert.ok(
    cssSrc.includes("grid-template-columns:100px 1fr;justify-items:start;text-align:left;gap:24px;padding:28px 32px;margin-left:auto;margin-right:auto"),
    "Founder desktop card must be 100px 1fr with auto margins for centering"
  );
  assert.ok(cssSrc.includes(".landing-wrapper .founder img{width:100px;height:100px}"), "Founder desktop img size must be 100x100");
  assert.ok(!cssSrc.includes(".fd-stats"), "Founder-stat-only CSS must be removed with the stat row");

  // 3b. Desktop (>=768px) Centering Rules Verification
  // NOTE: Owner-approved deviation from the original HTML: on desktop (>=768px), sections below the hero
  // are center aligned (like mobile) instead of left-aligned.
  console.log("Test 3b: Desktop (>=768px) centering rules (owner-approved deviation)...");
  assert.ok(
    cssSrc.includes(".h2{font-size:40px;text-align:center}"),
    "Desktop .h2 must be center-aligned (owner-approved deviation)"
  );
  assert.ok(
    cssSrc.includes(".vs{width:100%;max-width:760px;margin:32px auto 0;border-spacing:12px 0}"),
    "Desktop .vs must use auto margins and remove negative left margin"
  );
  assert.ok(
    cssSrc.includes(".faq{max-width:820px;margin-left:auto;margin-right:auto}"),
    "Desktop .faq must have auto margins"
  );
  assert.ok(
    cssSrc.includes(".contact{text-align:center} .landing-wrapper .contact .fbtn{margin:16px auto 0}"),
    "Desktop .contact must be center-aligned with centered button"
  );

  // 4. Header, Hero, Demo, Stats, Comparison, Footer Section Sequence
  console.log("Test 4: Section-by-section sequence check...");
  // Composite page: new top fold (ssampe@f21504b) then the ssampe@3386250 lower page, in this order.
  const headerIdx = pageSrc.indexOf('<header className="hero"');
  const heroIdx = pageSrc.indexOf('<p className="kicker">Skip LinkedIn competition</p>');
  const foldCtaIdx = pageSrc.indexOf('className="btn-cta"');
  const statsIdx = pageSrc.indexOf('id="stats-note"');
  const stripIdx = pageSrc.indexOf('<section className="ls"');
  const cmpIdx = pageSrc.indexOf('id="cmp-h"');
  const featIdx = pageSrc.indexOf('id="feat-h"');
  const faqIdx = pageSrc.indexOf('id="q-h"');
  const footerIdx = pageSrc.indexOf('<footer');
  const stickyIdx = pageSrc.indexOf('<aside className="sb"');

  const orderedIndices = [
    { name: "header", idx: headerIdx },
    { name: "hero", idx: heroIdx },
    { name: "foldCta", idx: foldCtaIdx },
    { name: "stats", idx: statsIdx },
    { name: "logoStrip", idx: stripIdx },
    { name: "comparison", idx: cmpIdx },
    { name: "features", idx: featIdx },
    { name: "reviews", idx: reviewsIdx },
    { name: "founder", idx: founderIdx },
    { name: "faq", idx: faqIdx },
    { name: "feedbackWall", idx: feedbackWallIdx },
    { name: "finalCta", idx: finalCtaIdx },
    { name: "footer", idx: footerIdx },
    { name: "stickyBar", idx: stickyIdx },
  ];
  for (const gone of ['id="hero-h"', 'id="demo"', 'className="hjs"', 'className="fj-cards"', 'id="t-h"', 'id="c-h"']) {
    assert.ok(!pageSrc.includes(gone), `Removed block must not come back: ${gone}`);
  }

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
  assert.ok(pageSrc.includes("<b>1L+</b>"), "Stats must include 1L+");
  assert.ok(pageSrc.includes('fresh roles <span className="sbr">active</span>'), "Stats must include 'fresh roles active'");
  assert.ok(pageSrc.includes("*Based on early access user surveys"), "Stats must include survey note");

  console.log("\n✅ ALL LANDING PARITY & FOUNDER PHOTO TESTS PASSED!");
}

runParityTests().catch(err => {
  console.error(err);
  process.exit(1);
});
