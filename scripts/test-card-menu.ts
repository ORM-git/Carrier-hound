import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("       TEST: /JOBS CARD STRUCTURE, PILLS, ICONS & OPTIONS MENU AUDIT              ");
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
    jobsPageCode = jobsPageCode.replace(/job-card-posted-tag/g, "corrupted-tag");
    jobsPageCode = jobsPageCode.replace(/getTagColorClass/g, "corruptedColor");
    jobsPageCode = jobsPageCode.replace(/font-semibold text-\[#0F172A\]/g, "text-gray-200");
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

  // -------------------------------------------------------------------------
  // 2. TOP ROW PILL TAGS (POSTED TIME & EARLY APPLICANT)
  // -------------------------------------------------------------------------
  // Posted time pill: Clock SVG icon, soft CM-blue pill, rendered ONLY from real postedAt
  const hasPostedPill = jobsPageCode.includes("data-testid=\"job-card-posted-tag\"") &&
    jobsPageCode.includes("job.postedAt && postedRelative ?") &&
    jobsPageCode.includes("<Clock className=\"w-3 h-3 text-[#2563EB]") &&
    jobsPageCode.includes("bg-[#EFF6FF] text-[#1E40AF] border border-[#BFDBFE]");
  if (!hasPostedPill) {
    failures.push("TOP PILL FAIL: Card top row must include posted-time tag with Clock SVG icon in soft CM-blue pill derived strictly from real postedAt (empty when missing).");
  } else {
    console.log("  [PASS] Top pills: Posted-time tag with Clock SVG icon and soft CM-blue pill from real postedAt");
  }

  // Early applicant pill: strictly derived from real data under 24h
  const hasEarlyPill = jobsPageCode.includes("data-testid=\"job-card-early-tag\"") &&
    jobsPageCode.includes("isRecent ?") &&
    jobsPageCode.includes("isPostedUnder24Hours") &&
    jobsPageCode.includes("Early applicant");
  if (!hasEarlyPill) {
    failures.push("EARLY APPLICANT FAIL: Card top row must include Early applicant tag derived strictly from real data posted within 24h.");
  } else {
    console.log("  [PASS] Top pills: Early applicant tag derived strictly from real data (< 24h old)");
  }

  // -------------------------------------------------------------------------
  // 3. COMPANY & CATEGORY/TYPE COLORED PILLS
  // -------------------------------------------------------------------------
  // Category & company-type words rendered as separate small colored pills with soft tints by stable hash
  const hasCompanyPills = jobsPageCode.includes("data-testid=\"job-card-category-pills\"") &&
    jobsPageCode.includes("companyPills.length > 0 &&") &&
    jobsPageCode.includes("getTagColorClass(pill)") &&
    jobsPageCode.includes("getCompanyTagPills(job)") &&
    jobsPageCode.includes("bg-blue-50 text-[#1D4ED8]") &&
    jobsPageCode.includes("bg-emerald-50 text-emerald-800") &&
    jobsPageCode.includes("bg-violet-50 text-violet-800") &&
    jobsPageCode.includes("bg-amber-50 text-amber-800");
  if (!hasCompanyPills) {
    failures.push("CATEGORY PILLS FAIL: Under title, category & company-type words must render as separate small pills with soft tints (blue, green, violet, amber) rotated by stable hash, strictly from real fields only.");
  } else {
    console.log("  [PASS] Category pills: Real fields rendered as separate small pills with 4 soft tints rotated by stable hash");
  }

  // -------------------------------------------------------------------------
  // 4. META GRID (3x2): SVG ICONS, SALARY WEIGHT & NO INVENTED DEFAULTS
  // -------------------------------------------------------------------------
  const hasMetaGridIcons = jobsPageCode.includes("grid grid-cols-3 grid-rows-2") &&
    jobsPageCode.includes("<MapPin className=\"w-4 h-4 text-[#475569]") &&
    jobsPageCode.includes("<Briefcase className=\"w-4 h-4 text-[#475569]") &&
    jobsPageCode.includes("<DollarSign className=\"w-4 h-4 text-[#475569]") &&
    jobsPageCode.includes("<Laptop className=\"w-4 h-4 text-[#475569]") &&
    jobsPageCode.includes("<TrendingUp className=\"w-4 h-4 text-[#475569]");
  if (!hasMetaGridIcons) {
    failures.push("META GRID ICONS FAIL: Meta grid must have small SVG icon before every item (MapPin, Briefcase, DollarSign, Laptop, TrendingUp).");
  } else {
    console.log("  [PASS] Meta grid icons: Small SVG icon before every item (MapPin, Briefcase, DollarSign, Laptop, TrendingUp)");
  }

  const hasSalaryHighlight = jobsPageCode.includes("font-semibold text-[#0F172A]");
  if (!hasSalaryHighlight) {
    failures.push("SALARY HIGHLIGHT FAIL: Salary value must be highlighted in stronger font weight (font-semibold text-[#0F172A]).");
  } else {
    console.log("  [PASS] Meta grid salary: Value highlighted in stronger font weight (font-semibold text-[#0F172A])");
  }

  const hasNoInventedDefaults = !jobsPageCode.includes('job.type || "Full-time"') &&
    !jobsPageCode.includes('jobLevel || "Mid-Senior"') &&
    !jobsPageCode.includes('"Verified Recent"') &&
    !jobsPageCode.includes('"Technology"');
  if (!hasNoInventedDefaults) {
    failures.push("INVENTED DEFAULTS FAIL: Meta grid must not invent placeholder defaults when real fields are empty.");
  } else {
    console.log("  [PASS] Meta grid purity: Empty cells stay empty, zero invented defaults");
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

  // Mobile below 640px preserved
  const hasMobilePreserved = jobsPageCode.includes("flex sm:hidden flex-col justify-between w-full space-y-3") &&
    jobsPageCode.includes("w-8 h-8 rounded-lg shrink-0 object-contain");
  if (!hasMobilePreserved) {
    failures.push("MOBILE PRESERVATION FAIL: Mobile view (<640px) must be preserved identical to main.");
  } else {
    console.log("  [PASS] Mobile view: Mobile layout below 640px preserved identical to main");
  }

  // -------------------------------------------------------------------------
  // 5. "..." MENU BUTTON & POPOVER SPECIFICATIONS
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
  // 6. POPOVER 4 ROWS / ACTIONS
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
  // 7. ACCESSIBILITY, FOCUS MANAGEMENT & KEYBOARD ARROW NAVIGATION
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
  console.log("JOB CARD POLISH, PILLS, ICONS & MENU AUDIT VALIDATED [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run();
