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
  for (const required of [
    "resume_extraction",
    "cover_letter",
    "job_fit",
    "validateAndSanitizeAiOutput",
    "executeAiCore",
    "Staged Rollout Order",
    "src/lib/ai/faithfulness.ts",
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
  assert.notEqual(
    result.status,
    0,
    "Subprocess negative-control run must exit non-zero"
  );
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
  // Helpers
  assert.deepEqual(extractTaxonomySkillsFromText("Ready to go and handle the rest of the work."), []);
  assert.ok(extractTaxonomySkillsFromText("Built Go APIs and REST endpoints").includes("go"));
  assert.deepEqual(extractNumericFactsFromText("10,000+ users and 35% faster"), ["10000+", "35%"]);

  // 1. resume_extraction grounded vs fabricated
  const cleanExtract = verifyResumeExtractionFaithfulness(SAMPLE_CANDIDATE, SAMPLE_RAW_RESUME);
  assert.equal(cleanExtract.faithful, true, `Clean extract failed: ${JSON.stringify(cleanExtract.violations)}`);

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
  assert.ok(badExtract.violations.some((v) => v.kind === "employer_or_organization"));
  assert.ok(badExtract.violations.some((v) => v.kind === "numeric_metric"));

  // 2. cover_letter grounded vs fabricated skill / employer / contact
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

  // 3. job_fit grounded vs contradiction / ungrounded matched skill
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

function main() {
  const checks: Array<[string, () => void]> = [
    ["design-doc-coverage", testDesignDocCoverage],
    ["not-wired-into-live-paths", testNotWiredIntoLivePaths],
    ["negative-control-subprocess", testNegativeControlSubprocess],
    ["behavioral-faithfulness", testBehavioralFaithfulness],
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
