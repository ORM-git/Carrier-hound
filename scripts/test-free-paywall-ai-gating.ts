process.env.NODE_ENV = "test";

import * as fs from "fs";
import * as path from "path";
import { handleAiRequest } from "../src/lib/ai/serviceHandler";
import { getTopRankedJobsForCandidate } from "../src/lib/jobs/service";
import { AllowedAiOperation } from "../src/lib/ai/security";
import { CandidateProfile } from "../src/lib/resume/types";

const isNegativeControl = process.argv.includes("--negative-control");

const testCandidate: CandidateProfile = {
  name: "Alex Morgan",
  headline: "Full-Stack Engineer",
  summary: "5 years building web applications with TypeScript and React.",
  skills: ["TypeScript", "React", "Node.js", "PostgreSQL"],
  experience: [
    {
      company: "Acme Corp",
      role: "Software Engineer",
      startDate: "2021",
      endDate: "Present",
      bullets: ["Built scalable microservices in Node.js."],
    },
  ],
  education: [
    {
      degree: "BS Computer Science",
      institution: "State University",
      year: "2020",
    },
  ],
  confirmedAt: "2026-01-01T00:00:00Z",
};

const testJob = {
  id: "job_test_101",
  title: "Senior Full-Stack Developer",
  company: "RemoteTech Inc.",
  location: "Remote - Worldwide",
  category: "Engineering",
  skills: ["TypeScript", "React", "Node.js"],
  description: "Looking for an experienced engineer to build user interfaces and API endpoints.",
};

