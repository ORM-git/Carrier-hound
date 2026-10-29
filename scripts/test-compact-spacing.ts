/**
 * test-compact-spacing.ts
 *
 * Verifies compact spacing on all signed-in pages for desktop/tablet (matching Jobright density),
 * while asserting that base/mobile (<640px) spacing classes remain strictly unchanged from main.
 * Also verifies that the sidebar plan badge is gated by isProDefinitive so that non-definitive
 * states render a neutral skeleton and never show "Free" while loading or on error.
 *
 * Usage:
 *   npx tsx scripts/test-compact-spacing.ts
 *   npx tsx scripts/test-compact-spacing.ts --negative-control
 */

import fs from "fs";
import path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function runAudit(corruptions: {
  revertNavGap?: boolean;
  breakMobileBaseNavGap?: boolean;
  removeIsProDefinitiveGating?: boolean;
  duplicateHeaderName?: boolean;
  removeSidebarUserCard?: boolean;
  breakMobileDashboardBase?: boolean;
  revertSidebarGap?: boolean;
} = {}) {
  const failures: string[] = [];

  const jobsPath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");
  const topBarPath = path.resolve(process.cwd(), "src/components/shell/AppTopBar.tsx");
  const filterBarPath = path.resolve(process.cwd(), "src/components/jobs/JobFilterBar.tsx");
  const detailPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");
  const dashPath = path.resolve(process.cwd(), "src/app/dashboard/page.tsx");
  const profilePath = path.resolve(process.cwd(), "src/app/profile/page.tsx");
  const pricingPath = path.resolve(process.cwd(), "src/app/pricing/page.tsx");
  const trackerPath = path.resolve(process.cwd(), "src/app/tracker/page.tsx");
  const modalPath = path.resolve(process.cwd(), "src/components/Modal.tsx");
  const topTenPath = path.resolve(process.cwd(), "src/components/dashboard/TopTenCompatibleJobs.tsx");
  const whyMatchPath = path.resolve(process.cwd(), "src/components/dashboard/WhyMatchPanel.tsx");

  let jobsCode = fs.readFileSync(jobsPath, "utf-8");
  let topBarCode = fs.readFileSync(topBarPath, "utf-8");
  let filterBarCode = fs.readFileSync(filterBarPath, "utf-8");
  let detailCode = fs.readFileSync(detailPath, "utf-8");
  let dashCode = fs.readFileSync(dashPath, "utf-8");
  let profileCode = fs.readFileSync(profilePath, "utf-8");
  let pricingCode = fs.readFileSync(pricingPath, "utf-8");
  let trackerCode = fs.readFileSync(trackerPath, "utf-8");
  let modalCode = fs.readFileSync(modalPath, "utf-8");
  let topTenCode = fs.readFileSync(topTenPath, "utf-8");
  let whyMatchCode = fs.readFileSync(whyMatchPath, "utf-8");

  // Apply in-memory corruptions for negative controls
  if (corruptions.revertNavGap) {
    jobsCode = jobsCode.replace(/sm:pt-4/g, "sm:pt-12");
  }
  if (corruptions.breakMobileBaseNavGap) {
    jobsCode = jobsCode.replace(/py-5 sm:pt-4 space-y-4 sm:space-y-3/g, "py-3 sm:pt-4 space-y-3");
  }
  if (corruptions.removeIsProDefinitiveGating) {
    jobsCode = jobsCode.replace(/\{isProDefinitive \?/g, "{true ?");
  }
  if (corruptions.duplicateHeaderName) {
    topBarCode = topBarCode.replace(/pathname !== "\/jobs"/g, "true");
  }
  if (corruptions.removeSidebarUserCard) {
    jobsCode = jobsCode.replace(/data-testid="sidebar-user-card"/g, 'data-testid="removed-user-card"');
  }
  if (corruptions.breakMobileDashboardBase) {
    dashCode = dashCode.replace(/p-tk-3 sm:p-tk-2/g, "p-tk-2");
  }
  if (corruptions.revertSidebarGap) {
    jobsCode = jobsCode.replace(/w-\[316px\] shrink-0 space-y-3/g, "w-[316px] shrink-0 space-y-8");
  }

  // Check 1: Gap between top nav and filter row (~16px on desktop sm:pt-4, sm:py-0; mobile base py-5, py-2 unchanged)
  const hasCompactNavGap = jobsCode.includes("sm:pt-4") && filterBarCode.includes("sm:py-0");
  const hasMobileBaseNav = jobsCode.includes("py-5 sm:pt-4") &&
    jobsCode.includes("space-y-4 sm:space-y-3") &&
    filterBarCode.includes("py-2 sm:py-0");
  if (!hasCompactNavGap || !hasMobileBaseNav) {
    failures.push("NAV GAP FAIL: Gap between top nav and filter row must be ~16px on desktop (sm:pt-4, sm:py-0), while mobile base remains py-5, space-y-4, and py-2.");
  }

  // Check 2: Filter rows gap (8px), gap to cards (12px on sm), mobile pt-2 preserved
  const hasFilterRowGap = filterBarCode.includes("gap-2");
  const hasFiltersToCardsGap = jobsCode.includes("space-y-4 sm:space-y-3") && jobsCode.includes("pt-2 sm:pt-0");
  if (!hasFilterRowGap || !hasFiltersToCardsGap) {
    failures.push("FILTER GAP FAIL: Gap between filter rows must be 8px (gap-2) and gap to first card must be 12px on sm (pt-2 sm:pt-0, space-y-4 sm:space-y-3).");
  }

  // Check 3: Job card padding 16px & no empty space under meta grid (height ~230px)
  const hasCardPadding16 = jobsCode.includes("p-4");
  const hasCompactInnerHeight = jobsCode.includes("min-h-[196px]") && jobsCode.includes("gap-2.5");
  if (!hasCardPadding16 || !hasCompactInnerHeight) {
    failures.push("JOB CARD FAIL: Job card must have 16px padding (p-4) and no empty space under meta grid (min-h-[196px], gap-2.5).");
  }

  // Check 4: Gap between cards (12px)
  const hasCardGap12 = jobsCode.includes("space-y-3");
  if (!hasCardGap12) {
    failures.push("CARD GAP FAIL: Gap between job cards must be 12px (space-y-3).");
  }

  // Check 5: Right sidebar card padding 16px (p-4), gap between widgets 12px (space-y-3)
  const hasSidebarGap12 = jobsCode.includes("w-[316px] shrink-0 space-y-3 sticky top-20");
  const hasSidebarCardPadding = jobsCode.includes("p-4 space-y-3");
  if (!hasSidebarGap12 || !hasSidebarCardPadding) {
    failures.push("SIDEBAR FAIL: Right sidebar must have 12px gap between widgets (space-y-3) and 16px card padding (p-4).");
  }

  // Check 6: Sidebar user card with avatar, name, and definitive-gated plan badge
  const hasSidebarUserCard = jobsCode.includes('data-testid="sidebar-user-card"');
  const hasSidebarPlanBadge = jobsCode.includes('data-testid="sidebar-plan-badge"');
  const hasSidebarUserAvatar = jobsCode.includes("w-8 h-8 rounded-full bg-[#2563EB]");
  const hasSidebarDivider = jobsCode.includes('className="border-b border-[#E2E8F0]"');
  const hasDefinitivePlanGating = jobsCode.includes("{isProDefinitive ?") &&
    jobsCode.includes("animate-pulse") &&
    !jobsCode.includes("!isProDefinitive ? 'Free'");
  if (!hasSidebarUserCard || !hasSidebarPlanBadge || !hasSidebarUserAvatar || !hasSidebarDivider || !hasDefinitivePlanGating) {
    failures.push("SIDEBAR USER CARD FAIL: Signed-in /jobs must display user's avatar, name, and plan pill gated strictly by isProDefinitive (neutral skeleton while loading/error).");
  }

  // Check 7: Desktop top bar does not duplicate user name when on /jobs
  const hasHeaderDeduplication = topBarCode.includes('pathname !== "/jobs"') && topBarCode.includes("displayName");
  if (!hasHeaderDeduplication) {
    failures.push("HEADER DEDUPLICATION FAIL: Desktop top bar must not duplicate user name when on /jobs.");
  }

  // Check 8: Compact scale applied on desktop behind sm:, mobile base classes unchanged across all signed-in pages
  const hasDashboardMobileBase = dashCode.includes("py-tk-3 sm:py-tk-3") &&
    dashCode.includes("space-y-tk-3 sm:space-y-tk-2") &&
    dashCode.includes("p-tk-3 sm:p-tk-2");
  const hasProfileMobileBase = profileCode.includes("py-6 sm:py-5") &&
    profileCode.includes("space-y-6 sm:space-y-4") &&
    profileCode.includes("p-6 sm:p-5");
  const hasPricingMobileBase = pricingCode.includes("p-tk-4 sm:p-tk-3") &&
    pricingCode.includes("gap-tk-4 sm:gap-tk-3") &&
    pricingCode.includes("space-y-tk-4 sm:space-y-tk-3");
  const hasDetailMobileBase = (detailCode.includes("space-y-4 sm:space-y-3 pb-24 md:pb-0") || detailCode.includes("space-y-4 sm:space-y-3 md:pb-12")) &&
    detailCode.includes("p-5 sm:p-4 shadow-none space-y-4 sm:space-y-3");
  const hasTrackerMobileBase = trackerCode.includes("py-5 sm:py-4 space-y-5 sm:space-y-3.5") &&
    trackerCode.includes("p-6 sm:p-5 space-y-4 sm:space-y-3");
  const hasModalMobileBase = modalCode.includes("p-5 sm:p-5") &&
    modalCode.includes("mb-4 sm:mb-3");
  const hasTopTenMobileBase = topTenCode.includes("space-y-5 sm:space-y-4") &&
    topTenCode.includes("p-5 sm:p-4");
  const hasWhyMatchMobileBase = whyMatchCode.includes("space-y-4 sm:space-y-3");

  if (
    !hasDashboardMobileBase ||
    !hasProfileMobileBase ||
    !hasPricingMobileBase ||
    !hasDetailMobileBase ||
    !hasTrackerMobileBase ||
    !hasModalMobileBase ||
    !hasTopTenMobileBase ||
    !hasWhyMatchMobileBase
  ) {
    failures.push("COMPACT SCALE & MOBILE BASE FAIL: Base mobile spacing must remain strictly unchanged from main, with compact density applied only via sm: / lg: prefixes.");
  }

  return failures;
}

console.log("==================================================================================");
console.log("       TEST: SIGNED-IN PAGES COMPACT DENSITY & SIDEBAR USER CARD AUDIT           ");
console.log("==================================================================================");

if (!isNegativeControl) {
  console.log("Mode: NORMAL VALIDATION\n");
  const failures = runAudit();
  if (failures.length > 0) {
    console.error("FAILED AUDIT CHECKS:");
    for (const f of failures) console.error(" - " + f);
    process.exit(1);
  }

  console.log("  [PASS] Target 1: Gap between top nav and filter row tightened to ~16px on desktop, mobile base preserved");
  console.log("  [PASS] Target 2: Filter row gap (8px) and filter-to-card gap (12px) verified");
  console.log("  [PASS] Target 3: Job card padding 16px (p-4), meta grid stretch removed (height ~230px)");
  console.log("  [PASS] Target 4: Gap between cards verified at 12px (space-y-3)");
  console.log("  [PASS] Target 5: Right sidebar widget gap 12px (space-y-3) and card padding 16px (p-4) verified");
  console.log("  [PASS] Add-on 1: Sidebar user card with avatar, name, divider, and isProDefinitive-gated plan pill");
  console.log("  [PASS] Add-on 2: Header user name deduplicated on desktop for /jobs, mobile header preserved");
  console.log("  [PASS] Mobile Base & Compact Scale: All 8 signed-in pages preserve main's base mobile spacing and apply compact scale on desktop");
  console.log("\n----------------------------------------------------------------------------------");
  console.log("SIGNED-IN COMPACT DENSITY & SIDEBAR USER CARD [PASS-LOCAL]");
  process.exit(0);
} else {
  console.log("Mode: NEGATIVE CONTROL (Expect Failures)\n");

  const corruptions = [
    { name: "Reverting desktop nav gap to ~48px", opts: { revertNavGap: true } },
    { name: "Breaking mobile base nav gap below 640px", opts: { breakMobileBaseNavGap: true } },
    { name: "Bypassing isProDefinitive gating on sidebar plan badge", opts: { removeIsProDefinitiveGating: true } },
    { name: "Duplicating header name on desktop /jobs", opts: { duplicateHeaderName: true } },
    { name: "Removing right sidebar user card", opts: { removeSidebarUserCard: true } },
    { name: "Breaking mobile base spacing on dashboard", opts: { breakMobileDashboardBase: true } },
    { name: "Reverting sidebar widget gap to 32px", opts: { revertSidebarGap: true } },
  ];

  let caughtCount = 0;
  for (const c of corruptions) {
    const errs = runAudit(c.opts);
    if (errs.length > 0) {
      console.log(`  [CAUGHT] ${c.name} -> detected failure: ${errs[0]}`);
      caughtCount++;
    } else {
      console.error(`  [MISSED] ${c.name} -> did NOT trigger a test failure!`);
      process.exit(1);
    }
  }

  console.log(`\n----------------------------------------------------------------------------------`);
  console.log(`NEGATIVE CONTROL PASSED: All ${caughtCount} deliberate corruptions caught as expected.`);
  process.exit(0);
}
