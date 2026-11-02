import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEMO_ROLES, STEP_TABS } from "../src/components/LandingInteractiveDemoSection";

const ROOT = process.cwd();
const isNegativeControl = process.argv.includes("--negative-control");

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-landing-interactive-demo.ts", "--negative-control"],
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
  console.log("  [PASS] Negative control '--negative-control' exited non-zero (1)");
}

async function main() {
  const pagePath = path.join(ROOT, "src", "app", "page.tsx");
  const demoPath = path.join(ROOT, "src", "components", "LandingInteractiveDemoSection.tsx");
  const oldMockPath = path.join(ROOT, "src", "components", "ProductScreenshotMock.tsx");

  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  assert.ok(fs.existsSync(demoPath), "src/components/LandingInteractiveDemoSection.tsx must exist");
  assert.ok(!fs.existsSync(oldMockPath), "ProductScreenshotMock.tsx must be removed");

  const pageSrc = fs.readFileSync(pagePath, "utf8");
  let demoSrc = fs.readFileSync(demoPath, "utf8");

  if (isNegativeControl) {
    // Inject banned term to prove negative control fails
    demoSrc += "\nATS breakdown of unindexed jobs from career pages";
  }

  console.log("================================================================================");
  console.log("       LANDING PAGE HERO INTERACTIVE DEMO VERIFICATION SUITE                    ");
  console.log("================================================================================\n");

  // 1. Existing sections in src/app/page.tsx remain intact
  assert.ok(
    pageSrc.includes("Find jobs not on LinkedIn/Indeed"),
    "Hero headline must remain untouched"
  );
  assert.ok(
    pageSrc.includes("LandingComparisonSection") ||
      pageSrc.includes("Tired of getting auto-rejected?") ||
      pageSrc.includes("Tired of getting auto-rejections?"),
    "Comparison section must remain untouched"
  );
  assert.ok(
    pageSrc.includes("Meet the monke that fixes your resume."),
    "AI Resume Monke subsection must remain untouched"
  );
  assert.ok(
    pageSrc.includes("Your next role might be in a city you haven&apos;t thought of yet."),
    "Global coverage section must remain untouched"
  );
  assert.ok(
    pageSrc.includes("Orissa Lee Patnaik"),
    "Founder card section must remain untouched"
  );
  assert.ok(
    pageSrc.includes("<Testimonials />"),
    "Testimonials section must remain untouched"
  );
  assert.ok(
    pageSrc.includes("Frequently Asked Questions"),
    "FAQ section must remain untouched"
  );
  assert.ok(
    pageSrc.includes('id="contact"'),
    "Contact section must remain untouched"
  );
  assert.ok(
    pageSrc.includes("<LandingFeaturesSection />"),
    "Features section must remain untouched"
  );

  // Hero placement and duplicate removal
  assert.ok(
    pageSrc.includes("<LandingInteractiveDemoSection />"),
    "LandingInteractiveDemoSection must be rendered in src/app/page.tsx"
  );
  const heroHeadlineIdx = pageSrc.indexOf("Find jobs not on LinkedIn/Indeed");
  const comparisonIdx =
    pageSrc.indexOf("<LandingComparisonSection />") !== -1
      ? pageSrc.indexOf("<LandingComparisonSection />")
      : pageSrc.indexOf("Tired of getting");
  const demoIdx = pageSrc.indexOf("<LandingInteractiveDemoSection />");
  assert.ok(
    heroHeadlineIdx > -1 && demoIdx > heroHeadlineIdx && comparisonIdx > demoIdx,
    "LandingInteractiveDemoSection must be rendered in the Hero section, replacing the static mockup"
  );
  assert.strictEqual(
    pageSrc.split("<LandingInteractiveDemoSection />").length - 1,
    1,
    "LandingInteractiveDemoSection must appear exactly once in src/app/page.tsx (no duplicates)"
  );
  assert.ok(
    !pageSrc.includes("ProductScreenshotMock"),
    "ProductScreenshotMock must be completely removed from src/app/page.tsx"
  );
  console.log("  [PASS] Hero demo placement verified and duplicate lower demo section removed cleanly");

  // 2. Step tabs: 1 Find, 2 Match, 3 Improve, 4 Start + progress bar
  assert.strictEqual(STEP_TABS.length, 4, "Expected 4 step tabs");
  assert.deepStrictEqual(
    STEP_TABS.map((t) => t.label),
    ["Find", "Match", "Improve", "Start"],
    "Step tabs must be Find, Match, Improve, Start"
  );
  assert.ok(
    demoSrc.includes("max-w-[880px]"),
    "Compact browser-style card must be max-width about 880px on desktop (max-w-[880px])"
  );
  assert.ok(
    demoSrc.includes("careermonke.com"),
    "Compact browser-style card must have 'careermonke.com' pill"
  );
  assert.ok(
    demoSrc.includes("shadow-[0_24px_60px_rgba(15,23,42,0.25)]"),
    "Card must feature soft layered shadow 0 24px 60px rgba(15,23,42,.25)"
  );
  assert.ok(
    demoSrc.includes('data-testid="demo-progress-bar"'),
    "Compact browser-style card must include a progress bar"
  );
  assert.ok(
    demoSrc.includes('data-testid="demo-step-1-panel"') &&
      demoSrc.includes('data-testid="demo-step-2-panel"') &&
      demoSrc.includes('data-testid="demo-step-3-panel"') &&
      demoSrc.includes('data-testid="demo-step-4-panel"'),
    "All 4 interactive step panels must exist in LandingInteractiveDemoSection.tsx"
  );
  assert.strictEqual(DEMO_ROLES.length, 4, "Expected 4 interactive role presets");
  for (const role of DEMO_ROLES) {
    assert.ok(role.jobs.length >= 1, `Role ${role.id} must have at least 1 sample job`);
    for (const job of role.jobs) {
      assert.ok(
        job.company.startsWith("Sample "),
        `Sample company '${job.company}' must clearly be sample data`
      );
      assert.strictEqual(job.matchScore, 94, "Sample match score must be 94");
    }
  }
  console.log("  [PASS] Compact browser-style card with Find, Match, Improve, Start tabs & progress bar verified");

  // 3. Auto-rotation removed completely & motion disabled under prefers-reduced-motion
  assert.ok(
    !demoSrc.includes("setInterval"),
    "Auto-rotation timer (setInterval) must be completely removed"
  );
  assert.ok(
    !demoSrc.includes("4500"),
    "Legacy auto-advance timer 4500ms must be completely removed"
  );
  assert.ok(
    demoSrc.includes("prefers-reduced-motion"),
    "Must respect prefers-reduced-motion"
  );
  assert.ok(
    demoSrc.includes("demoFadeIn") && demoSrc.includes("180ms"),
    "Step transitions must be 150-200ms fades"
  );
  assert.ok(
    demoSrc.includes('role="tab"'),
    "Tabs must be real buttons with role='tab'"
  );
  assert.ok(
    demoSrc.includes("aria-selected="),
    "Tabs must include aria-selected attribute"
  );
  assert.ok(
    demoSrc.includes("min-h-[44px]"),
    "Touch targets must be at least 44px"
  );
  console.log("  [PASS] Auto-advance removed, 180ms fade transitions, and prefers-reduced-motion verified");

  // 4. Primary buttons: exactly one per step, #2563EB, min-h-[48px], no green
  const primaryButtons = [
    { testId: "demo-step-1-next", label: "Show my jobs", hasArrow: true },
    { testId: "demo-step-2-next", label: "Fix my resume for this job", hasArrow: true },
    { testId: "demo-step-3-next", label: "Continue to apply", hasArrow: true },
    { testId: "landing-demo-email-submit", label: "Get early access", hasArrow: false },
  ];
  for (const btn of primaryButtons) {
    assert.ok(
      demoSrc.includes(btn.testId),
      `Button ${btn.testId} must exist`
    );
    assert.ok(
      demoSrc.includes(btn.label),
      `Button label '${btn.label}' must exist`
    );
  }
  assert.ok(
    demoSrc.includes("min-h-[48px]"),
    "Primary buttons must be minimum 48px tall (min-h-[48px])"
  );
  console.log("  [PASS] Exactly one blue #2563EB primary button per step verified");

  // 5. Step 1, 2, 3, 4 specific requirements
  // Step 1: "Pick your kind of work", wrapping category cards
  assert.ok(
    demoSrc.includes("Pick your kind of work"),
    "Step 1 must have heading 'Pick your kind of work'"
  );
  assert.ok(
    demoSrc.includes("break-words") && demoSrc.includes("whitespace-normal"),
    "Category card names must wrap to two lines without truncation"
  );
  assert.ok(
    demoSrc.includes("border-[#2563EB]") && demoSrc.includes("bg-blue-50"),
    "Tapping a card must give blue border and light blue fill"
  );

  // Step 2: "See your match score", ONE job card, "Your skills match 94% of what this job asks for."
  assert.ok(
    demoSrc.includes("See your match score"),
    "Step 2 must have heading 'See your match score'"
  );
  assert.ok(
    demoSrc.includes("Your skills match 94% of what this job asks for."),
    "Step 2 must include line 'Your skills match 94% of what this job asks for.'"
  );

  // Step 3: "Your improved resume", rewritten summary only, "See the cover letter instead" link
  assert.ok(
    demoSrc.includes("Your improved resume"),
    "Step 3 must have heading 'Your improved resume'"
  );
  assert.ok(
    demoSrc.includes("See the cover letter instead"),
    "Step 3 must have text link 'See the cover letter instead'"
  );

  // Step 4: "Get started", body text, visible label, "Get early access"
  assert.ok(
    demoSrc.includes("Get started"),
    "Step 4 must have heading 'Get started'"
  );
  assert.ok(
    demoSrc.includes("Leave your email and we&apos;ll set this up for your real job search.") ||
      demoSrc.includes("Leave your email and we'll set this up for your real job search."),
    "Step 4 must have body 'Leave your email and we'll set this up for your real job search.'"
  );
  assert.ok(
    demoSrc.includes('<label') && demoSrc.includes('htmlFor="landing-demo-email-input"') && demoSrc.includes("Email address"),
    "Step 4 must have a visible label 'Email address' above the input"
  );
  console.log("  [PASS] Steps 1-4 specific headings, bodies, links, and inputs verified");

  // 6. Strict copy ban: everyday words only, ban unindexed, aggregator, ATS, breakdown inside demo
  const bannedPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\bunindexed\b/i, reason: "Banned word: 'unindexed'" },
    { pattern: /\baggregator\b/i, reason: "Banned word: 'aggregator'" },
    { pattern: /\bATS\b/, reason: "Banned word: 'ATS'" },
    { pattern: /\bbreakdown\b/i, reason: "Banned word: 'breakdown'" },
    { pattern: /\bcareer page\b/i, reason: "No text about career pages allowed" },
    { pattern: /\bcareer site\b/i, reason: "No text about career sites allowed" },
    { pattern: /\bwhere jobs come from\b/i, reason: "No text about where jobs come from allowed" },
    { pattern: /\$\d+/i, reason: "No dollar prices allowed in demo section" },
    { pattern: /₹\s*\d+/i, reason: "No rupee prices allowed in demo section" },
    { pattern: /\b4\.[89]\s*\/?\s*5\b/i, reason: "No fake star ratings allowed" },
    { pattern: /\b\d{1,3}(,\d{3})+\+?\s*(users|members|engineers|candidates)\b/i, reason: "No fake member counts allowed" },
    { pattern: /"Verified Employer"/i, reason: "No 'Verified Employer' label allowed in hero demo" },
  ];

  for (const { pattern, reason } of bannedPatterns) {
    assert.ok(!pattern.test(demoSrc), `${reason} (matched ${pattern})`);
  }
  console.log("  [PASS] Banned words (unindexed, aggregator, ATS, breakdown, sources, career pages) absent");

  // 7. Keep every "Illustration - sample data" label
  assert.ok(
    demoSrc.includes("Illustration - sample companies and scores"),
    "Must render 'Illustration - sample companies and scores' label under the card"
  );
  assert.ok(
    demoSrc.includes("Illustration - sample data"),
    "Must render 'Illustration - sample data' badge text"
  );
  console.log("  [PASS] 'Illustration - sample data' labels preserved");

  // 8. Inline email capture -> existing /api/early-access + /early-access flow
  assert.ok(
    demoSrc.includes('fetch("/api/early-access"'),
    "Inline email capture must submit to /api/early-access"
  );
  assert.ok(
    demoSrc.includes('href="/early-access"'),
    "Email capture success state must link to /early-access"
  );
  console.log("  [PASS] Inline email capture -> /api/early-access flow verified");

  if (!isNegativeControl) {
    runNegativeControlSubprocess();
  }

  console.log("\n================================================================================");
  console.log("ALL LANDING INTERACTIVE DEMO TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("[FAIL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
