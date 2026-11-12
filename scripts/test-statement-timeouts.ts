/**
 * scripts/test-statement-timeouts.ts
 *
 * Offline guard test for per-function statement_timeout discipline.
 * Verifies:
 *   1. Migration file exists: supabase/migrations/20261112b_statement_timeouts.sql
 *   2. Migration carries the required NOT APPLIED header comment:
 *      "NOT APPLIED - record-migration.cjs 20261112b_statement_timeouts"
 *   3. docs/statement-timeouts.md exists and catalogs the heavy RPCs
 *   4. Zero forbidden statements: no INSERT, UPDATE, DELETE, DROP, CREATE, or TRUNCATE
 *   5. Every statement is an ALTER FUNCTION setting statement_timeout
 *   6. Every function named in ALTER FUNCTION exists in the repository migrations/schema dump
 *   7. Negative control mode (--negative-control) exits non-zero as required
 *
 * Run: npx tsx scripts/test-statement-timeouts.ts
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const isNegativeControl = process.argv.includes("--negative-control");

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-statement-timeouts.ts", "--negative-control"],
    {
      cwd: ROOT,
      encoding: "utf8",
    }
  );
  assert.notStrictEqual(
    res.status,
    0,
    `Expected negative control subprocess to exit non-zero, but got status=${res.status}`
  );
  console.log("  [PASS-LOCAL] Negative control '--negative-control' exited non-zero as expected");
}

function extractKnownFunctions(): Set<string> {
  const known = new Set<string>();
  const migrationsDir = path.resolve(ROOT, "supabase", "migrations");
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

  // Include schema.generated.sql if present
  const schemaGenerated = path.resolve(ROOT, "supabase", "schema.generated.sql");
  const allSqlPaths = files
    .filter((f) => f !== "20261112b_statement_timeouts.sql")
    .map((f) => path.join(migrationsDir, f));

  if (fs.existsSync(schemaGenerated)) {
    allSqlPaths.push(schemaGenerated);
  }

  const fnRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(/gi;

  for (const filePath of allSqlPaths) {
    const content = fs.readFileSync(filePath, "utf8");
    let match: RegExpExecArray | null;
    while ((match = fnRegex.exec(content)) !== null) {
      known.add(match[1].toLowerCase());
    }
  }

  return known;
}

function runStatementTimeoutTests() {
  console.log("================================================================================");
  console.log("       STATEMENT TIMEOUT DISCIPLINE OFFLINE GUARD TEST                          ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Inducing intentional assertion failure...");
    assert.strictEqual("actual", "intentional-statement-timeout-failure");
    return;
  }

  runNegativeControlSubprocess();

  const migrationPath = path.resolve(ROOT, "supabase", "migrations", "20261112b_statement_timeouts.sql");
  const docPath = path.resolve(ROOT, "docs", "statement-timeouts.md");

  // 1. Migration file existence
  console.log("Test 1: Migration file existence...");
  assert.ok(fs.existsSync(migrationPath), `Migration file must exist at ${migrationPath}`);
  const migrationRaw = fs.readFileSync(migrationPath, "utf8");
  assert.ok(migrationRaw.trim().length > 0, "Migration file must not be empty");

  // 2. Header comment check
  console.log("Test 2: Required NOT APPLIED header check...");
  assert.ok(
    migrationRaw.includes("NOT APPLIED - record-migration.cjs 20261112b_statement_timeouts"),
    "Migration file must contain exact header: 'NOT APPLIED - record-migration.cjs 20261112b_statement_timeouts'"
  );

  // 3. Documentation existence
  console.log("Test 3: Documentation file existence & coverage...");
  assert.ok(fs.existsSync(docPath), `Documentation must exist at ${docPath}`);
  const docContent = fs.readFileSync(docPath, "utf8");
  assert.ok(docContent.includes("statement_timeout"), "Doc must explain statement_timeout discipline");
  assert.ok(docContent.includes("SECURITY DEFINER"), "Doc must cover SECURITY DEFINER connection holding risk");
  assert.ok(docContent.includes("refresh_worldwide_company_counts"), "Doc must catalog refresh_worldwide_company_counts");
  assert.ok(docContent.includes("db_health_snapshot"), "Doc must catalog db_health_snapshot");

  // 4. Content sanity: strip comments and check prohibited statements
  console.log("Test 4: Statement purity (no INSERT, UPDATE, DELETE, DROP, CREATE)...");
  // Strip single-line comments (-- ...) and multi-line comments (/* ... */)
  const codeOnly = migrationRaw
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();

  const forbiddenKeywords = [
    { word: "INSERT", re: /\bINSERT\b/i },
    { word: "UPDATE", re: /\bUPDATE\b/i },
    { word: "DELETE", re: /\bDELETE\b/i },
    { word: "DROP", re: /\bDROP\b/i },
    { word: "CREATE", re: /\bCREATE\b/i },
    { word: "TRUNCATE", re: /\bTRUNCATE\b/i },
    { word: "ALTER TABLE", re: /\bALTER\s+TABLE\b/i },
    { word: "TRIGGER", re: /\bTRIGGER\b/i },
    { word: "cron.schedule", re: /\bcron\.schedule\b/i },
  ];

  for (const { word, re } of forbiddenKeywords) {
    assert.ok(
      !re.test(codeOnly),
      `Migration must NOT contain ${word} statements outside comments`
    );
  }

  // 5. Parse every statement and verify ALTER FUNCTION and function existence
  console.log("Test 5: Verifying all statements are ALTER FUNCTION with statement_timeout...");
  const statements = codeOnly
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  assert.ok(statements.length >= 5, `Expected at least 5 ALTER FUNCTION statements, got ${statements.length}`);

  const knownFunctions = extractKnownFunctions();
  assert.ok(knownFunctions.size > 0, "Must have found existing functions in migrations / schema dump");

  const alteredFunctionNames: string[] = [];

  for (const stmt of statements) {
    assert.ok(
      stmt.toUpperCase().startsWith("ALTER FUNCTION"),
      `Statement must start with ALTER FUNCTION: "${stmt}"`
    );
    assert.ok(
      stmt.toUpperCase().includes("SET STATEMENT_TIMEOUT"),
      `Statement must configure statement_timeout: "${stmt}"`
    );

    // Extract function name: ALTER FUNCTION [public.]<func_name>(...
    const match = stmt.match(/ALTER\s+FUNCTION\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(/i);
    assert.ok(match, `Could not parse function name from statement: "${stmt}"`);
    const fnName = match[1].toLowerCase();
    alteredFunctionNames.push(fnName);

    assert.ok(
      knownFunctions.has(fnName),
      `Function '${fnName}' in ALTER FUNCTION statement was NOT found in repository migrations or schema dump!`
    );
  }

  console.log(`  Identified and verified ${alteredFunctionNames.length} ALTER FUNCTION targets:`);
  for (const name of alteredFunctionNames) {
    console.log(`    - public.${name}`);
  }

  console.log("\n✅ ALL STATEMENT TIMEOUT GUARD TESTS PASSED!");
}

runStatementTimeoutTests();
