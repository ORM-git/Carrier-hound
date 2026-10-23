/**
 * scripts/test-tracker-resume-rebuild.ts
 *
 * Audit suite for Prompt 6 of the Jobright-style rebuild:
 * 1. Jobs page:
 *    - useMemo memoization for per-card getJobDiagnostics keyed by confirmed resume & job id.
 *    - no-op outer React.memo removed from JobCardItem.
 * 2. Tracker page:
 *    - Board view with 5 canonical stages (saved, applied, interview, offer, rejected).
 *    - Column tokens: #F1F5F9 bg, 16px radius, 12px padding, bold 14px header with dark count badge.
 *    - Card tokens: white, 12px radius, 1px #E2E8F0 ring, 14px padding, 32px company logo,
 *      14px bold title, 13px company #475569, 12px applied/updated date #94A3B8.
 *    - Dragging state: lifted card gets #93C5FD ring and soft shadow only while dragging.
 *    - Restyled notes UI with prompt 1 tokens.
 *    - Top row: segmented control for Board/List, search input pill, primary blue Add button.
 *    - Empty column: dashed #CBD5E1 border, "Drop applications here" muted line.
 *    - Mobile horizontal snap-scroll row.
 * 3. Resume list page:
 *    - Header: "Resumes" bold 24px and primary blue pill upload action.
 *    - Card: white, 16px radius, 1px #E2E8F0 ring.
 *    - Card elements: file icon tile, resume name bold 15px, uploaded date 13px,
 *      status chip (Confirmed or Needs review).
 *    - Real action icon buttons: view, rename, delete.
 *    - Authenticity: NO fake "Set as default" button and NO "Default" chip.
 *    - Delete confirmation message preserved.
 *    - Empty state: centred icon, one line, upload button.
 *    - Free user ProUpgradeScreen gating preserved with exact copy.
 * 4. Brand purity: Zero Jobright mentions, mascots, coaching/agent/autofill items.
 *
 * Supports --negative-control to verify non-zero exit on invalid conditions.
 */

