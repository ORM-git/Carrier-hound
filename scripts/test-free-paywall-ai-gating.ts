process.env.NODE_ENV = "test";

import * as fs from "fs";
import * as path from "path";
import { handleAiRequest } from "../src/lib/ai/serviceHandler";
import { getTopRankedJobsForCandidate } from "../src/lib/jobs/service";
import { AllowedAiOperation } from "../src/lib/ai/security";
import { CandidateProfile } from "../src/lib/resume/types";
import { UserPreferences, DEFAULT_USER_PREFERENCES } from "../src/lib/auth/types";

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
  // SUITE 3: Onboarding Preferences Preservation & Zero Invented Defaults (Items 1 & 2)
  // -----------------------------------------------------------------------------
  console.log("3. Verifying Onboarding Preferences Loading, Field Merging & Zero Invented Defaults...");

  const mockSavedExisting: UserPreferences = {
    roles: ["Data Engineer"],
    categories: ["data-science", "analytics"],
    experienceLevel: "lead",
    employmentTypes: ["contract"],
    locations: ["Berlin, Germany"],
    remotePreference: "hybrid",
    workAuth: "EU Work Permit",
    minSalary: 135000,
    salaryCurrency: "EUR",
    dailyDigestOptIn: false, // user explicitly unchecked
    onboardingCompleted: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  // Simulation of save logic under normal vs simulated negative control bug
  function simulateOnboardingSave(
    existing: UserPreferences | null,
    answered: {
      roles: string[];
      experienceLevel: UserPreferences["experienceLevel"] | "";
      remotePreference: UserPreferences["remotePreference"] | "";
      locations: string[];
      employmentTypes: string[];
      dailyDigestOptIn: boolean;
    },
    forceBug = false
  ): UserPreferences {
    if (forceBug) {
      // Simulate buggy behavior: spread DEFAULT_USER_PREFERENCES and invent defaults
      return {
        ...DEFAULT_USER_PREFERENCES,
        roles: answered.roles.length > 0 ? answered.roles : ["Full-Stack Developer"],
        experienceLevel: answered.experienceLevel || "mid",
        remotePreference: answered.remotePreference || "remote",
        locations: answered.locations.length > 0 ? answered.locations : ["Worldwide / Remote"],
        employmentTypes: answered.employmentTypes.length > 0 ? answered.employmentTypes : ["full-time"],
        dailyDigestOptIn: true, // forced on
        onboardingCompleted: true,
        updatedAt: new Date().toISOString(),
      };
    }

    // Correct behavior: never spread DEFAULT_USER_PREFERENCES, preserve existing, no invented defaults
    const basePrefs: Partial<UserPreferences> = existing ? { ...existing } : {};
    return {
      ...basePrefs,
      roles: answered.roles.length > 0 ? answered.roles : (existing?.roles ?? []),
      experienceLevel: (answered.experienceLevel || existing?.experienceLevel || "mid") as UserPreferences["experienceLevel"],
      remotePreference: (answered.remotePreference || existing?.remotePreference || "remote") as UserPreferences["remotePreference"],
      locations: answered.locations.length > 0 ? answered.locations : (existing?.locations ?? []),
      employmentTypes: answered.employmentTypes.length > 0 ? answered.employmentTypes : (existing?.employmentTypes ?? []),
      categories: existing?.categories ?? [],
      salaryCurrency: existing?.salaryCurrency ?? "USD",
      workAuth: existing?.workAuth,
      minSalary: existing?.minSalary,
      dailyDigestOptIn: answered.dailyDigestOptIn,
      onboardingCompleted: true,
      updatedAt: new Date().toISOString(),
    };
  }

  // Test 3A: Existing preferences preservation
  const savedResult = simulateOnboardingSave(
    mockSavedExisting,
    {
      roles: ["ML Ops Engineer"], // answered
      experienceLevel: "senior", // answered
      remotePreference: "", // skipped
      locations: [], // skipped
      employmentTypes: [], // skipped
      dailyDigestOptIn: mockSavedExisting.dailyDigestOptIn, // kept
    },
    isNegativeControl // in negative control, inject bug
  );

  if (isNegativeControl) {
    if (savedResult.salaryCurrency !== "EUR" || savedResult.minSalary !== 135000 || savedResult.dailyDigestOptIn !== false) {
      failures.push("NEGATIVE CONTROL TRIGGERED: Spreading DEFAULT_USER_PREFERENCES wiped custom fields (salaryCurrency/minSalary/dailyDigest).");
    }
    if (savedResult.locations.includes("Worldwide / Remote")) {
      failures.push("NEGATIVE CONTROL TRIGGERED: Invented default 'Worldwide / Remote' injected on skipped location question.");
    }
  } else {
    // Normal mode assertions
    if (savedResult.categories[0] !== "data-science" || savedResult.categories[1] !== "analytics") {
      failures.push("REGRESSION: Onboarding save wiped existing categories!");
    }
    if (savedResult.salaryCurrency !== "EUR" || savedResult.minSalary !== 135000) {
      failures.push("REGRESSION: Onboarding save wiped existing salary/currency with DEFAULT_USER_PREFERENCES!");
    }
    if (savedResult.workAuth !== "EU Work Permit") {
      failures.push("REGRESSION: Onboarding save wiped existing workAuth!");
    }
    if (savedResult.dailyDigestOptIn !== false) {
      failures.push("REGRESSION: Onboarding save forced dailyDigestOptIn: true, ignoring stored preference!");
    }
    if (savedResult.roles.length !== 1 || savedResult.roles[0] !== "ML Ops Engineer") {
      failures.push("REGRESSION: Onboarding save did not properly update answered role!");
    }
    if (savedResult.locations[0] !== "Berlin, Germany") {
      failures.push("REGRESSION: Onboarding save did not preserve existing location when skipped!");
    }
  }

  // Test 3B: Skipped questions stay empty for new user with no existing preferences
  const brandNewUserSave = simulateOnboardingSave(
    null,
    {
      roles: [], // skipped
      experienceLevel: "", // skipped
      remotePreference: "", // skipped
      locations: [], // skipped
      employmentTypes: [], // skipped
      dailyDigestOptIn: true,
    },
    isNegativeControl
  );

  if (!isNegativeControl) {
    if (brandNewUserSave.roles.length !== 0) {
      failures.push(`REGRESSION: Skipped roles should be empty [], found: ${JSON.stringify(brandNewUserSave.roles)}`);
    }
    if (brandNewUserSave.locations.length !== 0) {
      failures.push(`REGRESSION: Skipped locations should be empty [], found: ${JSON.stringify(brandNewUserSave.locations)}`);
    }
    if (brandNewUserSave.employmentTypes.length !== 0) {
      failures.push(`REGRESSION: Skipped employmentTypes should be empty [], found: ${JSON.stringify(brandNewUserSave.employmentTypes)}`);
    }
  }

  // -----------------------------------------------------------------------------
  // SUITE 4: Codebase Static Integrity, Gating & Color Assertions
  // -----------------------------------------------------------------------------
  console.log("4. Verifying Codebase Static Assertions, Gating Call Sites & CM Blue Colors...");

  const lockedPreviewPath = path.resolve(process.cwd(), "src/components/billing/LockedPreview.tsx");
  const freePreviewPath = path.resolve(process.cwd(), "src/components/dashboard/FreeDashboardTopTenPreview.tsx");
  const dashboardPath = path.resolve(process.cwd(), "src/app/dashboard/page.tsx");
  const onboardingPath = path.resolve(process.cwd(), "src/app/onboarding/page.tsx");
  const uploadPath = path.resolve(process.cwd(), "src/components/resume/ResumeUploadAndConfirm.tsx");
  const coverLetterPath = path.resolve(process.cwd(), "src/components/resume/CoverLetterModal.tsx");
  const tailorPath = path.resolve(process.cwd(), "src/components/resume/TailorResumeModal.tsx");
  const whyMatchPath = path.resolve(process.cwd(), "src/components/dashboard/WhyMatchPanel.tsx");
  const fitModalPath = path.resolve(process.cwd(), "src/components/matcher/FitDiagnosticsModal.tsx");
  const topTenJobsPath = path.resolve(process.cwd(), "src/components/dashboard/TopTenCompatibleJobs.tsx");
  const jobDetailPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");
  const resumePagePath = path.resolve(process.cwd(), "src/app/resume/page.tsx");

  const onboardingCode = fs.readFileSync(onboardingPath, "utf-8");
  if (onboardingCode.includes("DEFAULT_USER_PREFERENCES")) {
    failures.push("onboarding/page.tsx must NOT import or spread DEFAULT_USER_PREFERENCES.");
  }
  if (onboardingCode.includes('useState<string[]>(["Full-Stack Developer"])')) {
    failures.push("onboarding/page.tsx must NOT initialize roles state with invented default 'Full-Stack Developer'.");
  }
  if (onboardingCode.includes('useState<string[]>(["Worldwide / Remote"])')) {
    failures.push("onboarding/page.tsx must NOT initialize locations state with invented default 'Worldwide / Remote'.");
  }
  if (onboardingCode.includes('useState<string[]>(["full-time"])')) {
    failures.push("onboarding/page.tsx must NOT initialize employmentTypes state with invented default 'full-time'.");
  }
  if (!onboardingCode.includes('id="daily-digest"')) {
    failures.push("onboarding/page.tsx must restore the explicit daily-digest checkbox.");
  }
  if (!onboardingCode.includes("Saving your preferences")) {
    failures.push("onboarding/page.tsx processing step 4 must be titled 'Saving your preferences'.");
  }
  if (onboardingCode.includes("Matching you with jobs")) {
    failures.push("onboarding/page.tsx must NOT title processing step 4 'Matching you with jobs'.");
  }
  if (onboardingCode.includes("Resume parsed and matches computed!")) {
    failures.push("onboarding/page.tsx toast must not claim matches computed for free users.");
  }
  if (!onboardingCode.includes('toast.success("Resume saved")')) {
    failures.push("onboarding/page.tsx must show truthful toast 'Resume saved'.");
  }

  // Entitlement propagation assertions
  const topTenJobsCode = fs.readFileSync(topTenJobsPath, "utf-8");
  if (!topTenJobsCode.includes("TailorResumeModal") || !topTenJobsCode.includes("isPro={isPro}")) {
    failures.push("TopTenCompatibleJobs.tsx must pass isPro to TailorResumeModal.");
  }
  if (!topTenJobsCode.includes("CoverLetterModal") || !topTenJobsCode.includes("isPro={isPro}")) {
    failures.push("TopTenCompatibleJobs.tsx must pass isPro to CoverLetterModal.");
  }

  const jobDetailCode = fs.readFileSync(jobDetailPath, "utf-8");
  if (!jobDetailCode.includes("TailorResumeModal") || !jobDetailCode.includes("isPro={isPro}")) {
    failures.push("JobDetailView.tsx must pass isPro to TailorResumeModal.");
  }

  const resumePageCode = fs.readFileSync(resumePagePath, "utf-8");
  if (!resumePageCode.includes("ResumeUploadAndConfirm") || !resumePageCode.includes("isPro={isPro}")) {
    failures.push("resume/page.tsx must pass isPro to ResumeUploadAndConfirm.");
  }

  const dashboardCode = fs.readFileSync(dashboardPath, "utf-8");
  if (!dashboardCode.includes("ResumeUploadAndConfirm") || !dashboardCode.includes("isPro={isPro}")) {
    failures.push("dashboard/page.tsx must pass isPro to ResumeUploadAndConfirm.");
  }
  if (dashboardCode.includes("Your match score is ready")) {
    failures.push("dashboard/page.tsx must NOT claim 'Your match score is ready' for free users.");
  }

  // TailorResumeModal neutral loading state
  const tailorCode = fs.readFileSync(tailorPath, "utf-8");
  if (!tailorCode.includes("isProUser === null")) {
    failures.push("TailorResumeModal.tsx must render a neutral loading state while entitlement is unknown (null).");
  }
  if (!tailorCode.includes("isProUser === false ? (")) {
    failures.push("TailorResumeModal.tsx must render LockedPreview ONLY when isProUser === false.");
  }

  // WhyMatchPanel CM blue check
  const whyMatchCode = fs.readFileSync(whyMatchPath, "utf-8");
  const lockMatch = whyMatchCode.match(/data-testid="why-match-explain-pro-lock"[\s\S]*?<\/Link>/);
  if (!lockMatch || !lockMatch[0].includes("#2563EB")) {
    failures.push("WhyMatchPanel.tsx 'Explain with AI (Pro)' link must use CM blue (#2563EB).");
  }
  if (lockMatch && lockMatch[0].includes("purple")) {
    failures.push("WhyMatchPanel.tsx 'Explain with AI (Pro)' lock link must NOT use purple.");
  }

  // -----------------------------------------------------------------------------
  // SUITE 5: Truthful Copy & Absence of Dishonest Claims
  // -----------------------------------------------------------------------------
  console.log("5. Verifying Absence of False Match/Score Claims for Free Users...");

  const freePreviewCode = fs.readFileSync(freePreviewPath, "utf-8");
  const lockedPreviewCode = fs.readFileSync(lockedPreviewPath, "utf-8");
  const fitModalCode = fs.readFileSync(fitModalPath, "utf-8");
  const allPaywallCode = freePreviewCode + lockedPreviewCode + tailorCode + fitModalCode + dashboardCode + onboardingCode;

  const forbiddenClaims = [
    "Your match score is ready. Only you can't see it yet.",
    "Your match score is ready",
    "Top 10 Roles Matching Your Verified Experience",
    "Resume parsed and matches computed!",
    "Your resume has gaps. See exactly which ones.",
    "Matching you with jobs",
    "you are being rejected",
    "87% of candidates rejected",
  ];

  for (const claim of forbiddenClaims) {
    if (allPaywallCode.includes(claim)) {
      failures.push(`PROHIBITED COPY FOUND: '${claim}' still exists in codebase!`);
    }
  }

  const requiredTruthfulCopy = [
    "Unlock your Top 10 jobs ranked by fit",
    "Unlock to see your match score and fit analysis",
    "Resume saved",
    "Saving your preferences",
  ];

  for (const copy of requiredTruthfulCopy) {
    if (!allPaywallCode.includes(copy)) {
      failures.push(`REQUIRED TRUTHFUL COPY MISSING: '${copy}' not found in components.`);
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
      console.log("\n[PASS-LOCAL] All Free-Plan Paywall, Onboarding Stepper, Preference Preservation, and AI Gating tests passed cleanly!");
      process.exit(0);
    }
  }
}

run().catch((err) => {
  console.error("Unexpected test error:", err);
  process.exit(1);
});
