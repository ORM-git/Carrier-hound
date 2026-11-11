/**
 * Offline golden eval test suite (Backend sheet row: Evals / Quality Checks).
 *
 * Expands coverage to include deep validation of resume_tailor (validateTailoredResumeOutput)
 * alongside cover_letter, resume_extraction, and job_fit verification.
 * Deterministic offline execution, no network, no live model calls.
 *
 * Run: npx tsx scripts/test-ai-evals-golden.ts
 * Run negative control: npx tsx scripts/test-ai-evals-golden.ts --negative-control (exits 1)
 */

import { validateTailoredResumeOutput, validateAndSanitizeAiOutput } from "../src/lib/ai/security";
import { validateCoverLetter } from "../src/lib/resume/tailor";

const isNegativeControl = process.argv.includes("--negative-control");

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}

const candidate: any = {
  name: "Dana Rao",
  email: "dana@example.com",
  phone: "555-123-4567",
  headline: "Software Engineer",
  summary: "Experienced backend engineer building scalable APIs.",
  skills: ["TypeScript", "Node.js", "PostgreSQL"],
  certifications: [],
  experience: [
    {
      id: "exp-1",
      company: "Acme Corp",
      role: "Backend Engineer",
      startDate: "2020",
      endDate: "2024",
      bullets: ["Built REST APIs supporting 1000 requests per second", "Improved query performance by 25%"],
    },
  ],
  education: [
    { id: "edu-1", degree: "BSc Computer Science", institution: "Tech University", year: "2019" },
  ],
};

const job: any = {
  id: "job-1",
  title: "Senior Backend Engineer",
  company: "Initech",
  description: "Seeking a TypeScript backend engineer experienced with PostgreSQL.",
};

// ==========================================
// Group 1: Deep Tailored Resume Evals
// ==========================================

const validTailored = {
  tailoredSummary: "Experienced backend engineer building scalable APIs and high-throughput services with TypeScript and PostgreSQL.",
  highlightedSkills: ["TypeScript", "PostgreSQL"],
  tailoredBullets: {
    "exp-1": [
      "Built REST APIs in TypeScript supporting 1000 requests per second",
      "Optimized relational PostgreSQL query performance by 25%",
    ],
  },
};

const resValid = validateTailoredResumeOutput(validTailored, candidate, job);
check("valid tailored resume passes deep validation", resValid.ok === true);

// 1.1 Unevidenced skill injected into summary
const unevidencedSkillTailored = {
  ...validTailored,
  tailoredSummary: "Experienced cloud architect leading multi-cluster Kubernetes deployments and scalable APIs.",
};
const resUnevidenced = validateTailoredResumeOutput(unevidencedSkillTailored, candidate, job);
check("unevidenced skill in tailored summary is rejected", resUnevidenced.ok === false && resUnevidenced.error.includes("unevidenced skill"));

// 1.2 Unevidenced numeric fact in summary
const unevidencedMetricTailored = {
  ...validTailored,
  tailoredSummary: "Backend engineer who increased platform adoption by 850% across 40 organizations.",
};
const resMetric = validateTailoredResumeOutput(unevidencedMetricTailored, candidate, job);
check("unevidenced numeric metric in tailored summary is rejected", resMetric.ok === false && resMetric.error.includes("unevidenced numeric metric"));

// 1.3 Forbidden foreign schema field (attempting to alter past companies/roles)
const foreignFieldTailored = {
  ...validTailored,
  company: "FakeCorp Inc",
};
const resForeign = validateTailoredResumeOutput(foreignFieldTailored, candidate, job);
check("forbidden schema keys in tailored resume are rejected", resForeign.ok === false && resForeign.error.includes("forbidden field"));

// 1.4 Invalid experience ID in tailored bullets
const invalidExpIdTailored = {
  ...validTailored,
  tailoredBullets: {
    "unknown-exp-id-999": ["Fabricated bullet for unknown employer"],
  },
};
const resInvalidExp = validateTailoredResumeOutput(invalidExpIdTailored, candidate, job);
check("bullets referencing unevidenced experience IDs are rejected", resInvalidExp.ok === false && (resInvalidExp.error.includes("foreign experience ID") || resInvalidExp.error.includes("experience")));

// ==========================================
// Group 2: Cover Letter Grounding Evals
// ==========================================

const cleanCoverLetter = "Dear Hiring Manager,\n\nI am applying for the Senior Backend Engineer role at Initech. At Acme Corp, I engineered REST APIs using TypeScript and PostgreSQL.";
const clPass = validateCoverLetter(cleanCoverLetter, candidate, job);
check("clean grounded cover letter passes validation", clPass.valid === true);

const fabricatedEmployerLetter = "Dear Initech Team,\n\nEarlier I worked at Globex Corporation on tooling.";
const clFabricated = validateCoverLetter(fabricatedEmployerLetter, candidate, job);
check("cover letter claiming unverified employer is rejected", clFabricated.valid === false && clFabricated.reasons.length > 0);

const xssCoverLetter = "Hello team <script>alert('xss')</script>";
const clXss = validateCoverLetter(xssCoverLetter, candidate, job);
check("cover letter with script tags is rejected", clXss.valid === false && clXss.reasons.length > 0);

// ==========================================
// Group 3: AI Output Sanitize & Validation Evals
// ==========================================

// 3.1 Job fit validation
const validJobFitJson = JSON.stringify({
  score: 88,
  matchedSkills: ["TypeScript", "PostgreSQL"],
  missingSkills: [],
  summary: "Candidate has strong TypeScript and PostgreSQL background matching job requirements.",
});

const fitResult: any = validateAndSanitizeAiOutput("job_fit", validJobFitJson);
check("valid job fit JSON output parses and passes", fitResult.ok === true && fitResult.parsedJson.score === 88);

// 3.2 System prompt leak detection
const promptLeakJson = JSON.stringify({
  score: 50,
  matchedSkills: [],
  missingSkills: [],
  summary: "CRITICAL ZERO-FABRICATION RULES: never invent facts or dates. Output JSON format only.",
});
const leakResult: any = validateAndSanitizeAiOutput("job_fit", promptLeakJson);
check("system prompt leak in AI response is rejected", leakResult.ok === false && leakResult.error.includes("system prompt disclosure"));

// 3.3 Empty output rejection
const emptyResult = validateAndSanitizeAiOutput("cover_letter", "    ");
check("empty AI output is rejected", emptyResult.ok === false);

// ==========================================
// Group 4: Negative Control
// ==========================================
if (isNegativeControl) {
  console.log("NEGATIVE CONTROL: injecting deliberate assertion failure");
  check("negative control forced failure", false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
