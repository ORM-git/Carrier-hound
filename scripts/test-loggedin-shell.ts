import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("            PROMPT 3 REBUILD — LOGGED-IN APP SHELL AUDIT SUITE                   ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const railPath = path.resolve(process.cwd(), "src/components/shell/AppIconRail.tsx");
  const topBarPath = path.resolve(process.cwd(), "src/components/shell/AppTopBar.tsx");
  const shellContainerPath = path.resolve(process.cwd(), "src/components/shell/LoggedInAppShell.tsx");
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
  let jobsCode = fs.readFileSync(jobsPath, "utf-8");
  let trackerCode = fs.readFileSync(trackerPath, "utf-8");
  let resumeCode = fs.readFileSync(resumePath, "utf-8");
  let settingsCode = fs.readFileSync(settingsPath, "utf-8");

  if (isNegativeControl) {
    // Inject corruptions for negative control
    railCode = railCode.replace(/w-\[72px\]/g, "w-[240px]");
    railCode = railCode.replace(/bg-\[#EFF6FF\]/g, "");
    topBarCode = topBarCode.replace(/h-14/g, "h-20");
    topBarCode = topBarCode.replace(/Search by title or company/g, "");
    topBarCode = topBarCode.replace(/bg-\[#2563EB\]/g, "");
    jobsCode = jobsCode + '\n<aside className="w-[220px]">Old Sidebar</aside>';
    topBarCode = topBarCode + '\n<span>AI Career Coaching Agent</span>';
  }

  const failures: string[] = [];

  // -------------------------------------------------------------------------
  // 1. LEFT ICON RAIL SPECIFICATIONS
  // -------------------------------------------------------------------------
  // 1a. Fixed 72px wide, full height, white, 1px right border #E2E8F0
  const has72px = railCode.includes("w-[72px]");
  const hasRailWhite = railCode.includes("bg-white");
  const hasBorderRight = railCode.includes("border-r") && railCode.includes("border-[#E2E8F0]");
  if (!has72px || !hasRailWhite || !hasBorderRight) {
    failures.push("RAIL FAIL: Icon rail must be fixed 72px wide (w-[72px]), white (bg-white), with 1px right border #E2E8F0.");
  } else {
    console.log("  [PASS] rail dimensions: fixed 72px wide, white, 1px right border #E2E8F0");
  }

  // 1b. CareerMonke logo mark at the top
  const hasBrandIcon = railCode.includes("BrandIcon") && railCode.includes("CareerMonke");
  if (!hasBrandIcon) {
    failures.push("RAIL FAIL: Rail must have CareerMonke logo mark at the top.");
  } else {
    console.log("  [PASS] rail branding: small CareerMonke logo mark at top");
  }

  // 1c. Vertical nav items: Jobs, Resume, Profile, Tracker, Radar (since /radar exists)
  const hasJobsNav = railCode.includes('"Jobs"') || railCode.includes('label: "Jobs"');
  const hasResumeNav = railCode.includes('"Resume"') || railCode.includes('label: "Resume"');
  const hasProfileNav = railCode.includes('"Profile"') || railCode.includes('label: "Profile"');
  const hasTrackerNav = railCode.includes('"Tracker"') || railCode.includes('label: "Tracker"');
  const hasRadarNav = railCode.includes('"Radar"') || railCode.includes('label: "Radar"');
  if (!hasJobsNav || !hasResumeNav || !hasProfileNav || !hasTrackerNav || !hasRadarNav) {
    failures.push("RAIL FAIL: Nav items must include Jobs, Resume, Profile, Tracker, and Radar.");
  } else {
    console.log("  [PASS] rail nav items: Jobs, Resume, Profile, Tracker, Radar present");
  }

  // 1d. Icon 24px centred over 11px label
  const has24pxIcon = railCode.includes("w-6 h-6");
  const has11pxLabel = railCode.includes("text-[11px]");
  if (!has24pxIcon || !has11pxLabel) {
    failures.push("RAIL FAIL: Nav items must use 24px line icons (w-6 h-6) centred over 11px labels (text-[11px]).");
  } else {
    console.log("  [PASS] rail typography & sizing: 24px line icons centred over 11px labels");
  }

  // 1e. Active item: #2563EB with 12px-radius #EFF6FF block behind; inactive #64748B
  const hasActiveBg = railCode.includes("bg-[#EFF6FF]");
  const hasActiveText = railCode.includes("text-[#2563EB]");
  const has12pxRadius = railCode.includes("rounded-[12px]");
  const hasInactiveText = railCode.includes("text-[#64748B]");
  if (!hasActiveBg || !hasActiveText || !has12pxRadius || !hasInactiveText) {
    failures.push("RAIL FAIL: Active item must be #2563EB on #EFF6FF with 12px radius; inactive must be #64748B.");
  } else {
    console.log("  [PASS] rail token states: active #2563EB on #EFF6FF with 12px radius; inactive #64748B");
  }

  // 1f. Bottom of rail: settings gear 20px, omit unbacked help/mail
  const hasSettingsGear = railCode.includes("Settings") && railCode.includes("w-5 h-5");
  const hasUnbackedHelp = railCode.includes("mailto:") || railCode.includes("/help");
  if (!hasSettingsGear) {
    failures.push("RAIL FAIL: Bottom of rail must include settings gear icon (20px, w-5 h-5).");
  } else if (hasUnbackedHelp) {
    failures.push("RAIL FAIL: Bottom of rail must not include unbacked help or email links.");
  } else {
    console.log("  [PASS] rail footer: settings gear (20px) present; unbacked help link omitted per spec");
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

  // -------------------------------------------------------------------------
  // 4. MOBILE RESPONSIVENESS
  // -------------------------------------------------------------------------
  // Mobile bottom tab bar exists in rail component
  const hasMobileTabBar = railCode.includes('aria-label="Mobile Navigation"') && railCode.includes("md:hidden");
  const has44pxTouchTargets = railCode.includes("min-h-[44px]") && railCode.includes("min-w-[44px]");
  if (!hasMobileTabBar || !has44pxTouchTargets) {
    failures.push("MOBILE FAIL: Rail must become bottom tab bar on mobile with >=44px tap targets.");
  } else {
    console.log("  [PASS] mobile responsiveness: rail becomes bottom tab bar on mobile with 44px tap targets");
  }

  // -------------------------------------------------------------------------
  // 5. PURITY & 220PX SIDEBAR ELIMINATION
  // -------------------------------------------------------------------------
  // 5a. Zero 220px sidebars anywhere in the codebase
  const allCodes = [jobsCode, trackerCode, resumeCode, settingsCode, railCode, topBarCode, shellContainerCode];
  const has220px = allCodes.some((c) => c.includes("220px"));
  if (has220px) {
    failures.push("LEGACY FAIL: Found lingering '220px' sidebar references in application pages.");
  } else {
    console.log("  [PASS] legacy cleanup: zero 220px sidebar references across all pages");
  }

  // 5b. Pages use AppIconRail and AppTopBar
  const pagesHaveRail = jobsCode.includes("AppIconRail") && trackerCode.includes("AppIconRail") && resumeCode.includes("AppIconRail") && settingsCode.includes("AppIconRail");
  const pagesHaveTopBar = jobsCode.includes("AppTopBar") && trackerCode.includes("AppTopBar") && resumeCode.includes("AppTopBar") && settingsCode.includes("AppTopBar");
  if (!pagesHaveRail || !pagesHaveTopBar) {
    failures.push("SHELL ADOPTION FAIL: AppIconRail and AppTopBar must be adopted on /jobs, /tracker, /resume, and /settings.");
  } else {
    console.log("  [PASS] shell adoption: AppIconRail and AppTopBar integrated across /jobs, /tracker, /resume, /settings");
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

  console.log("PROMPT 3 LOGGED-IN APP SHELL VALIDATED LOCALLY [PASS-LOCAL]");
  process.exit(0);
}

run();
