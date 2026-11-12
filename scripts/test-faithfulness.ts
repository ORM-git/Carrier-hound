/**
 * Offline test & non-wiring guard for the AI faithfulness verifier (v1).
 *
 * Run with: npx tsx scripts/test-faithfulness.ts
 * Negative control check: npx tsx scripts/test-faithfulness.ts --negative-control
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  verifyAiOutputFaithfulness,
  verifyCoverLetterFaithfulness,
  verifyMatchExplanationFaithfulness,
  verifyResumeExtractionFaithfulness,
  extractTaxonomySkillsFromText,
  extractNumericFactsFromText,
} from "../src/lib/ai/faithfulness";
import { CandidateProfile } from "../src/lib/resume/types";

const ROOT = path.resolve(__dirname, "..");

if (process.argv.includes("--negative-control")) {
  console.error("NEGATIVE_CONTROL_TRIGGERED: deliberate failure verified.");
  process.exit(1);
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function testDesignDocCoverage() {
  const docPath = path.join(ROOT, "docs", "hallucination-guard-design.md");
  assert.ok(fs.existsSync(docPath), "docs/hallucination-guard-design.md must exist");
  const doc = fs.readFileSync(docPath, "utf8");
  assert.equal(
    /near-zero false-positive rate/i.test(doc),
    false,
    "Design doc must NOT claim a near-zero false-positive rate"
  );
  assert.equal(
    /Enforce First/i.test(doc),
    false,
    "Design doc must NOT recommend enforce-first before golden eval tests exist"
  );
  for (const required of [
    "resume_extraction",
    "cover_letter",
    "job_fit",
    "validateAndSanitizeAiOutput",
    "executeAiCore",
    "Staged Rollout Order",
    "src/lib/ai/faithfulness.ts",
    "Lexical support is NOT semantic entailment",
    "inconclusive",
  ]) {
    assert.ok(doc.includes(required), `Design doc missing required section/term: ${required}`);
  }
}

function testNotWiredIntoLivePaths() {
  const liveTargets = [
    path.join(ROOT, "src", "lib", "ai", "serviceHandler.ts"),
    path.join(ROOT, "src", "lib", "ai", "security.ts"),
    path.join(ROOT, "src", "lib", "ai", "groq.ts"),
    ...walkFiles(path.join(ROOT, "src", "app", "api")),
    ...walkFiles(path.join(ROOT, "netlify", "functions")),
  ];

  const importPattern = /\bfrom\s+["'][^"']*faithfulness["']|require\(["'][^"']*faithfulness["']\)/;
  for (const filePath of liveTargets) {
    if (!fs.existsSync(filePath)) continue;
    const src = fs.readFileSync(filePath, "utf8");
    const rel = path.relative(ROOT, filePath).replace(/\\/g, "/");
    assert.ok(
      !importPattern.test(src),
      `Live path ${rel} must NOT import faithfulness.ts in this unwired PR`
    );
  }
}

function testNegativeControlSubprocess() {
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const scriptPath = path.join(ROOT, "scripts", "test-faithfulness.ts");
  assert.ok(fs.existsSync(tsxCli), `Expected tsx CLI at ${tsxCli}`);
  const result = spawnSync(process.execPath, [tsxCli, scriptPath, "--negative-control"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, "Subprocess negative-control run must exit non-zero");
}

const SAMPLE_RAW_RESUME = `
Alex Chen
alex.chen@example.com | (415) 555-0199
SUMMARY
Frontend engineer with 4+ years building accessible web apps in TypeScript and React.
SKILLS
TypeScript, React, Next.js, Tailwind CSS, GraphQL
EXPERIENCE
Senior Frontend Engineer | Acme Corp | 2021 - Present
- Reduced bundle size by 35% and improved Lighthouse score across 12 pages.
EDUCATION
B.S. in Computer Science, State University, 2019
CERTIFICATIONS
AWS Certified Cloud Practitioner
`;

const SAMPLE_CANDIDATE: Partial<CandidateProfile> = {
  name: "Alex Chen",
  email: "alex.chen@example.com",
  phone: "(415) 555-0199",
  headline: "Frontend Engineer | TypeScript & React",
  summary: "Frontend engineer with 4+ years building accessible web apps in TypeScript and React.",
  skills: ["TypeScript", "React", "Next.js", "Tailwind CSS", "GraphQL"],
  experience: [
    {
      id: "exp-1",
      company: "Acme Corp",
      role: "Senior Frontend Engineer",
      startDate: "2021",
      endDate: "Present",
      bullets: ["Reduced bundle size by 35% and improved Lighthouse score across 12 pages."],
    },
  ],
  education: [
    {
      id: "edu-1",
      degree: "B.S. in Computer Science",
      institution: "State University",
      year: "2019",
    },
  ],
  certifications: ["AWS Certified Cloud Practitioner"],
};

const SAMPLE_JOB = {
  title: "Senior Frontend Engineer",
  company: "Linear Systems",
  description:
    "Seeking a Senior Frontend Engineer skilled in TypeScript, React, Next.js, Kubernetes deployment previews, and 4+ years experience.",
};

function testBehavioralFaithfulness() {
  assert.deepEqual(extractTaxonomySkillsFromText("Ready to go and handle the rest of the work."), []);
  assert.ok(extractTaxonomySkillsFromText("Built Go APIs and REST endpoints").includes("go"));
  assert.deepEqual(extractNumericFactsFromText("10,000+ users and 35% faster"), ["10000+", "35%"]);

  const cleanExtract = verifyResumeExtractionFaithfulness(SAMPLE_CANDIDATE, SAMPLE_RAW_RESUME);
  assert.equal(cleanExtract.faithful, true, `Clean extract failed: ${JSON.stringify(cleanExtract.violations)}`);
  assert.equal(cleanExtract.verdict, "faithful");

  const badExtract = verifyAiOutputFaithfulness(
    "resume_extraction",
    {
      ...SAMPLE_CANDIDATE,
      skills: ["TypeScript", "Kubernetes"],
      experience: [
        {
          id: "exp-x",
          company: "OpenAI",
          role: "Staff AI Architect",
          startDate: "2018",
          endDate: "2024",
          bullets: ["Cut inference spend by 90%"],
        },
      ],
    },
    { rawText: SAMPLE_RAW_RESUME }
  );
  assert.equal(badExtract.faithful, false);
  assert.equal(badExtract.verdict, "unfaithful");
  assert.ok(badExtract.violations.some((v) => v.kind === "employer_or_organization"));
  assert.ok(badExtract.violations.some((v) => v.kind === "numeric_metric"));

  const cleanLetter = verifyCoverLetterFaithfulness(
    "Dear Linear Systems team, at Acme Corp I built React and TypeScript interfaces and reduced bundle size by 35%. Reach me at alex.chen@example.com.",
    SAMPLE_CANDIDATE,
    SAMPLE_JOB
  );
  assert.equal(cleanLetter.faithful, true, `Clean letter failed: ${JSON.stringify(cleanLetter.violations)}`);

  const hallucinatedLetter = verifyCoverLetterFaithfulness(
    "Having worked at Stripe managing Kubernetes clusters, I cut outage recovery by 85%. Email alex.fake@evil.example.",
    SAMPLE_CANDIDATE,
    SAMPLE_JOB
  );
  assert.equal(hallucinatedLetter.faithful, false);
  assert.ok(hallucinatedLetter.violations.some((v) => v.kind === "skill_or_tool"));
  assert.ok(hallucinatedLetter.violations.some((v) => v.kind === "employer_or_organization"));
  assert.ok(hallucinatedLetter.violations.some((v) => v.kind === "contact_or_link"));

  const cleanFit = verifyMatchExplanationFaithfulness(
    {
      score: 86,
      matchedSkills: ["TypeScript", "React", "Next.js"],
      missingSkills: ["Kubernetes"],
      summary: "86% match driven by React and TypeScript experience at Acme Corp; lacks Kubernetes.",
    },
    SAMPLE_CANDIDATE,
    SAMPLE_JOB
  );
  assert.equal(cleanFit.faithful, true, `Clean fit failed: ${JSON.stringify(cleanFit.violations)}`);

  const badFit = verifyAiOutputFaithfulness(
    "job_fit",
    {
      score: 86,
      matchedSkills: ["Kubernetes"],
      missingSkills: ["React"],
      summary: "Strong Rust background with 9 years at Netflix.",
    },
    { candidate: SAMPLE_CANDIDATE, job: SAMPLE_JOB }
  );
  assert.equal(badFit.faithful, false);
  assert.ok(badFit.violations.some((v) => v.kind === "skill_contradiction"));
  assert.ok(badFit.violations.some((v) => v.kind === "skill_or_tool"));
  assert.ok(badFit.violations.some((v) => v.kind === "numeric_metric"));
  assert.ok(badFit.violations.some((v) => v.kind === "employer_or_organization"));
}

function testAdversarialCases() {
  // 1. Target job company claimed as candidate employment
  const case1 = verifyCoverLetterFaithfulness(
    "I worked at Google.",
    { skills: ["React"], experience: [{ id: "1", company: "Acme", role: "Engineer", bullets: [] }] },
    { title: "Engineer", company: "Google", description: "React" }
  );
  assert.equal(case1.faithful, false);
  assert.equal(case1.verdict, "unfaithful");
  assert.ok(case1.violations.some((v) => v.kind === "employer_or_organization" && v.claim === "Google"));

  // 2. Job title outside greeting/application span
  const case2 = verifyCoverLetterFaithfulness(
    "I am a Kubernetes Engineer.",
    { skills: ["React"] },
    { title: "Kubernetes Engineer", company: "CloudCo", description: "Kubernetes" }
  );
  assert.equal(case2.faithful, false);
  assert.equal(case2.verdict, "unfaithful");
  assert.ok(case2.checkedCount > 0);
  assert.ok(case2.violations.some((v) => v.kind === "skill_or_tool" && v.claim === "kubernetes"));

  // 3. JD number not laundered into candidate achievements
  const case3 = verifyCoverLetterFaithfulness(
    "I increased revenue by 80%.",
    { skills: ["React"], experience: [{ id: "1", company: "Acme", role: "Engineer", bullets: ["Shipped UI"] }] },
    { title: "Engineer", company: "ScaleCo", description: "Company revenue grew 80%." }
  );
  assert.equal(case3.faithful, false);
  assert.equal(case3.verdict, "unfaithful");
  assert.ok(case3.violations.some((v) => v.kind === "numeric_metric" && v.claim === "80%"));

  // 4. Match explanation subject ownership
  const case4 = verifyMatchExplanationFaithfulness(
    { matchedSkills: ["React"], missingSkills: ["Kubernetes"], summary: "Candidate has Kubernetes expertise." },
    { skills: ["React"] },
    { title: "DevOps", company: "CloudCo", description: "Requires React and Kubernetes." }
  );
  assert.equal(case4.faithful, false);
  assert.equal(case4.verdict, "unfaithful");
  assert.ok(case4.violations.some((v) => v.kind === "skill_or_tool" && v.claim === "kubernetes"));

  // 5. Negated/aspirational wording does not produce unsupported-skill error
  const case5 = verifyCoverLetterFaithfulness(
    "I have not used Kubernetes yet, and want to learn it.",
    { skills: ["React"], experience: [{ id: "1", company: "Acme", role: "Engineer", bullets: [] }] },
    { title: "Engineer", company: "CloudCo", description: "Kubernetes and React" }
  );
  assert.equal(case5.violations.some((v) => v.kind === "skill_or_tool"), false);
  assert.equal(case5.faithful, false);
  assert.equal(case5.verdict, "inconclusive");

  // 6. Resume extraction cross-employer reassignment caught
  const case6 = verifyResumeExtractionFaithfulness(
    {
      experience: [
        { id: "1", company: "Acme", role: "Director", startDate: "2022", bullets: ["Grew sales 80%"] },
      ],
    },
    "Acme Engineer 2020 UI 20%, Beta Director 2022 sales 80%"
  );
  assert.equal(case6.faithful, false);
  assert.equal(case6.verdict, "unfaithful");
  assert.ok(case6.violations.some((v) => v.kind === "cross_employer_relation"));

  // 7a. endDate Present when source ended 2021
  const case7a = verifyResumeExtractionFaithfulness(
    {
      experience: [
        { id: "1", company: "Acme", role: "Engineer", startDate: "2019", endDate: "Present", bullets: [] },
      ],
    },
    "Acme | Engineer | 2019 - 2021"
  );
  assert.equal(case7a.faithful, false);
  assert.equal(case7a.verdict, "unfaithful");
  assert.ok(case7a.violations.some((v) => v.kind === "date_or_year"));

  // 7b. Empty {} extracted or missing shape -> inconclusive, never faithful
  const case7b = verifyResumeExtractionFaithfulness({}, SAMPLE_RAW_RESUME);
  assert.equal(case7b.faithful, false);
  assert.equal(case7b.verdict, "inconclusive");
  assert.equal(case7b.checkedCount, 0);

  const case7c = verifyAiOutputFaithfulness("resume_extraction", null, { rawText: SAMPLE_RAW_RESUME });
  assert.equal(case7c.faithful, false);
  assert.equal(case7c.verdict, "inconclusive");
}

function main() {
  const checks: Array<[string, () => void]> = [
    ["design-doc-coverage", testDesignDocCoverage],
    ["not-wired-into-live-paths", testNotWiredIntoLivePaths],
    ["negative-control-subprocess", testNegativeControlSubprocess],
    ["behavioral-faithfulness", testBehavioralFaithfulness],
    ["adversarial-cases-1-to-7", testAdversarialCases],
  ];

  let passed = 0;
  for (const [name, fn] of checks) {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  }
  console.log(`faithfulness offline suite: ${passed}/${checks.length} checks passed.`);
}

main();
