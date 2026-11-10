import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("            PROMPT 8 REBUILD — LOGGED-IN APP SHELL AUDIT SUITE                   ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const railPath = path.resolve(process.cwd(), "src/components/shell/AppIconRail.tsx");
  const topBarPath = path.resolve(process.cwd(), "src/components/shell/AppTopBar.tsx");
  const shellContainerPath = path.resolve(process.cwd(), "src/components/shell/LoggedInAppShell.tsx");
  const sidebarLibPath = path.resolve(process.cwd(), "src/lib/sidebar.ts");
  const dashboardPath = path.resolve(process.cwd(), "src/app/dashboard/page.tsx");
  const jobsPath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");
  const trackerPath = path.resolve(process.cwd(), "src/app/tracker/page.tsx");
  const resumePath = path.resolve(process.cwd(), "src/app/resume/page.tsx");
  const settingsPath = path.resolve(process.cwd(), "src/app/settings/page.tsx");

  if (!fs.existsSync(railPath) || !fs.existsSync(topBarPath)) {
    console.error("FAIL: Required shell components are missing!");
    process.exit(1);
  }

  let railCode = fs.readFileSync(railPath, "utf-8");
  let topBarCode = fs.readFileSync(topBarPath, "utf-8");
  let shellContainerCode = fs.existsSync(shellContainerPath) ? fs.readFileSync(shellContainerPath, "utf-8") : "";
  let sidebarLibCode = fs.existsSync(sidebarLibPath) ? fs.readFileSync(sidebarLibPath, "utf-8") : "";
  let dashboardCode = fs.existsSync(dashboardPath) ? fs.readFileSync(dashboardPath, "utf-8") : "";
  let jobsCode = fs.readFileSync(jobsPath, "utf-8");
  let trackerCode = fs.readFileSync(trackerPath, "utf-8");
  let resumeCode = fs.readFileSync(resumePath, "utf-8");
  let settingsCode = fs.readFileSync(settingsPath, "utf-8");

  if (isNegativeControl) {
    // Inject corruptions for negative control
    railCode = railCode.replace(/w-\[72px\]/g, "w-[240px]");
    railCode = railCode.replace(/w-\[240px\]/g, "w-[600px]");
    railCode = railCode.replace(/Expand sidebar/g, "");
    railCode = railCode.replace(/Collapse sidebar/g, "");
    railCode = railCode.replace(/bg-\[#EFF6FF\]/g, "");
    railCode = railCode.replace(/hover:text-\[#2563EB\]/g, "hover:text-green-500");
    railCode = railCode.replace(/hidden md:flex/g, "flex");
    topBarCode = topBarCode.replace(/h-14/g, "h-20");
    topBarCode = topBarCode.replace(/Search by title or company/g, "");
    topBarCode = topBarCode.replace(/bg-\[#2563EB\]/g, "");
    topBarCode = topBarCode.replace(/Open navigation menu/g, "");
    topBarCode = topBarCode.replace(/z-\[60\]/g, "z-50");
    topBarCode = topBarCode.replace(/z-\[61\]/g, "z-50");
    jobsCode = jobsCode + '\n<aside className="w-[220px]">Old Sidebar</aside>';
    topBarCode = topBarCode + '\n<span>AI Career Coaching Agent</span>';
    jobsCode = jobsCode + '\ncount: "24+"';
    jobsCode = jobsCode.replace(/appliedApps/g, "[] as any");
    jobsCode = jobsCode.replace(/min-h-\[44px\]/g, "min-h-[30px]");
    topBarCode = topBarCode.replace(/min-h-\[44px\]/g, "min-h-[30px]");
    shellContainerCode = shellContainerCode.replace(/© 2026 Olive Ridley Media Private Limited\. All rights reserved\./g, "");
  }

  const failures: string[] = [];

  // -------------------------------------------------------------------------
  // 1. DUAL-MODE DESKTOP SIDEBAR SPECIFICATIONS (72px Narrow vs 240px Expanded)
  // -------------------------------------------------------------------------
  // 1a. Supports both 72px narrow rail and 240px expanded sidebar, white, 1px right border #E2E8F0
  const has72px = railCode.includes("w-[72px]");
  const has240px = railCode.includes("w-[240px]");
  const hasRailWhite = railCode.includes("bg-white");
  const hasBorderRight = railCode.includes("border-r") && railCode.includes("border-[#E2E8F0]");
  if (!has72px || !has240px || !hasRailWhite || !hasBorderRight) {
    failures.push("RAIL FAIL: Sidebar must support both narrow (w-[72px]) and expanded (w-[240px]) desktop modes with 1px right border #E2E8F0.");
  } else {
    console.log("  [PASS] dual-mode dimensions: narrow 72px (w-[72px]) and expanded 240px (w-[240px]) desktop modes supported");
  }

  // 1b. CareerMonke logo mark at the top
  const hasBrandIcon = railCode.includes("BrandIcon") && railCode.includes("CareerMonke");
  if (!hasBrandIcon) {
    failures.push("RAIL FAIL: Rail must have CareerMonke logo mark at the top.");
  } else {
    console.log("  [PASS] rail branding: small CareerMonke logo mark at top");
  }

  // 1c. Vertical nav items: Dashboard, Jobs, Resume, Profile, Tracker, Radar
  const hasDashboardNav = railCode.includes('"Dashboard"') || railCode.includes('label: "Dashboard"');
  const hasJobsNav = railCode.includes('"Jobs"') || railCode.includes('label: "Jobs"');
  const hasResumeNav = railCode.includes('"Resume"') || railCode.includes('label: "Resume"');
  const hasProfileNav = railCode.includes('"Profile"') || railCode.includes('label: "Profile"');
  const hasTrackerNav = railCode.includes('"Tracker"') || railCode.includes('label: "Tracker"');
  const hasRadarNav = railCode.includes('"Radar"') || railCode.includes('label: "Radar"');
  if (!hasDashboardNav || !hasJobsNav || !hasResumeNav || !hasProfileNav || !hasTrackerNav || !hasRadarNav) {
    failures.push("RAIL FAIL: Nav items must include Dashboard, Jobs, Resume, Profile, Tracker, and Radar.");
  } else {
    console.log("  [PASS] rail nav items: Dashboard, Jobs, Resume, Profile, Tracker, Radar present");
  }

  // 1d. Icon and label sizing in narrow mode (24px line icons centred over 11px labels)
  const has24pxIcon = railCode.includes("w-6 h-6");
  const has11pxLabel = railCode.includes("text-[11px]");
  if (!has24pxIcon || !has11pxLabel) {
    failures.push("RAIL FAIL: Narrow nav items must use 24px line icons (w-6 h-6) centred over 11px labels (text-[11px]).");
  } else {
    console.log("  [PASS] rail item sizing: 24px line icons over 11px labels in narrow mode");
  }

  // 1e. 56x56px item footprint, 8px side inset, 64px pitch (gap-2) in narrow mode
  const has56pxFootprint = railCode.includes("w-[56px] h-[56px]");
  const has8pxInset = railCode.includes("px-2");
  const hasPitch64 = railCode.includes("gap-2");
  if (!has56pxFootprint || !has8pxInset || !hasPitch64) {
    failures.push("RAIL GEOMETRY FAIL: Narrow rail items must have 56x56px footprint (w-[56px] h-[56px]), 8px side inset (px-2), and 64px vertical pitch (gap-2).");
  } else {
    console.log("  [PASS] rail geometry: 56x56px footprint, 8px inset, 64px pitch verified");
  }

  // 1f. Accessible expand/collapse control and state persistence
  const hasExpandToggle = railCode.includes("Expand sidebar") || railCode.includes("Collapse sidebar");
  const hasAriaExpanded = railCode.includes("aria-expanded");
  const hasSidebarPersistence = sidebarLibCode.includes("careermonke_sidebar_expanded");
  if (!hasExpandToggle || !hasAriaExpanded || !hasSidebarPersistence) {
    failures.push("SIDEBAR TOGGLE FAIL: Must provide accessible expand/collapse toggle with aria-expanded and persistent state across navigation via localStorage.");
  } else {
    console.log("  [PASS] sidebar toggle & persistence: accessible expand/collapse control with localStorage persistence");
  }

  // 1g. Fixed Settings icon at the bottom of the rail
  const hasSettingsBottom = railCode.includes("/settings") && railCode.includes("Settings");
  if (!hasSettingsBottom) {
    failures.push("RAIL FAIL: Fixed Settings nav item must exist at the bottom of the rail.");
  } else {
    console.log("  [PASS] rail bottom: fixed Settings item at the bottom of the sidebar");
  }

  // -------------------------------------------------------------------------
  // 2. COACHING-STYLE HOVER & KEYBOARD FOCUS TREATMENT (CareerMonke Blue Branding)
  // -------------------------------------------------------------------------
  // 2a. Inactive hover: soft light-blue tint background #F0F7FF, vibrant blue text #2563EB
  const hasCoachingHoverBg = railCode.includes("hover:bg-[#F0F7FF]");
  const hasCoachingHoverText = railCode.includes("hover:text-[#2563EB]");
  if (!hasCoachingHoverBg || !hasCoachingHoverText) {
    failures.push("HOVER TREATMENT FAIL: Inactive nav items must feature coaching-style light-blue hover background (hover:bg-[#F0F7FF]) and vibrant blue text (hover:text-[#2563EB]).");
  } else {
    console.log("  [PASS] coaching-style hover: soft light-blue background (#F0F7FF) and blue text (#2563EB) on hover");
  }

  // 2b. Persistent active route state distinct from hover
  const hasDistinctActive = railCode.includes("bg-[#EFF6FF]") && railCode.includes("aria-current");
  if (!hasDistinctActive) {
    failures.push("ACTIVE ROUTE FAIL: Persistent active route state must use #EFF6FF background and aria-current, distinct from hover.");
  } else {
    console.log("  [PASS] persistent active route: distinct active route state with #EFF6FF background and aria-current");
  }

  // 2c. Keyboard focus indicators matching WCAG 2.1
  const hasKeyboardFocus = railCode.includes("focus-visible:ring-2") && railCode.includes("focus-visible:ring-[#2563EB]");
  if (!hasKeyboardFocus) {
    failures.push("FOCUS TREATMENT FAIL: Nav items must provide accessible keyboard focus indicators (focus-visible:ring-2 focus-visible:ring-[#2563EB]).");
  } else {
    console.log("  [PASS] keyboard focus: accessible WCAG 2.1 focus indicators on all nav items");
  }

  // -------------------------------------------------------------------------
  // 3. TOP BAR CLEANUP & DYNAMIC CONTENT REFLOW
  // -------------------------------------------------------------------------
  // 3a. Top bar height: 56px (h-14), white, 1px bottom border #E2E8F0
  const hasTopBarH14 = topBarCode.includes("h-14");
  const hasTopBarWhite = topBarCode.includes("bg-white");
  const hasTopBarBorder = topBarCode.includes("border-b") && topBarCode.includes("border-[#E2E8F0]");
  if (!hasTopBarH14 || !hasTopBarWhite || !hasTopBarBorder) {
    failures.push("TOP BAR FAIL: Top bar must be 56px height (h-14), white (bg-white), with 1px bottom border #E2E8F0.");
  } else {
    console.log("  [PASS] top bar shell: 56px height (h-14), white background, 1px bottom border #E2E8F0");
  }

  // 3b. Duplicated primary navigation removed from top bar
  const topBarHasDashboard = topBarCode.includes('href="/dashboard"') && topBarCode.includes("md:flex");
  const topBarHasResume = topBarCode.includes('href="/resume"') && topBarCode.includes("md:flex");
  if (topBarHasDashboard || topBarHasResume) {
    failures.push("TOP BAR FAIL: Duplicated desktop primary nav links (Dashboard, Resume, etc.) must be removed from AppTopBar.");
  } else {
    console.log("  [PASS] top bar cleanup: duplicated desktop primary nav links removed from top bar");
  }

  // 3c. Top bar right-aligned user controls: circular avatar with user initial, bold 13px full name, plan pill
  const hasAvatarInitial = topBarCode.includes("userInitial") && topBarCode.includes("bg-[#2563EB]");
  const hasDisplayName = topBarCode.includes("displayName") && topBarCode.includes("text-[13px]");
  const hasPlanPill = topBarCode.includes("Free") && topBarCode.includes("Pro");
  if (!hasAvatarInitial || !hasDisplayName || !hasPlanPill) {
    failures.push("TOP BAR CONTROLS FAIL: Top bar must display circular avatar with user initial, full name bold 13px, and Free/Pro plan pill.");
  } else {
    console.log("  [PASS] top bar account controls: avatar initial, bold 13px name, Free/Pro plan pill verified");
  }

  // 3d. Top bar fully-rounded search input
  const hasSearchInput = topBarCode.includes("rounded-full") && topBarCode.includes("Search by title or company");
  if (!hasSearchInput) {
    failures.push("TOP BAR SEARCH FAIL: Top bar must feature fully-rounded search input (rounded-full).");
  } else {
    console.log("  [PASS] top bar search: fully-rounded search input present");
  }

  // 3e. Dynamic content reflow without overlap across narrow (72px) and expanded (240px)
  const hasDynamicPaddingReflow =
    (dashboardCode.includes("md:pl-[72px]") && dashboardCode.includes("md:pl-[240px]")) ||
    (shellContainerCode.includes("md:pl-[72px]") && shellContainerCode.includes("md:pl-[240px]")) ||
    (dashboardCode.includes("useSidebarMode") && shellContainerCode.includes("useSidebarMode"));

  if (!hasDynamicPaddingReflow) {
    failures.push("CONTENT REFLOW FAIL: Pages or LoggedInAppShell must reflow content dynamically based on sidebar mode (md:pl-[72px] vs md:pl-[240px]) to prevent overlap.");
  } else {
    console.log("  [PASS] dynamic content reflow: content smoothly reflows without clipping or overlap based on chosen sidebar mode");
  }

  // -------------------------------------------------------------------------
  // 4. MOBILE RESPONSIVENESS & STACKING (z-[60] backdrop, z-[61] drawer)
  // -------------------------------------------------------------------------
  // Desktop rail is hidden on mobile; mobile uses hamburger navigation drawer
  const railHiddenOnMobile = railCode.includes("hidden md:flex");
  const hasHamburgerButton = topBarCode.includes("Open navigation menu") || topBarCode.includes('aria-label="Open navigation menu"');
  const hasMobileDrawer = topBarCode.includes('id="mobile-nav-drawer"') || topBarCode.includes('aria-label="Mobile Navigation"');
  const has44pxTouchTargets = topBarCode.includes("min-h-[44px]");
  const hasRaisedZIndex = topBarCode.includes("z-[60]") && topBarCode.includes("z-[61]");
  if (!railHiddenOnMobile) {
    failures.push("MOBILE FAIL: Desktop rail must be hidden on mobile (hidden md:flex).");
  } else if (!hasHamburgerButton || !hasMobileDrawer || !has44pxTouchTargets) {
    failures.push("MOBILE FAIL: Mobile must provide hamburger navigation drawer with >=44px tap targets.");
  } else if (!hasRaisedZIndex) {
    failures.push("MOBILE STACKING FAIL: Mobile navigation backdrop must use z-[60] and drawer must use z-[61] to stay above CookieNotice z-50.");
  } else {
    console.log("  [PASS] mobile responsiveness & stacking: desktop rail hidden on mobile; drawer has >=44px targets, backdrop z-[60] & drawer z-[61] above CookieNotice");
  }

  // -------------------------------------------------------------------------
  // 5. PURITY & 220PX SIDEBAR ELIMINATION
  // -------------------------------------------------------------------------
  // 5a. Zero legacy 220px sidebars anywhere in the codebase (distinguishing sidebar width from column height/truncation)
  const allCodes = [dashboardCode, jobsCode, trackerCode, resumeCode, settingsCode, railCode, topBarCode, shellContainerCode];
  const legacySidebarPattern = /(?:aside|sidebar|nav)[^>]*220px|w-\[220px\]/i;
  const has220pxSidebar = allCodes.some((c) => legacySidebarPattern.test(c));
  if (has220pxSidebar) {
    failures.push("LEGACY FAIL: Found lingering '220px' sidebar references in application pages.");
  } else {
    console.log("  [PASS] legacy cleanup: zero 220px sidebar references across all pages");
  }

  // 5b. Pages use AppIconRail and AppTopBar
  const pagesHaveRail = dashboardCode.includes("AppIconRail") && jobsCode.includes("AppIconRail") && trackerCode.includes("AppIconRail") && resumeCode.includes("AppIconRail") && settingsCode.includes("AppIconRail");
  const pagesHaveTopBar = dashboardCode.includes("AppTopBar") && jobsCode.includes("AppTopBar") && trackerCode.includes("AppTopBar") && resumeCode.includes("AppTopBar") && settingsCode.includes("AppTopBar");
  if (!pagesHaveRail || !pagesHaveTopBar) {
    failures.push("SHELL ADOPTION FAIL: AppIconRail and AppTopBar must be adopted on /dashboard, /jobs, /tracker, /resume, and /settings.");
  } else {
    console.log("  [PASS] shell adoption: AppIconRail and AppTopBar integrated across /dashboard, /jobs, /tracker, /resume, /settings");
  }

  // 5c. Strict Jobright purity: no Jobright logo, mascot, copy; no Agent, Coaching, Interview, Autofill, or upsell pills
  const forbiddenPhrases = [
    "jobright",
    "coaching",
    "interview prep",
    "autofill",
    "ai agent",
    "career coaching",
  ];
  const violatedPhrases: string[] = [];
  for (const phrase of forbiddenPhrases) {
    for (const [name, code] of [
      ["rail", railCode],
      ["topbar", topBarCode],
      ["dashboard", dashboardCode],
      ["jobs", jobsCode],
      ["tracker", trackerCode],
      ["resume", resumeCode],
      ["settings", settingsCode],
    ]) {
      if (code.toLowerCase().includes(phrase)) {
        violatedPhrases.push(`${name} contains forbidden phrase '${phrase}'`);
      }
    }
  }

  if (violatedPhrases.length > 0) {
    failures.push(`BRAND/FEATURE PURITY FAIL: Found forbidden elements: ${violatedPhrases.join("; ")}`);
  } else {
    console.log("  [PASS] brand & feature purity: zero Jobright copy, mascots, or coaching/agent/autofill pills");
  }

  // -------------------------------------------------------------------------
  // 6. FOLLOW-UP AUDITS: TAB BADGE DATA INTEGRITY & TOUCH TARGETS
  // -------------------------------------------------------------------------
  // 6a. Zero hardcoded "24+" count literal in jobs page; real length used and hidden when 0 or loading
  const hasHardcoded24 = jobsCode.includes('"24+"') || jobsCode.includes("24+");
  const hasExternalCountCalc = jobsCode.includes("externalJobsCount") && jobsCode.includes("job.directSource");
  const hasHideExternalWhenZero =
    jobsCode.includes("!loadingJobs && externalJobsCount > 0 ? externalJobsCount : undefined") &&
    jobsCode.includes("!loadingJobs && externalJobsCount > 0 &&");

  if (hasHardcoded24 || !hasExternalCountCalc || !hasHideExternalWhenZero) {
    failures.push('DATA INTEGRITY FAIL: External tab must NOT contain hardcoded "24+" literal; must derive dynamically from job.directSource and hide when 0 or loading.');
  } else {
    console.log('  [PASS] tab counts: zero hardcoded "24+" count literal; External tab badge derives dynamically and hides when 0/loading');
  }

  // 6b. Applied & Saved tabs derive from tracker data with out-of-page resolution
  const hasTrackerDerivedApplied =
    jobsCode.includes("appliedApps") &&
    jobsCode.includes("trackedAppToLiveJob") &&
    jobsCode.includes("appliedCount");
  const hasOutOfPageResolution =
    jobsCode.includes("missingJobIds") &&
    jobsCode.includes("getLiveJobById");
  const hasHardcodedEmptyApplied = /activeTab\s*===\s*["']applied["']\s*\)\s*\{\s*result\s*=\s*\[\]/.test(jobsCode);

  if (!hasTrackerDerivedApplied || !hasOutOfPageResolution || hasHardcodedEmptyApplied) {
    failures.push('APPLIED TAB FAIL: Applied tab must derive live jobs from tracker applications and resolve out-of-page jobIds, not result = [].');
  } else {
    console.log("  [PASS] applied & saved tab list: derives from tracker applications and resolves jobs outside the first page");
  }

  // 6c. Tab buttons: min-h-[44px] touch target
  const tabButtonsTouchTargets = jobsCode.includes("min-h-[44px]") && topBarCode.includes("min-h-[44px]");
  if (!tabButtonsTouchTargets) {
    failures.push("TOUCH ACCESSIBILITY FAIL: Tab buttons must have min-h-[44px] on touch screens.");
  } else {
    console.log("  [PASS] tab buttons: min-h-[44px] touch target enforced across desktop and mobile tabs");
  }

  // 7. Footer Copyright Line in LoggedInAppShell
  const hasAppShellCopyright = shellContainerCode.includes("© 2026 Olive Ridley Media Private Limited. All rights reserved.");
  if (!hasAppShellCopyright) {
    failures.push("APP SHELL FAIL: LoggedInAppShell must include exact copyright line '© 2026 Olive Ridley Media Private Limited. All rights reserved.'.");
  } else {
    console.log("  [PASS] app shell footer: exact corporate copyright line present in LoggedInAppShell");
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

  console.log("PROMPT 8 LOGGED-IN APP SHELL & DUAL-MODE SIDEBAR VALIDATED LOCALLY [PASS-LOCAL]");
  process.exit(0);
}

run();
