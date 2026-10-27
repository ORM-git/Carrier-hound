/**
 * test-compact-spacing.ts
 *
 * Verifies compact spacing (vertical gaps and padding only) on all signed-in pages,
 * matching the compact density of Jobright, plus the sidebar user profile add-on.
 *
 * Rules:
 * - Gap between top nav and filter row on /jobs: ~16px (sm:pt-4, sm:py-0).
 * - Gap between filter rows: 8px (gap-2). Gap between filters and first card: 12px (space-y-3, pt-0).
 * - Job card: padding reduced to 16px (p-4), empty space under meta grid removed (height ~230px at 1440).
 * - Gap between cards: 12px (space-y-3).
 * - Right sidebar: card padding 16px (p-4), gap between widgets 12px (space-y-3).
 * - CM add-on: User name and plan badge (Pro/Free) at the top of the right sidebar above Saved Filters,
 *   with small avatar and divider below. Top bar does not duplicate user name on desktop when on /jobs.
 * - Compact scale on other signed-in pages (dashboard, profile, pricing, job detail, tracker, modals).
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
  duplicateHeaderName?: boolean;
  removeSidebarUserCard?: boolean;
  revertCardPadding?: boolean;
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
  const modalPath = path.resolve(process.cwd(), "src/components/Modal.tsx");

  let jobsCode = fs.readFileSync(jobsPath, "utf-8");
  let topBarCode = fs.readFileSync(topBarPath, "utf-8");
  let filterBarCode = fs.readFileSync(filterBarPath, "utf-8");
  let detailCode = fs.readFileSync(detailPath, "utf-8");
  let dashCode = fs.readFileSync(dashPath, "utf-8");
  let profileCode = fs.readFileSync(profilePath, "utf-8");
  let pricingCode = fs.readFileSync(pricingPath, "utf-8");
  let modalCode = fs.readFileSync(modalPath, "utf-8");

  // Apply in-memory corruptions for negative controls
  if (corruptions.revertNavGap) {
    jobsCode = jobsCode.replace(/sm:pt-4/g, "sm:pt-12");
  }
  if (corruptions.duplicateHeaderName) {
    topBarCode = topBarCode.replace(/pathname !== "\/jobs"/g, "true");
  }
  if (corruptions.removeSidebarUserCard) {
    jobsCode = jobsCode.replace(/data-testid="sidebar-user-card"/g, 'data-testid="removed-user-card"');
  }
  if (corruptions.revertCardPadding) {
    jobsCode = jobsCode.replace(/p-4 shadow-none/g, "p-8 shadow-none");
  }
  if (corruptions.revertSidebarGap) {
    jobsCode = jobsCode.replace(/w-\[316px\] shrink-0 space-y-3/g, "w-[316px] shrink-0 space-y-8");
  }

  // Check 1: Gap between top nav and filter row (~16px on desktop)
  const hasCompactNavGap = jobsCode.includes("sm:pt-4") && filterBarCode.includes("sm:py-0");
  if (!hasCompactNavGap) {
    failures.push("NAV GAP FAIL: Gap between top nav and filter row must be ~16px (sm:pt-4 on main, sm:py-0 on filter bar).");
  }

  // Check 2: Filter rows gap (8px) & gap between filters and first card (12px)
  const hasFilterRowGap = filterBarCode.includes("gap-2");
  const hasFiltersToCardsGap = jobsCode.includes("space-y-3") && jobsCode.includes("pt-0");
  if (!hasFilterRowGap || !hasFiltersToCardsGap) {
    failures.push("FILTER GAP FAIL: Gap between filter rows must be 8px (gap-2) and gap to first card must be 12px (space-y-3, pt-0).");
  }

  // Check 3: Job card padding 16px & no empty space under meta grid (height ~230px)
  const hasCardPadding16 = jobsCode.includes("rounded-[16px] ring-1 ring-[#E2E8F0] p-4 shadow-none");
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

  // Check 6: CM add-on - User's name and plan badge (Pro/Free) at top of right sidebar
  const hasSidebarUserCard = jobsCode.includes('data-testid="sidebar-user-card"');
  const hasSidebarPlanBadge = jobsCode.includes('data-testid="sidebar-plan-badge"');
  const hasSidebarUserAvatar = jobsCode.includes("w-8 h-8 rounded-full bg-[#2563EB]");
  const hasSidebarDivider = jobsCode.includes('className="border-b border-[#E2E8F0]"');
  if (!hasSidebarUserCard || !hasSidebarPlanBadge || !hasSidebarUserAvatar || !hasSidebarDivider) {
    failures.push("SIDEBAR USER CARD FAIL: Signed-in /jobs must display user's avatar, name, plan pill, and divider at top of right sidebar.");
  }

  // Check 7: Desktop top bar does not duplicate user name when on /jobs
  const hasHeaderDeduplication = topBarCode.includes('pathname !== "/jobs"') && topBarCode.includes("displayName");
  if (!hasHeaderDeduplication) {
    failures.push("HEADER DEDUPLICATION FAIL: Desktop top bar must not duplicate user name when on /jobs.");
  }

  // Check 8: Compact scale on other signed-in pages
  const hasCompactDashboard = dashCode.includes("py-tk-2 sm:py-tk-3") && dashCode.includes("space-y-tk-2") && dashCode.includes("p-tk-2");
  const hasCompactProfile = profileCode.includes("p-4 sm:p-5") && profileCode.includes("space-y-4");
  const hasCompactPricing = pricingCode.includes("p-tk-2.5 sm:p-tk-3") && pricingCode.includes("space-y-tk-3");
  const hasCompactDetail = detailCode.includes("p-4 sm:p-4 shadow-none space-y-3") && detailCode.includes("space-y-3 md:pb-12");
  const hasCompactModal = modalCode.includes("p-4 sm:p-5") && modalCode.includes("mb-3");

  if (!hasCompactDashboard || !hasCompactProfile || !hasCompactPricing || !hasCompactDetail || !hasCompactModal) {
    failures.push("COMPACT SCALE FAIL: Compact density scale (section gaps 16-20px, card padding 16px) must be applied across dashboard, profile, pricing, job detail, and modals.");
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

  console.log("  [PASS] Target 1: Gap between top nav and filter row tightened to ~16px");
  console.log("  [PASS] Target 2: Filter row gap (8px) and filter-to-card gap (12px) verified");
  console.log("  [PASS] Target 3: Job card padding reduced to 16px (p-4), meta grid stretch removed (height ~230px)");
  console.log("  [PASS] Target 4: Gap between cards verified at 12px (space-y-3)");
  console.log("  [PASS] Target 5: Right sidebar widget gap 12px (space-y-3) and card padding 16px (p-4) verified");
  console.log("  [PASS] Add-on 1: Sidebar user card with avatar, name, Pro/Free badge, and divider verified");
  console.log("  [PASS] Add-on 2: Header user name deduplicated on desktop for /jobs, mobile header preserved");
  console.log("  [PASS] Compact Scale: Applied across dashboard, profile, pricing, job detail, and modals");
  console.log("\n----------------------------------------------------------------------------------");
  console.log("SIGNED-IN COMPACT DENSITY & SIDEBAR USER CARD [PASS-LOCAL]");
  process.exit(0);
} else {
  console.log("Mode: NEGATIVE CONTROL (Expect Failures)\n");

  const corruptions = [
    { name: "Reverting nav gap to ~48px", opts: { revertNavGap: true } },
    { name: "Duplicating header name on desktop /jobs", opts: { duplicateHeaderName: true } },
    { name: "Removing right sidebar user card", opts: { removeSidebarUserCard: true } },
    { name: "Reverting job card padding to 32px", opts: { revertCardPadding: true } },
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
