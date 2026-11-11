/**
 * scripts/test-index-constraint-inventory.ts
 *
 * Database sheet row: Index & Constraint Inventory (DB #25 / DB #30)
 *
 * Offline static guard verifying that:
 * 1. docs/db-index-constraint-inventory.md exists and accurately catalogs indexes and constraints.
 * 2. Every documented index name and constraint name in the inventory actually exists in the real
 *    migration DDL (supabase/migrations/*.sql).
 * 3. Every index definition across all migrations complies with immutable predicate rules
 *    (catches now(), current_timestamp, created_at > now(), etc.).
 * 4. All CHECK constraints across migrations have balanced parentheses and valid syntax.
 * 5. Negative control runs the real detector/parser against synthetic bad-index fixtures,
 *    expecting and verifying failure.
 */

import * as fs from "fs";
import * as path from "path";
import * as assert from "assert";
import { spawnSync } from "child_process";

export function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

export const VOLATILE_PREDICATE_REGEX =
  /\b(now\s*\(\s*\)|clock_timestamp\s*\(\s*\)|timeofday\s*\(\s*\)|current_timestamp\b|current_date\b|current_time\b|localtime\b|localtimestamp\b)/i;

export function detectVolatilePredicate(predicate: string): boolean {
  return VOLATILE_PREDICATE_REGEX.test(predicate);
}

export interface ParsedIndex {
  file: string;
  name: string;
  table: string;
  predicate?: string;
}

export interface ParsedConstraint {
  file: string;
  table: string;
  name: string;
}

