/**
 * Backend sheet row "Evals / Quality Checks" (PARTIAL: "Cover-letter validation
 * rules; no systematic eval set"). Offline golden-case eval set for the existing
 * AI output rules: validateCoverLetter (src/lib/resume/tailor.ts) and
 * validateAndSanitizeAiOutput (src/lib/ai/security.ts).
 *
 * Each case is a fixed input plus the expected verdict. No model, network or
 * database is used, so the set is deterministic and free. It measures the guard
 * rules only; it does NOT score the quality of real model output (that needs live
 * model calls and a human-reviewed reference set, an owner decision).
 *
 * Add a case whenever a bad output slips through: write the input, the expected
 * verdict, and the reason text it must produce.
 * Run: npx tsx scripts/eval-ai-output-golden.ts   (exit 1 on any mismatch)
 */
import { validateCoverLetter } from "../src/lib/resume/tailor";
import { validateAndSanitizeAiOutput, buildOperationPayload, OPERATION_CONFIGS } from "../src/lib/ai/security";

const NOW = "2026-11-07T00:00:00Z";
const dev: any = {
  name: "Dana Rao", email: "dana@example.com", phone: "555-123-4567", headline: "Software Engineer", summary: "",
  skills: ["TypeScript", "Python"], certifications: [], updatedAt: NOW,
  experience: [{ id: "e1", company: "Acme Corp", role: "Software Engineer", startDate: "2020", endDate: "2024", bullets: ["Built APIs"] }],
  education: [{ id: "d1", degree: "BSc Computer Science", institution: "State University", year: "2019" }],
};
const fresher: any = { ...dev, name: "Sam Lee", email: "sam@example.com", phone: "555-222-3333", headline: "Marketing graduate", skills: ["Writing"], experience: [], education: [{ id: "d1", degree: "BA Marketing", institution: "City College", year: "2025" }] };
const job = { title: "Software Engineer", company: "Initech" };

interface LetterCase { id: string; candidate: any; text: string; valid: boolean; reason?: string }
const letters: LetterCase[] = [
  { id: "clean letter passes", candidate: dev, text: "Dear Hiring Team, I build reliable APIs with TypeScript and would like to join Initech.", valid: true },
  { id: "own email is allowed", candidate: dev, text: "You can reach me at dana@example.com about the Initech role.", valid: true },
  { id: "own phone is allowed", candidate: dev, text: "Call me on 555-123-4567 about the Initech role.", valid: true },
  { id: "verified employer is allowed", candidate: dev, text: "At Initech I would build on what I did when I worked at Acme Corp.", valid: true },
  { id: "script markup rejected", candidate: dev, text: "Hello <script>alert(1)</script> team", valid: false, reason: "disallowed HTML" },
  { id: "inline handler rejected", candidate: dev, text: "Hello <img src=x onerror=alert(1)> team", valid: false, reason: "disallowed HTML" },
  { id: "foreign email rejected", candidate: dev, text: "Write to boss@evil.example for details.", valid: false, reason: "unverified email" },
  { id: "fabricated phone rejected", candidate: dev, text: "My number is 555-987-6543.", valid: false, reason: "unverified phone" },
  { id: "fabricated link rejected", candidate: dev, text: "See my work at https://portfolio.example/dana today.", valid: false, reason: "unverified link" },
  { id: "invented years rejected for a fresher", candidate: fresher, text: "I bring 5 years of experience to Initech.", valid: false, reason: "years of work experience" },
  { id: "invented prior roles rejected for a fresher", candidate: fresher, text: "My previous roles taught me a lot.", valid: false, reason: "previous employment" },
  { id: "unverified employer rejected", candidate: dev, text: "Earlier I worked at Globex Corporation on tooling.", valid: false, reason: "unverified employer" },
  { id: "unevidenced microservices claim rejected", candidate: fresher, text: "I enjoy deploying microservices at scale.", valid: false, reason: "microservices" },
];

