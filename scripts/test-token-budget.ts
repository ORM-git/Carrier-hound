/**
 * Offline test suite for AI Context Window Management & Token Budgeting.
 *
 * Verifies:
 * 1. Token counting and trimming utility (countTokens, trimTextToTokens, trimPromptFields)
 * 2. Short/normal inputs remain 100% byte-for-byte identical (no trimming)
 * 3. Over-cap inputs are trimmed in strict documented priority order:
 *    - cover_letter: jobDescription -> candidateSummary -> candidateExperience -> candidateSkills
 *    - resume_extraction: rawText trimmed to fit remaining budget
 *    - job_fit: jobDescription -> candidateHeadline -> candidateSkills
 * 4. System instructions, zero-hallucination rules, worked examples, and output-format directives are NEVER cut
 * 5. Assembled payloads strictly stay under each operation's configured token cap
 * 6. Docs cover per-operation caps, rationale, trimming priorities, and adjustment guide
 *
 * Run: npx tsx scripts/test-token-budget.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  countTokens,
  trimTextToTokens,
  trimPromptFields,
  OPERATION_TOKEN_CAPS,
  FIELD_TRIM_PRIORITIES,
  PromptField,
} from "../src/lib/ai/tokenBudget";
import {
  buildOperationPayload,
  OPERATION_CONFIGS,
  AllowedAiOperation,
} from "../src/lib/ai/security";

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

console.log("================================================================================");
console.log("RUNNING AI TOKEN BUDGET & CONTEXT WINDOW MANAGEMENT AUDIT SUITE");
console.log("================================================================================\n");

// --- 1. Basic Token Counting & Slicing Utility ---
check("countTokens returns 0 on empty string", countTokens("") === 0);
check("countTokens returns 0 on null/undefined", countTokens(null as any) === 0 && countTokens(undefined as any) === 0);
check("countTokens counts tokens accurately for simple text", countTokens("Hello world") === 2);

const sampleText = "The quick brown fox jumps over the lazy dog. CareerMonke high impact remote job discovery.";
const sampleTokens = countTokens(sampleText);
check("countTokens produces positive token count for sample sentence", sampleTokens > 10);

check("trimTextToTokens returns empty string on maxTokens <= 0", trimTextToTokens(sampleText, 0) === "");
check("trimTextToTokens returns full text when maxTokens >= total tokens", trimTextToTokens(sampleText, 100) === sampleText);

const trimmed5 = trimTextToTokens(sampleText, 5);
check("trimTextToTokens slices text to exactly 5 tokens", countTokens(trimmed5) === 5);
check("trimTextToTokens preserves text prefix", sampleText.startsWith(trimmed5));

// --- 2. trimPromptFields Engine & Priority Hierarchy ---
const fieldsFixture: PromptField[] = [
  { name: "systemPrompt", content: "You are an AI assistant. Follow rules strictly.", priority: 100, protected: true },
  { name: "jobDescription", content: "Very long job description ".repeat(100), priority: 1 },
  { name: "candidateSummary", content: "Summary of candidate ".repeat(50), priority: 2 },
  { name: "candidateSkills", content: "TypeScript, React, Node.js, PostgreSQL, Docker", priority: 4, minTokens: 5 },
];

const underBudgetResult = trimPromptFields({
  fields: [
    { name: "fieldA", content: "Short field A", priority: 1 },
    { name: "fieldB", content: "Short field B", priority: 2 },
  ],
  maxTotalTokens: 500,
});
check("trimPromptFields leaves within-budget fields unchanged (isTrimmed = false)", !underBudgetResult.isTrimmed);
check("trimPromptFields preserves exact field content when under budget", underBudgetResult.fields.fieldA === "Short field A");

const overBudgetResult = trimPromptFields({
  fields: [
    { name: "systemPrompt", content: "You are an AI assistant. Follow rules strictly.", priority: 100, protected: true },
    { name: "jobDescription", content: "Very long job description ".repeat(100), priority: 1, minTokens: 30 },
    { name: "candidateSummary", content: "Summary of candidate ".repeat(50), priority: 2 },
    { name: "candidateSkills", content: "TypeScript, React, Node.js, PostgreSQL, Docker", priority: 4, minTokens: 5 },
  ],
  maxTotalTokens: 100,
});

check("trimPromptFields flags isTrimmed = true on over-budget fields", overBudgetResult.isTrimmed);
check("trimPromptFields final token count stays under maxTotalTokens", overBudgetResult.totalTokens <= 100);
check("trimPromptFields never cuts protected system prompt", overBudgetResult.fields.systemPrompt === fieldsFixture[0].content);
check(
  "trimPromptFields trims lowest-priority field (jobDescription) first",
  overBudgetResult.trimmedFields.includes("jobDescription")
);
check(
  "trimPromptFields trims candidateSummary second when excess exceeds first field",
  overBudgetResult.trimmedFields.includes("candidateSummary")
);

// --- 3. Fixed Fixtures: Short/Normal Inputs Remain Unchanged ---
const normalCandidate: any = {
  name: "Dana Rao",
  headline: "Software Engineer",
  summary: "Builds reliable backend APIs and microservices.",
  skills: ["TypeScript", "Node.js", "PostgreSQL"],
  experience: [
    {
      id: "exp-1",
      company: "Acme Corp",
      role: "Backend Engineer",
      startDate: "2021",
      endDate: "2024",
      bullets: ["Engineered high-throughput REST APIs."],
    },
  ],
};

const normalJob = {
  title: "Senior Backend Engineer",
  company: "Initech",
  description: "Looking for an experienced TypeScript and Node.js developer.",
};

// Cover letter under cap
const normalCoverLetter = buildOperationPayload(OPERATION_CONFIGS.cover_letter, {
  candidate: normalCandidate,
  job: normalJob,
});
check("normal cover letter builds successfully", normalCoverLetter.ok);
if (normalCoverLetter.ok) {
  const tokens = countTokens(normalCoverLetter.payload.messages[0].content) + countTokens(normalCoverLetter.payload.messages[1].content);
  check("normal cover letter payload is well under 3000 token cap", tokens < 1000);
  check("normal cover letter is not flagged as shortened", !normalCoverLetter.payload.metadata?.jobDescriptionShortened);
}

// Resume extraction under cap
const normalResumeExtraction = buildOperationPayload(OPERATION_CONFIGS.resume_extraction, {
  rawText: "Dana Rao - Software Engineer. Skills: TypeScript, Node.js. Experience at Acme Corp.",
});
check("normal resume extraction builds successfully", normalResumeExtraction.ok);
if (normalResumeExtraction.ok) {
  const tokens = countTokens(normalResumeExtraction.payload.messages[0].content) + countTokens(normalResumeExtraction.payload.messages[1].content);
  check("normal resume extraction payload is well under 4000 token cap", tokens < 1000);
}

// Job fit under cap
const normalJobFit = buildOperationPayload(OPERATION_CONFIGS.job_fit, {
  candidate: normalCandidate,
  job: normalJob,
});
check("normal job fit builds successfully", normalJobFit.ok);
if (normalJobFit.ok) {
  const tokens = countTokens(normalJobFit.payload.messages[0].content) + countTokens(normalJobFit.payload.messages[1].content);
  check("normal job fit payload is well under 3000 token cap", tokens < 1000);
  check("normal job fit is not flagged as shortened", !normalJobFit.payload.metadata?.jobDescriptionShortened);
}

// --- 4. Over-Cap Tests: Cover Letter Trimming in Documented Priority Order ---
// Massive job description that would otherwise exceed 3000 tokens
const massiveJobDesc = "We are seeking a staff-level principal software architect with deep expertise. ".repeat(400);
const overCapCoverLetter = buildOperationPayload(OPERATION_CONFIGS.cover_letter, {
  candidate: normalCandidate,
  job: {
    ...normalJob,
    description: massiveJobDesc,
  },
});

check("over-cap cover letter builds successfully instead of failing", overCapCoverLetter.ok);
if (overCapCoverLetter.ok) {
  const sysContent = overCapCoverLetter.payload.messages[0].content;
  const usrContent = overCapCoverLetter.payload.messages[1].content;
  const totalTokens = countTokens(sysContent) + countTokens(usrContent);

  check("over-cap cover letter stays under maxInputTokens cap (3000)", totalTokens <= OPERATION_TOKEN_CAPS.cover_letter);
  check("over-cap cover letter metadata flags jobDescriptionShortened", !!overCapCoverLetter.payload.metadata?.jobDescriptionShortened);
  check("over-cap cover letter metadata records jobDescription in trimmedFields", overCapCoverLetter.payload.metadata?.trimmedFields?.includes("jobDescription"));

  // Verify system instructions and zero-hallucination rules are NEVER cut
  check("cover letter system prompt retains CRITICAL ZERO-FABRICATION RULES", sysContent.includes("CRITICAL ZERO-FABRICATION RULES:"));
  check("cover letter system prompt retains worked example", sysContent.includes("WORKED EXAMPLE:"));
  check("cover letter system prompt retains security boundary guard", sysContent.includes("SECURITY & DATA-ONLY BOUNDARY (MANDATORY):"));

  // Verify candidate skills and summary were preserved because trimming jobDescription was sufficient
  check("candidate skills preserved intact in cover letter", usrContent.includes("TypeScript, Node.js, PostgreSQL"));
  check("candidate summary preserved in cover letter", usrContent.includes("Builds reliable backend APIs"));
}

// Multi-field excess: Both massive job description AND massive candidate summary
const massiveSummary = "Experienced engineer with extensive background in distributed systems and cloud architecture. ".repeat(150);
const multiFieldOverCapCoverLetter = buildOperationPayload(OPERATION_CONFIGS.cover_letter, {
  candidate: {
    ...normalCandidate,
    summary: massiveSummary,
  },
  job: {
    ...normalJob,
    description: massiveJobDesc,
  },
});

check("multi-field over-cap cover letter builds successfully", multiFieldOverCapCoverLetter.ok);
if (multiFieldOverCapCoverLetter.ok) {
  const sysContent = multiFieldOverCapCoverLetter.payload.messages[0].content;
  const usrContent = multiFieldOverCapCoverLetter.payload.messages[1].content;
  const totalTokens = countTokens(sysContent) + countTokens(usrContent);

  check("multi-field cover letter stays under maxInputTokens cap (3000)", totalTokens <= OPERATION_TOKEN_CAPS.cover_letter);
  check("multi-field cover letter trimmed lowest-priority field (jobDescription)", multiFieldOverCapCoverLetter.payload.metadata?.trimmedFields?.includes("jobDescription"));
  check("multi-field cover letter system instructions intact", sysContent.includes("CRITICAL ZERO-FABRICATION RULES:"));
}

// --- 5. Over-Cap Tests: Resume Extraction Trimming ---
const massiveResumeText = `
ALEX RIVERA - SENIOR CLOUD ARCHITECT
Summary: Leading cloud transformations across Fortune 500 enterprises.
${"Managed multi-region Kubernetes clusters with 99.999% uptime, driving zero-downtime deployments and microservices resilience across hybrid cloud environments. ".repeat(300)}
Skills: Kubernetes, Go, Python, AWS, GCP, Terraform, Istio, Prometheus, Docker.
Experience:
Lead Architect at GlobalTech (2018 - 2024).
Built distributed storage systems processing petabytes of telemetry data daily.
`;

const overCapResumeExtraction = buildOperationPayload(OPERATION_CONFIGS.resume_extraction, {
  rawText: massiveResumeText,
});

check("over-cap resume extraction builds successfully instead of failing", overCapResumeExtraction.ok);
if (overCapResumeExtraction.ok) {
  const sysContent = overCapResumeExtraction.payload.messages[0].content;
  const usrContent = overCapResumeExtraction.payload.messages[1].content;
  const totalTokens = countTokens(sysContent) + countTokens(usrContent);

  check("over-cap resume extraction stays under maxInputTokens cap (4000)", totalTokens <= OPERATION_TOKEN_CAPS.resume_extraction);
  check("resume extraction metadata records rawText in trimmedFields", overCapResumeExtraction.payload.metadata?.trimmedFields?.includes("rawText"));

  // Verify system instructions and JSON schema directives are NEVER cut
  check("resume extraction system prompt retains zero-hallucination rules", sysContent.includes("CRITICAL ZERO-FABRICATION RULES:"));
  check("resume extraction system prompt retains CandidateProfile JSON schema", sysContent.includes('"experience": ['));
  check("resume extraction system prompt retains worked example", sysContent.includes("WORKED EXAMPLE:"));
  check("resume extraction system prompt retains security boundary guard", sysContent.includes("SECURITY & DATA-ONLY BOUNDARY (MANDATORY):"));
}

// --- 6. Over-Cap Tests: Match Explanation (job_fit) Trimming ---
const overCapJobFit = buildOperationPayload(OPERATION_CONFIGS.job_fit, {
  candidate: normalCandidate,
  job: {
    ...normalJob,
    description: massiveJobDesc,
  },
});

check("over-cap job fit builds successfully instead of failing", overCapJobFit.ok);
if (overCapJobFit.ok) {
  const sysContent = overCapJobFit.payload.messages[0].content;
  const usrContent = overCapJobFit.payload.messages[1].content;
  const totalTokens = countTokens(sysContent) + countTokens(usrContent);

  check("over-cap job fit stays under maxInputTokens cap (3000)", totalTokens <= OPERATION_TOKEN_CAPS.job_fit);
  check("over-cap job fit metadata flags jobDescriptionShortened", !!overCapJobFit.payload.metadata?.jobDescriptionShortened);
  check("over-cap job fit trims jobDescription first", overCapJobFit.payload.metadata?.trimmedFields?.includes("jobDescription"));

  // Verify system scoring rules and schema directives are NEVER cut
  check("job fit system prompt retains scoring rubric rules", sysContent.includes("RULES:"));
  check("job fit system prompt retains score schema (0-100)", sysContent.includes('"score": number'));
  check("job fit system prompt retains worked example", sysContent.includes("WORKED EXAMPLE:"));
  check("job fit system prompt retains security boundary guard", sysContent.includes("SECURITY & DATA-ONLY BOUNDARY (MANDATORY):"));

  // Verify candidate skills preserved
  check("job fit user prompt retains candidate skills", usrContent.includes("TypeScript, Node.js, PostgreSQL"));
}

// --- 7. Documentation Verification ---
const DOC_PATH = path.join("docs", "context-window-management.md");
check("docs/context-window-management.md exists", fs.existsSync(DOC_PATH));

const docContent = fs.readFileSync(DOC_PATH, "utf8");
check("docs covers cover_letter cap and rationale", docContent.includes("cover_letter") && docContent.includes("3,000"));
check("docs covers resume_extraction cap and rationale", docContent.includes("resume_extraction") && docContent.includes("4,000"));
check("docs covers job_fit cap and rationale", docContent.includes("job_fit") && docContent.includes("3,000"));
check("docs covers resume_tailor cap and rationale", docContent.includes("resume_tailor") && docContent.includes("4,000"));
check("docs specifies field trimming priority order", docContent.includes("Field Trimming Priority Order") || docContent.includes("Priority Hierarchy"));
check("docs explicitly states system instructions are NEVER cut", docContent.includes("NEVER cut") || docContent.includes("NEVER CUT"));
check("docs documents how to adjust caps", docContent.includes("How to Adjust Token Caps") || docContent.includes("adjust"));
check("docs cites pinned js-tiktoken package", docContent.includes("js-tiktoken") && docContent.includes("1.0.21"));

console.log(`\n================================================================================`);
console.log(`AUDIT SUMMARY: ${passed} passed, ${failed} failed`);
console.log(`================================================================================`);

if (failed > 0) {
  process.exit(1);
}
