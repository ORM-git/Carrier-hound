/**
 * Offline behavioral test for Feature Flags System (Backend sheet row 48: Feature Flags).
 *
 * Verifies runtime snapshot generation, scope filtering, strict vs truthy rule enforcement,
 * and typo protection.
 *
 * Run: npx tsx scripts/test-feature-flags-system.ts
 * Run negative control: npx tsx scripts/test-feature-flags-system.ts --negative-control (exits 1)
 */

import {
  FLAGS,
  isFlagEnabled,
  getFeatureFlagsSnapshot,
  getFlagsByScope,
  isKnownFeatureFlag,
} from "../src/lib/flags/flags";

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

// 1. Snapshot generation with default empty env
const emptyEnv: Record<string, string | undefined> = {};
const defaultSnapshot = getFeatureFlagsSnapshot(emptyEnv);
check("snapshot returns an entry for every registered flag", Object.keys(defaultSnapshot).length === FLAGS.length);
check("all default flag values evaluate to false", Object.values(defaultSnapshot).every((v) => v === false));

// 2. Strict true rule evaluation
const strictFlag = "NEXT_PUBLIC_BILLING_ENABLED";
check("strict flag is false with empty env", isFlagEnabled(strictFlag, emptyEnv) === false);
check("strict flag is true with exact 'true'", isFlagEnabled(strictFlag, { [strictFlag]: "true" }) === true);
check("strict flag is false with '1'", isFlagEnabled(strictFlag, { [strictFlag]: "1" }) === false);
check("strict flag is false with 'yes'", isFlagEnabled(strictFlag, { [strictFlag]: "yes" }) === false);
check("strict flag is false with 'TRUE' (strict lowercase requirement)", isFlagEnabled(strictFlag, { [strictFlag]: "TRUE" }) === false);

// 3. Truthy words rule evaluation (AI_GLOBAL_DISABLE)
const truthyFlag = "AI_GLOBAL_DISABLE";
check("truthy flag is false with empty env", isFlagEnabled(truthyFlag, emptyEnv) === false);
check("truthy flag is true with 'true'", isFlagEnabled(truthyFlag, { [truthyFlag]: "true" }) === true);
check("truthy flag is true with '1'", isFlagEnabled(truthyFlag, { [truthyFlag]: "1" }) === true);
check("truthy flag is true with 'yes'", isFlagEnabled(truthyFlag, { [truthyFlag]: "yes" }) === true);
check("truthy flag is true with 'on'", isFlagEnabled(truthyFlag, { [truthyFlag]: "on" }) === true);
check("truthy flag is true with ' YES ' (trimmed, case-insensitive)", isFlagEnabled(truthyFlag, { [truthyFlag]: " YES " }) === true);
check("truthy flag is false with '0'", isFlagEnabled(truthyFlag, { [truthyFlag]: "0" }) === false);
check("truthy flag is false with 'false'", isFlagEnabled(truthyFlag, { [truthyFlag]: "false" }) === false);

// 4. Typo protection: unknown flag throws
let threw = false;
try {
  isFlagEnabled("UNKNOWN_NONEXISTENT_FLAG", emptyEnv);
} catch {
  threw = true;
}
check("isFlagEnabled throws for unknown flag name to prevent silent typos", threw === true);

// 5. Scope filtering
const serverFlags = getFlagsByScope("server");
const publicFlags = getFlagsByScope("public-build");
check("server flags returned by scope filter", serverFlags.length > 0 && serverFlags.every((f) => f.scope === "server"));
check("public flags returned by scope filter", publicFlags.length > 0 && publicFlags.every((f) => f.scope === "public-build"));
check("scope union covers all registered flags", serverFlags.length + publicFlags.length === FLAGS.length);

// 6. Validation helper
check("isKnownFeatureFlag returns true for valid flag", isKnownFeatureFlag("NEXT_PUBLIC_BILLING_ENABLED") === true);
check("isKnownFeatureFlag returns false for invalid flag", isKnownFeatureFlag("FAKE_FLAG_NAME") === false);

// 7. Negative control
if (isNegativeControl) {
  console.log("NEGATIVE CONTROL: injecting deliberate assertion failure");
  check("negative control forced failure", false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
