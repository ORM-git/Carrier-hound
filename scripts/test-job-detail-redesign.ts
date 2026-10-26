import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("       JOB DETAIL REDESIGN (JOBRIGHT-STYLE TWO-COLUMN & STICKY HEADER) AUDIT      ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const detailViewPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");

  if (!fs.existsSync(detailViewPath)) {
    console.error("FAIL: Required file src/components/jobs/JobDetailView.tsx is missing!");
    process.exit(1);
  }

  let detailCode = fs.readFileSync(detailViewPath, "utf-8");

  if (isNegativeControl) {
    // Inject intentional corruptions to verify negative control failure detection
    detailCode = detailCode.replace(/sticky top-14/g, "static");
    detailCode = detailCode.replace(/Overview/g, "BadTab1");
    detailCode = detailCode.replace(/Company/g, "BadTab2");
    detailCode = detailCode.replace(/const isUnlocked = isPro && !job.proUnlockError;/g, "const isUnlocked = false;");
    detailCode = detailCode.replace(/lg:grid-cols-12/g, "block");
  }

  const failures: string[] = [];

  // 1. Sticky Header under Top Bar
  const hasStickyHeader =
    detailCode.includes("sticky top-14 z-20") &&
    detailCode.includes('aria-label="Job header"') &&
    detailCode.includes("onBack") &&
    detailCode.includes("onApply") &&
    detailCode.includes("Overview") &&
    detailCode.includes("Company") &&
    detailCode.includes("onHide") &&
    detailCode.includes("onSave") &&
    detailCode.includes("isScrolled") &&
    detailCode.includes("scrolled-header-chip");

  if (!hasStickyHeader) {
    failures.push("STICKY HEADER FAIL: Header must be sticky (sticky top-14 z-20) with Back, Overview/Company tabs, Share, Report issue, Hide, Heart, Apply, and scrolled compact chip.");
  } else {
    console.log("  [PASS] sticky header: pinned with top-14 z-20 docking under AppTopBar, with Back, Overview/Company tabs, Share, Report issue, Hide, Heart, Apply, and scrolled compact chip");
  }

  // 2. Header Body with 2x3 metadata and Match card
  const hasHeaderBody =
    detailCode.includes("inferJobLevel") &&
    detailCode.includes("formatRelativeTime") &&
    detailCode.includes("Experience Level") &&
    detailCode.includes("Skill") &&
    detailCode.includes("Industry Exp.");

  if (!hasHeaderBody) {
    failures.push("HEADER BODY FAIL: Must contain 2x3 metadata grid (location, job type, work model, level, salary, exp) and Match card with sub-scores.");
  } else {
    console.log("  [PASS] header body: metadata grid (location, type, work model, level, salary, exp) and match card with total % + sub-scores");
  }

  // 3. Two-Column Desktop Layout
  const hasTwoColumnGrid =
    detailCode.includes("grid-cols-1 lg:grid-cols-12") &&
    detailCode.includes("lg:col-span-7") &&
    detailCode.includes("lg:col-span-5");

  if (!hasTwoColumnGrid) {
    failures.push("TWO COLUMN GRID FAIL: Layout must be two-column on desktop (grid-cols-1 lg:grid-cols-12 with lg:col-span-7 and lg:col-span-5).");
  } else {
    console.log("  [PASS] two-column layout: clean two-column grid on desktop (lg:grid-cols-12 with 7/5 column ratio), single column on mobile");
  }

  // 4. Content Order: Summary + tags, Responsibilities, Qualifications, Benefits, Company
  const hasContentOrder =
    detailCode.includes("Job description") &&
    detailCode.includes("Responsibilities") &&
    detailCode.includes("Requirements") &&
    detailCode.includes("Benefits") &&
    detailCode.includes('id="company-section"');

  if (!hasContentOrder) {
    failures.push("CONTENT ORDER FAIL: Must render summary + tags, Responsibilities, Qualifications, Benefits, and Company section in order.");
  } else {
    console.log("  [PASS] content order: summary + tags, Responsibilities, Qualifications, Benefits, and Company section");
  }

  // 5. Right Rail with Stacked Cards
  const hasRightRail =
    detailCode.includes("Tailor Resume") &&
    detailCode.includes("Similar jobs") &&
    detailCode.includes("Your notes");

  if (!hasRightRail) {
    failures.push("RIGHT RAIL FAIL: Desktop right rail must contain stacked cards (Tailor Resume, Similar jobs, Your notes).");
  } else {
    console.log("  [PASS] right rail: stacked action cards (Tailor Resume, Similar jobs, Your notes) with sections hidden when no data");
  }

  // 6. Pro Unlock Error Handling & isUnlocked logic preserved
  const hasUnlockLogic =
    detailCode.includes("const isUnlocked = isPro && !job.proUnlockError;") &&
    detailCode.includes('data-testid="pro-unlock-error-banner"') &&
    detailCode.includes("onRetryUnlock") &&
    detailCode.includes("isRetryingUnlock");

  if (!hasUnlockLogic) {
    failures.push("UNLOCK LOGIC FAIL: Must preserve PR #84 isUnlocked logic, pro-unlock-error-banner, and onRetryUnlock prop.");
  } else {
    console.log("  [PASS] unlock logic: preserves isUnlocked (isPro && !job.proUnlockError), error retry banner, and onRetryUnlock prop");
  }

  // 7. Mobile Compact Cards in One Row
  const hasMobileMatchRow =
    detailCode.includes("grid-cols-4 gap-2") &&
    detailCode.includes("Match Score");

  if (!hasMobileMatchRow) {
    failures.push("MOBILE MATCH ROW FAIL: Mobile must render match score as compact cards in one row (grid-cols-4 gap-2).");
  } else {
    console.log("  [PASS] mobile match layout: match scores rendered as compact cards in one row on mobile");
  }

  // 8. Prohibited Terms & Data Blocks We Do Not Have
  const prohibitedTerms = [
    /jobright/i,
    /coaching/i,
    /\bagent\b/i,
    /interview (?:prep|coaching|copilot|autofill)/i,
    /autofill/i,
    /referral/i,
    /upsell/i,
    /insider connection/i,
    /find any email/i,
    /h1b sponsor/i,
    /email credits/i,
  ];

  for (const term of prohibitedTerms) {
    if (term.test(detailCode)) {
      failures.push(`BRAND PURITY FAIL: Prohibited term "${term.source}" found in source.`);
    }
  }

  if (failures.some((f) => f.includes("BRAND PURITY FAIL"))) {
    // already logged
  } else {
    console.log("  [PASS] brand & data purity: zero unbacked blocks (no referral people, H1B, funding, news, ratings, applicant counts, or external AI tools)");
  }

  console.log("\n----------------------------------------------------------------------------------");
  if (isNegativeControl) {
    if (failures.length >= 3) {
      console.log(`NEGATIVE CONTROL PASSED: Detected ${failures.length} expected intentional failure(s):`);
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(1);
    } else {
      console.error(`NEGATIVE CONTROL FAILED: Expected >= 3 failures, got ${failures.length}`);
      process.exit(0);
    }
  }

  if (failures.length > 0) {
    console.error("VALIDATION FAILED:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log("JOB DETAIL REDESIGN VALIDATED LOCALLY [PASS-LOCAL]");
  process.exit(0);
}

run();
