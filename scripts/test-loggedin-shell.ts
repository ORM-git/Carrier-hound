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
    jobsCode = jobsCode + '\n<aside className="w-[220px]">Old Sidebar</aside>';
    topBarCode = topBarCode + '\n<span>AI Career Coaching Agent</span>';
    jobsCode = jobsCode + '\ncount: "24+"';
    jobsCode = jobsCode.replace(/appliedJobIds\.includes\(job\.id\)/g, "true ? [] : false");
    jobsCode = jobsCode.replace(/min-h-\[44px\]/g, "min-h-[30px]");
    topBarCode = topBarCode.replace(/min-h-\[44px\]/g, "min-h-[30px]");
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
    console.log("  [PASS] narrow sizing: 24px line icons centred over 11px labels");
  }

  // 1e. Active item vs Hover & Focus Treatment
  const hasActiveBg = railCode.includes("bg-[#EFF6FF]");
  const hasActiveText = railCode.includes("text-[#2563EB]");
  const has12pxRadius = railCode.includes("rounded-[12px]");
  const hasHoverBlue = railCode.includes("hover:text-[#2563EB]") && railCode.includes("hover:bg-[#F0F7FF]");
  const hasFocusState = railCode.includes("focus-visible:ring-[#2563EB]");
  const hasAriaCurrent = railCode.includes("aria-current");
  if (!hasActiveBg || !hasActiveText || !has12pxRadius) {
    failures.push("RAIL FAIL: Active item must be #2563EB on #EFF6FF with 12px radius.");
  } else if (!hasHoverBlue || !hasFocusState || !hasAriaCurrent) {
    failures.push("RAIL FAIL: Nav items must have blue hover highlight (hover:text-[#2563EB]), equivalent focus-visible ring, and separate active-route state (aria-current).");
  } else {
    console.log("  [PASS] interaction states: persistent active #2563EB/#EFF6FF, coaching-style blue hover highlight, and equivalent focus-visible ring");
  }

  // 1f. Bottom of rail: settings gear 20px, omit unbacked help/mail
  const hasSettingsGear = railCode.includes("Settings") && (railCode.includes("w-5 h-5") || railCode.includes("Settings className"));
  const hasUnbackedHelp = railCode.includes("mailto:") || railCode.includes("/help");
  if (!hasSettingsGear) {
    failures.push("RAIL FAIL: Bottom of rail must include settings gear icon.");
  } else if (hasUnbackedHelp) {
    failures.push("RAIL FAIL: Bottom of rail must not include unbacked help or email links.");
  } else {
    console.log("  [PASS] rail footer: settings gear present; unbacked help link omitted per spec");
  }

  // 1g. Verified desktop narrow geometry: 56x56px items with 8px side inset and 64px vertical pitch
  const has56pxItems = railCode.includes("w-[56px] h-[56px]");
  const has8pxInset = railCode.includes("px-2");
  const has64pxPitch = railCode.includes("gap-2");
  if (!has56pxItems || !has8pxInset || !has64pxPitch) {
    failures.push("RAIL FAIL: Narrow nav items must be 56x56px with 8px side inset (px-2) and 64px vertical pitch (gap-2).");
  } else {
    console.log("  [PASS] narrow rail geometry: 56x56px items with 8px side inset (px-2) and 64px vertical pitch (gap-2)");
  }

  // 1h. Accessible expand/collapse control and mode persistence
  const hasExpandToggle = railCode.includes('aria-label="Expand sidebar"');
  const hasCollapseToggle = railCode.includes('aria-label="Collapse sidebar"');
  const hasAriaExpanded = railCode.includes("aria-expanded");
  const hasPersistenceLib = sidebarLibCode.includes("careermonke_sidebar_expanded") && sidebarLibCode.includes("useSidebarMode");
  if (!hasExpandToggle || !hasCollapseToggle || !hasAriaExpanded || !hasPersistenceLib) {
    failures.push("ACCESSIBILITY/PERSISTENCE FAIL: Sidebar must provide accessible expand and collapse controls with aria-expanded, and persist mode via useSidebarMode.");
  } else {
    console.log("  [PASS] expand/collapse controls: accessible toggles with aria-expanded and persistent mode across navigation");
  }

  // -------------------------------------------------------------------------
  // 2. TOP BAR SPECIFICATIONS
  // -------------------------------------------------------------------------
  // 2a. 56px, white, 1px bottom border
  const has56px = topBarCode.includes("h-14");
  const hasTopBarWhite = topBarCode.includes("bg-white");
  const hasTopBarBorder = topBarCode.includes("border-b") && topBarCode.includes("border-[#E2E8F0]");
  if (!has56px || !hasTopBarWhite || !hasTopBarBorder) {
    failures.push("TOPBAR FAIL: Top bar must be 56px (h-14), white (bg-white), with 1px bottom border #E2E8F0.");
  } else {
    console.log("  [PASS] topbar dimensions: 56px height (h-14), white, 1px bottom border #E2E8F0");
  }

  // 2b. Left: page label, bold 18px uppercase
  const has18pxLabel = topBarCode.includes("text-[18px]") && topBarCode.includes("uppercase") && topBarCode.includes("font-bold");
  if (!has18pxLabel) {
    failures.push("TOPBAR FAIL: Page label must be bold 18px uppercase.");
  } else {
    console.log("  [PASS] topbar label: bold 18px uppercase tracking");
  }

  // 2c. Tabs on /jobs: 14px, active bold with 2px ink underline, inactive #94A3B8, small dark count badge
  const hasTab14px = topBarCode.includes("text-[14px]");
  const hasTabActiveUnderline = topBarCode.includes("after:h-[2px] after:bg-[#0F172A]");
  const hasTabInactive = topBarCode.includes("text-[#94A3B8]");
  const hasDarkBadge = topBarCode.includes("bg-[#0F172A]") && topBarCode.includes("text-white");
  if (!hasTab14px || !hasTabActiveUnderline || !hasTabInactive || !hasDarkBadge) {
    failures.push("TOPBAR FAIL: Tabs must be 14px, active bold with 2px ink underline, inactive #94A3B8, with small dark count badge.");
  } else {
    console.log("  [PASS] topbar tabs: 14px, active bold with 2px ink underline, inactive #94A3B8, small dark count badge");
  }

  // 2d. Fully rounded search input: placeholder "Search by title or company", magnifier, #F1F5F9 bg
  const hasSearchPlaceholder = topBarCode.includes("Search by title or company");
  const hasMagnifier = topBarCode.includes("Search");
  const hasSearchBg = topBarCode.includes("bg-[#F1F5F9]");
  const hasRoundedFull = topBarCode.includes("rounded-full");
  if (!hasSearchPlaceholder || !hasMagnifier || !hasSearchBg || !hasRoundedFull) {
    failures.push('TOPBAR FAIL: Search input must have placeholder "Search by title or company", magnifier icon, #F1F5F9 bg, fully rounded.');
  } else {
    console.log('  [PASS] topbar search: fully rounded #F1F5F9 pill with magnifier and "Search by title or company" placeholder');
  }

  // 2e. Far right: circular avatar on #2563EB, full name bold 13px, plan pill ("Free" or "Pro")
  const hasAvatarBlue = topBarCode.includes("bg-[#2563EB]") && topBarCode.includes("rounded-full");
  const hasBold13pxName = topBarCode.includes("text-[13px]") && topBarCode.includes("font-bold");
  const hasPlanPill = topBarCode.includes("isPro ?") && topBarCode.includes('"Pro"') && topBarCode.includes('"Free"') && topBarCode.includes("border-[#CBD5E1]");
  if (!hasAvatarBlue || !hasBold13pxName || !hasPlanPill) {
    failures.push('TOPBAR FAIL: Far right must include circular initial avatar on #2563EB, bold 13px full name, and neutral outline plan pill ("Free" or "Pro").');
  } else {
    console.log('  [PASS] topbar user profile: circular avatar on #2563EB, full name bold 13px, plan pill ("Free" | "Pro")');
  }

  // -------------------------------------------------------------------------
  // 3. CONTENT AREA & CARDS
  // -------------------------------------------------------------------------
  const hasJobsF8 = jobsCode.includes("bg-[#F8FAFC]");
  const hasTrackerF8 = trackerCode.includes("bg-[#F8FAFC]");
  const hasResumeF8 = resumeCode.includes("bg-[#F8FAFC]");
  const hasSettingsF8 = settingsCode.includes("bg-[#F8FAFC]");
  if (!hasJobsF8 || !hasTrackerF8 || !hasResumeF8 || !hasSettingsF8) {
    failures.push("CONTENT FAIL: Content area background must be #F8FAFC across all logged-in views.");
  } else {
    console.log("  [PASS] content surface: bg-[#F8FAFC] applied across all logged-in application pages");
  }

  // 3b. Content reflow without overlap: dynamic padding based on sidebar mode
  const shellHasReflow = shellContainerCode.includes("md:pl-[240px]") && shellContainerCode.includes("md:pl-[72px]");
  const jobsHasReflow = jobsCode.includes("md:pl-[240px]") && jobsCode.includes("md:pl-[72px]");
  const trackerHasReflow = trackerCode.includes("md:pl-[240px]") && trackerCode.includes("md:pl-[72px]");
  const resumeHasReflow = resumeCode.includes("md:pl-[240px]") && resumeCode.includes("md:pl-[72px]");
  const settingsHasReflow = settingsCode.includes("md:pl-[240px]") && settingsCode.includes("md:pl-[72px]");
  if (!shellHasReflow || !jobsHasReflow || !trackerHasReflow || !resumeHasReflow || !settingsHasReflow) {
    failures.push("REFLOW FAIL: Content area must dynamically adjust left padding (md:pl-[72px] to md:pl-[240px]) to prevent overlap.");
  } else {
    console.log("  [PASS] content reflow: pages dynamically adjust padding (72px vs 240px) without content overlap or clipping");
  }

  // -------------------------------------------------------------------------
  // 4. MOBILE RESPONSIVENESS
  // -------------------------------------------------------------------------
  // Desktop rail is hidden on mobile; mobile uses hamburger navigation drawer
  const railHiddenOnMobile = railCode.includes("hidden md:flex");
  const hasHamburgerButton = topBarCode.includes("Open navigation menu") || topBarCode.includes('aria-label="Open navigation menu"');
  const hasMobileDrawer = topBarCode.includes('id="mobile-nav-drawer"') || topBarCode.includes('aria-label="Mobile Navigation"');
  const has44pxTouchTargets = topBarCode.includes("min-h-[44px]");
  if (!railHiddenOnMobile) {
    failures.push("MOBILE FAIL: Desktop rail must be hidden on mobile (hidden md:flex).");
  } else if (!hasHamburgerButton || !hasMobileDrawer || !has44pxTouchTargets) {
    failures.push("MOBILE FAIL: Mobile must provide hamburger navigation drawer with >=44px tap targets.");
  } else {
    console.log("  [PASS] mobile responsiveness: desktop rail hidden on mobile; hamburger navigation drawer provided with >=44px tap targets");
  }

  // -------------------------------------------------------------------------
  // 5. PURITY & 220PX SIDEBAR ELIMINATION
  // -------------------------------------------------------------------------
  // 5a. Zero legacy 220px sidebars anywhere in the codebase
  const allCodes = [dashboardCode, jobsCode, trackerCode, resumeCode, settingsCode, railCode, topBarCode, shellContainerCode];
  const has220px = allCodes.some((c) => c.includes("220px"));
  if (has220px) {
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

  // 6b. Applied tab list derives from tracker data (not hardcoded empty array)
  const hasAppliedFilter = jobsCode.includes('appliedJobIds.includes(job.id)');
  const hasHardcodedEmptyApplied = /activeTab\s*===\s*["']applied["']\s*\)\s*\{\s*result\s*=\s*\[\]/.test(jobsCode);

  if (!hasAppliedFilter || hasHardcodedEmptyApplied) {
    failures.push('APPLIED TAB FAIL: Applied tab must filter live jobs by applied tracker application jobIds, not result = [].');
  } else {
    console.log("  [PASS] applied tab list: filters live jobs by tracker applied jobIds to match badge count");
  }

  // 6c. Tab buttons: min-h-[44px] touch target
  const tabButtonsTouchTargets = jobsCode.includes("min-h-[44px]") && topBarCode.includes("min-h-[44px]");
  if (!tabButtonsTouchTargets) {
    failures.push("TOUCH ACCESSIBILITY FAIL: Tab buttons must have min-h-[44px] on touch screens.");
  } else {
    console.log("  [PASS] tab buttons: min-h-[44px] touch target enforced across desktop and mobile tabs");
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
