/**
 * scripts/test-statement-timeouts.ts
 *
 * Offline guard test for statement timeout discipline.
 * Verifies:
 *   1. Migration file exists: supabase/migrations/20261112b_statement_timeouts.sql
 *   2. Migration carries the required NOT APPLIED header comment:
 *      "NOT APPLIED - record-migration.cjs 20261112b_statement_timeouts"
 *   3. docs/statement-timeouts.md exists, distinguishes invocation routes (REST RPC, direct, pg_cron),
 *      notes retention-cron.ts and ingest.ts use REST, confirms ALTER FUNCTION statement_timeout
 *      IS supported for REST RPCs, covers reindex loop/rollback mechanics and REST 60s bounds,
 *      removes unverified p99s, explains RESET inheritance, and includes PostgREST config reload note.
 *   4. Zero forbidden statements: no INSERT, UPDATE, DELETE, DROP, CREATE, TRUNCATE, or ALTER TABLE.
 *   5. Zero ALTER ROLE statements: no broad role ceilings added to service_role or reasserted on authenticator.
 *   6. Exact argument signatures: Every ALTER FUNCTION specifies exact argument signatures matching
 *      the canonical defining migrations.
 *   7. Rollback block: Contains exact rollback commands, restores previous proconfig for
 *      db_health_snapshot (SET statement_timeout = '5s' preserved from 20261108b, NOT RESET blindly).
 *   8. Negative control mode (--negative-control) exits non-zero as required.
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

/** Canonical list of heavy RPC targets and their exact argument signatures in PostgreSQL */
const CANONICAL_TARGETS: Record<string, string> = {
  refresh_worldwide_company_counts: "()",
  db_health_snapshot: "()",
  analyze_after_ingest: "()",
  dedupe_jobs_by_role: "(boolean)",
  archive_expired_jobs: "(boolean, interval)",
  reindex_bloated_indexes: "(integer, boolean)",
  purge_operational_logs: "(boolean)",
  purge_row_change_history: "(boolean)",
  purge_soft_deleted_account_data: "(interval)",
  outbox_claim_batch: "(text, integer, integer, text)",
  cleanup_expired_rate_limits: "()",
  check_rate_limit: "(text, integer, integer)",
  claim_search_alert_window: "(uuid, integer)",
  release_search_alert_window: "(uuid, timestamptz)",
};

function normalizeSignature(sig: string): string {
  return sig.replace(/\s+/g, " ").trim().toLowerCase();
}

