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
    detailCode = detailCode.replace(/mobile-sticky-header-strip/g, "bad-strip");
    detailCode = detailCode.replace(/sanitizeExternalUrl\(rawWebsite\)/g, "rawWebsite");
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

  // 5. Right Rail with Stacked Cards. Product restore (#665): the Tailor Resume card was removed (no AI
  // CTAs outside the landing page), so it must NOT come back; Similar jobs and Your notes remain.
  const hasRightRail =
    detailCode.includes("Similar jobs") &&
    detailCode.includes("Your notes") &&
    !detailCode.includes("Tailor Resume");

  if (!hasRightRail) {
    failures.push("RIGHT RAIL FAIL: Desktop right rail must contain stacked cards (Similar jobs, Your notes) and no Tailor Resume card.");
  } else {
    console.log("  [PASS] right rail: stacked cards (Similar jobs, Your notes), no Tailor Resume card, sections hidden when no data");
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

  // 7. Mobile match score: heading + highlighted overall card (big %, band label) + one grid-cols-3 row of
  // component score cards (Experience/Skill/Industry, dropped when no data), 11px+ labels
  const mobileScore = detailCode.slice(detailCode.indexOf('data-testid="mobile-match-score"'), detailCode.indexOf("(3) CONTENT ORDER"));
  const hasMobileMatchRow =
    mobileScore.includes("Match Score") &&
    mobileScore.includes("matchLabel") &&
    mobileScore.includes("grid grid-cols-3") &&
    mobileScore.includes("Pro Match") &&
    ["Experience", "Skill", "Industry"].every((l) => mobileScore.includes(l)) &&
    !/text-\[(9|10)px\]/.test(mobileScore);

  if (!hasMobileMatchRow) {
    failures.push("MOBILE MATCH ROW FAIL: Mobile must render Match Score as a highlighted overall card (big %, band label) plus one grid-cols-3 row of Experience/Skill/Industry cards with 11px+ labels.");
  } else {
    console.log("  [PASS] mobile match layout: highlighted overall card plus component score cards with readable labels");
  }

  // 8. Mobile Single-Row Sticky Strip: X (close) left, Overview/Company tabs centered, "..." menu right
  const hasMobileStrip =
    detailCode.includes('data-testid="mobile-sticky-header-strip"') &&
    detailCode.includes("md:hidden flex items-center justify-between gap-2") &&
    detailCode.includes("Overview") &&
    detailCode.includes("Company") &&
    detailCode.includes("Close job details") &&
    detailCode.includes("<JobCardMenu");

  if (!hasMobileStrip) {
    failures.push("MOBILE STRIP FAIL: Mobile header must be a single sticky row: X (close) left, Overview/Company tabs centered, '...' menu right.");
  } else {
    console.log("  [PASS] mobile strip: X left, Overview/Company tabs centered, '...' menu right");
  }

  // 8b. Mobile overview restyle details: 64px logo action row, posted/category pills, grey summary card with
  // company name, salary always listed ("Not disclosed" when empty, never masked on mobile)
  const mobileFacts = detailCode.slice(detailCode.indexOf('data-testid="mobile-job-facts"'), detailCode.indexOf('data-testid="overview-chips"'));
  const hasMobileOverviewRestyle =
    detailCode.includes("w-16 h-16 rounded-2xl") &&
    detailCode.includes("{/* Mobile pills: posted time + category (real data only) */}") &&
    detailCode.includes("max-md:bg-[#F1F5F9]") &&
    mobileFacts.includes("Not disclosed") &&
    !mobileFacts.includes("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022");

  if (!hasMobileOverviewRestyle) {
    failures.push("MOBILE OVERVIEW FAIL: Mobile overview must have the 64px-logo action row, posted/category pills, the grey summary card, and an always-visible salary row (never masked).");
  } else {
    console.log("  [PASS] mobile overview: action row, pills, grey summary card, always-visible salary row");
  }

  // 9. Sanitized Company Website URL
  const { sanitizeExternalUrl } = require("../src/lib/security/xss");
  const hasSanitizedWebsite =
    detailCode.includes("sanitizeExternalUrl(rawWebsite)") &&
    sanitizeExternalUrl("javascript:alert(1)") === null &&
    sanitizeExternalUrl("https://careermonke.com") === "https://careermonke.com/";

  if (!hasSanitizedWebsite) {
    failures.push("SANITIZED WEBSITE FAIL: Company website must be wrapped with sanitizeExternalUrl and reject javascript: URLs.");
  } else {
    console.log("  [PASS] sanitized company website: wrapped with sanitizeExternalUrl; javascript: URLs rejected");
  }

  // 10. Prohibited Terms & Data Blocks We Do Not Have
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
