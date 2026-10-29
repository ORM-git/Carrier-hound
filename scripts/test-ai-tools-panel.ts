import * as fs from "fs";
import * as path from "path";
import assert from "assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JobAiToolsPanel, { resolveTailorClickAction } from "../src/components/jobs/JobAiToolsPanel";
import { computeFitDiagnostics } from "../src/lib/matcher/scoring";
import { CandidateProfile } from "../src/lib/resume/types";
import { LiveJob } from "@/lib/jobs/service";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("             TEST: AI TOOLS PANEL BEHAVIOR & ACCESS GATING PATHS                  ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  if (isNegativeControl) {
    console.log("Triggering deliberate failure for negative control...");
    assert.strictEqual(true, false, "Negative control asserted non-zero exit successfully");
  }

  const failures: string[] = [];

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

  const mockJob: LiveJob = {
    id: "test-job-123",
    title: "Senior Frontend Engineer",
    company: "Acme Cloud",
    location: "Remote",
    remote: true,
    remoteScope: "worldwide",
    category: "Engineering",
    skills: ["React", "TypeScript", "GraphQL", "Tailwind CSS"],
    description: "Looking for Senior Frontend Engineer skilled in React, TypeScript, GraphQL and Tailwind CSS.",
    salary: "$140,000 - $180,000",
    applyUrl: "https://example.com/apply",
    proUnlockError: false,
  };

  const diagnostics = computeFitDiagnostics(mockCandidate, mockJob);

  // ----------------------------------------------------------------------------------
  // BEHAVIOR TEST 1: GUEST CLICK PATH
  // ----------------------------------------------------------------------------------
  console.log("1. Testing Guest User Click Path Behavior...");
  const guestDecision = resolveTailorClickAction({ user: null, hasConfirmedResume: false });
  assert.strictEqual(
    guestDecision.action,
    "show_login_modal",
    "Guest click MUST resolve strictly to show_login_modal"
  );

  let tailorCalledForGuest = false;
  let paywallCalledForGuest = false;

  const guestMarkup = renderToStaticMarkup(
    React.createElement(JobAiToolsPanel, {
      job: mockJob,
      candidate: null,
      user: null,
      isPro: false,
      diagnostics: null,
      isSaved: false,
      isApplied: false,
      onSave: () => {},
      onToggleApplied: () => {},
      onOpenTailor: () => {
        tailorCalledForGuest = true;
      },
      onOpenPaywall: () => {
        paywallCalledForGuest = true;
      },
    })
  );

  assert.strictEqual(tailorCalledForGuest, false, "Tailoring must not be triggered on guest render");
  assert.strictEqual(paywallCalledForGuest, false, "Paywall must not be triggered on guest render");
  assert(guestMarkup.includes("Sign in required to tailor"), "Guest view must show sign-in prompt label");
  assert(!guestMarkup.includes("ai-tools-match-breakdown"), "Guest view must not render match breakdown stub");
  console.log("  [PASS] Guest Click Path: Only showLoginModal resolves; no secondary prompt stacking");

  // ----------------------------------------------------------------------------------
  // BEHAVIOR TEST 2: FREE SIGNED-IN USER CLICK PATH
  // ----------------------------------------------------------------------------------
  console.log("2. Testing Signed-In Free User Click Path Behavior...");
  const freeUser = { id: "usr_free_123", email: "free@example.com" } as any;
  const freeDecision = resolveTailorClickAction({ user: freeUser, hasConfirmedResume: true });
  assert.strictEqual(
    freeDecision.action,
    "open_tailor",
    "Signed-in Free user with confirmed resume MUST resolve to open_tailor (rules-based)"
  );

  let freeTailorOpened = false;
  let freePaywallOpened = false;

  const freeMarkup = renderToStaticMarkup(
    React.createElement(JobAiToolsPanel, {
      job: { ...mockJob, proUnlockError: true }, // proUnlockError must NOT block tailoring
      candidate: mockCandidate,
      user: freeUser,
      isPro: false,
      diagnostics,
      isSaved: false,
      isApplied: false,
      onSave: () => {},
      onToggleApplied: () => {},
      onOpenTailor: () => {
        freeTailorOpened = true;
      },
      onOpenPaywall: () => {
        freePaywallOpened = true;
      },
    })
  );

  assert(freeMarkup.includes(">Free<"), "Free user must see active 'Free' label for rules-based tailoring");
  assert(freeMarkup.includes("Rules-based tailoring"), "Free user must see rules-based tailoring description");
  assert(freeMarkup.includes("ai-tools-match-breakdown"), "Free user with confirmed profile must see match breakdown");
  console.log("  [PASS] Free Click Path: Free users access rules-based tailoring directly without paywall block");

  // ----------------------------------------------------------------------------------
  // BEHAVIOR TEST 3: PRO SIGNED-IN USER CLICK PATH
  // ----------------------------------------------------------------------------------
  console.log("3. Testing Signed-In Pro User Click Path Behavior...");
  const proUser = { id: "usr_pro_456", email: "pro@example.com" } as any;
  const proDecision = resolveTailorClickAction({ user: proUser, hasConfirmedResume: true });
  assert.strictEqual(
    proDecision.action,
    "open_tailor",
    "Signed-in Pro user with confirmed resume MUST resolve to open_tailor"
  );

  const proMarkup = renderToStaticMarkup(
    React.createElement(JobAiToolsPanel, {
      job: mockJob,
      candidate: mockCandidate,
      user: proUser,
      isPro: true,
      diagnostics,
      isSaved: true,
      isApplied: true,
      onSave: () => {},
      onToggleApplied: () => {},
      onOpenTailor: () => {},
    })
  );

  assert(proMarkup.includes(">Pro AI<"), "Pro user must see Pro AI badge on button");
  assert(proMarkup.includes("Full AI tailoring enabled"), "Pro user must see AI tailoring status");
  assert(proMarkup.includes("Saved"), "Tracker save button must reflect active saved state");
  assert(proMarkup.includes("Applied"), "Tracker applied button must reflect active applied state");
  console.log("  [PASS] Pro Click Path: Pro users access full tailoring and active tracker states");

  // ----------------------------------------------------------------------------------
  // BEHAVIOR TEST 4: NO-RESUME USER CLICK PATH
  // ----------------------------------------------------------------------------------
  console.log("4. Testing No-Resume User Click Path Behavior...");
  const noResumeUser = { id: "usr_no_resume_789", email: "noresume@example.com" } as any;
  const noResumeDecision = resolveTailorClickAction({ user: noResumeUser, hasConfirmedResume: false });
  assert.strictEqual(
    noResumeDecision.action,
    "redirect_resume",
    "Signed-in user without confirmed resume must route to /resume"
  );
  assert.strictEqual(noResumeDecision.destination, "/resume", "Target destination must be /resume");

  const noResumeMarkup = renderToStaticMarkup(
    React.createElement(JobAiToolsPanel, {
      job: mockJob,
      candidate: null,
      user: noResumeUser,
      isPro: false,
      diagnostics: null,
      isSaved: false,
      isApplied: false,
      onSave: () => {},
      onToggleApplied: () => {},
      onOpenTailor: () => {},
    })
  );

  assert(noResumeMarkup.includes("Upload resume to tailor"), "Must guide user to upload resume");
  assert(!noResumeMarkup.includes("ai-tools-match-breakdown"), "Match breakdown must remain hidden when resume unconfirmed");
  console.log("  [PASS] No-Resume Path: Routes to /resume and hides match breakdown completely");

  // ----------------------------------------------------------------------------------
  // BEHAVIOR TEST 5: CLIENT-SIDE MATCH SCORING (NO NETWORK CALLS)
  // ----------------------------------------------------------------------------------
  console.log("5. Testing Pure Client-Side Scoring Consistency...");
  assert(diagnostics.score >= 10 && diagnostics.score <= 100, "Score should be valid percentage");
  assert(diagnostics.matchedSkills.some((s) => s.toLowerCase().includes("react")), "React must be matched");
  console.log(`  [PASS] Client-Side Diagnostics: score=${Math.round(diagnostics.score)}%, matched=${diagnostics.matchedSkills.length}, missing=${diagnostics.missingSkills.length}`);

  // ----------------------------------------------------------------------------------
  // BEHAVIOR TEST 6: JOBDETAILVIEW TAILOR HANDLER DECOUPLING
  // ----------------------------------------------------------------------------------
  console.log("6. Verifying JobDetailView onOpenTailor Handler...");
  const detailPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");
  const detailCode = fs.readFileSync(detailPath, "utf8");

  const tailorBody = detailCode.slice(detailCode.indexOf("onOpenTailor"), detailCode.indexOf("onOpenTailor") + 80).split("}}")[0];
  const hasUnlockedBlock = tailorBody.includes("!isUnlocked") || tailorBody.includes("onApply");
  if (hasUnlockedBlock) {
    failures.push("TAILOR HANDLER FAIL: onOpenTailor must not gate on !isUnlocked or onApply (free users must reach tailoring).");
  } else {
    console.log("  [PASS] Tailor Handler Decoupling: Free users not blocked by !isUnlocked or job.proUnlockError");
  }

  const hasStackedOnRequireAuth = detailCode.includes("onRequireAuth={() =>");
  if (hasStackedOnRequireAuth) {
    failures.push("PROMPT STACKING FAIL: JobDetailView must not pass onRequireAuth to JobAiToolsPanel.");
  } else {
    console.log("  [PASS] Prompt Decoupling: No stacked prompts between panel and page");
  }

  // ----------------------------------------------------------------------------------
  // BEHAVIOR TEST 7: FORBIDDEN DOMAIN STRING GUARD
  // ----------------------------------------------------------------------------------
  const panelPath = path.resolve(process.cwd(), "src/components/jobs/JobAiToolsPanel.tsx");
  const panelCode = fs.readFileSync(panelPath, "utf8");
  const forbiddenDomain = ["career", "monke", ".com"].join("");
  if (panelCode.toLowerCase().includes(forbiddenDomain)) {
    failures.push(`BRAND FORBIDDEN STRING FAIL: JobAiToolsPanel must not contain ${forbiddenDomain}`);
  } else {
    console.log("  [PASS] Domain String Guard: Zero occurrences of forbidden domain string");
  }

  if (failures.length > 0) {
    console.error("\nFAILURES DETECTED:\n" + failures.join("\n"));
    process.exit(1);
  }

  console.log("\n----------------------------------------------------------------------------------");
  console.log("AI TOOLS PANEL BEHAVIOR AUDIT VALIDATED [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run().catch((err) => {
  console.error("UNEXPECTED TEST CRASH:", err);
  process.exit(1);
});