function runStatementTimeoutTests() {
  console.log("================================================================================");
  console.log("       STATEMENT TIMEOUT DISCIPLINE & INVOCATION ARCHITECTURE GUARD TEST        ");
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

  // 3. Documentation existence & coverage
  console.log("Test 3: Documentation file existence & coverage...");
  assert.ok(fs.existsSync(docPath), `Documentation must exist at ${docPath}`);
  const docContent = fs.readFileSync(docPath, "utf8");
  assert.ok(docContent.includes("statement_timeout"), "Doc must explain statement_timeout discipline");
  assert.ok(docContent.includes("SECURITY DEFINER"), "Doc must cover SECURITY DEFINER connection holding risk");
  assert.ok(docContent.includes("retention-cron.ts"), "Doc must identify retention-cron.ts as using REST RPC");
  assert.ok(docContent.includes("ingest.ts"), "Doc must identify ingest.ts as using REST RPC");
  assert.ok(
    docContent.includes("IS fully supported and effective for REST RPC calls") ||
      docContent.includes("is supported and effective for REST RPC calls"),
    "Doc must affirm that function-level statement_timeout is supported for REST RPC calls"
  );
  assert.ok(docContent.includes("Direct PostgreSQL Connection"), "Doc must distinguish direct connection route");
  assert.ok(docContent.includes("pg_cron"), "Doc must distinguish pg_cron background route");
  assert.ok(docContent.includes("60 seconds") || docContent.includes("60s"), "Doc must note Supabase REST 60s gateway bound");
  assert.ok(docContent.includes("reindex_bloated_indexes"), "Doc must catalog reindex_bloated_indexes");
  assert.ok(docContent.includes("57014"), "Doc must explain 57014 cancellation code and rollback");
  assert.ok(
    !/Normal p99/i.test(docContent),
    "Doc must NOT claim unverified 'Normal p99' measurements without provenance"
  );
  assert.ok(
    docContent.includes("NOTIFY pgrst, 'reload config'"),
    "Doc runbook must include PostgREST config reload note (NOTIFY pgrst, 'reload config')"
  );
  assert.ok(
    docContent.includes("Pre-Apply Capture") || docContent.includes("pre-apply"),
    "Doc runbook must include pre-apply capture step"
  );

  // 4. Content sanity: strip comments and check prohibited statements
  console.log("Test 4: Statement purity (no INSERT, UPDATE, DELETE, DROP, CREATE, TRUNCATE, ALTER ROLE)...");
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
    { word: "ALTER ROLE", re: /\bALTER\s+ROLE\b/i },
    { word: "TRIGGER", re: /\bTRIGGER\b/i },
    { word: "cron.schedule", re: /\bcron\.schedule\b/i },
  ];

  for (const { word, re } of forbiddenKeywords) {
    assert.ok(
      !re.test(codeOnly),
      `Migration must NOT contain ${word} statements outside comments`
    );
  }

  // 5. Parse every statement and verify ALTER FUNCTION with exact argument signatures
  console.log("Test 5: Verifying all statements are ALTER FUNCTION with exact signatures...");
  const statements = codeOnly
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  assert.strictEqual(
    statements.length,
    Object.keys(CANONICAL_TARGETS).length,
    `Expected exactly ${Object.keys(CANONICAL_TARGETS).length} ALTER FUNCTION statements, got ${statements.length}`
  );

  const foundTargets = new Set<string>();

  for (const stmt of statements) {
    assert.ok(
      stmt.toUpperCase().startsWith("ALTER FUNCTION"),
      `Statement must start with ALTER FUNCTION: "${stmt}"`
    );
    assert.ok(
      stmt.toUpperCase().includes("SET STATEMENT_TIMEOUT"),
      `Statement must configure statement_timeout: "${stmt}"`
    );

    // Extract function name and arguments: ALTER FUNCTION [public.]<name>(<args>) SET ...
    const match = stmt.match(/ALTER\s+FUNCTION\s+(?:public\.)?([a-zA-Z0-9_]+)\s*(\([^)]*\))\s+SET/i);
    assert.ok(match, `Could not parse function name and argument signature from statement: "${stmt}"`);
    const fnName = match[1].toLowerCase();
    const args = normalizeSignature(match[2]);

    assert.ok(
      fnName in CANONICAL_TARGETS,
      `Unexpected function '${fnName}' in ALTER FUNCTION statement!`
    );

    const expectedArgs = normalizeSignature(CANONICAL_TARGETS[fnName]);
    assert.strictEqual(
      args,
      expectedArgs,
      `Argument signature mismatch for '${fnName}': expected '${expectedArgs}', got '${args}'`
    );

    // reindex_bloated_indexes must fit the Supabase REST bound (60s)
    if (fnName === "reindex_bloated_indexes") {
      assert.ok(
        /SET\s+statement_timeout\s*=\s*'60s'/i.test(stmt),
        "reindex_bloated_indexes must be set to '60s' to fit Supabase REST gateway bound"
      );
    }

    foundTargets.add(fnName);
  }

  assert.strictEqual(
    foundTargets.size,
    Object.keys(CANONICAL_TARGETS).length,
    "All canonical heavy RPC functions must have ALTER FUNCTION statements"
  );
  console.log(`  Identified and verified ${foundTargets.size} ALTER FUNCTION targets with exact argument signatures:`);
  for (const name of foundTargets) {
    console.log(`    - public.${name}${CANONICAL_TARGETS[name]}`);
  }

  // 6. Rollback Block & Exact proconfig restoration
  console.log("Test 6: Rollback block presence, exact proconfig preservation, and no unbounded claims...");
  assert.ok(
    /--\s*=+\s*\n--\s*ROLLBACK\s+INSTRUCTIONS/i.test(migrationRaw),
    "Migration must contain commented ROLLBACK INSTRUCTIONS block"
  );

  const rollbackIdx = migrationRaw.search(/--\s*ROLLBACK/i);
  assert.ok(rollbackIdx !== -1, "Must find ROLLBACK block in migration");
  const rollbackText = migrationRaw.slice(rollbackIdx);

  // Must not claim RESET restores an unbounded baseline
  assert.ok(
    !/RESET restores an unbounded baseline/i.test(rollbackText),
    "Rollback must NOT claim that RESET restores an unbounded baseline"
  );

  // db_health_snapshot exact proconfig preservation: MUST NOT RESET BLINDLY!
  assert.ok(
    !/ALTER\s+FUNCTION\s+(?:public\.)?db_health_snapshot\s*\(\s*\)\s+RESET\s+statement_timeout/i.test(rollbackText),
    "Rollback must NOT reset db_health_snapshot blindly! It must restore its 5s setting from 20261108b"
  );
  assert.ok(
    /ALTER\s+FUNCTION\s+(?:public\.)?db_health_snapshot\s*\(\s*\)\s+SET\s+statement_timeout\s*=\s*'5s'/i.test(rollbackText),
    "Rollback must restore db_health_snapshot statement_timeout = '5s' (preserving 20261108b)"
  );

  // Verify all other 13 functions are present in rollback with exact signatures
  for (const [fnName, sig] of Object.entries(CANONICAL_TARGETS)) {
    if (fnName === "db_health_snapshot") continue;
    const escapedSig = sig.replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/,/g, "\\s*,\\s*");
    const re = new RegExp(`ALTER\\s+FUNCTION\\s+(?:public\\.)?${fnName}\\s*${escapedSig}\\s+RESET\\s+statement_timeout`, "i");
    assert.ok(
      re.test(rollbackText),
      `Rollback must contain RESET statement_timeout for '${fnName}${sig}'`
    );
  }

  console.log("\n✅ ALL STATEMENT TIMEOUT GUARD TESTS PASSED!");
}

runStatementTimeoutTests();
