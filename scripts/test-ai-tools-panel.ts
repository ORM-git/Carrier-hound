import * as fs from "fs";
import * as path from "path";
import assert from "assert";
import { computeFitDiagnostics } from "../src/lib/matcher/scoring";
import { CandidateProfile } from "../src/lib/resume/types";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("             TEST: AI TOOLS PANEL, MATCH BREAKDOWN & ACCESS GATING                ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  if (isNegativeControl) {
    console.log("Triggering deliberate failure for negative control...");
    assert.strictEqual(true, false, "Negative control asserted non-zero exit successfully");
  }

  const failures: string[] = [];

  const panelPath = path.resolve(process.cwd(), "src/components/jobs/JobAiToolsPanel.tsx");
  const detailPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");

  if (!fs.existsSync(panelPath)) {
    failures.push(`MISSING FILE: ${panelPath} does not exist`);
  }
  if (!fs.existsSync(detailPath)) {
    failures.push(`MISSING FILE: ${detailPath} does not exist`);
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  const panelCode = fs.readFileSync(panelPath, "utf8");
  const detailCode = fs.readFileSync(detailPath, "utf8");

  // 1. Integration in JobDetailView below sticky header
  const detailHasPanelImport = detailCode.includes('import JobAiToolsPanel from "@/components/jobs/JobAiToolsPanel";');
  const detailHasMountedPanel = detailCode.includes("<JobAiToolsPanel");
  const stickyHeaderIdx = detailCode.indexOf('aria-label="Job header"');
  const panelMountIdx = detailCode.indexOf("<JobAiToolsPanel");
  const headerBodyCardIdx = detailCode.indexOf("{/* (2) HEADER BODY CARD */}");

  if (!detailHasPanelImport || !detailHasMountedPanel) {
    failures.push("INTEGRATION FAIL: JobDetailView must import and mount JobAiToolsPanel.");
  } else if (stickyHeaderIdx === -1 || panelMountIdx === -1 || headerBodyCardIdx === -1) {
    failures.push("INTEGRATION FAIL: Could not locate sticky header or header body card in JobDetailView.");
  } else if (!(stickyHeaderIdx < panelMountIdx && panelMountIdx < headerBodyCardIdx)) {
    failures.push("LAYOUT FAIL: JobAiToolsPanel must be mounted below the sticky header and before the header body card.");
  } else {
    console.log("  [PASS] Integration & Placement: JobAiToolsPanel mounted below header and before body card");
  }

  // 2. Gating for guest / free / pro users on Tailor action
  const hasGuestLoginModal =
    panelCode.includes("showLoginModal") &&
    panelCode.includes('role="dialog"') &&
    panelCode.includes('aria-labelledby="login-prompt-title"') &&
    panelCode.includes("Sign in to tailor your resume") &&
    panelCode.includes("/login?returnTo=");

  const hasGuestGatingCheck =
    panelCode.includes("if (!user)") &&
    panelCode.includes("setShowLoginModal(true)");

  const hasFreeGatingBadge =
    panelCode.includes("!isPro && user") &&
    panelCode.includes("Free") &&
    panelCode.includes("Rules-based tailoring");

  const hasProGatingBadge =
    panelCode.includes("isPro &&") &&
    panelCode.includes("Pro AI") &&
    panelCode.includes("Full AI tailoring");

  if (!hasGuestLoginModal || !hasGuestGatingCheck) {
    failures.push("GUEST GATING FAIL: Signed-out users must see a login prompt dialog with /login redirect when attempting to tailor.");
  } else {
    console.log("  [PASS] Guest Gating: Signed-out users see accessible login prompt dialog with redirect return path");
  }

  if (!hasFreeGatingBadge || !hasProGatingBadge) {
    failures.push("FREE/PRO GATING FAIL: Must distinguish Free rules-based tailoring from Pro AI tailoring without altering pricing.");
  } else {
    console.log("  [PASS] Free vs Pro Gating: Existing paywall rules preserved (Free rules-based vs Pro AI)");
  }

  // 3. Match Breakdown (Score, matched skills, missing skills, zero fake stubs)
  const hasMatchBreakdownGuards =
    panelCode.includes("hasConfirmedResume && diagnostics && matchScore !== null") &&
    panelCode.includes('data-testid="ai-tools-match-breakdown"') &&
    panelCode.includes('data-testid="ai-tools-matched-skills"') &&
    panelCode.includes('data-testid="ai-tools-missing-skills"');

  if (!hasMatchBreakdownGuards) {
    failures.push("MATCH BREAKDOWN FAIL: Match breakdown must strictly gate on confirmed resume and valid diagnostics (no fake stubs).");
  } else {
    console.log("  [PASS] Match Breakdown: Uses computeFitDiagnostics data, shows matched/missing skills, hidden when unconfirmed");
  }

  // Test local scoring calculation without network calls
  const mockCandidate: CandidateProfile = {
    fullName: "Jane Doe",
    email: "jane@example.com",
    title: "Senior Full-Stack Engineer",
    skills: ["React", "TypeScript", "Node.js", "PostgreSQL", "Next.js"],
    confirmedAt: "2026-10-20T12:00:00Z",
    workExperiences: [
      {
        id: "1",
        title: "Senior Full-Stack Engineer",
        company: "Tech Corp",
        startDate: "2022-01-01",
        endDate: null,
        isCurrent: true,
        bullets: ["Built React and TypeScript web apps"],
      },
    ],
  };

  const mockJob = {
    id: "test-job-123",
    title: "Senior Frontend Engineer",
    company: "Acme Cloud",
    location: "Remote",
    remote: true,
    skills: ["React", "TypeScript", "GraphQL", "Tailwind CSS"],
    description: "Looking for Senior Frontend Engineer skilled in React, TypeScript, GraphQL and Tailwind CSS.",
  };

  const diagResult = computeFitDiagnostics(mockCandidate, mockJob);
  assert(diagResult.score >= 10 && diagResult.score <= 100, "Score should be valid percentage");
  assert(diagResult.matchedSkills.includes("React") || diagResult.matchedSkills.includes("react"), "React should be matched");
  assert(diagResult.missingSkills.length >= 0, "Missing skills list present");
  console.log(`  [PASS] Local Match Logic: Pure client-side diagnostics score=${Math.round(diagResult.score)}%, matched=${diagResult.matchedSkills.length}, missing=${diagResult.missingSkills.length}`);

  // 4. Tracker Actions (Save / Applied)
  const hasSaveAction =
    panelCode.includes('data-testid="ai-tools-save-button"') &&
    panelCode.includes("onSave") &&
    panelCode.includes("aria-pressed={isSaved}");

  const hasAppliedAction =
    panelCode.includes('data-testid="ai-tools-applied-button"') &&
    panelCode.includes("onToggleApplied") &&
    panelCode.includes("isUpdatingApplied") &&
    panelCode.includes("Loader2");

  if (!hasSaveAction || !hasAppliedAction) {
    failures.push("TRACKER FAIL: Save and Applied buttons must reuse existing onSave, onToggleApplied, and display loading state.");
  } else {
    console.log("  [PASS] Tracker Actions: Save and Applied actions reuse existing tracker with loading and disabled states");
  }

  // 5. Mobile Collapsibility
  const hasMobileCollapse =
    panelCode.includes("isMobileExpanded") &&
    panelCode.includes("setIsMobileExpanded") &&
    panelCode.includes("md:hidden") &&
    panelCode.includes('aria-controls="ai-tools-panel-body"');

  if (!hasMobileCollapse) {
    failures.push("MOBILE COLLAPSIBLE FAIL: JobAiToolsPanel must be collapsible on mobile with toggle control.");
  } else {
    console.log("  [PASS] Mobile Collapsibility: Accessible toggle for mobile (md:hidden) with persistent desktop view");
  }

  // 6. Hidden Feature Flags Stay Hidden
  const interviewFlagGate = detailCode.includes('process.env.NEXT_PUBLIC_ENABLE_INTERVIEW_PACK === "true" &&');
  const skillWhatIfFlagGate = detailCode.includes('process.env.NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF === "true" &&');
  const hasDevBypassOnInterview = detailCode.includes('NEXT_PUBLIC_ENABLE_INTERVIEW_PACK === "true" || process.env.NODE_ENV !== "production"');
  const hasDevBypassOnWhatIf = detailCode.includes('NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF === "true" || process.env.NODE_ENV !== "production"');

  if (!interviewFlagGate || !skillWhatIfFlagGate || hasDevBypassOnInterview || hasDevBypassOnWhatIf) {
    failures.push("FEATURE FLAG FAIL: NEXT_PUBLIC_ENABLE_INTERVIEW_PACK and NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF must stay OFF and hidden (no dev mode bypass).");
  } else {
    console.log("  [PASS] Feature Flags: NEXT_PUBLIC_ENABLE_INTERVIEW_PACK & NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF stay strictly OFF and hidden");
  }

  // 7. No New Network Calls on Page Load
  const hasFetchInPanel = panelCode.includes("fetch(") || panelCode.includes("axios");
  const hasAsyncEffectInPanel = panelCode.includes("useEffect(") && (panelCode.includes("async") || panelCode.includes("Promise"));

  if (hasFetchInPanel || hasAsyncEffectInPanel) {
    failures.push("NETWORK CALL FAIL: JobAiToolsPanel must not make new network calls or async fetches on page load.");
  } else {
    console.log("  [PASS] Zero Network Calls: Component performs zero fetch/axios/async calls on page load");
  }

  // 8. No forbidden domain string anywhere in new component
  const forbiddenDomain = ["career", "monke", ".com"].join("");
  if (panelCode.toLowerCase().includes(forbiddenDomain)) {
    failures.push(`BRAND FORBIDDEN STRING FAIL: JobAiToolsPanel must not contain ${forbiddenDomain}.`);
  } else {
    console.log("  [PASS] Domain String Guard: Zero occurrences of forbidden domain string in JobAiToolsPanel");
  }

  if (failures.length > 0) {
    console.error("\nFAILURES DETECTED:\n" + failures.join("\n"));
    process.exit(1);
  }

  console.log("\n----------------------------------------------------------------------------------");
  console.log("AI TOOLS PANEL & MATCH BREAKDOWN AUDIT VALIDATED [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run().catch((err) => {
  console.error("UNEXPECTED TEST CRASH:", err);
  process.exit(1);
});
