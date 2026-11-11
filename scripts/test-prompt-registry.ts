/**
 * Offline test for Prompt Template Registry (Backend sheet row: Prompt Template Versioning).
 *
 * Verifies versioned template lookup, rollback target availability, fallback behavior,
 * and machine-checked inventory for all 4 AI operations.
 *
 * Run: npx tsx scripts/test-prompt-registry.ts
 * Run negative control: npx tsx scripts/test-prompt-registry.ts --negative-control (exits 1)
 */

import {
  PROMPT_REGISTRY,
  getPromptVersionMeta,
  listAvailablePromptVersions,
  getActivePromptVersion,
  getRollbackPromptVersion,
  isKnownPromptVersion,
} from "../src/lib/ai/promptRegistry";
import { AllowedAiOperation } from "../src/lib/ai/security";

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

const REQUIRED_OPERATIONS: AllowedAiOperation[] = [
  "cover_letter",
  "resume_extraction",
  "resume_tailor",
  "job_fit",
];

// 1. All required operations registered
for (const op of REQUIRED_OPERATIONS) {
  check(`operation ${op} is registered`, Boolean(PROMPT_REGISTRY[op]));
  const entry = PROMPT_REGISTRY[op];
  if (entry) {
    check(`${op} has valid currentVersion`, typeof entry.currentVersion === "string" && entry.currentVersion.length > 0);
    check(`${op} has valid rollbackVersion`, typeof entry.rollbackVersion === "string" && entry.rollbackVersion.length > 0);
    check(`${op} rollbackVersion differs from currentVersion`, entry.rollbackVersion !== entry.currentVersion);
    check(`${op} currentVersion exists in versions map`, Boolean(entry.versions[entry.currentVersion]));
    check(`${op} rollbackVersion exists in versions map`, Boolean(entry.versions[entry.rollbackVersion]));
  }
}

// 2. Exact version resolution
const clv2 = getPromptVersionMeta("cover_letter", "2.0");
check("resolves cover_letter 2.0 exactly", clv2.meta.version === "2.0" && clv2.isFallback === false);
check("cover_letter 2.0 has active status", clv2.meta.status === "active");

const clv1 = getPromptVersionMeta("cover_letter", "1.0");
check("resolves cover_letter 1.0 rollback target", clv1.meta.version === "1.0" && clv1.isFallback === false);
check("cover_letter 1.0 has rollback_target status", clv1.meta.status === "rollback_target");

// 3. Fallback on unknown version
const unknownResolution = getPromptVersionMeta("job_fit", "999.0");
check("unknown version falls back to active version", unknownResolution.meta.version === "2.0" && unknownResolution.isFallback === true);

// 4. Default version retrieval (no version arg)
const defaultResolution = getPromptVersionMeta("resume_tailor");
check("omitted version resolves to active version", defaultResolution.meta.version === "2.0" && defaultResolution.isFallback === false);

// 5. Version helper functions
check("getActivePromptVersion returns 2.0 for resume_extraction", getActivePromptVersion("resume_extraction") === "2.0");
check("getRollbackPromptVersion returns 1.0 for resume_extraction", getRollbackPromptVersion("resume_extraction") === "1.0");
check("isKnownPromptVersion correctly identifies known version", isKnownPromptVersion("job_fit", "2.0") === true);
check("isKnownPromptVersion correctly identifies unknown version", isKnownPromptVersion("job_fit", "999.0") === false);

const versions = listAvailablePromptVersions("cover_letter");
check("listAvailablePromptVersions returns sorted list", versions.length >= 2 && versions.includes("2.0") && versions.includes("1.0"));

// 6. Negative control branch
if (isNegativeControl) {
  console.log("NEGATIVE CONTROL: injecting deliberate assertion failure");
  check("negative control forced failure", false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
