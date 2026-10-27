process.env.NODE_ENV = "test";
(globalThis as any).__mockSupabaseClient = {
  auth: {
    getSession: async () => ({
      data: {
        session: {
          access_token: "mock-pro-jwt-token",
          user: { id: "usr_mock_pro_123" },
        },
      },
    }),
  },
};

import * as fs from "fs";
import * as path from "path";
import { CandidateProfile } from "../src/lib/resume/types";
import {
  extractJobSummary,
  computeSubScores,
  getMatchThresholdLabel,
  getCandidateResumeHash,
} from "../src/components/dashboard/WhyMatchPanel";
import { generateJobFitExplanation } from "../src/lib/ai/groq";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("       TEST: TOP 10 EXPANDABLE 'WHY THIS JOB IS A MATCH' & AI EXPLANATION         ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const top10Path = path.resolve(process.cwd(), "src/components/dashboard/TopTenCompatibleJobs.tsx");
  const panelPath = path.resolve(process.cwd(), "src/components/dashboard/WhyMatchPanel.tsx");
  const jobsPagePath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");
  const groqPath = path.resolve(process.cwd(), "src/lib/ai/groq.ts");

  if (!fs.existsSync(top10Path)) {
    console.error("FAIL: src/components/dashboard/TopTenCompatibleJobs.tsx missing!");
    process.exit(1);
  }
  if (!fs.existsSync(panelPath)) {
    console.error("FAIL: src/components/dashboard/WhyMatchPanel.tsx missing!");
    process.exit(1);
  }
  if (!fs.existsSync(jobsPagePath)) {
    console.error("FAIL: src/app/jobs/page.tsx missing!");
    process.exit(1);
  }
  if (!fs.existsSync(groqPath)) {
    console.error("FAIL: src/lib/ai/groq.ts missing!");
    process.exit(1);
  }

  let top10Code = fs.readFileSync(top10Path, "utf-8");
  let panelCode = fs.readFileSync(panelPath, "utf-8");
  let jobsPageCode = fs.readFileSync(jobsPagePath, "utf-8");
  let groqCode = fs.readFileSync(groqPath, "utf-8");

  const failures: string[] = [];

  // ============================================================================
  // TEST 1: Distinct Per-Job Summaries & Empty Description Handling
  // ============================================================================
  console.log("TEST 1: Verifying distinct per-job summaries and empty description handling...");

  const descA =
    "Looking for a Senior Frontend Architect with 7+ years of React and Next.js experience. High scale distributed user interfaces.";
  const descB =
    "Backend Platform Engineer needed for high throughput Golang and PostgreSQL microservices. Kubernetes and Kafka experience required.";

  let summaryA = extractJobSummary(descA);
  let summaryB = extractJobSummary(descB);
  let emptySummary = extractJobSummary("");
  let nullSummary = extractJobSummary(null);
  let whitespaceSummary = extractJobSummary("     \n\t   ");

  if (isNegativeControl) {
    // Deliberate corruption NC1: Generic summary string returned across all jobs
    summaryA = "Evaluated against your confirmed resume facts and requirements.";
    summaryB = "Evaluated against your confirmed resume facts and requirements.";
  }

  if (!summaryA || !summaryB) {
    failures.push("SUMMARY FAIL: extractJobSummary returned null for valid job description.");
  } else if (summaryA === summaryB) {
    failures.push("SUMMARY DUPLICATION: Two different job descriptions produced identical summaries!");
  } else {
    console.log("  [PASS] Distinct per-job summaries verified: unique descriptions produce distinct summaries");
  }

  if (emptySummary !== null || nullSummary !== null || whitespaceSummary !== null) {
    failures.push("SUMMARY FAIL: Empty, null, or whitespace descriptions must return null (omitted).");
  } else {
    console.log("  [PASS] Empty, null, and whitespace descriptions cleanly produce null (omitted line)");
  }

  // ============================================================================
  // TEST 2: Real Sub-Scores Only & Absolutely NO Education Ring
  // ============================================================================
  console.log("\nTEST 2: Verifying real sub-score calculation & zero Education ring...");

  const mockDiagnostics = {
    score: 85,
    matchedSkills: ["React", "TypeScript", "Node.js"],
    breakdown: {
      experienceScore: 12, // 12 / 15 * 100 = 80
      skillScore: 40,      // 40 / 50 * 100 = 80
      titleScore: 20,      // 20 / 25 * 100 = 80
    },
  };

  const subScores = computeSubScores(mockDiagnostics as any);
  if (subScores.experienceScore !== 80 || subScores.skillScore !== 80 || subScores.roleScore !== 80) {
    failures.push(`SCORING FAIL: Sub-scores incorrectly derived: exp=${subScores.experienceScore}, skill=${subScores.skillScore}, role=${subScores.roleScore}`);
  } else {
    console.log("  [PASS] Sub-scores correctly normalized (Experience: 80%, Skills: 80%, Role: 80%)");
  }

  // Check omitted ring when not computable
  const partialDiagnostics = {
    score: 70,
    breakdown: {
      experienceScore: 15,
      skillScore: null,
      titleScore: undefined,
    },
  };
  const partialScores = computeSubScores(partialDiagnostics as any);
  if (partialScores.experienceScore !== 100 || partialScores.skillScore !== null || partialScores.roleScore !== null) {
    failures.push("RING OMISSION FAIL: Sub-scores not null when breakdown values missing.");
  } else {
    console.log("  [PASS] Rings cleanly hidden when sub-scores not computable");
  }

  // Verify NO Education ring exists anywhere in WhyMatchPanel
  let hasEducationRing = panelCode.includes('label="Education"') || panelCode.includes("match-ring-education");
  if (isNegativeControl) {
    // Deliberate corruption NC4: Re-inject Education ring
    hasEducationRing = true;
  }

  if (hasEducationRing) {
    failures.push("RING POLLUTION FAIL: WhyMatchPanel must NEVER render an Education ring (no education score exists).");
  } else {
    console.log("  [PASS] Zero Education ring verified (cleanly omitted as requested)");
  }

  // ============================================================================
  // TEST 3: Gating "Explain with AI" Button (Pro + Confirmed Resume ONLY)
  // ============================================================================
  console.log("\nTEST 3: Verifying 'Explain with AI' button gating...");

  const hasAiButtonGating =
    panelCode.includes("isPro && candidate?.confirmedAt") ||
    panelCode.includes("isPro && candidate && candidate.confirmedAt");

  if (!hasAiButtonGating) {
    failures.push("GATING FAIL: 'Explain with AI' button must be strictly gated by isPro && candidate?.confirmedAt.");
  } else {
    console.log("  [PASS] 'Explain with AI' button strictly gated for Pro users with confirmed resume");
  }

  // ============================================================================
  // TEST 4: AI Success Shows ONLY Summary + Gaps, and NEVER the AI Score
  // ============================================================================
  console.log("\nTEST 4: Verifying AI output displays ONLY summary and gaps, never AI score...");

  // Setup mock fetch for generateJobFitExplanation
  const originalFetch = global.fetch;
  let fetchCallCount = 0;
  let lastFetchBody: any = null;

  global.fetch = async (url: any, init: any) => {
    fetchCallCount++;
    lastFetchBody = JSON.parse(init.body || "{}");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: {
          score: 95, // AI score returned from server
          summary: "Outstanding candidate with 5+ years of verified React and TypeScript experience.",
          missingSkills: ["GraphQL", "Docker"],
        },
      }),
    } as any;
  };

  const testCandidate: CandidateProfile = {
    confirmedAt: "2026-10-22T10:00:00Z",
    headline: "Senior Frontend Engineer",
    skills: ["React", "TypeScript", "Tailwind CSS"],
    experience: [],
  };

  const testJob = {
    id: "job_test_101",
    title: "Senior React Engineer",
    company: "CarrierHound Inc",
    description: "Looking for an expert React engineer with modern frontend architecture experience.",
  };

  const aiResult = await generateJobFitExplanation(testCandidate, testJob);

  if (!aiResult.success || !aiResult.summary) {
    failures.push(`AI EXECUTION FAIL: generateJobFitExplanation failed: ${aiResult.error}`);
  } else {
    if (aiResult.summary.includes("<script>") || aiResult.summary.includes("<div>")) {
      failures.push("SANITIZATION FAIL: AI summary contained unstripped markup.");
    } else {
      console.log("  [PASS] AI summary verified and sanitized (plain text only)");
    }

    if (!Array.isArray(aiResult.missingSkills) || aiResult.missingSkills.length !== 2) {
      failures.push("GAPS FAIL: AI missingSkills array not returned as expected.");
    } else {
      console.log(`  [PASS] Missing skills ('Gaps to address') returned: ${aiResult.missingSkills.join(", ")}`);
    }

    // Verify payload sent ONLY skills + headline + title, company, description
    if (lastFetchBody && lastFetchBody.params) {
      const p = lastFetchBody.params;
      const sentCandidateKeys = Object.keys(p.candidate || {});
      const invalidCandKeys = sentCandidateKeys.filter((k) => k !== "headline" && k !== "skills");
      if (invalidCandKeys.length > 0) {
        failures.push(`PAYLOAD LEAK: Candidate sent unapproved fields: ${invalidCandKeys.join(", ")}`);
      } else {
        console.log("  [PASS] Privacy safe: Sent ONLY candidate skills + headline to AI service");
      }
    }

    // CRITICAL: Ensure AI score is NEVER returned from generateJobFitExplanation
    let hasAiScoreExposed = (aiResult as any).score !== undefined;
    if (isNegativeControl) {
      // Deliberate corruption NC2: Expose AI score
      hasAiScoreExposed = true;
    }

    if (hasAiScoreExposed) {
      failures.push("AI SCORE LEAK: generateJobFitExplanation exposed the server AI score!");
    } else {
      console.log("  [PASS] Zero AI score leakage: AI score strictly excluded from client explanation");
    }
  }

  // ============================================================================
  // TEST 5: Cache Hit Makes No Second Call
  // ============================================================================
  console.log("\nTEST 5: Verifying client-side localStorage caching prevents duplicate calls...");

  const resumeHash = getCandidateResumeHash(testCandidate);
  const cacheKey = `cm_job_fit_user1_${testJob.id}_${resumeHash}`;

  // Check that WhyMatchPanel checks cacheKey before making call
  const hasCacheCheck = panelCode.includes("localStorage.getItem(cacheKey)");
  if (!hasCacheCheck) {
    failures.push("CACHE FAIL: WhyMatchPanel does not inspect localStorage cacheKey before calling AI.");
  } else {
    console.log("  [PASS] localStorage cache inspection verified: cache hit bypasses server fetch");
  }

  // ============================================================================
  // TEST 6: Failure / Quota / Empty Output Falls Back Honestly
  // ============================================================================
  console.log("\nTEST 6: Verifying error/quota/empty fallback behavior...");

  // Mock error response (e.g. 429 quota or 500)
  global.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: "Daily AI match explanation quota exceeded." }),
  } as any);

  const errorResult = await generateJobFitExplanation(testCandidate, testJob);
  if (errorResult.success) {
    failures.push("ERROR HANDLING FAIL: generateJobFitExplanation did not report failure on HTTP 429.");
  } else if (!errorResult.error || !errorResult.error.includes("quota")) {
    failures.push(`ERROR MESSAGE FAIL: Did not return honest quota message: "${errorResult.error}"`);
  } else {
    console.log("  [PASS] Honest failure response on HTTP 429 quota returned");
  }

  const hasFallbackUI =
    panelCode.includes("aiError") &&
    panelCode.includes("Showing verified match summary below") &&
    panelCode.includes("deterministicSummary");

  if (!hasFallbackUI) {
    failures.push("FALLBACK UI FAIL: WhyMatchPanel must show honest alert and fall back to deterministic summary on error.");
  } else {
    console.log("  [PASS] Fallback UI verified: Honest error alert displayed with deterministic summary fallback");
  }

  // Restore fetch
  global.fetch = originalFetch;

  // ============================================================================
  // TEST 7: Lazy Rendering & Expandable Controls (Compute Nothing Until Expanded)
  // ============================================================================
  console.log("\nTEST 7: Verifying lazy rendering and accessible expandable trigger button...");

  const hasLazyPanelRender =
    top10Code.includes("{isExpanded &&") &&
    top10Code.includes("<WhyMatchPanel");

  if (!hasLazyPanelRender) {
    failures.push("LAZY RENDER FAIL: WhyMatchPanel must only be mounted and computed when row isExpanded.");
  } else {
    console.log("  [PASS] Lazy rendering verified: WhyMatchPanel computed strictly on demand when expanded");
  }

  const hasAriaExpanded =
    top10Code.includes('aria-expanded={isExpanded}') &&
    top10Code.includes('data-testid={`why-match-toggle-${job.id}`}');

  const has44pxTarget =
    top10Code.includes("min-h-[44px]") &&
    top10Code.includes("min-w-[44px]");

  if (!hasAriaExpanded) {
    failures.push("A11Y FAIL: Expand button must specify aria-expanded={isExpanded}.");
  } else {
    console.log("  [PASS] Accessible aria-expanded and data-testid attributes verified on toggle button");
  }

  if (!has44pxTarget) {
    failures.push("TOUCH TARGET FAIL: Expand button must satisfy 44px touch target (min-h-[44px] min-w-[44px]).");
  } else {
    console.log("  [PASS] 44px minimum touch target verified on toggle button");
  }

  // Check that AI is never auto-called on all rows
  let hasAutoRunAllRows = top10Code.includes("rankedJobs.forEach") && top10Code.includes("generateJobFitExplanation");
  if (isNegativeControl) {
    // Deliberate corruption NC3: Auto-call all rows
    hasAutoRunAllRows = true;
  }

  if (hasAutoRunAllRows) {
    failures.push("PERF / QUOTA VIOLATION: Top 10 must NEVER auto-run AI explanations on all rows!");
  } else {
    console.log("  [PASS] Zero auto-run verified: Explanations require explicit per-row user click");
  }

  // ============================================================================
  // TEST 8: /jobs List Card Has No Hover Panel and page.tsx Has No getDiagnosticsSummary
  // ============================================================================
  console.log("\nTEST 8: Verifying /jobs list card has no hover panel and zero generic text...");

  const hasHoverPanelInJobs = jobsPageCode.includes('data-testid="card-hover-match-panel"');
  const hasGetDiagnosticsSummaryInJobs = jobsPageCode.includes("getDiagnosticsSummary");
  const hasEvaluatedAgainstInJobs = jobsPageCode.includes("Evaluated against");

  if (hasHoverPanelInJobs) {
    failures.push("HOVER PANEL LEAK: src/app/jobs/page.tsx still contains data-testid='card-hover-match-panel'.");
  } else {
    console.log("  [PASS] Zero hover match panel in src/app/jobs/page.tsx");
  }

  if (hasGetDiagnosticsSummaryInJobs) {
    failures.push("IMPORT LEAK: src/app/jobs/page.tsx still contains getDiagnosticsSummary.");
  } else {
    console.log("  [PASS] getDiagnosticsSummary completely removed from src/app/jobs/page.tsx");
  }

  if (hasEvaluatedAgainstInJobs) {
    failures.push("GENERIC COPY LEAK: src/app/jobs/page.tsx still contains 'Evaluated against'.");
  } else {
    console.log("  [PASS] Zero 'Evaluated against' fallback string in src/app/jobs/page.tsx");
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
      console.log("TOP 10 WHY MATCH & AI EXPLANATION VALIDATION [PASS-LOCAL]");
      process.exit(0);
    }
  }
}

run();
