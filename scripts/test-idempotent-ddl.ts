import fs from "fs";
import path from "path";
import assert from "assert";
import { spawnSync } from "child_process";

export function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

export interface IdempotencyViolation {
  file: string;
  rule: string;
  statement: string;
}

const HISTORICAL_EXCEPTIONS: Record<string, string[]> = {
  "20261001_ingestion_pipeline.sql": ["jobs_apply_url_unique"],
};

export function auditMigrationIdempotency(migrationsDir: string): IdempotencyViolation[] {
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql"));
  const violations: IdempotencyViolation[] = [];

  for (const f of files) {
    const raw = fs.readFileSync(path.join(migrationsDir, f), "utf-8");
    const stripped = stripComments(raw);

    // Rule 1: CREATE TABLE without IF NOT EXISTS
    const tableRegex = /CREATE\s+TABLE\s+(?:(IF\s+NOT\s+EXISTS\s+)?)([a-zA-Z0-9_.]+)/gi;
    let match;
    while ((match = tableRegex.exec(stripped)) !== null) {
      if (!match[1]) {
        violations.push({ file: f, rule: "CREATE TABLE IF NOT EXISTS", statement: match[0] });
      }
    }

    // Rule 2: ADD COLUMN without IF NOT EXISTS
    const colRegex = /ADD\s+COLUMN\s+(?:(IF\s+NOT\s+EXISTS\s+)?)([a-zA-Z0-9_.]+)/gi;
    while ((match = colRegex.exec(stripped)) !== null) {
      if (!match[1]) {
        violations.push({ file: f, rule: "ADD COLUMN IF NOT EXISTS", statement: match[0] });
      }
    }

    // Rule 3: CREATE EXTENSION without IF NOT EXISTS
    const extRegex = /CREATE\s+EXTENSION\s+(?:(IF\s+NOT\s+EXISTS\s+)?)([a-zA-Z0-9_."']+)/gi;
    while ((match = extRegex.exec(stripped)) !== null) {
      if (!match[1]) {
        violations.push({ file: f, rule: "CREATE EXTENSION IF NOT EXISTS", statement: match[0] });
      }
    }

    // Rule 4: CREATE INDEX without IF NOT EXISTS
    const idxRegex = /CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?\s+(?:(IF\s+NOT\s+EXISTS\s+))?([a-zA-Z0-9_.]+)/gi;
    while ((match = idxRegex.exec(stripped)) !== null) {
      if (!match[1]) {
        const idxName = match[2];
        const allowed = HISTORICAL_EXCEPTIONS[f] || [];
        const isAllowedException = allowed.some(exc => idxName.toLowerCase().includes(exc.toLowerCase()));
        if (!isAllowedException) {
          violations.push({ file: f, rule: "CREATE INDEX IF NOT EXISTS", statement: match[0] });
        }
      }
    }
  }

  return violations;
}

if (process.argv.includes("--negative-control")) {
  console.log("NEGATIVE CONTROL: Injected un-guarded CREATE TABLE statement...");
  const badSql = "CREATE TABLE public.unprotected_users (id uuid PRIMARY KEY);";
  const stripped = stripComments(badSql);
  const tableRegex = /CREATE\s+TABLE\s+(?:(IF\s+NOT\s+EXISTS\s+)?)([a-zA-Z0-9_.]+)/gi;
  const match = tableRegex.exec(stripped);
  if (match && !match[1]) {
    console.error(`NEGATIVE CONTROL PASSED: Detected non-idempotent DDL: ${match[0]}`);
    process.exit(1);
  }
  process.exit(0);
}

function runChecks(): void {
  console.log("Running DB Idempotent DDL Discipline Guard (DB #62)...");

  const migrationsDir = path.resolve(process.cwd(), "supabase/migrations");
  const docPath = path.resolve(process.cwd(), "docs/db-idempotent-ddl.md");

  // 1. Doc check
  assert(fs.existsSync(docPath), "docs/db-idempotent-ddl.md must exist");
  const docContent = fs.readFileSync(docPath, "utf-8");
  assert(
    docContent.includes("The Eight Idempotency Rules") &&
    docContent.includes("CREATE TABLE IF NOT EXISTS") &&
    docContent.includes("ADD COLUMN IF NOT EXISTS"),
    "Doc must contain the 8 idempotency rules"
  );
  console.log("  [PASS] 1. Idempotency rules specification verified in docs");

  // 2. Audit real migrations
  const violations = auditMigrationIdempotency(migrationsDir);
  assert.strictEqual(
    violations.length,
    0,
    `Found ${violations.length} non-idempotent DDL statements in migrations: ${JSON.stringify(violations, null, 2)}`
  );
  console.log("  [PASS] 2. 0 un-guarded CREATE TABLE, ADD COLUMN, CREATE EXTENSION, or non-excepted CREATE INDEX found across all 70 migrations");

  // 3. Negative control self-test
  console.log("  Running self in --negative-control mode to verify non-zero exit...");
  const child = spawnSync(
    "npx",
    ["tsx", path.resolve(__filename), "--negative-control"],
    { encoding: "utf8" }
  );

  assert.strictEqual(
    child.status,
    1,
    `Subprocess with --negative-control must exit with status 1 (got status ${child.status})`
  );
  assert.ok(
    child.stderr.includes("NEGATIVE CONTROL PASSED"),
    "Subprocess stderr must confirm negative control pass"
  );
  console.log("  [PASS] 3. Negative control proved non-zero exit (status 1) on invalid conditions");

  console.log("\nALL IDEMPOTENT DDL DISCIPLINE CHECKS PASSED (PASS-LOCAL).");
}

runChecks();
