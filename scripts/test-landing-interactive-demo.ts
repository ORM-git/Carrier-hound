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
    // Inject prohibited price to prove negative control fails
    demoSrc += "\nPrice: $19/month";
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

  // 2. Compact browser-style card + 4 step tabs (Find, Match, Tailor, Send) + progress line
  assert.strictEqual(STEP_TABS.length, 4, "Expected 4 step tabs");
  assert.deepStrictEqual(
    STEP_TABS.map((t) => t.label),
    ["Find", "Match", "Tailor", "Send"],
    "Step tabs must be Find, Match, Tailor, Send"
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
    assert.ok(role.jobs.length >= 2, `Role ${role.id} must have at least 2 sample jobs`);
    for (const job of role.jobs) {
      assert.ok(
        job.company.startsWith("Sample "),
        `Sample company '${job.company}' must clearly be sample data`
      );
      assert.ok(
        job.matchScore >= 70 && job.matchScore <= 99,
        `Sample match score ${job.matchScore} must be in valid range`
      );
    }
  }
  console.log("  [PASS] Compact browser-style card with Find, Match, Tailor, Send tabs & progress bar verified");

  // 3. Motion & accessibility
  assert.ok(
    demoSrc.includes("4500"),
    "Must auto-advance steps every 4.5s (4500ms) until user interaction"
  );
  assert.ok(
    demoSrc.includes("prefers-reduced-motion"),
    "Must respect prefers-reduced-motion"
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
    "Mobile tap targets must be at least 44px (min-h-[44px])"
  );
  console.log("  [PASS] Auto-advance (4.5s), prefers-reduced-motion, and tab accessibility verified");

  // 4. 'Illustration - sample companies and scores' caption under card & 'Illustration - sample data' badge
  assert.ok(
    demoSrc.includes("Illustration - sample companies and scores"),
    "Must render 'Illustration - sample companies and scores' label under the card"
  );
  assert.ok(
    demoSrc.includes("Illustration - sample data"),
    "Must render 'Illustration - sample data' badge text"
  );
  console.log("  [PASS] 'Illustration - sample companies and scores' label under card verified");

  // 5. No fake testimonials, member counts, ratings, prices, auto-apply claims, or 'Verified Employer'
  const prohibitedPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\$\d+/i, reason: "No dollar prices allowed in demo section" },
    { pattern: /₹\s*\d+/i, reason: "No rupee prices allowed in demo section" },
    { pattern: /\b4\.[89]\s*\/?\s*5\b/i, reason: "No fake star ratings allowed" },
    { pattern: /\b\d{1,3}(,\d{3})+\+?\s*(users|members|engineers|candidates)\b/i, reason: "No fake member counts allowed" },
    { pattern: /we apply for you|send your resume straight to the hiring team|auto-apply for you/i, reason: "Must not claim we apply for the user or send resumes to hiring teams" },
    { pattern: /"Verified Employer"/i, reason: "No 'Verified Employer' label allowed in hero demo" },
    { pattern: /\bApply Now\b/i, reason: "No 'Apply Now' button allowed" },
    { pattern: /\bDislike\b/i, reason: "No 'Dislike' button allowed" },
  ];

  for (const { pattern, reason } of prohibitedPatterns) {
    assert.ok(!pattern.test(demoSrc), `${reason} (matched ${pattern})`);
  }
  assert.ok(
    demoSrc.includes("official career site"),
    "Must explicitly state that the user applies on the company's official career site"
  );
  console.log("  [PASS] Zero prices, ratings, member counts, 'Verified Employer', or auto-apply claims verified");

  // 6. Inline email capture -> existing /api/early-access + /early-access flow
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