async function run() {
  console.log("==================================================================================");
  console.log("        TEST: FREE-PLAN PAYWALL, ONBOARDING STEPPER & AI GATING VALIDATION        ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const failures: string[] = [];

  // -----------------------------------------------------------------------------
  // SUITE 1: Server-Side AI Gating on all 4 Allowed Operations
  // -----------------------------------------------------------------------------
  console.log("1. Verifying Server-Side 403 PRO_REQUIRED for Non-Pro Users Across All AI Operations...");

  const operations: AllowedAiOperation[] = [
    "cover_letter",
    "resume_extraction",
    "resume_tailor",
    "job_fit",
  ];

  for (const op of operations) {
    const payload =
      op === "resume_extraction"
        ? { operation: op, params: { rawText: "Sample resume text with TypeScript and React." } }
        : op === "job_fit"
        ? {
            operation: op,
            params: {
              candidate: { headline: testCandidate.headline, skills: testCandidate.skills },
              job: { title: testJob.title, company: testJob.company, description: testJob.description },
            },
          }
        : {
            operation: op,
            params: { candidate: testCandidate, job: testJob },
          };

    const req = new Request("http://localhost:3000/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_mock_free_token",
      },
      body: JSON.stringify(payload),
    });

    const res = await handleAiRequest(req, {
      getSupabaseAdmin: () => ({
        auth: {
          getUser: async () => ({
            data: { user: { id: "usr_free_test", user_metadata: {} } },
            error: null,
          }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
      getServerEntitlement: async () => ({
        isPro: isNegativeControl ? true : false, // Negative control inverts entitlement
        tier: isNegativeControl ? "pro_monthly" : "free",
        status: isNegativeControl ? "active" : "canceled",
        expiresAt: null,
        cachedAt: Date.now(),
        cancelAtPeriodEnd: false,
      }),
    });

    if (isNegativeControl) {
      if (res.status !== 403) {
        // Expected failure in negative control mode
        failures.push(`NEGATIVE CONTROL TRIGGERED: Server allowed operation '${op}' under inverted entitlement.`);
      }
    } else {
      if (res.status !== 403) {
        failures.push(`SECURITY LEAK: Operation '${op}' returned HTTP ${res.status} instead of 403 for non-Pro user!`);
      } else {
        const body = await res.json().catch(() => ({}));
        if (body.code !== "PRO_REQUIRED") {
          failures.push(`SECURITY ERROR: Operation '${op}' returned 403 but missing code 'PRO_REQUIRED'.`);
        }
      }
    }
  }

  // -----------------------------------------------------------------------------
  // SUITE 2: Top 10 Ranked Jobs Service Gating
  // -----------------------------------------------------------------------------
  console.log("2. Verifying getTopRankedJobsForCandidate strictly returns [] for free users...");

  const freeTopJobs = await getTopRankedJobsForCandidate(
    testCandidate,
    10,
    isNegativeControl ? true : false
  );

  if (isNegativeControl) {
    if (freeTopJobs.length !== 0) {
      failures.push("NEGATIVE CONTROL TRIGGERED: getTopRankedJobsForCandidate returned jobs under inverted flag.");
    }
  } else {
    if (!Array.isArray(freeTopJobs) || freeTopJobs.length > 0) {
      failures.push(`DATA EXPOSURE: getTopRankedJobsForCandidate returned ${freeTopJobs.length} jobs for non-Pro user!`);
    }
  }

  // -----------------------------------------------------------------------------
  // SUITE 3: Codebase File Integrity & Architectural Protections
  // -----------------------------------------------------------------------------
  console.log("3. Verifying LockedPreview, Free Dashboard, Onboarding, and AI Call Sites...");

  const lockedPreviewPath = path.resolve(process.cwd(), "src/components/billing/LockedPreview.tsx");
  const freePreviewPath = path.resolve(process.cwd(), "src/components/dashboard/FreeDashboardTopTenPreview.tsx");
  const dashboardPath = path.resolve(process.cwd(), "src/app/dashboard/page.tsx");
  const onboardingPath = path.resolve(process.cwd(), "src/app/onboarding/page.tsx");
  const uploadPath = path.resolve(process.cwd(), "src/components/resume/ResumeUploadAndConfirm.tsx");
  const coverLetterPath = path.resolve(process.cwd(), "src/components/resume/CoverLetterModal.tsx");
  const tailorPath = path.resolve(process.cwd(), "src/components/resume/TailorResumeModal.tsx");
  const whyMatchPath = path.resolve(process.cwd(), "src/components/dashboard/WhyMatchPanel.tsx");
  const fitModalPath = path.resolve(process.cwd(), "src/components/matcher/FitDiagnosticsModal.tsx");

  const filesToCheck = [
    { p: lockedPreviewPath, name: "LockedPreview.tsx" },
    { p: freePreviewPath, name: "FreeDashboardTopTenPreview.tsx" },
    { p: dashboardPath, name: "dashboard/page.tsx" },
    { p: onboardingPath, name: "onboarding/page.tsx" },
    { p: uploadPath, name: "ResumeUploadAndConfirm.tsx" },
    { p: coverLetterPath, name: "CoverLetterModal.tsx" },
    { p: tailorPath, name: "TailorResumeModal.tsx" },
    { p: whyMatchPath, name: "WhyMatchPanel.tsx" },
    { p: fitModalPath, name: "FitDiagnosticsModal.tsx" },
  ];

  for (const { p, name } of filesToCheck) {
    if (!fs.existsSync(p)) {
      failures.push(`MISSING FILE: ${name} does not exist at ${p}`);
    }
  }

  // A. LockedPreview assertions
  const lockedPreviewCode = fs.readFileSync(lockedPreviewPath, "utf-8");
  if (!lockedPreviewCode.includes("blur-md") && !lockedPreviewCode.includes("blur-sm")) {
    failures.push("LockedPreview must implement real CSS blur (blur-md or blur-sm).");
  }
  if (!lockedPreviewCode.includes('aria-hidden="true"')) {
    failures.push("LockedPreview blurred container must be aria-hidden='true' for accessibility.");
  }
  if (!lockedPreviewCode.includes("pointer-events-none") || !lockedPreviewCode.includes("select-none")) {
    failures.push("LockedPreview blurred container must be pointer-events-none and select-none.");
  }
  if (!lockedPreviewCode.includes('href={ctaHref}')) {
    failures.push("LockedPreview CTA must link to /pricing.");
  }

  // B. FreeDashboardTopTenPreview assertions
  const freePreviewCode = fs.readFileSync(freePreviewPath, "utf-8");
  if (!freePreviewCode.includes("LockedPreview")) {
    failures.push("FreeDashboardTopTenPreview must wrap blurred skeleton cards in LockedPreview.");
  }
  if (!freePreviewCode.includes("Array.from({ length: 10 }")) {
    failures.push("FreeDashboardTopTenPreview must render 10 structural placeholder cards matching Top 10 layout.");
  }
  // Verify no fake scores or invented percentages in placeholders
  if (/\b\d{2}%\b/.test(freePreviewCode)) {
    failures.push("PROHIBITED FAKE DATA: FreeDashboardTopTenPreview contains hardcoded percentage scores!");
  }

  // C. Dashboard Page assertions
  const dashboardCode = fs.readFileSync(dashboardPath, "utf-8");
  if (!dashboardCode.includes("FreeDashboardTopTenPreview")) {
    failures.push("dashboard/page.tsx must import and use FreeDashboardTopTenPreview for non-Pro users.");
  }
  if (dashboardCode.includes("if (!isPro) {\n    return (\n      <LoggedInAppShell") || dashboardCode.includes("title=\"Unlock CareerMonke Pro\"")) {
    failures.push("dashboard/page.tsx must NOT replace the entire page with ProUpgradeScreen for non-Pro users.");
  }
  if (!dashboardCode.includes("FREE PLAN")) {
    failures.push("dashboard/page.tsx must render FREE PLAN badge for non-Pro users.");
  }

  // D. Onboarding Page assertions
  const onboardingCode = fs.readFileSync(onboardingPath, "utf-8");
  if (onboardingCode.includes("ProUpgradeScreen")) {
    failures.push("onboarding/page.tsx must NOT lock onboarding behind ProUpgradeScreen.");
  }
  const requiredQuestions = ["Target Role", "Seniority Level", "Work Model", "Location Eligibility", "Employment Type", "Resume Upload"];
  for (const q of requiredQuestions) {
    if (!onboardingCode.includes(q)) {
      failures.push(`onboarding/page.tsx is missing onboarding step: '${q}'`);
    }
  }
  const requiredStepperEvents = ["Uploading", "Reading your resume", "Extracting skills and experience", "Matching you with jobs"];
  for (const ev of requiredStepperEvents) {
    if (!onboardingCode.includes(ev)) {
      failures.push(`onboarding/page.tsx resume processing screen is missing real event step: '${ev}'`);
    }
  }
  if (!onboardingCode.includes("parseResumeText")) {
    failures.push("onboarding/page.tsx must use deterministic non-AI parser parseResumeText.");
  }
  if (onboardingCode.includes("extractResumeFactsWithGroq")) {
    failures.push("PROHIBITED AI CALL: onboarding/page.tsx must not call extractResumeFactsWithGroq before payment!");
  }

  // E. Gating of AI call sites
  const uploadCode = fs.readFileSync(uploadPath, "utf-8");
  if (!uploadCode.includes("isProUser && getGroqApiKey()")) {
    failures.push("ResumeUploadAndConfirm.tsx must gate extractResumeFactsWithGroq behind isProUser.");
  }

  const coverLetterCode = fs.readFileSync(coverLetterPath, "utf-8");
  if (!coverLetterCode.includes("isProUser && getGroqApiKey()")) {
    failures.push("CoverLetterModal.tsx must gate generateGroqTailoredCoverLetter behind isProUser.");
  }

  const tailorCode = fs.readFileSync(tailorPath, "utf-8");
  if (!tailorCode.includes("LockedPreview")) {
    failures.push("TailorResumeModal.tsx must render LockedPreview for non-Pro users.");
  }
  if (!tailorCode.includes("if (!isProUser)")) {
    failures.push("TailorResumeModal.tsx must block handleGenerateAi if !isProUser.");
  }

  const whyMatchCode = fs.readFileSync(whyMatchPath, "utf-8");
  if (!whyMatchCode.includes("data-testid=\"why-match-explain-pro-lock\"")) {
    failures.push("WhyMatchPanel.tsx must render Pro lock CTA when user is not Pro.");
  }

  const fitModalCode = fs.readFileSync(fitModalPath, "utf-8");
  if (!fitModalCode.includes("LockedPreview")) {
    failures.push("FitDiagnosticsModal.tsx must render LockedPreview for non-Pro users.");
  }

  // -----------------------------------------------------------------------------
  // SUITE 4: Truthful Copy Assertions
  // -----------------------------------------------------------------------------
  console.log("4. Verifying Truthful Loss-Aversion Copy and Absence of Invented Stats...");

  const requiredCopySamples = [
    "Your match score is ready. Only you can't see it yet.",
    "Recruiters filter by fit. Find out where you stand.",
    "Unlock to see your compatible score and your Top 10 jobs.",
    "Your resume has gaps. See exactly which ones.",
  ];

  const allCode = freePreviewCode + lockedPreviewCode + tailorCode + fitModalCode;
  for (const copy of requiredCopySamples) {
    if (!allCode.includes(copy)) {
      failures.push(`COPY MISSING: Required truthful copy '${copy}' not found in paywall components.`);
    }
  }

  // Check that invented stats or dishonest claims do NOT exist
  const forbiddenClaims = [
    "you are being rejected",
    "87% of candidates rejected",
    "recruiters are ignoring you",
  ];
  for (const claim of forbiddenClaims) {
    if (allCode.toLowerCase().includes(claim)) {
      failures.push(`PROHIBITED COPY CLAIM: Found dishonest claim '${claim}' in paywall copy.`);
    }
  }

  // -----------------------------------------------------------------------------
  // Results & Exit Code
  // -----------------------------------------------------------------------------
  if (isNegativeControl) {
    if (failures.length > 0) {
      console.log("\n[PASS-NEGATIVE-CONTROL] Negative control successfully caught expected failure:");
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(0);
    } else {
      console.error("\n[FAIL-NEGATIVE-CONTROL] Negative control unexpectedly passed! Gating checks may be inactive.");
      process.exit(1);
    }
  } else {
    if (failures.length > 0) {
      console.error("\n[FAIL] Test suite failed with the following errors:");
      failures.forEach((f) => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.log("\n[PASS-LOCAL] All Free-Plan Paywall, Onboarding Stepper, and AI Gating tests passed cleanly!");
      process.exit(0);
    }
  }
}

run().catch((err) => {
  console.error("Unexpected test error:", err);
  process.exit(1);
});
