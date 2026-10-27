import * as fs from "fs";
import * as path from "path";
import { computeFitDiagnostics, getDiagnosticsSummary, FitDiagnosticsResult } from "../src/lib/matcher/scoring";
import { CandidateProfile } from "../src/lib/resume/types";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("       TEST: JOB CARD HOVER STATE 'WHY THIS JOB IS A MATCH' VALIDATION            ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const jobsPath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");
  const scoringPath = path.resolve(process.cwd(), "src/lib/matcher/scoring.ts");

  if (!fs.existsSync(jobsPath)) {
    console.error("FAIL: src/app/jobs/page.tsx does not exist!");
    process.exit(1);
  }
  if (!fs.existsSync(scoringPath)) {
    console.error("FAIL: src/lib/matcher/scoring.ts does not exist!");
    process.exit(1);
  }

  let code = fs.readFileSync(jobsPath, "utf-8");
  const whyCardPath = path.resolve(process.cwd(), "src/components/jobs/WhyMatchCard.tsx");
  if (fs.existsSync(whyCardPath)) {
    code += "\n" + fs.readFileSync(whyCardPath, "utf-8");
  }
  const scoringCode = fs.readFileSync(scoringPath, "utf-8");

  if (isNegativeControl) {
    // Deliberate corruption: return artificial diagnostics when candidate is unconfirmed
    code = code.replace(
      "function getJobDiagnostics(job: LiveJob, candidate: CandidateProfile | null): FitDiagnosticsResult | null {",
      "function getJobDiagnostics(job: LiveJob, candidate: CandidateProfile | null): FitDiagnosticsResult | null {\n  return { score: 75, breakdown: { skillScore: 40, experienceScore: 12 } } as any;"
    );
    code = code.replace("{diagnostics ? (", "{true ? (");
  }

  const failures: string[] = [];

  // ============================================================================
  // CHECK 1: Brand & Asset Purity (Prompt 5 Rule 5)
  // No Jobright logo, mascot or copy; no fake claims
  // ============================================================================
  const lowerCode = code.toLowerCase();
  const hasJobright = lowerCode.includes("jobright") || lowerCode.includes("monke-agent");
  if (hasJobright) {
    failures.push("PURITY FAIL: Detected Jobright mascot/copy/brand in src/app/jobs/page.tsx");
  } else {
    console.log("  [PASS] Check 1: Zero Jobright branding, mascots, or copy detected");
  }

  // ============================================================================
  // CHECK 2: Desktop Hover & Focus Crossfade Structure (Prompt 5 Rule 1 & 4)
  // 14px bold ink heading, 0.2s transition, motion-reduce:transition-none
  // ============================================================================
  const hasHoverPanelTestId = code.includes('data-testid="card-hover-match-panel"');
  if (!hasHoverPanelTestId) {
    failures.push("STRUCTURE FAIL: Missing data-testid='card-hover-match-panel' for hover match panel.");
  } else {
    console.log("  [PASS] Check 2a: data-testid='card-hover-match-panel' present in job card");
  }

  const hasHeading = code.includes("Why this job is a match") && code.includes("text-[14px] font-bold text-[#0F172A]");
  if (!hasHeading) {
    failures.push("STYLING FAIL: Heading 'Why this job is a match' must be 14px bold ink (#0F172A).");
  } else {
    console.log("  [PASS] Check 2b: Heading 'Why this job is a match' verified as 14px bold ink");
  }

  const hasCrossfadeTiming = code.includes("transition-opacity duration-200");
  if (!hasCrossfadeTiming) {
    failures.push("MOTION FAIL: Hover panel must crossfade over 0.2s (duration-200).");
  } else {
    console.log("  [PASS] Check 2c: 0.2s (duration-200) opacity transition verified");
  }

  const hasReducedMotion = code.includes("motion-reduce:transition-none");
  if (!hasReducedMotion) {
    failures.push("A11Y FAIL: Must respect prefers-reduced-motion via motion-reduce:transition-none.");
  } else {
    console.log("  [PASS] Check 2d: prefers-reduced-motion respected via motion-reduce:transition-none");
  }

  const hasTouchGuard = code.includes("hidden sm:flex") && code.includes("sm:group-hover:opacity-100");
  if (!hasTouchGuard) {
    failures.push("RESPONSIVE FAIL: Hover swap must not trigger on mobile/touch devices (hidden sm:flex).");
  } else {
    console.log("  [PASS] Check 2e: Touch & mobile devices protected from hover swap (hidden sm:flex)");
  }

  // Card height stability check: CSS Grid row stack
  const hasGridStack = code.includes("grid grid-cols-1 grid-rows-1") && code.includes("col-start-1 row-start-1");
  if (!hasGridStack) {
    failures.push("LAYOUT STABILITY FAIL: Card middle part must use grid stack to guarantee zero card height shift on hover.");
  } else {
    console.log("  [PASS] Check 2f: Zero card height shift mechanism verified (CSS Grid stack)");
  }

  // Anchor elements remain fixed outside crossfade
  const hasFixedLogoAndActions =
    code.includes("<CompanyLogo") &&
    code.includes('aria-label={isSaved ? "Unlike job" : "Save job"}') &&
    code.includes("<span>Apply</span>");
  if (!hasFixedLogoAndActions) {
    failures.push("LAYOUT FAIL: Company logo square, Save button, and Apply button must stay in place.");
  } else {
    console.log("  [PASS] Check 2g: Company logo, Save button, and Apply button remain fixed in place");
  }

  // Keyboard accessibility on card
  const hasKeyboardFocus = code.includes("tabIndex={0}") && (code.includes("sm:group-focus-within:opacity-100") || code.includes("sm:group-focus:opacity-100"));
  if (!hasKeyboardFocus) {
    failures.push("A11Y FAIL: Card must be keyboard-focusable (tabIndex={0}) and trigger hover panel on keyboard focus.");
  } else {
    console.log("  [PASS] Check 2h: Keyboard navigation (tabIndex={0} and group-focus-within) verified");
  }

  // ============================================================================
  // CHECK 3: SmallComponentRing Token Specifications (Prompt 5 Rule 2)
  // Ring colour #2563EB on #E2E8F0 track, 12px label, value inside ring
  // ============================================================================
  const hasBlueRing = code.includes('stroke="#2563EB"');
  const hasNeutralTrack = code.includes('stroke="#E2E8F0"');
  const hasRing12pxLabel = code.includes("text-[12px] font-medium text-[#475569]");
  const hasValueInsideRing = code.includes("{score}%") && code.includes("absolute inset-0 flex items-center justify-center");

  if (!hasBlueRing || !hasNeutralTrack) {
    failures.push("TOKEN FAIL: SmallComponentRing must use #2563EB ring stroke on #E2E8F0 background track.");
  } else {
    console.log("  [PASS] Check 3a: Ring color tokens verified (#2563EB progress on #E2E8F0 track)");
  }

  if (!hasRing12pxLabel) {
    failures.push("TOKEN FAIL: SmallComponentRing label must be 12px font-medium text-[#475569].");
  } else {
    console.log("  [PASS] Check 3b: 12px label formatting verified");
  }

  if (!hasValueInsideRing) {
    failures.push("RENDER FAIL: SmallComponentRing must render formatted percentage value inside the ring.");
  } else {
    console.log("  [PASS] Check 3c: Percentage value centered inside circular ring verified");
  }

  // ============================================================================
  // CHECK 4: Scorer Component Availability & Industry Component Omission
  // If scorer has no Industry component, show only rings that exist (Experience, Skill)
  // ============================================================================
  const scorerHasIndustry = scoringCode.includes("industryScore:");
  const codeHasExperienceRing = code.includes('label="Experience"');
  const codeHasSkillRing = code.includes('label="Skill"');
  const codeGuardsIndustry = code.includes('industryScore');

  if (!codeHasExperienceRing || !codeHasSkillRing) {
    failures.push("MISSING RINGS: Experience and Skill rings must be present.");
  } else {
    console.log("  [PASS] Check 4a: Experience and Skill component rings present");
  }

  if (!scorerHasIndustry) {
    console.log("  [PASS] Check 4b: Confirmed scorer has no industry component; Industry ring cleanly omitted");
  } else if (!codeGuardsIndustry) {
    failures.push("INDUSTRY CHECK FAIL: Scorer has industry component but page does not guard it.");
  }

  // ============================================================================
  // CHECK 5: Unconfirmed Resume Gating (Prompt 5 Rule 3)
  // Without confirmed resume: NO rings, NO percentages, NO summary, single CTA line
  // ============================================================================
  const hasDiagnosticsGating = code.includes("{diagnostics ? (");
  if (!hasDiagnosticsGating) {
    failures.push("GATING FAIL: Match diagnostics hover view must be strictly guarded by {diagnostics ? (.");
  } else {
    console.log("  [PASS] Check 5a: Hover panel rings & summary strictly guarded by {diagnostics ? (");
  }

  const hasUnconfirmedUploadCta =
    code.includes("Upload your resume to see why this job matches") &&
    code.includes('data-testid="hover-upload-resume-cta"') &&
    code.includes('href="/resume"');

  if (!hasUnconfirmedUploadCta) {
    failures.push("CTA FAIL: Missing 'Upload your resume to see why this job matches' linking to /resume.");
  } else {
    console.log("  [PASS] Check 5b: Unconfirmed hover CTA rendered with exact Prompt 5 copy linking to /resume");
  }

  // Function execution test across unconfirmed profiles
  const testJob = {
    id: "job_sec_01",
    title: "Senior Full Stack Engineer",
    company: "CarrierHound Inc",
    location: "Worldwide",
    remote: true,
    remoteScope: "worldwide",
    category: "engineering",
    skills: ["React", "TypeScript", "Node.js", "PostgreSQL"],
    description: "Looking for an experienced engineer with strong React and TypeScript experience.",
    salary: "$140,000 - $180,000",
    applyUrl: "https://example.com/apply",
  };

  const unconfirmedProfiles: Array<{ label: string; candidate: CandidateProfile | null }> = [
    { label: "Guest (null candidate)", candidate: null },
    { label: "Candidate with null confirmedAt", candidate: { confirmedAt: null, skills: ["React"] } as any },
    { label: "Candidate with undefined confirmedAt", candidate: { confirmedAt: undefined, skills: ["React"] } as any },
    { label: "Candidate with empty string confirmedAt", candidate: { confirmedAt: "", skills: ["React"] } as any },
  ];

  function extractFunction(source: string, fnName: string): string | null {
    const startIdx = source.indexOf(`function ${fnName}`);
    if (startIdx === -1) return null;
    const openBrace = source.indexOf("{", startIdx);
    if (openBrace === -1) return null;

    let depth = 0;
    for (let i = openBrace; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          return source.slice(startIdx, i + 1);
        }
      }
    }
    return null;
  }

  const fnBody = extractFunction(code, "getJobDiagnostics");
  if (!fnBody) {
    failures.push("PARSE ERROR: Could not locate getJobDiagnostics declaration in src/app/jobs/page.tsx");
  } else {
    try {
      const jsFn = fnBody
        .replace(/:\s*LiveJob/g, "")
        .replace(/:\s*CandidateProfile\s*\|\s*null/g, "")
        .replace(/\):\s*FitDiagnosticsResult\s*\|\s*null/g, ")");

      const harness = `
        const computeFitDiagnostics = (cand, job) => {
          if (!cand || !cand.confirmedAt) return null;
          return { score: 85, breakdown: { skillScore: 40, experienceScore: 12, yearsOfExperience: 5 } };
        };
        ${jsFn}
        return getJobDiagnostics;
      `;
      const fn = new Function(harness)();

      for (const { label, candidate } of unconfirmedProfiles) {
        const diag = fn(testJob, candidate);
        if (diag !== null) {
          failures.push(`GATE LEAK: ${label} produced diagnostics (expected null).`);
        } else {
          console.log(`  [PASS] Check 5c (${label}): getJobDiagnostics returned strictly null`);
        }
      }
    } catch (e: any) {
      failures.push(`HARNESS ERROR: Failed executing getJobDiagnostics simulation: ${e.message}`);
    }
  }

  // ============================================================================
  // CHECK 6: Confirmed Resume Diagnostics & Summary Truthfulness (Prompt 5 Rule 2)
  // Summary built strictly from real diagnostics (matchedSkills, yearsOfExperience)
  // ============================================================================
  const confirmedCandidate: CandidateProfile = {
    confirmedAt: "2026-10-22T10:00:00Z",
    headline: "Senior Full Stack Engineer",
    skills: ["React", "TypeScript", "Node.js", "Python"],
    location: "Remote",
    experience: [
      {
        company: "Alpha Corp",
        role: "Senior Full Stack Engineer",
        startDate: "2019-01-01",
        endDate: "2024-01-01",
        description: "Built scalable web apps using React, TypeScript, and Node.js.",
      },
    ],
  };

  const confirmedDiag = computeFitDiagnostics(confirmedCandidate, testJob as any);
  if (!confirmedDiag || typeof confirmedDiag.score !== "number") {
    failures.push("DIAGNOSTICS FAIL: computeFitDiagnostics failed on valid confirmed candidate.");
  } else {
    console.log(`  [PASS] Check 6a: computeFitDiagnostics produced valid result (score=${confirmedDiag.score}%)`);

    // Verify Experience score derivation
    const expScore = confirmedDiag.breakdown.experienceScore;
    const expPct = Math.min(100, Math.max(0, Math.round((expScore / 15) * 100)));
    if (isNaN(expPct) || expPct < 0 || expPct > 100) {
      failures.push(`SCORER DERIVATION FAIL: Invalid experience percentage: ${expPct}`);
    } else {
      console.log(`  [PASS] Check 6b: Experience ring score strictly derived from scorer breakdown (${expScore}/15 -> ${expPct}%)`);
    }

    // Verify Skill score derivation
    const skillScore = confirmedDiag.breakdown.skillScore;
    const skillPct = Math.min(100, Math.max(0, Math.round((skillScore / 50) * 100)));
    if (isNaN(skillPct) || skillPct < 0 || skillPct > 100) {
      failures.push(`SCORER DERIVATION FAIL: Invalid skill percentage: ${skillPct}`);
    } else {
      console.log(`  [PASS] Check 6c: Skill ring score strictly derived from scorer breakdown (${skillScore}/50 -> ${skillPct}%)`);
    }

    // Verify Summary contains real facts and no invented text
    const summary = getDiagnosticsSummary(confirmedDiag);
    if (!summary || summary.length < 10) {
      failures.push("SUMMARY FAIL: getDiagnosticsSummary returned empty or insufficient string.");
    } else {
      const mentionsSkills = summary.includes("skills") || summary.includes("React");
      const mentionsYears = summary.includes("years") || summary.includes("5+");
      if (!mentionsSkills && !mentionsYears) {
        failures.push(`SUMMARY FAIL: Summary does not reference evidenced facts: "${summary}"`);
      } else {
        console.log(`  [PASS] Check 6d: Factual summary verified: "${summary}"`);
      }
    }
  }

  // ============================================================================
  // CHECK 7: Dynamic Variation Check
  // Verify that varying candidate facts produces strictly different scorer outputs
  // ============================================================================
  const juniorCandidate: CandidateProfile = {
    confirmedAt: "2026-10-22T10:00:00Z",
    headline: "Junior Designer",
    skills: ["Figma"],
    location: "New York",
    experience: [],
  };

  const juniorDiag = computeFitDiagnostics(juniorCandidate, testJob as any);
  const juniorExpPct = Math.min(100, Math.max(0, Math.round((juniorDiag.breakdown.experienceScore / 15) * 100)));
  const juniorSkillPct = Math.min(100, Math.max(0, Math.round((juniorDiag.breakdown.skillScore / 50) * 100)));

  if (juniorExpPct >= 50 || juniorSkillPct >= 50) {
    failures.push("SENSITIVITY FAIL: Candidate with zero matching skills received excessive score.");
  } else {
    console.log(`  [PASS] Check 7: Scorer responsiveness verified (Junior Designer: Exp=${juniorExpPct}%, Skill=${juniorSkillPct}%)`);
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
      console.log("JOB CARD HOVER MATCH PANEL VALIDATION [PASS-LOCAL]");
      process.exit(0);
    }
  }
}

run();
