/**
 * Integrity checks for scripts/suite-runner.ts (regression guard for the
 * rpc-retry misplacement found 2026-11-06, where a suite object was merged
 * into TEST_PROJECT_ALLOWLIST and the suite silently never ran).
 * Run: npx tsx scripts/test-suite-runner-integrity.ts
 */
import * as fs from "fs";

const { SUITES, TEST_PROJECT_ALLOWLIST } = require("./suite-runner.ts");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

// 1. The allowlist holds project-ref strings only - never suite objects.
check(
  "TEST_PROJECT_ALLOWLIST contains only strings",
  Array.isArray(TEST_PROJECT_ALLOWLIST) &&
    TEST_PROJECT_ALLOWLIST.every((e: unknown) => typeof e === "string")
);

// 2. Every registered suite name maps to a script file that exists.
const missing = (SUITES as { name: string }[])
  .map((s) => s.name.split(" ")[0])
  .filter((p) => !fs.existsSync(p));
check("every registered suite script exists", missing.length === 0);
if (missing.length > 0) console.log("  missing:", missing.join(", "));

// 3. The rpc-retry suite is actually registered in SUITES.
check(
  "rpc-retry suite registered in SUITES",
  (SUITES as { name: string }[]).some((s) => s.name.startsWith("scripts/test-rpc-retry.ts"))
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
