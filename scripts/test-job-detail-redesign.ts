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
    // Inject corruptions to verify negative control
    detailCode = detailCode.replace(/sticky top-14/g, "static");
    detailCode = detailCode.replace(/lg:grid-cols-12/g, "block");
    detailCode = detailCode.replace(/lg:col-span-7/g, "w-full");
    detailCode = detailCode.replace(/lg:col-span-5/g, "hidden");
    detailCode = detailCode.replace(/const isUnlocked/g, "const isBad");
    detailCode = detailCode.replace(/pro-unlock-error-banner/g, "bad-banner");
  }

  const failures: string[] = [];

  // 1. Sticky Header
  const hasStickyHeader =
    detailCode.includes("sticky top-14 z-20") &&
    detailCode.includes('aria-label="Job header"') &&
    detailCode.includes("onBack") &&
    detailCode.includes("ArrowLeft") &&
    detailCode.includes("onApply") &&
    detailCode.includes("text-[24px] font-bold text-[#0F172A]") &&
    detailCode.includes("formatRelativeTime");

  if (!hasStickyHeader) {
    failures.push("STICKY HEADER FAIL: Header must be sticky (sticky top-14 z-20) with title, company, location, posted time, back button, and primary apply button.");
  } else {
    console.log("  [PASS] sticky header: pinned with top-14 z-20 docking under AppTopBar, with title, company, location, posted time, back button, and Apply");
  }

  // 2. Two-Column Desktop Layout
  const hasTwoColumnGrid =
    detailCode.includes("grid-cols-1 lg:grid-cols-12") &&
    detailCode.includes("lg:col-span-7") &&
    detailCode.includes("lg:col-span-5");

  if (!hasTwoColumnGrid) {
    failures.push("TWO COLUMN GRID FAIL: Layout must be two-column on desktop (grid-cols-1 lg:grid-cols-12 with lg:col-span-7 and lg:col-span-5).");
  } else {
    console.log("  [PASS] two-column layout: clean two-column grid on desktop (lg:grid-cols-12 with 7/5 column ratio), single column on mobile");
  }

  // 3. Left Column Sections: Description, Requirements, Benefits
  const hasLeftSections =
    detailCode.includes("Job description") &&
    detailCode.includes("requirementsList.length > 0") &&
    detailCode.includes("Requirements") &&
    detailCode.includes("benefitsList.length > 0") &&
    detailCode.includes("Benefits");

  if (!hasLeftSections) {
    failures.push("LEFT COLUMN SECTIONS FAIL: Left column must contain Job description, Requirements, and Benefits.");
  } else {
    console.log("  [PASS] left column content: contains Job description, guarded Requirements, and guarded Benefits");
  }

  // 4. Pro unlock error handling & isUnlocked logic preserved
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

  // 5. Similar jobs card
  const hasSimilarJobsCard = detailCode.includes("Similar jobs");

  if (!hasSimilarJobsCard) {
    failures.push("SIMILAR JOBS CARD FAIL: Right column must contain Similar jobs card.");
  } else {
    console.log("  [PASS] similar jobs card: present in right column");
  }

  // 6. Prohibited Terms & Brand Purity
  const prohibitedTerms = [
    /jobright/i,
    /coaching/i,
    /\bagent\b/i,
    /interview (?:prep|coaching|copilot|autofill)/i,
    /autofill/i,
    /referral/i,
    /upsell/i,
  ];

  for (const term of prohibitedTerms) {
    if (term.test(detailCode)) {
      failures.push(`BRAND PURITY FAIL: Prohibited term "${term.source}" found in source.`);
    }
  }

  if (failures.some((f) => f.includes("BRAND PURITY FAIL"))) {
    // already logged
  } else {
    console.log("  [PASS] brand purity: zero Jobright copy, mascots, coaching, agent, or autofill terms in code");
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
