import fs from "fs";
import path from "path";
import assert from "assert";
import { spawnSync } from "child_process";

export function findBareTimestamps(sqlContent: string, fileName = ""): Array<{ file: string; line: number; text: string }> {
  const violations: Array<{ file: string; line: number; text: string }> = [];
  const lines = sqlContent.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Ignore comment lines
    if (trimmed.startsWith("--")) continue;

    // Detect bare TIMESTAMP or TIMESTAMP WITHOUT TIME ZONE (not timestamptz or clock_timestamp())
    // Match patterns like: "col_name TIMESTAMP," or "col_name TIMESTAMP NOT NULL" or "TIMESTAMP WITHOUT TIME ZONE"
    if (/\bTIMESTAMP\s+WITHOUT\s+TIME\s+ZONE\b/i.test(trimmed)) {
      violations.push({ file: fileName, line: i + 1, text: trimmed });
      continue;
    }

    // Match column definition: column_name TIMESTAMP (excluding timestamptz and clock_timestamp)
    const match = /\b[a-zA-Z0-9_]+\s+TIMESTAMP\b(?!\s*\(|\s*tz)/i.exec(trimmed);
    if (match) {
      // Exclude function calls like clock_timestamp()
      if (!/clock_timestamp\s*\(/i.test(trimmed)) {
        violations.push({ file: fileName, line: i + 1, text: trimmed });
      }
    }
  }

  return violations;
}

if (process.argv.includes("--negative-control")) {
  console.log("NEGATIVE CONTROL: Injected synthetic bare TIMESTAMP column declaration...");
  const badSql = "CREATE TABLE public.bad_temporal (id uuid, created_at TIMESTAMP DEFAULT now());";
  const violations = findBareTimestamps(badSql, "bad_temporal.sql");
  if (violations.length > 0) {
    console.error(`NEGATIVE CONTROL PASSED: Detected prohibited bare TIMESTAMP: ${violations[0].text}`);
    process.exit(1);
  }
  process.exit(0);
}

function runChecks(): void {
  console.log("Running PostgreSQL TIMESTAMPTZ Storage Discipline Guard...");

  const migrationsDir = path.resolve(process.cwd(), "supabase/migrations");
  const docPath = path.resolve(process.cwd(), "docs/db-timestamptz-storage.md");

  // 1. Doc check
  assert(fs.existsSync(docPath), "docs/db-timestamptz-storage.md must exist");
  const docContent = fs.readFileSync(docPath, "utf-8");
  assert(
    docContent.includes("information_schema.columns") &&
    docContent.includes("data_type = 'timestamp without time zone'"),
    "Doc must contain the production read-only audit query"
  );
  console.log("  [PASS] 1. Production audit query present in docs");

  // 2. Scan all migrations for bare timestamps
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql"));
  assert(files.length >= 70, `Expected at least 70 migration files, found ${files.length}`);

  let totalViolations: Array<{ file: string; line: number; text: string }> = [];
  let timestamptzCount = 0;

  for (const f of files) {
    const content = fs.readFileSync(path.join(migrationsDir, f), "utf-8");
    const violations = findBareTimestamps(content, f);
    if (violations.length > 0) {
      totalViolations = totalViolations.concat(violations);
    }

    // Count timestamptz declarations
    const tzs = content.match(/\btimestamptz\b/gi);
    if (tzs) timestamptzCount += tzs.length;
  }

  assert.strictEqual(
    totalViolations.length,
    0,
    `Found ${totalViolations.length} bare TIMESTAMP column definitions in migrations! All must be TIMESTAMPTZ.`
  );
  console.log(`  [PASS] 2. 0 bare TIMESTAMP columns found across ${files.length} migration files`);
  console.log(`  [PASS] 3. Verified ${timestamptzCount} TIMESTAMPTZ declarations across schema`);

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
  console.log("  [PASS] 4. Negative control proved non-zero exit (status 1) on invalid conditions");

  console.log("\nALL TIMESTAMPTZ STORAGE DISCIPLINE CHECKS PASSED (PASS-LOCAL).");
}

runChecks();
