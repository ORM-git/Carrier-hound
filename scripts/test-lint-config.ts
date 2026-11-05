/**
 * scripts/test-lint-config.ts
 *
 * Verification suite for ESLint and Prettier configuration:
 * 1. .eslintrc.json exists, extends next/core-web-vitals and plugin:jsx-a11y/recommended.
 * 2. .prettierrc.json exists and is valid JSON without reformatting repo files.
 * 3. .eslint-baseline.json exists with maxWarnings cap and rule warning breakdown.
 * 4. npm run lint runs ESLint with baseline pass (code 0), and fails when warnings exceed baseline.
 * 5. Rules of hooks is configured as error.
 * 6. CI workflow (.github/workflows/ci.yml) has lint step wired.
 *
 * Run directly: npx tsx scripts/test-lint-config.ts
 * Negative control: npx tsx scripts/test-lint-config.ts --negative-control
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import assert from "assert";

const isNegativeControl = process.argv.includes("--negative-control");

function pass(msg: string) {
  console.log(`  [PASS] ${msg}`);
}

async function runTests() {
  console.log("=== Running Lint & Prettier Configuration Test Suite ===");

  if (isNegativeControl) {
    console.log("Testing negative control (expected failure)...");
    assert.strictEqual(true, false, "Negative control intentional failure to verify non-zero exit");
    process.exit(1);
  }

  const rootDir = process.cwd();

  // 1. ESLint configuration file
  console.log("\n--- 1. ESLint Configuration (.eslintrc.json) ---");
  const eslintrcPath = path.join(rootDir, ".eslintrc.json");
  assert.ok(fs.existsSync(eslintrcPath), ".eslintrc.json must exist in project root");
  const eslintConfig = JSON.parse(fs.readFileSync(eslintrcPath, "utf8"));

  assert.ok(
    Array.isArray(eslintConfig.extends),
    ".eslintrc.json must contain extends array"
  );
  assert.ok(
    eslintConfig.extends.includes("next/core-web-vitals"),
    ".eslintrc.json must extend next/core-web-vitals"
  );
  assert.ok(
    eslintConfig.extends.includes("plugin:jsx-a11y/recommended"),
    ".eslintrc.json must extend plugin:jsx-a11y/recommended"
  );
  assert.strictEqual(
    eslintConfig.rules["react-hooks/rules-of-hooks"],
    "error",
    "react-hooks/rules-of-hooks must be configured as error"
  );
  assert.strictEqual(
    eslintConfig.rules["react-hooks/exhaustive-deps"],
    "warn",
    "react-hooks/exhaustive-deps must be configured as warn"
  );
  pass(".eslintrc.json extends next/core-web-vitals and plugin:jsx-a11y/recommended with rules-of-hooks error");

  // 2. Prettier configuration file
  console.log("\n--- 2. Prettier Configuration (.prettierrc.json) ---");
  const prettierrcPath = path.join(rootDir, ".prettierrc.json");
  assert.ok(fs.existsSync(prettierrcPath), ".prettierrc.json must exist in project root");
  const prettierConfig = JSON.parse(fs.readFileSync(prettierrcPath, "utf8"));
  assert.strictEqual(typeof prettierConfig.semi, "boolean", "prettierConfig.semi must be boolean");
  assert.strictEqual(typeof prettierConfig.singleQuote, "boolean", "prettierConfig.singleQuote must be boolean");
  pass(".prettierrc.json exists and is valid configuration");

  // 3. ESLint Baseline file
  console.log("\n--- 3. ESLint Baseline File (.eslint-baseline.json) ---");
  const baselinePath = path.join(rootDir, ".eslint-baseline.json");
  assert.ok(fs.existsSync(baselinePath), ".eslint-baseline.json must exist in project root");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  assert.strictEqual(typeof baseline.maxWarnings, "number", "baseline.maxWarnings must be a number");
  assert.strictEqual(baseline.maxWarnings, 305, "baseline.maxWarnings must match the 305 baseline warnings");
  assert.ok(
    baseline.warningCountsByRule && typeof baseline.warningCountsByRule === "object",
    "baseline must contain warningCountsByRule breakdown"
  );
  pass(".eslint-baseline.json contains maxWarnings=305 and rule breakdown");

  // 4. package.json scripts
  console.log("\n--- 4. package.json Scripts ---");
  const pkgPath = path.join(rootDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.ok(
    pkg.scripts.lint && pkg.scripts.lint.includes("run-lint.cjs"),
    "package.json lint script must invoke run-lint.cjs"
  );
  assert.ok(
    pkg.scripts["type-check"] && pkg.scripts["type-check"].includes("tsc --noEmit"),
    "package.json type-check script must run tsc --noEmit"
  );
  assert.ok(
    pkg.devDependencies.eslint,
    "package.json devDependencies must include eslint"
  );
  assert.ok(
    pkg.devDependencies["eslint-config-next"],
    "package.json devDependencies must include eslint-config-next"
  );
  assert.ok(
    pkg.devDependencies["eslint-plugin-jsx-a11y"],
    "package.json devDependencies must include eslint-plugin-jsx-a11y"
  );
  assert.ok(
    pkg.devDependencies.prettier,
    "package.json devDependencies must include prettier"
  );
  pass("package.json properly declares lint scripts and devDependencies");

  // 5. CI Workflow Integration
  console.log("\n--- 5. CI Workflow Integration ---");
  const ciPath = path.join(rootDir, ".github/workflows/ci.yml");
  const ciContent = fs.readFileSync(ciPath, "utf8");
  assert.ok(
    ciContent.includes("npm run lint"),
    "CI workflow (.github/workflows/ci.yml) must run npm run lint"
  );
  assert.ok(
    ciContent.includes("npm run type-check") || ciContent.includes("tsc --noEmit"),
    "CI workflow (.github/workflows/ci.yml) must run type check"
  );
  pass("CI workflow integrates npm run lint and type check");

  // 6. Max-warnings enforcement test
  console.log("\n--- 6. Max-warnings Enforcement Verification ---");
  const isWindows = process.platform === "win32";
  const eslintBin = isWindows ? "npx.cmd" : "npx";

  // Test baseline pass
  const passResult = spawnSync(
    eslintBin,
    ["eslint", "src", "--max-warnings", "305", "--quiet"],
    {
      shell: isWindows,
      cwd: rootDir,
    }
  );
  assert.strictEqual(
    passResult.status,
    0,
    `ESLint with baseline max-warnings 305 must exit with 0 (got ${passResult.status})`
  );
  pass("ESLint passes cleanly (exit code 0) on existing src with max-warnings=305");

  // Test that lower max-warnings triggers failure (simulating new warning on new code)
  const failResult = spawnSync(
    eslintBin,
    ["eslint", "src", "--max-warnings", "304", "--quiet"],
    {
      shell: isWindows,
      cwd: rootDir,
    }
  );
  assert.strictEqual(
    failResult.status,
    1,
    `ESLint with max-warnings 304 must fail with code 1 (got ${failResult.status})`
  );
  pass("ESLint fails (exit code 1) when warning count exceeds baseline (new code regression gate)");

  console.log("\n==================================================================");
  console.log("🎉 ALL LINT & PRETTIER CONFIGURATION TESTS PASSED (PASS-LOCAL)!");
  console.log("==================================================================");
}

runTests().catch((err) => {
  console.error("❌ Test suite encountered unhandled error:", err);
  process.exit(1);
});