interface OutCase { id: string; op: any; raw: string; ok: boolean; error?: string; check?: (r: any) => boolean }
const outputs: OutCase[] = [
  { id: "empty output rejected", op: "cover_letter", raw: "   ", ok: false, error: "empty generation" },
  { id: "system prompt leak rejected", op: "cover_letter", raw: "Sure. CRITICAL ZERO-FABRICATION RULES: never invent facts", ok: false, error: "system prompt disclosure" },
  { id: "untrusted-data tag leak rejected", op: "job_fit", raw: "<untrusted_candidate_data>x</untrusted_candidate_data>", ok: false, error: "system prompt disclosure" },
  { id: "cover letter markup is stripped", op: "cover_letter", raw: "<script>alert(1)</script>Dear team, hello.", ok: true, check: (r) => r.sanitizedText.indexOf("<script") === -1 && r.sanitizedText.indexOf("Dear team") !== -1 },
  { id: "markup-only cover letter rejected", op: "cover_letter", raw: "<script>alert(1)</script>", ok: false, error: "only disallowed" },
  { id: "invalid JSON rejected", op: "resume_extraction", raw: "{not json", ok: false, error: "invalid JSON" },
  { id: "JSON array rejected", op: "job_fit", raw: "[1,2]", ok: false, error: "expected JSON object" },
  { id: "extraction with no known key rejected", op: "resume_extraction", raw: "{\"foo\":1}", ok: false, error: "CandidateProfile schema" },
  { id: "extraction skills must be an array", op: "resume_extraction", raw: "{\"skills\":\"sql\"}", ok: false, error: "'skills' must be an array" },
  { id: "extraction experience must be an array", op: "resume_extraction", raw: "{\"experience\":{}}", ok: false, error: "'experience' must be an array" },
  { id: "extraction strips markup from fields", op: "resume_extraction", raw: "{\"name\":\"<b>Dana</b>\",\"skills\":[\"SQL\"]}", ok: true, check: (r) => r.parsedJson.name === "Dana" && r.parsedJson.skills[0] === "SQL" },
  { id: "job_fit needs a numeric score", op: "job_fit", raw: "{\"score\":\"high\"}", ok: false, error: "'score' must be a valid number" },
  { id: "job_fit score is clamped high", op: "job_fit", raw: "{\"score\":150}", ok: true, check: (r) => r.parsedJson.score === 100 },
  { id: "job_fit score is clamped low", op: "job_fit", raw: "{\"score\":-5}", ok: true, check: (r) => r.parsedJson.score === 0 },
  { id: "job_fit skills must be arrays", op: "job_fit", raw: "{\"score\":50,\"matchedSkills\":\"a\"}", ok: false, error: "'matchedSkills' must be an array" },
  { id: "resume_tailor with no expected key rejected", op: "resume_tailor", raw: "{\"x\":1}", ok: false, error: "resume_tailor schema" },
  // Expected output shape assertion cases for all four operations:
  {
    id: "cover_letter ideal output shape asserted",
    op: "cover_letter",
    raw: "At Acme Corp, I engineered responsive user interfaces utilizing TypeScript, React, and Next.js.\n\nJoining Linear aligns directly with my engineering focus on high-performance web tooling.",
    ok: true,
    check: (r) => typeof r.sanitizedText === "string" && r.sanitizedText.length > 50 && r.sanitizedText.includes("Acme Corp")
  },
  {
    id: "resume_extraction ideal output shape asserted",
    op: "resume_extraction",
    raw: JSON.stringify({
      name: "Alex Chen",
      headline: "Frontend Developer",
      summary: "Experienced UI engineer",
      skills: ["React", "TypeScript", "CSS"],
      experience: [
        {
          id: "exp-1",
          company: "DevCo",
          role: "UI Developer",
          startDate: "2021",
          endDate: "2023",
          bullets: ["Built responsive UI components."],
          needsReview: false
        }
      ],
      education: [
        {
          id: "edu-1",
          degree: "BS Computer Science",
          institution: "Tech University",
          year: "2021",
          needsReview: false
        }
      ],
      certifications: []
    }),
    ok: true,
    check: (r) =>
      r.parsedJson.name === "Alex Chen" &&
      Array.isArray(r.parsedJson.skills) &&
      r.parsedJson.skills.length === 3 &&
      Array.isArray(r.parsedJson.experience) &&
      r.parsedJson.experience[0].company === "DevCo" &&
      Array.isArray(r.parsedJson.education) &&
      r.parsedJson.education[0].institution === "Tech University"
  },
  {
    id: "job_fit ideal output shape asserted",
    op: "job_fit",
    raw: JSON.stringify({
      score: 85,
      matchedSkills: ["Python", "SQL"],
      missingSkills: ["Tableau"],
      summary: "Candidate has strong verified SQL and Python foundations."
    }),
    ok: true,
    check: (r) =>
      typeof r.parsedJson.score === "number" &&
      r.parsedJson.score === 85 &&
      Array.isArray(r.parsedJson.matchedSkills) &&
      r.parsedJson.matchedSkills.includes("Python") &&
      Array.isArray(r.parsedJson.missingSkills) &&
      typeof r.parsedJson.summary === "string" &&
      r.parsedJson.summary.length > 10
  },
  {
    id: "resume_tailor ideal output shape asserted",
    op: "resume_tailor",
    raw: JSON.stringify({
      tailoredSummary: "Backend engineer with proven experience in Node.js and Docker.",
      highlightedSkills: ["Node.js", "Docker"],
      tailoredBullets: {
        "exp-1": ["Optimized backend microservices to scale throughput by 30%."]
      }
    }),
    ok: true,
    check: (r) =>
      typeof r.parsedJson.tailoredSummary === "string" &&
      Array.isArray(r.parsedJson.highlightedSkills) &&
      r.parsedJson.highlightedSkills.includes("Node.js") &&
      typeof r.parsedJson.tailoredBullets === "object" &&
      Array.isArray(r.parsedJson.tailoredBullets["exp-1"]) &&
      r.parsedJson.tailoredBullets["exp-1"][0].includes("microservices")
  },
];