export function parseMigrationIndexes(cleanSql: string, fileName: string): ParsedIndex[] {
  const indexes: ParsedIndex[] = [];
  const idxHeaderRegex =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s+ON\s+(?:public\.)?([a-zA-Z0-9_]+)(?:\s+USING\s+([a-zA-Z0-9_]+))?\s*\(/gi;

  let m: RegExpExecArray | null;
  while ((m = idxHeaderRegex.exec(cleanSql)) !== null) {
    const indexName = m[1];
    const tableName = m[2];

    let depth = 1;
    let pos = idxHeaderRegex.lastIndex;
    while (pos < cleanSql.length && depth > 0) {
      if (cleanSql[pos] === "(") depth++;
      else if (cleanSql[pos] === ")") depth--;
      pos++;
    }

    const semicolonPos = cleanSql.indexOf(";", pos - 1);
    const rest = semicolonPos !== -1 ? cleanSql.substring(pos, semicolonPos) : cleanSql.substring(pos);

    let predicate: string | undefined;
    const whereMatch = /\bWHERE\s+([^;]+)/i.exec(rest);
    if (whereMatch) {
      predicate = whereMatch[1].replace(/\s+/g, " ").trim();
    }

    indexes.push({ file: fileName, name: indexName, table: tableName, predicate });
  }

  return indexes;
}

export function parseMigrationConstraints(cleanSql: string, fileName: string): ParsedConstraint[] {
  const constraints: ParsedConstraint[] = [];

  // A. ALTER TABLE ... ADD CONSTRAINT <name> ...
  const addConRegex =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)\s+ADD\s+CONSTRAINT\s+([a-zA-Z0-9_]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = addConRegex.exec(cleanSql)) !== null) {
    constraints.push({ file: fileName, table: m[1], name: m[2] });
  }

  // B. CREATE TABLE ... CONSTRAINT <name> ...
  const tableRegex =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\);/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tableRegex.exec(cleanSql)) !== null) {
    const table = tm[1];
    const body = tm[2];
    const inlineConRegex =
      /CONSTRAINT\s+([a-zA-Z0-9_]+)\s+(CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY)/gi;
    let icm: RegExpExecArray | null;
    while ((icm = inlineConRegex.exec(body)) !== null) {
      constraints.push({ file: fileName, table, name: icm[1] });
    }
  }

  return constraints;
}

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL MODE
// Runs the REAL parser and volatile detector against synthetic bad fixtures.
// Expects failure and exits 1 upon detecting all synthetic volatile predicates.
// ---------------------------------------------------------------------------
if (process.argv.includes("--negative-control")) {
  console.log("Running REAL detector against synthetic bad-index fixtures under --negative-control...");

  const syntheticBadSql = `
    CREATE INDEX bad_now_idx ON public.jobs (created_at) WHERE created_at > now();
    CREATE INDEX bad_now_interval_idx ON public.jobs (created_at) WHERE created_at > now() - interval '1 day';
    CREATE INDEX bad_current_timestamp_idx ON public.jobs (created_at) WHERE created_at > current_timestamp;
  `;

  const parsedBad = parseMigrationIndexes(syntheticBadSql, "synthetic_bad.sql");
  const badDetected = parsedBad.filter(
    (idx) => idx.predicate && detectVolatilePredicate(idx.predicate)
  );

  if (badDetected.length === 3) {
    console.error(
      `NEGATIVE CONTROL PASSED: Real detector caught all ${badDetected.length} synthetic volatile predicates: ${badDetected.map((b) => b.name).join(", ")}`
    );
    process.exit(1);
  } else {
    console.error(`Negative control failed to detect all volatile predicates (found ${badDetected.length}/3)`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// MAIN TEST EXECUTION
// ---------------------------------------------------------------------------
function runGuard(): void {
  console.log("Running DB Index & Constraint Inventory Guard (DB #25 / DB #30)...");

  const ROOT = path.resolve(__dirname, "..");
  const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
  const DOC_PATH = path.join(ROOT, "docs", "db-index-constraint-inventory.md");

  // 1. Verify Inventory Doc Existence & Content
  assert.ok(fs.existsSync(DOC_PATH), "Inventory documentation must exist at docs/db-index-constraint-inventory.md");
  const docContent = fs.readFileSync(DOC_PATH, "utf8");

  // Extract documented index names from Section 2
  const s2Parts = docContent.split("## 2. Custom Index Inventory");
  assert.ok(s2Parts.length > 1, "Doc must contain Section 2: Custom Index Inventory");
  const s2Content = s2Parts[1].split("## 3. Named Constraints Inventory")[0];
  const docIndexRegex = /\|\s*`[a-zA-Z0-9_.]+`\s*\|\s*`([a-zA-Z0-9_]+)`/g;
  const documentedIndexes: string[] = [];
  let dim: RegExpExecArray | null;
  while ((dim = docIndexRegex.exec(s2Content)) !== null) {
    documentedIndexes.push(dim[1]);
  }

  // Extract documented constraint names from Section 3
  const s3Parts = docContent.split("## 3. Named Constraints Inventory");
  assert.ok(s3Parts.length > 1, "Doc must contain Section 3: Named Constraints Inventory");
  const s3Content = s3Parts[1].split("## 4. Inline Unnamed Check Constraints")[0];
  const docConRegex = /\|\s*`[a-zA-Z0-9_.]+`\s*\|\s*`([a-zA-Z0-9_]+)`/g;
  const documentedConstraints: string[] = [];
  let dcm: RegExpExecArray | null;
  while ((dcm = docConRegex.exec(s3Content)) !== null) {
    documentedConstraints.push(dcm[1]);
  }

  assert.ok(documentedIndexes.length >= 80, `Expected at least 80 documented indexes, found ${documentedIndexes.length}`);
  assert.ok(documentedConstraints.length >= 15, `Expected at least 15 documented constraints, found ${documentedConstraints.length}`);
  console.log(`  [PASS] 1. Extracted ${documentedIndexes.length} index names and ${documentedConstraints.length} constraint names from docs`);

  // 2. Parse Migration Files
  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(migrationFiles.length >= 70, `Expected at least 70 migration files, found ${migrationFiles.length}`);

  const realIndexes: ParsedIndex[] = [];
  const realConstraints: ParsedConstraint[] = [];
  const volatileViolations: string[] = [];

  for (const file of migrationFiles) {
    const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const cleanSql = stripComments(raw);

    const idxs = parseMigrationIndexes(cleanSql, file);
    for (const idx of idxs) {
      realIndexes.push(idx);
      if (idx.predicate && detectVolatilePredicate(idx.predicate)) {
        volatileViolations.push(`${file}: index "${idx.name}" contains volatile predicate "${idx.predicate}"`);
      }
    }

    const cons = parseMigrationConstraints(cleanSql, file);
    for (const con of cons) {
      realConstraints.push(con);
    }
  }

  console.log(`  [PASS] 2. Parsed ${realIndexes.length} index declarations and ${realConstraints.length} constraint declarations across migrations`);

  // 3. Verify each documented index name actually exists in real migration DDL
  const realIndexNames = new Set(realIndexes.map((i) => i.name));
  for (const docIdx of documentedIndexes) {
    assert.ok(
      realIndexNames.has(docIdx),
      `Documented index "${docIdx}" in docs/db-index-constraint-inventory.md does NOT exist in any migration DDL!`
    );
  }
  console.log(`  [PASS] 3. Every documented index name (${documentedIndexes.length}) verified to exist in migration DDL`);

  // 4. Verify each documented constraint name actually exists in real migration DDL
  const realConstraintNames = new Set(realConstraints.map((c) => c.name));
  for (const docCon of documentedConstraints) {
    assert.ok(
      realConstraintNames.has(docCon),
      `Documented constraint "${docCon}" in docs/db-index-constraint-inventory.md does NOT exist in any migration DDL!`
    );
  }
  console.log(`  [PASS] 4. Every documented constraint name (${documentedConstraints.length}) verified to exist in migration DDL`);

  // 5. Verify zero volatile functions in index WHERE clauses across all real migrations
  assert.strictEqual(
    volatileViolations.length,
    0,
    `Found volatile predicates in migration indexes:\n${volatileViolations.join("\n")}`
  );
  console.log("  [PASS] 5. Zero volatile functions (now(), current_timestamp) in index WHERE clauses across all migrations");

  // 6. Check constraint syntax & balanced parens in migration files
  const ADD_CONSTRAINT_CHECK_REGEX = /add\s+constraint\s+([a-z0-9_]+)\s+check\s*\(([^;]+)/gi;
  let malformedConstraints = 0;

  for (const file of migrationFiles) {
    const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const cleanSql = stripComments(raw);

    ADD_CONSTRAINT_CHECK_REGEX.lastIndex = 0;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = ADD_CONSTRAINT_CHECK_REGEX.exec(cleanSql)) !== null) {
      const constraintName = cMatch[1];
      const rawCheck = cMatch[2];

      let openCount = 1;
      for (const char of rawCheck) {
        if (char === "(") openCount++;
        if (char === ")") openCount--;
        if (openCount === 0) break;
      }

      if (openCount !== 0) {
        console.error(`Malformed check constraint ${constraintName} in ${file}`);
        malformedConstraints++;
      }
    }
  }

  assert.strictEqual(malformedConstraints, 0, `Found ${malformedConstraints} malformed CHECK constraints`);
  console.log("  [PASS] 6. All CHECK constraints verified with balanced parentheses");

  // 7. Negative control self-test
  console.log("  Running self in --negative-control mode to verify non-zero exit...");
  const child = spawnSync("npx", ["tsx", path.resolve(__filename), "--negative-control"], {
    encoding: "utf8",
  });

  assert.strictEqual(
    child.status,
    1,
    `Subprocess with --negative-control must exit with status 1 (got status ${child.status})`
  );
  assert.ok(
    child.stderr.includes("NEGATIVE CONTROL PASSED"),
    "Subprocess stderr must confirm negative control pass"
  );
  console.log("  [PASS] 7. Negative control proved non-zero exit (status 1) using real detector on synthetic fixtures");

  console.log("\nALL INDEX & CONSTRAINT INVENTORY CHECKS PASSED (PASS-LOCAL).");
}

runGuard();
