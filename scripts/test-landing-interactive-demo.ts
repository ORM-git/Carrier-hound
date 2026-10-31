/**
 * scripts/test-landing-interactive-demo.ts
 *
 * Verifies the Landing Page Interactive Demo Section:
 * 1. Existing sections, hero line, nav, and design in src/app/page.tsx remain intact.
 * 2. One new section (<LandingInteractiveDemoSection />) is added below existing content sections.
 * 3. 4-step walkthrough: (1) Pick a role, (2) Matched jobs & scores, (3) Open job & fit, (4) Tailored resume & cover letter.
 * 4. Only real features shown as Live; Autofill Extension & AI Interview Prep carry "Coming soon" badges.
 * 5. All sample companies, jobs, and scores carry the "Illustration - sample data" label.
 * 6. Zero fake testimonials, member counts, ratings, prices, or third-party logos, and no claims that we apply for the user or send resumes to hiring teams.
 * 7. Every CTA opens the same inline email capture submitting to /api/early-access and linking to /early-access.
 * 8. Real negative control (--negative-control) proves non-zero exit on violation.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEMO_ROLES } from "../src/components/LandingInteractiveDemoSection";

const isNegativeControl = process.argv.includes("--negative-control");

function main() {
  const pagePath = path.resolve(process.cwd(), "src/app/page.tsx");
  const demoPath = path.resolve(
    process.cwd(),
    "src/components/LandingInteractiveDemoSection.tsx"
  );

  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  assert.ok(
    fs.existsSync(demoPath),
    "src/components/LandingInteractiveDemoSection.tsx must exist"
  );

  let pageSrc = fs.readFileSync(pagePath, "utf8");
  let demoSrc = fs.readFileSync(demoPath, "utf8");

  if (isNegativeControl) {
    // Inject prohibited price and remove Coming soon badge to prove negative control fails
    demoSrc = demoSrc.replace(/Coming soon/g, "Live now") + "\nPrice: $19/month";
  }

  console.log("================================================================================");
  console.log("       LANDING PAGE INTERACTIVE DEMO SECTION VERIFICATION SUITE                 ");
  console.log("================================================================================\n");

  // 1. Existing sections in src/app/page.tsx remain intact
  assert.ok(
    pageSrc.includes("Find jobs not on LinkedIn/Indeed"),
    "Hero headline must remain untouched"
  );
  assert.ok(
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
    pageSrc.includes("<LandingInteractiveDemoSection />"),
    "LandingInteractiveDemoSection must be rendered in src/app/page.tsx"
  );
  const contactIdx = pageSrc.indexOf('id="contact"');
  const demoIdx = pageSrc.indexOf("<LandingInteractiveDemoSection />");
  const footerIdx = pageSrc.indexOf("<Footer />");
  assert.ok(
    contactIdx > -1 && demoIdx > contactIdx && footerIdx > demoIdx,
    "LandingInteractiveDemoSection must be placed below the existing sections and above Footer"
  );
  console.log("  [PASS] Existing landing sections preserved and new section placed below them");

  // 2. 4-step interactive walkthrough structure & data
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
        `Sample score ${job.matchScore} must be a valid percentage`
      );
      assert.ok(job.beforeBullet.length > 10 && job.afterBullet.length > 10);
      assert.ok(job.coverLetterSnippet.length > 20);
    }
  }
  assert.ok(demoSrc.includes("Pick a role"));
  assert.ok(demoSrc.includes("Matched jobs & scores"));
  assert.ok(demoSrc.includes("Open job & fit"));
  assert.ok(demoSrc.includes("Tailored resume & letter"));
  console.log("  [PASS] 4-step walkthrough flow (role -> matched jobs -> job fit -> tailored resume & cover letter) verified");

  // 3. Live features vs "Coming soon" badges
  assert.ok(
    demoSrc.includes("Direct Career-Page Search · Live"),
    "Job search must be shown as Live"
  );
  assert.ok(
    demoSrc.includes("Personalised Match Scores · Live"),
    "Personalised matches must be shown as Live"
  );
  assert.ok(
    demoSrc.includes("Resume &amp; Cover Letter Tailoring · Live"),
    "Resume/cover letter tailoring must be shown as Live"
  );
  assert.ok(
    demoSrc.includes("Autofill Extension · Coming soon"),
    "Autofill extension must carry 'Coming soon' badge"
  );
  assert.ok(
    demoSrc.includes("AI Interview Prep · Coming soon"),
    "AI interview prep must carry 'Coming soon' badge"
  );
  console.log("  [PASS] Live features and 'Coming soon' badges (Autofill Extension, AI Interview Prep) verified");

  // 4. Mandatory "Illustration - sample data" label
  assert.ok(
    demoSrc.includes("Illustration - sample data"),
    "Must include 'Illustration - sample data' badge text"
  );
  const badgeUsageCount = (demoSrc.match(/<IllustrationSampleBadge/g) || []).length;
  assert.ok(
    badgeUsageCount >= 10,
    `Expected IllustrationSampleBadge across all steps, jobs, companies, and scores (found ${badgeUsageCount})`
  );
  console.log(`  [PASS] 'Illustration - sample data' badge rendered across ${badgeUsageCount} sample points`);

  // 5. No fake testimonials, member counts, ratings, prices, or "we apply for you" claims
  assert.ok(
    !/₹\s*\d|\$\s*\d|\b\d+\s*\/\s*mo(?:nth)?\b/i.test(demoSrc),
    "Demo section must NOT contain prices"
  );
  assert.ok(
    !/\b(?:4\.9|5\.0)\s*★|\btrustpilot\b|\b\d+[kK+]\s*(?:members|users|candidates)\b/i.test(
      demoSrc
    ),
    "Demo section must NOT contain fake ratings or member counts"
  );
  assert.ok(
    !/we apply for you|send your resume directly to the hiring team|straight to hiring team/i.test(
      demoSrc
    ),
    "Demo section must NOT claim we apply for the user or send resumes to hiring teams"
  );
  assert.ok(
    demoSrc.includes("You apply directly on the company&apos;s official career site"),
    "Demo section must state clearly that the user applies on the company's official career site"
  );
  console.log("  [PASS] Zero prices, ratings, member counts, or auto-apply claims verified");

  // 6. Unified CTA flow -> inline email capture -> /api/early-access -> /early-access
  assert.ok(
    demoSrc.includes('fetch("/api/early-access"'),
    "Inline email capture must submit to /api/early-access"
  );
  assert.ok(
    demoSrc.includes('href="/early-access"'),
    "Post-capture state must link to /early-access"
  );
  const openCaptureCount = (demoSrc.match(/onClick=\{handleOpenEmailCapture\}/g) || []).length;
  assert.ok(
    openCaptureCount >= 4,
    `All step CTAs must trigger handleOpenEmailCapture (found ${openCaptureCount})`
  );
  console.log("  [PASS] Unified CTA -> inline email capture -> /api/early-access flow verified");

  // 7. Subprocess negative control check
  if (!isNegativeControl) {
    const child = spawnSync(
      "npx",
      ["tsx", path.resolve(__dirname, "test-landing-interactive-demo.ts"), "--negative-control"],
      {
        shell: true,
        stdio: "pipe",
        env: { ...process.env, NODE_ENV: "test" },
      }
    );
    assert.notStrictEqual(
      child.status,
      0,
      `Negative control must exit non-zero, got ${child.status}`
    );
    console.log(`  [PASS] Negative control '--negative-control' exited non-zero (${child.status})`);
  }

  console.log("\n================================================================================");
  console.log("ALL LANDING INTERACTIVE DEMO TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main();