let total = 0;
let bad = 0;
function report(group: string, id: string, pass: boolean, why: string) {
  total++;
  if (!pass) { bad++; console.log(`FAIL [${group}] ${id}: ${why}`); } else console.log(`PASS [${group}] ${id}`);
}

letters.forEach((c) => {
  const r = validateCoverLetter(c.text, c.candidate, job);
  const reasonOk = c.reason ? r.reasons.join(" | ").indexOf(c.reason) !== -1 : r.reasons.length === 0;
  report("cover_letter", c.id, r.valid === c.valid && reasonOk, `valid=${r.valid} reasons=${r.reasons.join(" | ")}`);
});
outputs.forEach((c) => {
  const r: any = validateAndSanitizeAiOutput(c.op, c.raw);
  const errOk = c.error ? (!r.ok && String(r.error).indexOf(c.error) !== -1) : true;
  const checkOk = c.check ? (r.ok && c.check(r)) : true;
  report("ai_output", c.id, r.ok === c.ok && errOk && checkOk, `ok=${r.ok} error=${r.error || ""}`);
});

// Few-shot prompt verification: assert each of the four AI operations has a worked example pair
const sampleCandidate = {
  name: "Jordan Smith",
  headline: "Full Stack Engineer",
  summary: "Experienced developer",
  skills: ["TypeScript", "Node.js", "React"],
  experience: [{ id: "exp-1", company: "TechCorp", role: "Engineer", startDate: "2021", endDate: "2023", bullets: ["Built APIs"] }],
  education: [{ id: "edu-1", degree: "BSc", institution: "Uni", year: "2020", needsReview: false }],
  certifications: [],
};
const sampleJob = {
  title: "Full Stack Engineer",
  company: "CloudScale",
  description: "Looking for an engineer with TypeScript and Node.js skills.",
};

const fewShotOps = [
  { op: "cover_letter", params: { candidate: sampleCandidate, job: sampleJob } },
  { op: "resume_extraction", params: { rawText: "Jordan Smith - Developer. Skills: TypeScript." } },
  { op: "resume_tailor", params: { candidate: sampleCandidate, job: sampleJob } },
  { op: "job_fit", params: { candidate: sampleCandidate, job: sampleJob } },
] as const;

fewShotOps.forEach(({ op, params }) => {
  const cfg = OPERATION_CONFIGS[op as keyof typeof OPERATION_CONFIGS];
  const built = buildOperationPayload(cfg, params);
  const hasWorkedExample =
    built.ok &&
    built.payload.messages.some(
      (m) => m.role === "system" && m.content.includes("WORKED EXAMPLE") && m.content.includes("Ideal output")
    );
  const withinBudget = built.ok && (built.payload.estimatedInputTokens || 0) < cfg.maxInputTokens;
  report(
    "few_shot_prompt",
    `${op} system prompt contains worked example pair within budget`,
    hasWorkedExample && withinBudget,
    `hasWorkedExample=${hasWorkedExample} withinBudget=${withinBudget}`
  );
});

console.log(`\ncases=${total} passed=${total - bad} failed=${bad}`);
if (bad > 0) process.exit(1);
