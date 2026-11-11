/**
 * Backend sheet row "Prompt Template Versioning" (PARTIAL: "prompts versioned in
 * git; no registry or per-prompt rollback"). Snapshot guard for the four AI
 * operations built by buildOperationPayload (src/lib/ai/security.ts).
 *
 * For a fixed fixture, each operation's full request (system + user messages and
 * model, temperature, maxOutputTokens, jsonMode) is hashed with SHA-256 and compared
 * with the table below. Any prompt or model-setting change makes this test fail until
 * the author bumps `version` and updates `sha256` in the SAME PR, so prompt changes are
 * always deliberate, visible in review, and traceable by version.
 *
 * This is a change-control guard, not a runtime registry: nothing here selects a
 * prompt version at runtime and there is no per-prompt rollback (rollback = git revert).
 * It says nothing about prompt quality.
 * Run: npx tsx scripts/test-prompt-template-versions.ts
 */
import * as crypto from "crypto";
import { buildOperationPayload, OPERATION_CONFIGS, AllowedAiOperation } from "../src/lib/ai/security";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const candidate: any = {
  name: "Dana Rao", email: "dana@example.com", phone: "555-123-4567", location: "Pune", headline: "Software Engineer",
  summary: "Builds reliable APIs.", skills: ["TypeScript", "Python", "SQL"], certifications: [], updatedAt: "2026-11-07T00:00:00Z",
  experience: [{ id: "exp-1", company: "Acme Corp", role: "Software Engineer", startDate: "2020", endDate: "2024", bullets: ["Built APIs used by 40 teams", "Cut latency by 30%"] }],
  education: [{ id: "edu-1", degree: "BSc Computer Science", institution: "State University", year: "2019" }],
};
const job = { id: "job-1", title: "Backend Engineer", company: "Initech", description: "Build and run backend services in TypeScript." };
const PARAMS: Record<AllowedAiOperation, any> = {
  cover_letter: { candidate, job },
  resume_extraction: { rawText: "Dana Rao\nSoftware Engineer at Acme Corp 2020-2024\nSkills: TypeScript, Python" },
  resume_tailor: { candidate, job },
  job_fit: { candidate, job },
};

// Bump `version` and update `sha256` together whenever a prompt or setting changes on purpose.
const REGISTRY: Record<AllowedAiOperation, { version: string; sha256: string }> = {
  cover_letter: { version: "2", sha256: "bca8533bf3a86845b0673fe8e4252b4faff25f3e89719664b673840680d4e92e" },
  resume_extraction: { version: "2", sha256: "7e0a560fe264681dbf0a522411d341b6fadd275633d67bac3b83ff65e6e59639" },
  resume_tailor: { version: "2", sha256: "5ed5e8f2eb8541fcdab466a350783e6e95b55742bf5dab57d59dc33a4611fbd8" },
  job_fit: { version: "2", sha256: "e12fdd764ad9ef4ff2ceb4b2542718d7e2cf86786e322991812d0311af51a0cd" },
};

function fingerprint(op: AllowedAiOperation): string | null {
  const built = buildOperationPayload(OPERATION_CONFIGS[op], PARAMS[op]);
  if (!built.ok) return null;
  const p = built.payload;
  const canonical = JSON.stringify({ messages: p.messages, model: p.model, temperature: p.temperature, maxOutputTokens: p.maxOutputTokens, jsonMode: p.jsonMode });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

const ops = Object.keys(REGISTRY) as AllowedAiOperation[];
ops.forEach((op) => {
  const fp = fingerprint(op);
  if (process.env.PRINT_PROMPT_HASHES) console.log(`HASH ${op} ${fp}`);
  check(`${op}: fixture builds a payload`, fp !== null);
  check(`${op}: prompt + settings match registry v${REGISTRY[op].version} (changed on purpose? bump version and update sha256)`, fp === REGISTRY[op].sha256);
  check(`${op}: version is a positive integer string`, /^[1-9][0-9]*$/.test(REGISTRY[op].version));
});
check("registry covers every configured operation", Object.keys(OPERATION_CONFIGS).sort().join(",") === ops.slice().sort().join(","));
check("fingerprint is deterministic", fingerprint("job_fit") === fingerprint("job_fit"));
const a = fingerprint("cover_letter");
const alt = buildOperationPayload(OPERATION_CONFIGS.cover_letter, { candidate: { ...candidate, name: "Other Name" }, job });
check("fingerprint reacts to the input (fixture self-test)", alt.ok && a !== null && crypto.createHash("sha256").update(JSON.stringify({ messages: alt.payload.messages, model: alt.payload.model, temperature: alt.payload.temperature, maxOutputTokens: alt.payload.maxOutputTokens, jsonMode: alt.payload.jsonMode })).digest("hex") !== a);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
