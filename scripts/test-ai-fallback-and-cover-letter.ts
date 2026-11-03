/**
 * scripts/test-ai-fallback-and-cover-letter.ts
 *
 * Verification suite for:
 * 1) Deterministic cover letter:
 *    - Strict grounding in parsed resume duties/facts only (never invents responsibilities).
 *    - Omits duty sentence when a role has no parsed duties.
 *    - Fixes "a Intern" to correct indefinite article ("an Intern").
 *    - Keeps "Grounded in verified facts" badge text when validated.
 * 2) AI enhance call failure handling:
 *    - Displays small neutral notice (data-testid="cover-letter-ai-notice") instead of failing silently.
 * 3) Leak neutralization for user-facing messages:
 *    - Replaces every user-facing message exposing GROQ_API_KEY in tailor modal,
 *      error toast, and Why match banner with:
 *      "AI is temporarily unavailable. Your verified rules-based version is ready."
 *    - Keeps server-side logs and server responses unchanged.
 * 4) Negative control flag support (--negative-control).
 */

process.env.NODE_ENV = "test";

import * as fs from "fs";
import * as path from "path";
import {
  generateTailoredCoverLetter,
  getIndefiniteArticle,
} from "../src/lib/resume/tailor";
import {
  GENERIC_AI_UNAVAILABLE_MESSAGE,
  sanitizeUserFacingAiError,
  generateGroqTailoredCoverLetter,
  generateAiTailoredResume,
  generateJobFitExplanation,
} from "../src/lib/ai/groq";
import { CandidateProfile } from "../src/lib/resume/types";

const isNegativeControl = process.argv.includes("--negative-control");

