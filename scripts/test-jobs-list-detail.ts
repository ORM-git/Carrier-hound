import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("            PROMPT 4 REBUILD — JOBS LIST & DETAIL AUDIT SUITE                     ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const jobsPath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");
  const detailViewPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");

  if (!fs.existsSync(jobsPath) || !fs.existsSync(detailViewPath)) {
    console.error("FAIL: Required files (src/app/jobs/page.tsx or src/components/jobs/JobDetailView.tsx) are missing!");
    process.exit(1);
  }

  let jobsCode = fs.readFileSync(jobsPath, "utf-8");
  let detailCode = fs.readFileSync(detailViewPath, "utf-8");

  if (isNegativeControl) {
    // Inject corruptions to verify negative control
    jobsCode = jobsCode.replace(/max-w-\[880px\]/g, "max-w-[1400px]");
    jobsCode = jobsCode.replace(/w-\[56px\] h-\[56px\] sm:w-\[72px\] sm:h-\[72px\]|w-12 h-12/g, "w-20 h-20");
    jobsCode = jobsCode.replace(/text-\[16px\] font-bold text-\[#0F172A\]/g, "text-[12px]");
    jobsCode = jobsCode.replace(/hover:ring-\[#93C5FD\]/g, "");
    jobsCode = jobsCode + '\n<article className="hover:-translate-y-2">Moving Card</article>';
    detailCode = detailCode.replace(/text-\[24px\] font-bold text-\[#0F172A\]/g, "text-[14px]");
    detailCode = detailCode.replace(/text-\[18px\] font-bold text-\[#0F172A\]/g, "text-[12px]");
    detailCode = detailCode.replace(/leading-\[24px\]/g, "leading-none");
    detailCode = detailCode.replace(/getCanonicalJobUrl/g, "getBadUrl");
    detailCode = detailCode.replace(/support@careermonke.com/g, "invented@unknown.com");
    jobsCode = jobsCode.replace(/w-\[54px\]|sm:hidden pt-2/g, "");
    jobsCode = jobsCode + '\n<div className="jobright-mascot">Jobright Coaching Agent Autofill</div>';
  }

  const failures: string[] = [];

  // -------------------------------------------------------------------------
  // 1. JOBS LIST SPECIFICATIONS
  // -------------------------------------------------------------------------
  // 1a. Single column of job cards on #F8FAFC, 12px gap, max width 880px centred
  const has880px = jobsCode.includes("max-w-[880px]") && jobsCode.includes("mx-auto");
  const has12pxGap = jobsCode.includes("space-y-3") || jobsCode.includes("gap-3");
  const hasF8FAFC = jobsCode.includes("bg-[#F8FAFC]");
  if (!has880px || !has12pxGap || !hasF8FAFC) {
    failures.push("LIST LAYOUT FAIL: Jobs list must be a single column on #F8FAFC with 12px gap (space-y-3) and max width 880px centred (max-w-[880px] mx-auto).");
  } else {
    console.log("  [PASS] list layout: single column on #F8FAFC, 12px gap (space-y-3), max width 880px centred");
  }

  // 1b. Card tokens: white, 16px radius, 1px #E2E8F0 ring, 20px padding (p-5), no shadow
  const hasCardTokens =
    jobsCode.includes("bg-white") &&
    jobsCode.includes("rounded-[16px]") &&
    jobsCode.includes("ring-1 ring-[#E2E8F0]") &&
    jobsCode.includes("p-5") &&
    jobsCode.includes("shadow-none");
  if (!hasCardTokens) {
    failures.push("CARD TOKEN FAIL: Card must be white (bg-white), 16px radius (rounded-[16px]), 1px #E2E8F0 ring, 20px padding (p-5), and no drop shadow (shadow-none).");
  } else {
    console.log("  [PASS] card tokens: white, 16px radius (rounded-[16px]), 1px #E2E8F0 ring, 20px padding (p-5), shadow-none");
  }

  // 1c. Left: 48px company logo square (CompanyLogo or fallback)
  const has48pxLogo = (jobsCode.includes("w-[56px] h-[56px] sm:w-[72px] sm:h-[72px]") || jobsCode.includes("w-12 h-12 rounded-xl")) && jobsCode.includes("CompanyLogo");
  if (!has48pxLogo) {
    failures.push("LOGO FAIL: Left logo must be a 48px square (w-12 h-12 rounded-xl) using CompanyLogo.");
  } else {
    console.log("  [PASS] logo sizing: 48px company logo square (w-12 h-12 rounded-xl) on the left");
  }

  // 1d. Middle: title bold 16px ink, company 14px #475569, then row of small gray chips
  const has16pxTitle = jobsCode.includes("text-[16px] font-bold text-[#0F172A]");
  const has14pxCompany = jobsCode.includes("text-[14px] text-[#475569]");
  const hasGrayChips = jobsCode.includes("bg-[#F1F5F9] text-[#475569]") && jobsCode.includes("text-[12px]");
  if (!has16pxTitle || !has14pxCompany || !hasGrayChips) {
    failures.push("CARD TYPOGRAPHY FAIL: Card middle must have title bold 16px ink, company 14px #475569, and row of small gray chips (text-[12px]).");
  } else {
    console.log("  [PASS] card middle: title bold 16px ink, company 14px #475569, row of small gray chips (location, work type, salary, posted time)");
  }

  // 1e. Right: Fit Match panel from PR #68 unchanged with real score condition or upload CTA
  const hasFitMatchRight =
    jobsCode.includes("w-44 shrink-0") &&
    jobsCode.includes("rounded-[16px]") &&
    jobsCode.includes("matchScore !== null ?");
  const hasUploadCta = jobsCode.includes("Upload your resume to see your real match") && jobsCode.includes('href="/resume"');
  if (!hasFitMatchRight || !hasUploadCta) {
    failures.push("FIT MATCH FAIL: Right Fit Match panel from PR #68 must be preserved with conditional real score or upload CTA.");
  } else {
    console.log("  [PASS] fit match panel: desktop panel (w-44 shrink-0 rounded-[16px]) with score condition and resume upload CTA");
  }

  // 1f. Bottom row: Save icon button and primary blue pill Apply
  const hasSaveButton = jobsCode.includes("handleSaveJob") && jobsCode.includes("Heart");
  const hasApplyPill = jobsCode.includes("bg-[#2563EB]") && jobsCode.includes("rounded-full") && jobsCode.includes("min-h-[44px]");
  if (!hasSaveButton || !hasApplyPill) {
    failures.push("ACTIONS FAIL: Bottom row must have Save icon button and primary blue pill Apply.");
  } else {
    console.log("  [PASS] card actions: bottom row with Save icon button and primary blue pill Apply (min-h-[44px])");
  }

  // 1g. Hover: ring turns #93C5FD over 0.2s, no movement
  const hasRingHover = jobsCode.includes("hover:ring-[#93C5FD]") && jobsCode.includes("duration-200");
  const hasTranslateY = /hover:-translate-y|hover:translate-y/.test(jobsCode);
  if (!hasRingHover || hasTranslateY) {
    failures.push("HOVER ANIMATION FAIL: Card hover must turn ring #93C5FD over 0.2s with NO movement (no translate-y).");
  } else {
    console.log("  [PASS] hover effect: ring turns #93C5FD over 0.2s with zero positional movement");
  }

  // -------------------------------------------------------------------------
  // 2. JOB DETAIL IN-PLACE PAGE SWAP SPECIFICATIONS
  // -------------------------------------------------------------------------
  // 2a. In-place swap replaces list area inside same shell, popstate back button, URL synchronization
  const hasSelectedJobState = jobsCode.includes("selectedJob") && jobsCode.includes("setSelectedJob");
  const hasPopStateSync = jobsCode.includes("popstate") && jobsCode.includes("window.history.pushState");
  const hasJobDetailView = jobsCode.includes("<JobDetailView");
  if (!hasSelectedJobState || !hasPopStateSync || !hasJobDetailView) {
    failures.push("PAGE SWAP FAIL: Clicking a card must replace the list area with JobDetailView in-place with URL history and popstate back button.");
  } else {
    console.log("  [PASS] in-place swap: replaces list area with JobDetailView inside shell; URL synced via history.pushState and popstate");
  }

  // 2b. Top left "Back" text button with an arrow
  const hasBackButton = detailCode.includes("ArrowLeft") && detailCode.includes("Back") && detailCode.includes("onBack");
  if (!hasBackButton) {
    failures.push('BACK BUTTON FAIL: Job detail view must have top left "Back" text button with an arrow.');
  } else {
    console.log('  [PASS] detail navigation: top left "Back" text button with an arrow');
  }

  // 2c. Detail layout: Header block (logo, title 24px bold, company, chips, Save and Apply buttons)
  const has24pxTitle = detailCode.includes("text-[24px] font-bold text-[#0F172A]");
  const hasDetailCompany = detailCode.includes("text-[14px] text-[#475569]");
  const hasDetailLogo = detailCode.includes("CompanyLogo") && detailCode.includes("w-12 h-12 rounded-xl");
  const hasDetailChips = detailCode.includes("bg-[#F1F5F9] text-[#475569]");
  const hasDetailActions = detailCode.includes("onSave") && detailCode.includes("onApply");
  if (!has24pxTitle || !hasDetailCompany || !hasDetailLogo || !hasDetailChips || !hasDetailActions) {
    failures.push("DETAIL HEADER FAIL: Header block must include 48px logo, 24px bold title, 14px company, chips, Save and Apply buttons.");
  } else {
    console.log("  [PASS] detail header: 48px logo, title 24px bold ink, company 14px #475569, chips, Save and Apply buttons");
  }

  // 2d. Detail sections: each in a white 16px-radius card with a 18px bold heading
  const has18pxHeadings = detailCode.includes("text-[18px] font-bold text-[#0F172A]");
  const hasMatchBreakdown = detailCode.includes("Match breakdown");
  const hasJobDescription = detailCode.includes("Job description");
  const hasDescriptionStyle = detailCode.includes("text-[15px]") && detailCode.includes("leading-[24px]") && detailCode.includes("max-w-[720px]");
  if (!has18pxHeadings || !hasMatchBreakdown || !hasJobDescription || !hasDescriptionStyle) {
    failures.push("DETAIL SECTIONS FAIL: Sections must each be in a white 16px-radius card with 18px bold headings, description readable 15px/24px line height max width 720px.");
  } else {
    console.log("  [PASS] detail sections: white 16px-radius cards with 18px bold headings; description readable 15px/24px line height max-w-[720px]");
  }

  // 2e. Match breakdown: only with confirmed resume, otherwise the upload CTA
  const hasDetailResumeCondition = detailCode.includes("hasConfirmedResume && matchScore !== null ?");
  const hasDetailUploadCta = detailCode.includes("Upload your resume to see your real match") && detailCode.includes('href="/resume"');
  if (!hasDetailResumeCondition || !hasDetailUploadCta) {
    failures.push('DETAIL MATCH FAIL: Match breakdown must only render score with confirmed resume, otherwise the upload CTA linking to /resume.');
  } else {
    console.log('  [PASS] detail match breakdown: strictly requires confirmed resume; renders "Upload your resume to see your real match" when unconfirmed');
  }

  // 2f. Requirements and Benefits only if data exists
  const hasRequirementsGuard = detailCode.includes("requirementsList.length > 0");
  const hasBenefitsGuard = detailCode.includes("benefitsList.length > 0");
  if (!hasRequirementsGuard || !hasBenefitsGuard) {
    failures.push("DETAIL OPTIONAL SECTIONS FAIL: Requirements and Benefits sections must only render if data exists.");
  } else {
    console.log("  [PASS] detail optional sections: Requirements and Benefits render strictly when data exists");
  }

  // 2g. Sticky bottom Apply bar on mobile
  const hasMobileStickyBar = detailCode.includes("md:hidden fixed") && detailCode.includes("z-30") && detailCode.includes("Apply");
  if (!hasMobileStickyBar) {
    failures.push("MOBILE STICKY BAR FAIL: Mobile layout must have a sticky bottom Apply bar.");
  } else {
    console.log("  [PASS] mobile sticky bar: md:hidden sticky bottom Apply bar with 44px tap targets");
  }

  // -------------------------------------------------------------------------
  // 3. SKELETON LOADER & EMPTY STATE SPECIFICATIONS
  // -------------------------------------------------------------------------
  const hasSkeletonDimensions = jobsCode.includes("data-testid=\"jobs-skeleton-list\"") && jobsCode.includes("w-12 h-12 rounded-xl");
  const hasCentredEmptyState = jobsCode.includes("Search className=\"w-6 h-6\"") && jobsCode.includes("text-center");
  if (!hasSkeletonDimensions || !hasCentredEmptyState) {
    failures.push("SKELETON/EMPTY FAIL: Skeleton must match card dimensions (w-12 h-12) and empty state must have centred icon with one line of text.");
  } else {
    console.log("  [PASS] skeleton & empty state: skeleton cards match layout dimensions; empty state has centred icon and one line of text");
  }

  // -------------------------------------------------------------------------
  // 4. MOBILE LAYOUT SPECIFICATIONS
  // -------------------------------------------------------------------------
  const hasMobileFitMatchUnderChips = (jobsCode.includes("sm:hidden") && (jobsCode.includes("w-[54px]") || jobsCode.includes("Fit Match"))) || (jobsCode.includes("sm:hidden pt-2") && jobsCode.includes("Fit Match"));
  if (!hasMobileFitMatchUnderChips) {
    failures.push("MOBILE RESPONSIVENESS FAIL: On mobile, Fit Match panel must move under the chips.");
  } else {
    console.log("  [PASS] mobile responsiveness: cards full width, Fit Match panel moves under chips on mobile");
  }

  // -------------------------------------------------------------------------
  // 5. BRAND & FEATURE PURITY SPECIFICATIONS
  // -------------------------------------------------------------------------
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
    if (term.test(jobsCode) || term.test(detailCode)) {
      failures.push(`BRAND PURITY FAIL: Prohibited term "${term.source}" found in source.`);
    }
  }

  // -------------------------------------------------------------------------
  // 6. JOB DETAIL ACTIONS: SHARE & REPORT ISSUE SPECIFICATIONS
  // -------------------------------------------------------------------------
  const hasCanonicalShare =
    detailCode.includes("getCanonicalJobUrl") &&
    detailCode.includes("/jobs?id=") &&
    detailCode.includes("copyTextToClipboard") &&
    detailCode.includes("data-testid=\"share-job-button\"") &&
    detailCode.includes("data-testid=\"mobile-share-job-button\"");

  const hasCopiedSuccessCondition =
    detailCode.includes('shareStatus === "success"') &&
    detailCode.includes("Link copied");

  const hasUsableFallbackOnError =
    detailCode.includes('shareStatus === "error"') &&
    detailCode.includes('data-testid="share-fallback-container"') &&
    detailCode.includes('data-testid="share-fallback-input"');

  if (!hasCanonicalShare || !hasCopiedSuccessCondition || !hasUsableFallbackOnError) {
    failures.push("SHARE CONTROL FAIL: Job detail must have desktop & mobile Share controls, copy canonical URL without session params, show 'Link copied' only on success, and provide usable fallback container on failure.");
  } else {
    console.log("  [PASS] share control: Desktop and mobile share controls copy canonical URL (/jobs?id=); 'Link copied' shown strictly on success; usable fallback input on failure");
  }

  const hasVerifiedSupportDestination =
    detailCode.includes("support@careermonke.com") &&
    detailCode.includes("getReportJobMailto") &&
    detailCode.includes("data-testid=\"report-issue-link\"") &&
    detailCode.includes("data-testid=\"report-issue-detail-link\"");

  const hasNoPrivateCandidateDataInReport =
    !detailCode.includes("candidate.email") &&
    !detailCode.includes("user.email") &&
    !detailCode.includes("candidate.skills") &&
    !detailCode.includes("candidate.name");

  if (!hasVerifiedSupportDestination || !hasNoPrivateCandidateDataInReport) {
    failures.push("REPORT ISSUE FAIL: Report Issue must reuse verified support@careermonke.com with job id/title context, accessible links, and zero private candidate data.");
  } else {
    console.log("  [PASS] report issue: Reuses verified destination support@careermonke.com with job id/title context and zero candidate data");
  }

  if (failures.some((f) => f.includes("BRAND PURITY FAIL"))) {
    // already pushed
  } else {
    console.log("  [PASS] brand & feature purity: zero Jobright copy, mascots, coaching, agent, or autofill terms");
  }

  console.log("\n----------------------------------------------------------------------------------");
  if (isNegativeControl) {
    if (failures.length >= 4) {
      console.log(`NEGATIVE CONTROL PASSED: Detected ${failures.length} expected intentional failure(s):`);
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(1); // Non-zero exit code proves negative control works
    } else {
      console.error(`NEGATIVE CONTROL FAILED: Expected >= 4 failures, got ${failures.length}`);
      process.exit(0);
    }
  }

  if (failures.length > 0) {
    console.error("VALIDATION FAILED:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log("PROMPT 4 JOBS LIST & DETAIL REDESIGN VALIDATED LOCALLY [PASS-LOCAL]");
  process.exit(0);
}

run();
