/**
 * Offline test suite for AI Context Window Management & Token Budgeting.
 *
 * Verifies:
 * 1. Token counting and trimming utility (countTokens, trimTextToTokens, trimPromptFields)
 * 2. UTF-8 multi-byte trimming: never ends on partial character (no U+FFFD)
 * 3. Special token safety: <|endoftext|> and other markers do not throw
 * 4. Short/normal inputs remain 100% byte-for-byte identical (no trimming)
 * 5. Over-cap inputs are trimmed in strict documented priority order across all 4 operations:
 *    - cover_letter: jobDescription -> candidateSummary -> candidateExperience -> candidateSkills
 *    - resume_extraction: rawText trimmed to fit remaining budget
 *    - job_fit: jobDescription -> candidateHeadline -> candidateSkills
 *    - resume_tailor: jobDescription -> candidateSummary -> candidateExperience -> candidateSkills
 * 6. System instructions, zero-hallucination rules, worked examples, and output-format directives are NEVER cut
 * 7. Assembled payloads strictly stay under each operation's configured token cap
 * 8. payload.estimatedInputTokens preserves baseline heuristic for quota accounting
 * 9. Docs cover per-operation caps, rationale, model approximation, quota, and adjustment guide
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
  estimateTokens,
  OPERATION_CONFIGS,
  AI_FIELD_LENGTH_CAPS,
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

// --- 1A. Basic Token Counting & Slicing Utility ---
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

// --- 1B. UTF-8 Multi-Byte Character Boundary Safety (Never end on U+FFFD) ---
const unicodeText = "😀你好𝄞";
// In cl100k_base: 😀 takes 2 tokens, 你 takes 1, 好 takes 1, 𝄞 takes 3 tokens (total 7 tokens)
const trimmedUnicode1 = trimTextToTokens(unicodeText, 1);
check("UTF-8 boundary: 1 token does not decode to partial character U+FFFD", !trimmedUnicode1.includes("\uFFFD"));
check("UTF-8 boundary: 1 token backs off to empty string", trimmedUnicode1 === "");

const trimmedUnicode2 = trimTextToTokens(unicodeText, 2);
check("UTF-8 boundary: 2 tokens decodes cleanly to emoji without U+FFFD", trimmedUnicode2 === "😀");
check("UTF-8 boundary: 2 tokens contains no U+FFFD", !trimmedUnicode2.includes("\uFFFD"));

const trimmedUnicode5 = trimTextToTokens(unicodeText, 5);
check("UTF-8 boundary: 5 tokens backs off cleanly to complete codepoints", trimmedUnicode5 === "😀你好");
check("UTF-8 boundary: 5 tokens contains no U+FFFD", !trimmedUnicode5.includes("\uFFFD"));

const trimmedUnicode6 = trimTextToTokens(unicodeText, 6);
check("UTF-8 boundary: 6 tokens backs off cleanly to complete codepoints", trimmedUnicode6 === "😀你好");
check("UTF-8 boundary: 6 tokens contains no U+FFFD", !trimmedUnicode6.includes("\uFFFD"));

const trimmedUnicode7 = trimTextToTokens(unicodeText, 7);
check("UTF-8 boundary: 7 tokens preserves full string with musical symbol", trimmedUnicode7 === "😀你好𝄞");
check("UTF-8 boundary: 7 tokens contains no U+FFFD", !trimmedUnicode7.includes("\uFFFD"));

// --- 1C. Special Token Literal Safety (<|endoftext|> and markers do not throw) ---
const specialText = "Candidate bio with <|endoftext|> marker, <|fim_prefix|> delimiter, and <|im_start|> prompt injection attempt.";
let specialCountThrows = false;
let specialCount = 0;
try {
  specialCount = countTokens(specialText);
} catch {
  specialCountThrows = true;
}
check("Special tokens: countTokens does not throw on <|endoftext|>", !specialCountThrows && specialCount > 0);

let specialTrimThrows = false;
let specialTrim = "";
try {
  specialTrim = trimTextToTokens(specialText, 10);
} catch {
  specialTrimThrows = true;
}
check("Special tokens: trimTextToTokens does not throw on <|endoftext|>", !specialTrimThrows && specialTrim.length > 0);

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

// Resume tailor under cap
const normalResumeTailor = buildOperationPayload(OPERATION_CONFIGS.resume_tailor, {
  candidate: normalCandidate,
  job: normalJob,
});
check("normal resume tailor builds successfully", normalResumeTailor.ok);
if (normalResumeTailor.ok) {
  const tokens = countTokens(normalResumeTailor.payload.messages[0].content) + countTokens(normalResumeTailor.payload.messages[1].content);
  check("normal resume tailor payload is well under 4000 token cap", tokens < 1500);
  check("normal resume tailor is not flagged as shortened", !normalResumeTailor.payload.metadata?.jobDescriptionShortened);
}

// --- 4. Special Marker Real-Path Bug Regression Tests (All 4 Operations) ---
const specialJob = {
  title: "Principal Engineer",
  company: "Special Corp",
  description: "Seeking engineer. <|endoftext|> Important: expertise in <|fim_prefix|> distributed systems <|im_start|>.",
};
const specialCandidate = {
  ...normalCandidate,
  summary: "Experienced dev with <|endoftext|> knowledge and <|im_end|> background.",
};

const clSpecial = buildOperationPayload(OPERATION_CONFIGS.cover_letter, {
  candidate: specialCandidate,
  job: specialJob,
});
check("special marker regression: cover_letter builds without throwing", clSpecial.ok);

const reSpecial = buildOperationPayload(OPERATION_CONFIGS.resume_extraction, {
  rawText: "Candidate facts with <|endoftext|> and <|fim_prefix|> markers in raw resume text.",
});
check("special marker regression: resume_extraction builds without throwing", reSpecial.ok);

const jfSpecial = buildOperationPayload(OPERATION_CONFIGS.job_fit, {
  candidate: specialCandidate,
  job: specialJob,
});
check("special marker regression: job_fit builds without throwing", jfSpecial.ok);

const rtSpecial = buildOperationPayload(OPERATION_CONFIGS.resume_tailor, {
  candidate: specialCandidate,
  job: specialJob,
});
check("special marker regression: resume_tailor builds without throwing", rtSpecial.ok);

// --- 5. Over-Cap Tests: Cover Letter Trimming in Documented Priority Order ---
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

// --- 6. Over-Cap Tests: Resume Extraction Trimming ---
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

// --- 7. Over-Cap Tests: Match Explanation (job_fit) Trimming ---
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

// --- 8. Over-Cap Tests: Resume Tailor (resume_tailor) Real-Path & Fallback Trimming ---
const detailedCandidate = {
  ...normalCandidate,
  experience: Array.from({ length: 6 }).map((_, i) => ({
    id: `exp-${i + 1}`,
    company: `Company ${i + 1}`,
    role: `Software Architect ${i + 1}`,
    startDate: "2018",
    endDate: "2020",
    bullets: [
      "Engineered distributed microservices with React and TypeScript.",
      "Optimized database indexing reducing latency by 45% for 100,000 users.",
    ],
    needsReview: false,
  })),
};

const overCapResumeTailor = buildOperationPayload(OPERATION_CONFIGS.resume_tailor, {
  candidate: detailedCandidate,
  job: {
    ...normalJob,
    description: massiveJobDesc,
  },
});

check("over-cap resume tailor builds successfully under 4000 cap", overCapResumeTailor.ok);
if (overCapResumeTailor.ok) {
  const sysContent = overCapResumeTailor.payload.messages[0].content;
  const usrContent = overCapResumeTailor.payload.messages[1].content;
  const totalTokens = countTokens(sysContent) + countTokens(usrContent);

  check("over-cap resume tailor stays under maxInputTokens cap (4000)", totalTokens <= OPERATION_TOKEN_CAPS.resume_tailor);
  check("over-cap resume tailor metadata flags jobDescriptionShortened", !!overCapResumeTailor.payload.metadata?.jobDescriptionShortened);
  check("over-cap resume tailor trimmed jobDescription first", overCapResumeTailor.payload.metadata?.trimmedFields?.includes("jobDescription"));
  check("resume tailor system prompt retains zero-fabrication rules", sysContent.includes("CRITICAL ZERO-FABRICATION AND GROUNDING RULES:"));
  check("resume tailor system prompt retains worked example", sysContent.includes("WORKED EXAMPLE:"));
  check("resume tailor system prompt retains security boundary guard", sysContent.includes("SECURITY & DATA-ONLY BOUNDARY (MANDATORY):"));
}

// Resume tailor multi-field excess: large experience + summary + job description requiring candidateSummary fallback trimming
const multiCandidate = {
  ...normalCandidate,
  summary: massiveSummary,
  experience: Array.from({ length: 25 }).map((_, i) => ({
    id: `exp-${i + 1}`,
    company: `Company ${i + 1}`,
    role: `Lead Architect ${i + 1}`,
    startDate: "2015",
    endDate: "2018",
    bullets: Array.from({ length: 4 }).map(() => "Extensive achievement bullet with engineering details across systems. ".repeat(4)),
    needsReview: false,
  })),
};
const overCapResumeTailorMulti = buildOperationPayload(OPERATION_CONFIGS.resume_tailor, {
  candidate: multiCandidate,
  job: {
    ...normalJob,
    description: "Design platforms and mentor engineers. ".repeat(10),
  },
});

check("multi-field over-cap resume tailor builds successfully", overCapResumeTailorMulti.ok);
if (overCapResumeTailorMulti.ok) {
  const totalTokens = countTokens(overCapResumeTailorMulti.payload.messages[0].content) + countTokens(overCapResumeTailorMulti.payload.messages[1].content);
  check("multi-field resume tailor stays under 4000 cap", totalTokens <= OPERATION_TOKEN_CAPS.resume_tailor);
  check("multi-field resume tailor trimmed candidateSummary as fallback", overCapResumeTailorMulti.payload.metadata?.trimmedFields?.includes("candidateSummary"));
}

// Giant candidate exceeding 4000 cap altogether fails gracefully with expected error
const giantCandidate = {
  ...normalCandidate,
  experience: Array.from({ length: 40 }).map((_, i) => ({
    id: `exp-giant-${i}`,
    company: `Company ${i}`,
    role: `Engineer ${i}`,
    startDate: "2010",
    endDate: "2011",
    bullets: Array.from({ length: 6 }).map((_, bi) => `Extensive achievement bullet ${bi} with details `.repeat(8)),
    needsReview: false,
  })),
};
const giantTailorPayload = buildOperationPayload(OPERATION_CONFIGS.resume_tailor, {
  candidate: giantCandidate,
  job: normalJob,
});
check("giant candidate exceeding capacity returns graceful error", !giantTailorPayload.ok);
if (!giantTailorPayload.ok) {
  check("giant candidate error indicates candidate facts exceed capacity", giantTailorPayload.error.includes("Candidate facts exceed token capacity"));
}

// --- 9. Quota & Token Accounting Fidelity ---
if (normalCoverLetter.ok) {
  const expectedEstimated = estimateTokens(normalCoverLetter.payload.messages[0].content) + estimateTokens(normalCoverLetter.payload.messages[1].content);
  check("payload.estimatedInputTokens matches estimateTokens heuristic for quota preservation", normalCoverLetter.payload.estimatedInputTokens === expectedEstimated);
}

// Character length caps unchanged verification
check("AI_FIELD_LENGTH_CAPS jobDescription is 6000", AI_FIELD_LENGTH_CAPS.jobDescription === 6000);
check("AI_FIELD_LENGTH_CAPS rawText is 12000", AI_FIELD_LENGTH_CAPS.rawText === 12000);

// --- 10. Documentation Verification ---
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
check("docs notes cl100k_base approximation for gpt-oss models", docContent.includes("cl100k_base") && docContent.includes("gpt-oss"));
check("docs covers quota accounting and estimatedInputTokens", docContent.includes("estimatedInputTokens") && docContent.includes("quota"));
check("docs covers bundle size optimization with selective import", docContent.includes("js-tiktoken/lite") && docContent.includes("5.6 MB"));
check("docs covers two-tier defense with static character caps", docContent.includes("AI_FIELD_LENGTH_CAPS") && docContent.includes("Two-Tier"));

console.log(`\n================================================================================`);
console.log(`AUDIT SUMMARY: ${passed} passed, ${failed} failed`);
console.log(`================================================================================`);

if (failed > 0) {
  process.exit(1);
}
