import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("       TEST: /JOBS LIST BASE CARD PURITY & HOVER PANEL REMOVAL VALIDATION         ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const jobsPath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");

  if (!fs.existsSync(jobsPath)) {
    console.error("FAIL: src/app/jobs/page.tsx does not exist!");
    process.exit(1);
  }

  let code = fs.readFileSync(jobsPath, "utf-8");

  if (isNegativeControl) {
    // Deliberate corruption: re-inject old hover panel, getDiagnosticsSummary, generic fallback, and hover hide
    code += '\n<div data-testid="card-hover-match-panel"><h3>Why this job is a match</h3></div>';
    code += '\nimport { getDiagnosticsSummary } from "@/lib/matcher/scoring";';
    code += '\n<p>Evaluated against your confirmed resume facts and requirements.</p>';
    code = code.replace(
      '<div className="min-w-0 flex-1 space-y-1.5">',
      '<div className="min-w-0 flex-1 space-y-1.5 sm:group-hover:opacity-0">'
    );
  }

  const failures: string[] = [];

  // ============================================================================
  // CHECK 1: Brand & Asset Purity
  // Zero Jobright mascot, logo, or copy
  // ============================================================================
  const lowerCode = code.toLowerCase();
  const hasJobright = lowerCode.includes("jobright") || lowerCode.includes("monke-agent");
  if (hasJobright) {
    failures.push("PURITY FAIL: Detected Jobright mascot/copy/brand in src/app/jobs/page.tsx");
  } else {
    console.log("  [PASS] Check 1: Zero Jobright branding, mascots, or copy detected");
  }

  // ============================================================================
  // CHECK 2: No Hover Panel or Popover of Any Kind on /jobs List Card
  // card-hover-match-panel and "Why this job is a match" MUST be absent from /jobs
  // ============================================================================
  const hasHoverPanelTestId = code.includes('data-testid="card-hover-match-panel"');
  if (hasHoverPanelTestId) {
    failures.push("STRUCTURE FAIL: /jobs list card still contains data-testid='card-hover-match-panel'. Old hover panel must be removed.");
  } else {
    console.log("  [PASS] Check 2a: data-testid='card-hover-match-panel' successfully removed from /jobs");
  }

  const hasWhyMatchTitle = code.includes("Why this job is a match");
  if (hasWhyMatchTitle) {
    failures.push("HOVER LEAK: Found 'Why this job is a match' text in src/app/jobs/page.tsx. Hover popover must be completely removed.");
  } else {
    console.log("  [PASS] Check 2b: Zero 'Why this job is a match' text in src/app/jobs/page.tsx");
  }

  const hasHoverFadeOut = code.includes("sm:group-hover:opacity-0");
  if (hasHoverFadeOut) {
    failures.push("LAYOUT STABILITY FAIL: Base card still crossfades out on hover (sm:group-hover:opacity-0 detected). Original card must always remain visible.");
  } else {
    console.log("  [PASS] Check 2c: Original card does not crossfade out on hover (sm:group-hover:opacity-0 absent)");
  }

  // ============================================================================
  // CHECK 3: No getDiagnosticsSummary or Generic Fallback Copy in page.tsx
  // No card may render "Evaluated against your confirmed resume facts and requirements."
  // ============================================================================
  const hasGetDiagnosticsSummary = code.includes("getDiagnosticsSummary");
  if (hasGetDiagnosticsSummary) {
    failures.push("IMPORT/USAGE LEAK: src/app/jobs/page.tsx still references getDiagnosticsSummary. It must be completely removed.");
  } else {
    console.log("  [PASS] Check 3a: getDiagnosticsSummary is completely absent from src/app/jobs/page.tsx");
  }

  const hasEvaluatedAgainst = code.includes("Evaluated against");
  if (hasEvaluatedAgainst) {
    failures.push("COPY LEAK: src/app/jobs/page.tsx contains generic fallback 'Evaluated against'.");
  } else {
    console.log("  [PASS] Check 3b: Zero generic fallback 'Evaluated against' found in src/app/jobs/page.tsx");
  }

  // ============================================================================
  // CHECK 4: Base Card Elements Intact & Always Visible
  // Logo, badges, title, company, 2x3 metadata grid, Apply, Save
  // ============================================================================
  const hasBaseCardElements =
    code.includes("<CompanyLogo") &&
    code.includes("Early applicant") &&
    code.includes("Remote Eligible") &&
    code.includes("grid grid-cols-3 grid-rows-2") &&
    code.includes('aria-label={isSaved ? "Unlike job" : "Save job"}') &&
    code.includes("<span>Apply</span>");

  if (!hasBaseCardElements) {
    failures.push("LAYOUT REGRESSION: One or more base card elements (CompanyLogo, badges, 2x3 grid, Save, Apply) missing from page.tsx.");
  } else {
    console.log("  [PASS] Check 4: Original card (logo, badges, 2x3 grid, Save, Apply) verified intact and always shown");
  }

  // ============================================================================
  // EVALUATION & VERDICT
  // ============================================================================
  console.log("\n----------------------------------------------------------------------------------");
  if (isNegativeControl) {
    if (failures.length > 0) {
      console.log("NEGATIVE CONTROL PASSED: Test caught deliberate corruption as expected.");
      console.log(`Caught issues:\n - ${failures.join("\n - ")}`);
      process.exit(0);
    } else {
      console.error("NEGATIVE CONTROL FAILED: Test failed to detect deliberate corruption!");
      process.exit(1);
    }
  } else {
    if (failures.length > 0) {
      console.error("VALIDATION FAILED with errors:\n - " + failures.join("\n - "));
      process.exit(1);
    } else {
      console.log("JOB CARD HOVER REMOVAL & BASE CARD VALIDATION [PASS-LOCAL]");
      process.exit(0);
    }
  }
}

run();
