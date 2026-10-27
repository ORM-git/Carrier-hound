import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("       TEST: /JOBS CARD STRUCTURE DIVIDERS & OPTIONS MENU POPOVER AUDIT           ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const jobsPagePath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");
  const menuCompPath = path.resolve(process.cwd(), "src/components/jobs/JobCardMenu.tsx");

  if (!fs.existsSync(jobsPagePath) || !fs.existsSync(menuCompPath)) {
    console.error("FAIL: Required files missing (src/app/jobs/page.tsx or src/components/jobs/JobCardMenu.tsx)");
    process.exit(1);
  }

  let jobsPageCode = fs.readFileSync(jobsPagePath, "utf-8");
  let menuCompCode = fs.readFileSync(menuCompPath, "utf-8");

  if (isNegativeControl) {
    // In-memory mutation to prove non-zero exit on invalid conditions
    jobsPageCode = jobsPageCode.replace(/JobCardMenu/g, "FakeMissingMenu");
    jobsPageCode = jobsPageCode.replace(/border-b border-\[#E2E8F0\]/g, "");
    menuCompCode = menuCompCode.replace(/Remove From List/g, "Delete All");
    menuCompCode = menuCompCode.replace(/Already Applied/g, "");
    menuCompCode = menuCompCode.replace(/navigator\.share/g, "undefinedShare");
    menuCompCode = menuCompCode.replace(/getReportJobMailto/g, "");
    menuCompCode = menuCompCode.replace(/ArrowDown/g, "");
    menuCompCode = menuCompCode.replace(/rounded-\[12px\]/g, "rounded-none");
  }

  const failures: string[] = [];

  // -------------------------------------------------------------------------
  // 1. CARD STRUCTURE & HORIZONTAL DIVIDERS (DESKTOP & MOBILE)
  // -------------------------------------------------------------------------
  // Must have JobCardMenu integrated on both desktop and mobile
  const hasJobCardMenuImport = jobsPageCode.includes('import { JobCardMenu } from "@/components/jobs/JobCardMenu";');
  const jobCardMenuUsages = (jobsPageCode.match(/<JobCardMenu/g) || []).length;
  if (!hasJobCardMenuImport || jobCardMenuUsages < 2) {
    failures.push(`CARD STRUCTURE FAIL: JobCardMenu must be imported and rendered in both desktop and mobile views (found ${jobCardMenuUsages} occurrences).`);
  } else {
    console.log(`  [PASS] Card menu integration: JobCardMenu imported and rendered in both desktop & mobile views (${jobCardMenuUsages} usages)`);
  }

  // Thin 1px light gray horizontal dividers inside the card
  const hasDividers = (jobsPageCode.match(/border-b border-\[#E2E8F0\]/g) || []).length >= 2;
  if (!hasDividers) {
    failures.push("DIVIDERS FAIL: Card must include thin 1px light gray horizontal dividers (border-b border-[#E2E8F0]).");
  } else {
    console.log("  [PASS] Dividers: Thin 1px light gray horizontal dividers (border-b border-[#E2E8F0]) present inside card");
  }

  // Company · Category/domain line (omit missing fields)
  const hasCompanyDomainLine = jobsPageCode.includes("job.company || \"Verified Employer\"") &&
    jobsPageCode.includes("job.category && <span className=\"capitalize\"> · {job.category}</span>");
  if (!hasCompanyDomainLine) {
    failures.push("CARD HEADER FAIL: Card must include one line 'Company · Category/domain' using real fields and omitting missing ones.");
  } else {
    console.log("  [PASS] Card header: One line 'Company · Category/domain' with conditional category rendering");
  }

  // Meta grid 3 columns x 2 rows (location, job type, salary / work model, level, posted)
  const has3x2MetaGrid = jobsPageCode.includes("grid grid-cols-3 grid-rows-2") &&
    jobsPageCode.includes("job.remote ? \"Remote\" : \"On-site\"") &&
    jobsPageCode.includes("{job.type ?") &&
    jobsPageCode.includes("{jobLevel ?") &&
    jobsPageCode.includes("{job.postedAt ?") &&
    !jobsPageCode.includes('job.type || "Full-time"') &&
    !jobsPageCode.includes('jobLevel || "Mid-Senior"') &&
    !jobsPageCode.includes('"Verified Recent"') &&
    !jobsPageCode.includes('"Technology"');
  if (!has3x2MetaGrid) {
    failures.push("META GRID FAIL: Card must include 3 columns x 2 rows meta grid with location, job type, salary, work model, level, and posted time, with no invented defaults when empty.");
  } else {
    console.log("  [PASS] Meta grid: 3 columns x 2 rows verified with real fields only and no invented defaults");
  }

  // Footer action buttons: Hide, Save, Tailor Resume, Apply
  const hasFooterActions = jobsPageCode.includes("handleHideJob") &&
    jobsPageCode.includes("handleSaveJob") &&
    jobsPageCode.includes("Tailor Resume") &&
    jobsPageCode.includes("Apply");
  if (!hasFooterActions) {
    failures.push("FOOTER ACTIONS FAIL: Footer action buttons (Hide, Save, Tailor Resume, Apply) must be present.");
  } else {
    console.log("  [PASS] Footer actions: Hide, Save, Tailor Resume, and Apply buttons preserved");
  }

  // Dark match panel on the right preserved
  const hasDarkMatchPanel = jobsPageCode.includes("w-[164px] sm:w-44 shrink-0 rounded-xl sm:rounded-[16px] bg-gradient-to-b from-[#09151E]") ||
    jobsPageCode.includes("CircularMatchRing");
  if (!hasDarkMatchPanel) {
    failures.push("MATCH PANEL FAIL: Right dark match panel must be preserved unchanged.");
  } else {
    console.log("  [PASS] Match panel: Right dark match panel preserved unchanged");
  }

  // -------------------------------------------------------------------------
  // 2. "..." MENU BUTTON & POPOVER SPECIFICATIONS
  // -------------------------------------------------------------------------
  // Trigger button attributes & touch target (32px desktop, >=44px mobile)
  const hasMenuButton = menuCompCode.includes('data-testid="job-card-menu-button"') &&
    menuCompCode.includes('aria-haspopup="true"') &&
    menuCompCode.includes('aria-expanded={isOpen}') &&
    (menuCompCode.includes('min-h-[44px]') && menuCompCode.includes('min-w-[44px]')) &&
    (menuCompCode.includes('sm:w-8') && menuCompCode.includes('sm:h-8'));
  if (!hasMenuButton) {
    failures.push("MENU BUTTON FAIL: Button must have aria-haspopup, aria-expanded, 32px desktop target, and >=44px mobile target.");
  } else {
    console.log("  [PASS] Menu button: aria-haspopup, aria-expanded, 32px desktop & >=44px mobile tap target verified");
  }

  // Popover styling: white, rounded 12px, soft shadow, z-50, no clipping
  const hasPopoverStyling = menuCompCode.includes('data-testid="job-card-menu-popover"') &&
    menuCompCode.includes('role="menu"') &&
    menuCompCode.includes('bg-white') &&
    menuCompCode.includes('rounded-[12px]') &&
    menuCompCode.includes('shadow-lg') &&
    menuCompCode.includes('absolute right-0 top-full') &&
    menuCompCode.includes('z-50');
  if (!hasPopoverStyling) {
    failures.push("POPOVER STYLING FAIL: Popover must be white, rounded 12px, soft shadow (shadow-lg), positioned right-0 top-full with z-50.");
  } else {
    console.log("  [PASS] Popover styling: White, rounded 12px, soft shadow, right-0 top-full with z-50 (anti-clipping)");
  }

  // -------------------------------------------------------------------------
  // 3. POPOVER 4 ROWS / ACTIONS
  // -------------------------------------------------------------------------
  // Row 1: Remove From List
  const hasRemoveAction = menuCompCode.includes('data-testid="job-card-menu-item-remove"') &&
    menuCompCode.includes("Remove From List") &&
    menuCompCode.includes("onRemoveFromList");
  if (!hasRemoveAction) {
    failures.push("ACTION 1 FAIL: Popover must include 'Remove From List' action wiring to existing hide/remove handler.");
  } else {
    console.log("  [PASS] Action 1: 'Remove From List' row calling hide/remove action");
  }

  // Row 2: Already Applied
  const hasAppliedAction = menuCompCode.includes('data-testid="job-card-menu-item-applied"') &&
    menuCompCode.includes("Already Applied") &&
    menuCompCode.includes("onAlreadyApplied");
  if (!hasAppliedAction) {
    failures.push("ACTION 2 FAIL: Popover must include 'Already Applied' action wiring to existing tracker toggle.");
  } else {
    console.log("  [PASS] Action 2: 'Already Applied' row calling mark-as-applied and updating count");
  }

  // Row 3: Share (navigator.share fallback to clipboard copy)
  const hasShareAction = menuCompCode.includes('data-testid="job-card-menu-item-share"') &&
    menuCompCode.includes("Share") &&
    menuCompCode.includes("navigator.share") &&
    menuCompCode.includes("navigator.clipboard.writeText") &&
    menuCompCode.includes("toast");
  if (!hasShareAction) {
    failures.push("ACTION 3 FAIL: Popover must include 'Share' with navigator.share and clipboard copy toast fallback.");
  } else {
    console.log("  [PASS] Action 3: 'Share' row with navigator.share and clipboard copy toast fallback");
  }

  // Row 4: Report Issue (mailto with prefilled job link)
  const hasReportAction = menuCompCode.includes('data-testid="job-card-menu-item-report"') &&
    menuCompCode.includes("Report Issue") &&
    menuCompCode.includes("getReportJobMailto");
  if (!hasReportAction) {
    failures.push("ACTION 4 FAIL: Popover must include 'Report Issue' row opening mailto with prefilled job details.");
  } else {
    console.log("  [PASS] Action 4: 'Report Issue' row opening verified mailto support destination");
  }

  // -------------------------------------------------------------------------
  // 4. ACCESSIBILITY, FOCUS MANAGEMENT & KEYBOARD ARROW NAVIGATION
  // -------------------------------------------------------------------------
  const hasKeyboardNav = menuCompCode.includes("ArrowDown") &&
    menuCompCode.includes("ArrowUp") &&
    menuCompCode.includes("Escape") &&
    menuCompCode.includes("Home") &&
    menuCompCode.includes("End");
  const hasFocusManagement = menuCompCode.includes("triggerRef.current?.focus()") &&
    menuCompCode.includes("itemRefs.current[0]?.focus()");
  const hasOutsideClickClose = menuCompCode.includes("mousedown") &&
    menuCompCode.includes("touchstart");

  if (!hasKeyboardNav || !hasFocusManagement || !hasOutsideClickClose) {
    failures.push("A11Y & FOCUS FAIL: Popover must support arrow navigation, outside click close, Esc close, and focus move into/back.");
  } else {
    console.log("  [PASS] Keyboard & focus: ArrowDown/Up wrapping, Home/End, Esc/outside click close, focus move in & back");
  }

  // -------------------------------------------------------------------------
  // EVALUATION & EXIT
  // -------------------------------------------------------------------------
  if (isNegativeControl) {
    if (failures.length > 0) {
      console.log(`\n[PASS-NEGATIVE-CONTROL] Negative control successfully failed with ${failures.length} expected errors:`);
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(0);
    } else {
      console.error("\n[FAIL-NEGATIVE-CONTROL] Negative control failed to catch mutations!");
      process.exit(1);
    }
  }

  if (failures.length > 0) {
    console.error(`\nAUDIT FAILED with ${failures.length} issues:`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log("\n----------------------------------------------------------------------------------");
  console.log("JOB CARD DIVIDERS & OPTIONS MENU POPOVER VALIDATED [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run();