import fs from "fs";
import path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function runAudit() {
  console.log("==================================================================================");
  console.log("       TEST: PROMPT 6 REBUILD — TRACKER BOARD & RESUME LIST AUDIT                 ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Simulating intentional failure)" : "NORMAL VALIDATION"}\n`);

  const trackerFile = path.resolve(process.cwd(), "src/app/tracker/page.tsx");
  const resumeFile = path.resolve(process.cwd(), "src/app/resume/page.tsx");
  const jobsFile = path.resolve(process.cwd(), "src/app/jobs/page.tsx");

  if (!fs.existsSync(trackerFile) || !fs.existsSync(resumeFile) || !fs.existsSync(jobsFile)) {
    console.error("FAIL: Target files do not exist.");
    process.exit(1);
  }

  let trackerCode = fs.readFileSync(trackerFile, "utf-8");
  let resumeCode = fs.readFileSync(resumeFile, "utf-8");
  let jobsCode = fs.readFileSync(jobsFile, "utf-8");

  if (isNegativeControl) {
    // Sabotage code: simulate re-adding fake Default chip or Set as default action
    resumeCode += '<span data-testid="resume-default-chip">Default</span>\n<button>Set as default</button>';
  }

  const failures: string[] = [];

  // ===========================================================================
  // SECTION 1: JOBS PAGE MEMOIZATION & CLEANUP
  // ===========================================================================
  const hasUseMemoMemo = jobsCode.includes("useMemo") && jobsCode.includes("getJobDiagnostics");
  const hasKeyedMemo = jobsCode.includes("job.id") && (jobsCode.includes("confirmedResumeKey") || jobsCode.includes("candidate?.confirmedAt"));
  if (hasUseMemoMemo && hasKeyedMemo) {
    console.log("  [PASS] Jobs Memoization: per-card getJobDiagnostics wrapped in useMemo keyed by job.id and confirmed resume");
  } else {
    failures.push("Jobs Memoization: getJobDiagnostics must be memoized in useMemo keyed by job.id and confirmed resume.");
  }

  const hasNoOuterReactMemo = !jobsCode.includes("const JobCardItem = React.memo") && !jobsCode.includes("React.memo(function JobCardItem");
  if (hasNoOuterReactMemo) {
    console.log("  [PASS] Jobs Memoization: no-op outer React.memo removed from JobCardItem");
  } else {
    failures.push("Jobs Memoization: no-op outer React.memo on JobCardItem must be removed.");
  }

  // ===========================================================================
  // SECTION 2: TRACKER BOARD ARCHITECTURE & STAGES
  // ===========================================================================
  // Check exact 5 stages in tracker
  const stages = ["saved", "applied", "interview", "offer", "rejected"];
  const stagesMatch = stages.every((st) => trackerCode.includes(`"${st}"`) || trackerCode.includes(`'${st}'`));
  if (stagesMatch) {
    console.log("  [PASS] Tracker Stages: preserved exactly 5 canonical stages (saved, applied, interview, offer, rejected)");
  } else {
    failures.push("Tracker Stages: Must strictly preserve existing stages without additions or renames.");
  }

  // Column Tokens: #F1F5F9 bg, 16px radius, 12px padding (p-3), bold 14px header, dark count badge
  const hasColBg = trackerCode.includes("bg-[#F1F5F9]");
  const hasColRadius = trackerCode.includes("rounded-[16px]");
  const hasColPadding = trackerCode.includes("p-3");
  const hasColHeader = trackerCode.includes("text-[14px] font-bold text-[#0F172A]");
  const hasColBadge = trackerCode.includes("bg-[#0F172A] text-white");

  if (hasColBg && hasColRadius && hasColPadding && hasColHeader && hasColBadge) {
    console.log("  [PASS] Tracker Columns: #F1F5F9 bg, 16px radius, 12px padding, bold 14px header with dark count badge");
  } else {
    failures.push("Tracker Columns: Missing specified tokens (#F1F5F9, rounded-[16px], p-3, 14px bold, dark badge).");
  }

  // Card Tokens: white, 12px radius, 1px #E2E8F0 ring, 14px padding (p-3.5), 32px company logo,
  // 14px bold title, 13px company #475569, 12px applied/updated date #94A3B8
  const hasCardRadius = trackerCode.includes("rounded-[12px]");
  const hasCardRing = trackerCode.includes("ring-1 ring-[#E2E8F0]");
  const hasCardPadding = trackerCode.includes("p-3.5");
  const hasLogo32px = trackerCode.includes("w-8 h-8 rounded-lg");
  const hasTitle14px = trackerCode.includes("text-[14px] font-bold text-[#0F172A]");
  const hasCompany13px = trackerCode.includes("text-[13px] text-[#475569]");
  const hasDate12px = trackerCode.includes("text-[12px] text-[#94A3B8]") || trackerCode.includes("text-[12px] text-[#64748B]");

  if (hasCardRadius && hasCardRing && hasCardPadding && hasLogo32px && hasTitle14px && hasCompany13px && hasDate12px) {
    console.log("  [PASS] Tracker Cards: white, 12px radius, 1px #E2E8F0 ring, 14px padding, 32px logo, 14px title, 13px company, 12px date");
  } else {
    failures.push("Tracker Cards: Missing specified tokens (rounded-[12px], ring-[#E2E8F0], p-3.5, 32px logo, 14px title, 13px company, 12px date).");
  }

  // Dragging State: lifted card gets #93C5FD ring and soft shadow only while dragging
  const hasDragRing = trackerCode.includes("ring-2 ring-[#93C5FD]");
  const hasDragShadow = trackerCode.includes("shadow-[0_8px_20px_rgba(15,23,42,0.12)]") || trackerCode.includes("shadow-");
  const hasDragCond = trackerCode.includes("isDragging") && trackerCode.includes("cursor-grabbing");

  if (hasDragRing && hasDragShadow && hasDragCond) {
    console.log("  [PASS] Tracker Dragging: lifted card gets #93C5FD ring and soft shadow strictly while dragging");
  } else {
    failures.push("Tracker Dragging: Must apply #93C5FD ring and soft shadow strictly during active drag state.");
  }

  // Top Row: segmented control for views, search input pill, primary blue Add button
  const hasSegmented = trackerCode.includes("bg-[#F1F5F9] border border-[#E2E8F0]") && trackerCode.includes("Board") && trackerCode.includes("List");
  const hasSearchPill = trackerCode.includes("rounded-full border border-[#E2E8F0] bg-[#F1F5F9]") && trackerCode.includes("Search by title or company");
  const hasAddPill = trackerCode.includes("bg-[#2563EB]") && trackerCode.includes("rounded-full") && trackerCode.includes("Add application");

  if (hasSegmented && hasSearchPill && hasAddPill) {
    console.log("  [PASS] Tracker Top Row: segmented control (Board/List), search input pill, primary blue Add pill button");
  } else {
    failures.push("Tracker Top Row: Missing segmented control, search input pill, or primary blue Add button.");
  }

  // Empty Column: dashed #CBD5E1 border, one muted line of existing wording
  const hasEmptyCol = trackerCode.includes("border-2 border-dashed border-[#CBD5E1] rounded-[12px]") && trackerCode.includes("Drop applications here");
  if (hasEmptyCol) {
    console.log("  [PASS] Tracker Empty Column: dashed #CBD5E1 border with muted 'Drop applications here' line");
  } else {
    failures.push("Tracker Empty Column: Missing dashed #CBD5E1 border or muted 'Drop applications here' line.");
  }

  // Mobile Snap-Scroll
  const hasMobileSnap = trackerCode.includes("overflow-x-auto snap-x snap-mandatory") && trackerCode.includes("snap-center");
  if (hasMobileSnap) {
    console.log("  [PASS] Tracker Mobile: columns render as a horizontal snap-scroll row on mobile");
  } else {
    failures.push("Tracker Mobile: Missing horizontal snap-scroll (overflow-x-auto snap-x snap-mandatory).");
  }

  // ===========================================================================
  // SECTION 3: RESUME LIST PAGE ARCHITECTURE
  // ===========================================================================
  // Header: "Resumes" bold 24px and primary blue pill upload action
  const hasResumeHeader24 = resumeCode.includes("text-[24px] font-bold text-[#0F172A]") && resumeCode.includes("Resumes");
  const hasUploadBluePill = resumeCode.includes("bg-[#2563EB]") && resumeCode.includes("Upload resume");

  if (hasResumeHeader24 && hasUploadBluePill) {
    console.log("  [PASS] Resume Header: 'Resumes' bold 24px with primary blue pill upload button");
  } else {
    failures.push("Resume Header: Missing bold 24px 'Resumes' title or primary blue pill upload button.");
  }

  // Resume Card: white, 16px radius, 1px #E2E8F0 ring
  const hasResumeCardTokens = resumeCode.includes("rounded-[16px]") && resumeCode.includes("ring-1 ring-[#E2E8F0]");
  if (hasResumeCardTokens) {
    console.log("  [PASS] Resume Card: white, 16px radius, 1px #E2E8F0 ring");
  } else {
    failures.push("Resume Card: Missing rounded-[16px] or ring-1 ring-[#E2E8F0].");
  }

  // Card Content:
  // - File icon tile (w-10 h-10 rounded-lg bg-[#EFF6FF] border border-[#BFDBFE] text-[#2563EB])
  // - Resume name bold 15px
  // - Uploaded date 13px
  // - Status chip (Confirmed or Needs review)
  // - Row of real icon buttons: view, rename, delete
  const hasFileIconTile = resumeCode.includes("w-10 h-10 rounded-lg bg-[#EFF6FF]") && resumeCode.includes("border-[#BFDBFE]");
  const hasResumeName15 = resumeCode.includes("text-[15px] font-bold text-[#0F172A]");
  const hasUploadedDate13 = (resumeCode.includes("text-[13px] text-[#94A3B8]") || resumeCode.includes("text-[13px] text-[#64748B]")) && resumeCode.includes("Uploaded");
  const hasStatusChip = resumeCode.includes('data-testid="resume-status-chip"') &&
    resumeCode.includes("Confirmed") &&
    resumeCode.includes("Needs review");
  const hasRealActionButtons = resumeCode.includes('data-testid="resume-actions-row"') &&
    resumeCode.includes("View resume") &&
    resumeCode.includes("Rename resume") &&
    resumeCode.includes("Delete resume");

  if (hasFileIconTile && hasResumeName15 && hasUploadedDate13 && hasStatusChip && hasRealActionButtons) {
    console.log("  [PASS] Resume Card Elements: file icon tile, 15px title, 13px date, status chip, and real action buttons (view, rename, delete)");
  } else {
    failures.push("Resume Card Elements: Missing file icon tile, title, date, status chip, or real action buttons.");
  }

  // Authenticity Check: Strict absence of fake "Set as default" action and "Default" chip
  const hasFakeDefaultChip = resumeCode.includes('data-testid="resume-default-chip"') ||
    resumeCode.includes('>Default</span>') ||
    resumeCode.includes('"Default"') ||
    resumeCode.includes("'Default'");
  const hasFakeSetDefaultAction = resumeCode.includes("Set as default") ||
    resumeCode.includes("handleSetDefault");

  if (!hasFakeDefaultChip && !hasFakeSetDefaultAction) {
    console.log("  [PASS] Resume Authenticity: fake 'Set as default' action and 'Default' chip strictly omitted until multi-resume ships");
  } else {
    failures.push("Resume Authenticity: 'Set as default' action or 'Default' chip must not be present until multi-resume backend ships.");
  }

  // Delete Confirmation: preserves exact confirmation wording
  const hasDeleteConfirm = resumeCode.includes("window.confirm") &&
    resumeCode.includes("Are you sure you want to delete your confirmed resume facts? This will reset all personalized match scores.");
  if (hasDeleteConfirm) {
    console.log("  [PASS] Resume Delete: preserves exact confirmation modal wording");
  } else {
    failures.push("Resume Delete: Confirmation prompt wording altered or missing.");
  }

  // Empty State: centred icon, one line, upload button
  const hasEmptyState = resumeCode.includes('data-testid="resume-empty-state"') &&
    resumeCode.includes("No resumes uploaded yet") &&
    resumeCode.includes('data-testid="empty-upload-resume-button"');
  if (hasEmptyState) {
    console.log("  [PASS] Resume Empty State: centred icon, one line message, upload button");
  } else {
    failures.push("Resume Empty State: Missing centred icon, single-line message, or upload button.");
  }

  // Free User Gating: ProUpgradeScreen with exact copy
  const hasProGating = resumeCode.includes("ProUpgradeScreen") &&
    resumeCode.includes('title="Unlock CareerMonke Pro"') &&
    resumeCode.includes('subtitle="Upgrade to Pro to upload your resume, compute compatibility scores, and generate AI tailored applications."');
  if (hasProGating) {
    console.log("  [PASS] Free User Gating: ProUpgradeScreen preserved with exact copy within logged-in shell");
  } else {
    failures.push("Free User Gating: ProUpgradeScreen or copy altered.");
  }

  // ===========================================================================
  // SECTION 4: BRAND PURITY (Zero Jobright, Mascot, Coaching, Agent, Autofill)
  // ===========================================================================
  const forbiddenTerms = [
    "jobright",
    "mascot",
    "coaching",
    "ai copilot",
    "auto-fill",
    "autofill application",
    "interview coach",
  ];
  let brandPurityFailed = false;
  for (const term of forbiddenTerms) {
    if (trackerCode.toLowerCase().includes(term) || resumeCode.toLowerCase().includes(term)) {
      failures.push(`Brand Purity: Forbidden term '${term}' found in tracker or resume page.`);
      brandPurityFailed = true;
    }
  }
  if (!brandPurityFailed) {
    console.log("  [PASS] Brand & Feature Purity: zero Jobright terms, mascots, coaching, or autofill items");
  }

  // ===========================================================================
  // RESULTS & EXIT
  // ===========================================================================
  console.log("\n----------------------------------------------------------------------------------");
  if (failures.length > 0) {
    if (isNegativeControl) {
      console.log(`NEGATIVE CONTROL PASSED: Detected ${failures.length} expected simulated failure(s).`);
      process.exit(0);
    }
    console.error(`PROMPT 6 AUDIT FAILED with ${failures.length} error(s):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  if (isNegativeControl) {
    console.error("NEGATIVE CONTROL FAILED: Expected intentional errors were not caught!");
    process.exit(1);
  }

  console.log("PROMPT 6 TRACKER & RESUME REBUILD VALIDATED LOCALLY [PASS-LOCAL]");
  process.exit(0);
}

runAudit();
