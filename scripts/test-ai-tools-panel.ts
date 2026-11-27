import * as fs from "fs";
import * as path from "path";
import assert from "assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JobAiToolsPanel from "../src/components/jobs/JobAiToolsPanel";
import { computeFitDiagnostics } from "../src/lib/matcher/scoring";
import { CandidateProfile } from "../src/lib/resume/types";
import { LiveJob } from "@/lib/jobs/service";

/**
 * Job detail "Match Insights" panel: match breakdown + tracker actions only.
 * AI tool entry points (resume tailoring) must not be offered outside the landing page.
 */

const isNegativeControl = process.argv.includes("--negative-control");

// Any of these in the rendered panel means an AI tool entry point leaked back in.
const AI_CTA_TEXT = [
  "Tailor my resume",
  "Upload resume to tailor",
  "Tailor Resume",
  "Pro AI",
  "AI tailoring",
  "Sign in to tailor",
  "ai-tools-tailor-button",
];

async function run() {
  console.log("==================================================================================");
  console.log("        TEST: MATCH INSIGHTS PANEL (NO AI TOOL ENTRY POINTS) & TRACKER STATES     ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  if (isNegativeControl) {
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
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
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
        ...props,
      } as any)
    );
  const noAiCta = (markup: string, who: string) => {
    for (const t of AI_CTA_TEXT) {
      if (markup.includes(t)) failures.push(`AI CTA LEAK (${who}): panel renders "${t}"`);
    }
  };

  // 1. Guest
  const guest = render({});
  noAiCta(guest, "guest");
  assert(!guest.includes("ai-tools-match-breakdown"), "Guest must not see a match breakdown");
  assert(guest.includes("Match Insights"), "Panel heading must be Match Insights");
  console.log("  [PASS] Guest: no AI tool entry point, no breakdown");

  // 2. Free user with confirmed resume
  const freeUser = { id: "usr_free_123", email: "free@example.com" } as any;
  const free = render({ job: { ...mockJob, proUnlockError: true }, candidate: mockCandidate, user: freeUser, diagnostics });
  noAiCta(free, "free");
  // Paid-only score (owner, 24 Nov): a Free/locked user never gets the numeric score, breakdown or skills here.
  assert(!free.includes("ai-tools-match-breakdown"), "Free user must NOT see the match breakdown");
  assert(!free.includes("ai-tools-match-badge"), "Free user must NOT see the numeric match badge");
  assert(!free.includes("ai-tools-matched-skills") && !free.includes("ai-tools-missing-skills"), "Free user must NOT see matched/missing skills");
  const freeNotLocked = render({ job: { ...mockJob, matchScore: 87 }, candidate: mockCandidate, user: freeUser, isPro: false, diagnostics });
  assert(!freeNotLocked.includes("ai-tools-match-breakdown") && !freeNotLocked.includes("87%"), "Free (isPro=false) with a stale server score must not render it");
  console.log("  [PASS] Free: no score, breakdown or skills, no AI tool entry point");

  // 3. Pro user: tracker states
  const proUser = { id: "usr_pro_456", email: "pro@example.com" } as any;
  const pro = render({ candidate: mockCandidate, user: proUser, isPro: true, diagnostics, isSaved: true, isApplied: true });
  noAiCta(pro, "pro");
  assert(pro.includes("ai-tools-match-breakdown"), "Pro user with confirmed profile must see the match breakdown");
  assert(pro.includes("ai-tools-save-button") && pro.includes(">Saved<"), "Save button must reflect saved state");
  assert(pro.includes("ai-tools-applied-button") && pro.includes(">Applied<"), "Applied button must reflect applied state");
  console.log("  [PASS] Pro: tracker Saved/Applied states, no AI tool entry point");

  // 4. Signed-in, no confirmed resume
  const noResume = render({ user: { id: "usr_no_resume_789" } as any });
  noAiCta(noResume, "no-resume");
  assert(!noResume.includes("ai-tools-match-breakdown"), "Breakdown hidden when resume unconfirmed");
  console.log("  [PASS] No-resume: breakdown hidden, no AI tool entry point");

  // 5. Deterministic client-side scoring still works
  assert(diagnostics.score >= 10 && diagnostics.score <= 100, "Score should be a valid percentage");
  assert(diagnostics.matchedSkills.some((s) => s.toLowerCase().includes("react")), "React must be matched");
  console.log(`  [PASS] Client-side diagnostics: score=${Math.round(diagnostics.score)}%`);

  // 6. JobDetailView carries no tailoring wiring or AI tool entry cards
  const detailCode = fs.readFileSync(path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx"), "utf8");
  for (const needle of ["TailorResumeModal", "onOpenTailor", "setIsTailorOpen", "interview-pack-entry-button", "skill-what-if-entry-button"]) {
    if (detailCode.includes(needle)) failures.push(`DETAIL AI WIRING FAIL: JobDetailView still contains ${needle}`);
  }
  if (detailCode.includes("onRequireAuth={() =>")) {
    failures.push("PROMPT STACKING FAIL: JobDetailView must not pass onRequireAuth to JobAiToolsPanel.");
  }
  console.log("  [PASS] JobDetailView: no tailoring modal, handler or AI tool entry cards");

  // 7. Forbidden domain string guard
  const panelCode = fs.readFileSync(path.resolve(process.cwd(), "src/components/jobs/JobAiToolsPanel.tsx"), "utf8");
  const forbiddenDomain = ["career", "monke", ".com"].join("");
  if (panelCode.toLowerCase().includes(forbiddenDomain)) {
    failures.push(`BRAND FORBIDDEN STRING FAIL: JobAiToolsPanel must not contain ${forbiddenDomain}`);
  }

  if (failures.length > 0) {
    console.error("\nFAILURES DETECTED:\n" + failures.join("\n"));
    process.exit(1);
  }
  console.log("\nMATCH INSIGHTS PANEL AUDIT VALIDATED [PASS-LOCAL]");
}

run().catch((err) => {
  console.error("UNEXPECTED TEST CRASH:", err);
  process.exit(1);
});