async function main() {
  console.log("================================================================================");
  console.log("      TEST: AI FALLBACK, GROQ KEY LEAK PREVENTION & COVER LETTER GROUNDING      ");
  console.log("================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const failures: string[] = [];

  // ============================================================================
  // TEST 1: Indefinite article helper ("a" vs "an")
  // ============================================================================
  console.log("TEST 1: getIndefiniteArticle grammar resolution...");
  const articleTests = [
    { input: "Intern", expected: "an" },
    { input: "Engineering Intern", expected: "an" },
    { input: "Software Engineer", expected: "a" },
    { input: "Architect", expected: "an" },
    { input: "Product Manager", expected: "a" },
    { input: "iOS Developer", expected: "an" },
    { input: "Operations Lead", expected: "an" },
  ];

  for (const { input, expected } of articleTests) {
    const actual = getIndefiniteArticle(input);
    if (actual !== expected) {
      failures.push(`Article mismatch for "${input}": expected "${expected}", got "${actual}"`);
    }
  }

  if (isNegativeControl) {
    // Deliberately fail on negative control
    failures.push("NEGATIVE CONTROL: Simulated failure to verify test runner exits non-zero.");
  }

  // ============================================================================
  // TEST 2: Deterministic cover letter with & without parsed duties
  // ============================================================================
  console.log("TEST 2: Cover letter duty grounding & 'a/an Intern' validation...");

  const baseJob = {
    title: "Software Engineer",
    company: "Acme Cloud",
    description: "Looking for an engineer to help in building reliable web platforms.",
  };

  // Case A: Role with parsed duties
  const candidateWithDuties: CandidateProfile = {
    name: "Alex Doe",
    email: "alex@example.com",
    headline: "Frontend Specialist",
    skills: ["TypeScript", "React", "Next.js"],
    experience: [
      {
        role: "Intern",
        company: "VentureTech",
        startDate: "2023",
        endDate: "2024",
        bullets: [
          "Developed automated UI test suites reducing regression cycle time.",
        ],
      },
    ],
  };

  const letterWithDuties = generateTailoredCoverLetter(candidateWithDuties, baseJob);
  const textA = letterWithDuties.fullText;

  // Verify correct article "an Intern"
  if (!textA.includes("as an Intern at VentureTech")) {
    failures.push(`Expected "as an Intern at VentureTech" in cover letter, got: ${textA}`);
  }
  if (textA.includes("as a Intern")) {
    failures.push(`Found ungrammatical "as a Intern" in cover letter!`);
  }

  // Verify duty sentence is present and sourced strictly from bullets
  if (!textA.includes("my responsibilities included developed automated UI test suites")) {
    failures.push(`Duty sentence missing or not grounded in parsed bullets: ${textA}`);
  }

  // Verify isValidated is true
  if (!letterWithDuties.isValidated) {
    failures.push("Cover letter with verified duties should have isValidated = true");
  }

  // Case B: Role without parsed duties (empty bullets)
  const candidateNoDuties: CandidateProfile = {
    name: "Jordan Smith",
    email: "jordan@example.com",
    headline: "Developer",
    skills: ["Python", "Docker"],
    experience: [
      {
        role: "Intern",
        company: "LegacyCorp",
        startDate: "2022",
        endDate: "2023",
        bullets: [],
      },
    ],
  };

  const letterNoDuties = generateTailoredCoverLetter(candidateNoDuties, baseJob);
  const textB = letterNoDuties.fullText;

  // Duty sentence must be completely omitted
  if (textB.includes("my responsibilities included")) {
    failures.push(`Duty sentence was not omitted when role has empty bullets: ${textB}`);
  }
  if (!textB.includes("In my work as an Intern at LegacyCorp, my evidenced strengths include")) {
    failures.push(`Expected clean omitted-duty sentence format in cover letter B: ${textB}`);
  }
  // Ensure no fabricated domain duties (e.g., "building high-throughput APIs")
  if (textB.includes("focused on building high-throughput") || textB.includes("architecting scalable")) {
    failures.push(`Found fabricated domain duties in letter without bullets: ${textB}`);
  }

  // Case C: Fresher with 0 experience
  const fresherCandidate: CandidateProfile = {
    name: "Sam Lee",
    email: "sam@example.com",
    headline: "CS Graduate",
    skills: ["Java", "SQL"],
    experience: [],
  };

  const letterFresher = generateTailoredCoverLetter(fresherCandidate, baseJob);
  const textC = letterFresher.fullText;

  if (textC.includes("at VentureTech") || textC.includes("as a ") || textC.includes("as an ")) {
    failures.push(`Fresher letter fabricated past role or company: ${textC}`);
  }
  if (!textC.includes("Through rigorous coursework, hands-on projects, and dedicated skill mastery")) {
    failures.push(`Fresher letter missing standard coursework foundation: ${textC}`);
  }

  // ============================================================================
  // TEST 3: Neutral notice on AI enhance failure in CoverLetterModal.tsx
  // ============================================================================
  console.log("TEST 3: CoverLetterModal neutral notice & badge retention...");

  const coverModalPath = path.resolve(process.cwd(), "src/components/resume/CoverLetterModal.tsx");
  const coverModalCode = fs.readFileSync(coverModalPath, "utf-8");

  // Must have data-testid="cover-letter-ai-notice"
  if (!coverModalCode.includes('data-testid="cover-letter-ai-notice"')) {
    failures.push("CoverLetterModal missing data-testid='cover-letter-ai-notice' for AI failure notice");
  }

  // Must have small neutral styling: bg-slate-50 border-slate-200 text-slate-700 text-xs
  if (!coverModalCode.includes("bg-slate-50") || !coverModalCode.includes("text-slate-700")) {
    failures.push("CoverLetterModal notice does not use small neutral slate styling");
  }

  // Must retain "Grounded in verified facts" badge
  if (!coverModalCode.includes("Grounded in verified facts")) {
    failures.push("CoverLetterModal missing 'Grounded in verified facts' badge text");
  }

  // Must manage aiNotice state
  if (!coverModalCode.includes("aiNotice") || !coverModalCode.includes("setAiNotice")) {
    failures.push("CoverLetterModal does not manage aiNotice state");
  }

  // ============================================================================
  // TEST 4: Leak neutralization - sanitizeUserFacingAiError
  // ============================================================================
  console.log("TEST 4: sanitizeUserFacingAiError sanitization logic...");

  const leakInputs = [
    "Missing required environment variable: GROQ_API_KEY",
    "Server error: missing GROQ_API_KEY configuration",
    "Invalid GROQ_API_KEYS provided",
    "GROQ_API_KEY is not defined",
    "Error with process.env.API_KEY",
    "SECRET_KEY undefined in execution context",
  ];

  for (const input of leakInputs) {
    const sanitized = sanitizeUserFacingAiError(input);
    if (sanitized !== GENERIC_AI_UNAVAILABLE_MESSAGE) {
      failures.push(`Failed to neutralize env var in "${input}": got "${sanitized}"`);
    }
    if (sanitized.includes("GROQ_API_KEY") || sanitized.includes("KEY")) {
      failures.push(`Sanitized output still exposes sensitive keyword in: "${sanitized}"`);
    }
  }

  // Legitimate user errors (e.g. quota, auth) should retain their message
  const legitimateErrors = [
    "Daily AI match explanation quota exceeded.",
    "Authentication required to generate AI tailored resume.",
    "CareerMonke Pro subscription required for AI resume tailoring.",
  ];

  for (const input of legitimateErrors) {
    const sanitized = sanitizeUserFacingAiError(input);
    if (sanitized !== input) {
      failures.push(`Legitimate user error was mutated: expected "${input}", got "${sanitized}"`);
    }
  }

  // ============================================================================
  // TEST 5: Inspection of TailorResumeModal.tsx & WhyMatchPanel.tsx
  // ============================================================================
  console.log("TEST 5: UI component inspection for GROQ_API_KEY leaks...");

  const tailorModalPath = path.resolve(process.cwd(), "src/components/resume/TailorResumeModal.tsx");
  const tailorModalCode = fs.readFileSync(tailorModalPath, "utf-8");

  const whyMatchPath = path.resolve(process.cwd(), "src/components/dashboard/WhyMatchPanel.tsx");
  const whyMatchCode = fs.readFileSync(whyMatchPath, "utf-8");

  // Check TailorResumeModal for sanitization
  if (!tailorModalCode.includes("sanitizeUserFacingAiError")) {
    failures.push("TailorResumeModal.tsx does not call sanitizeUserFacingAiError on error messages");
  }
  if (!tailorModalCode.includes("GENERIC_AI_UNAVAILABLE_MESSAGE")) {
    failures.push("TailorResumeModal.tsx does not reference GENERIC_AI_UNAVAILABLE_MESSAGE");
  }

  // Check WhyMatchPanel for sanitization
  if (!whyMatchCode.includes("sanitizeUserFacingAiError")) {
    failures.push("WhyMatchPanel.tsx does not call sanitizeUserFacingAiError on error messages");
  }
  if (!whyMatchCode.includes("GENERIC_AI_UNAVAILABLE_MESSAGE")) {
    failures.push("WhyMatchPanel.tsx does not reference GENERIC_AI_UNAVAILABLE_MESSAGE");
  }

  // Verify that neither UI component hardcodes GROQ_API_KEY in its code
  if (tailorModalCode.includes("GROQ_API_KEY")) {
    failures.push("TailorResumeModal.tsx contains direct reference to GROQ_API_KEY");
  }
  if (whyMatchCode.includes("GROQ_API_KEY")) {
    failures.push("WhyMatchPanel.tsx contains direct reference to GROQ_API_KEY");
  }

  // ============================================================================
  // TEST 6: Server logs in serviceHandler.ts remain unchanged
  // ============================================================================
  console.log("TEST 6: Server-side logging integrity in serviceHandler.ts...");

  const serviceHandlerPath = path.resolve(process.cwd(), "src/lib/ai/serviceHandler.ts");
  const serviceHandlerCode = fs.readFileSync(serviceHandlerPath, "utf-8");

  const expectedServerLog = '[AI Service] Missing required environment variable: GROQ_API_KEY';
  if (!serviceHandlerCode.includes(expectedServerLog)) {
    failures.push("serviceHandler.ts server log was modified; expected server log: " + expectedServerLog);
  }

  const expectedServerBody = 'missingVariable: "GROQ_API_KEY"';
  if (!serviceHandlerCode.includes(expectedServerBody)) {
    failures.push("serviceHandler.ts server error payload was modified; expected missingVariable: GROQ_API_KEY");
  }

  // ============================================================================
  // Final Verdict
  // ============================================================================
  console.log("\n================================================================================");
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} check(s) failed:`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  console.log("ALL CHECKS PASSED: Cover letter grounded, AI notice shown, GROQ keys sanitized.");
  console.log("Verdict: PASS-LOCAL");
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected test error:", err);
  process.exit(1);
});
