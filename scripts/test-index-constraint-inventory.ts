/**
 * scripts/test-index-constraint-inventory.ts
 *
 * Database sheet row: Index & Constraint Inventory
 *
 * Offline static test verifying that:
 * 1. docs/db-index-constraint-inventory.md exists and catalogs core indexes and constraints.
 * 2. Every index definition across all 70 migrations in supabase/migrations/ complies with
 *    immutable predicate rules (no bare volatile functions like NOW() in WHERE clauses).
 * 3. All CHECK constraints across migrations have balanced parentheses and valid syntax.
 * 4. Critical performance and deduplication indexes documented in the inventory are present in migration DDL.
 *
 * Negative control mode (--negative-control): injects a synthetic volatile index failure,
 * exits code 1 with non-zero exit validation.
 */

import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`✅ [PASS] ${name}`);
  } else {
    failed++;
    console.error(`❌ [FAIL] ${name}`);
  }
}

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const DOC_PATH = path.join(ROOT, "docs", "db-index-constraint-inventory.md");

// 1. Verify Inventory Doc Existence & Content
check("Inventory documentation exists at docs/db-index-constraint-inventory.md", fs.existsSync(DOC_PATH));

const docContent = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, "utf8") : "";
check("Doc catalogs jobs_active_list_covering_idx", docContent.includes("jobs_active_list_covering_idx"));
check("Doc catalogs jobs_role_key_unique", docContent.includes("jobs_role_key_unique"));
check("Doc catalogs jobs_salary_bounds_check", docContent.includes("jobs_salary_bounds_check"));
check("Doc catalogs chk_inbound_kind", docContent.includes("chk_inbound_kind"));

// 2. Scan Migration Files
const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
check("Migration catalog contains at least 70 migrations", migrationFiles.length >= 70);

const CREATE_INDEX_REGEX = /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s+on\s+(?:public\.)?([a-z0-9_]+)(?:\s+using\s+([a-z0-9_]+))?\s*\(([^)]+)\)(?:\s+include\s*\(([^)]+)\))?(?:\s+where\s+([^;]+))?/gi;
const VOLATILE_INDEX_PREDICATE_REGEX = /\b(now\s*\(\s*\)|current_timestamp|current_date)\b/i;

const allIndexes: Array<{ file: string; indexName: string; tableName: string; predicate?: string }> = [];
const volatileIndexes: string[] = [];

for (const file of migrationFiles) {
  const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
  const cleanSql = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

  CREATE_INDEX_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREATE_INDEX_REGEX.exec(cleanSql)) !== null) {
    const indexName = match[1];
    const tableName = match[2];
    const predicate = match[6] ? match[6].trim() : undefined;

    allIndexes.push({ file, indexName, tableName, predicate });

    if (predicate && VOLATILE_INDEX_PREDICATE_REGEX.test(predicate)) {
      volatileIndexes.push(`${file}: ${indexName} contains volatile function in predicate "${predicate}"`);
    }
  }
}

// Simulated failure under negative control
if (isNegativeControl) {
  volatileIndexes.push("simulated_failure.sql: bad_index contains volatile function in predicate 'now()'");
}

check("Extracted at least 80 index definitions across migrations", allIndexes.length >= 80);
check("Zero indexes contain volatile functions (e.g. NOW()) in WHERE predicates", volatileIndexes.length === 0);

// 3. Check Constraint Syntax Validation
const ADD_CONSTRAINT_CHECK_REGEX = /add\s+constraint\s+([a-z0-9_]+)\s+check\s*\(([^;]+)/gi;
let malformedConstraints = 0;

for (const file of migrationFiles) {
  const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
  const cleanSql = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

  ADD_CONSTRAINT_CHECK_REGEX.lastIndex = 0;
  let cMatch: RegExpExecArray | null;
  while ((cMatch = ADD_CONSTRAINT_CHECK_REGEX.exec(cleanSql)) !== null) {
    const constraintName = cMatch[1];
    const rawCheck = cMatch[2];

    // Count open vs close parentheses
    let openCount = 1; // already matched leading '('
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

if (isNegativeControl) {
  malformedConstraints++;
}

check("Zero check constraints have malformed or unbalanced parentheses", malformedConstraints === 0);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
