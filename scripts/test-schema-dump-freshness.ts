/**
 * Offline test suite for Schema Dump Freshness (Database sheet: Schema dump freshness).
 *
 * Verifies that:
 * 1. The repository schema dump is fresh and up-to-date with all migrations.
 * 2. Missing dump file fails freshness check.
 * 3. Stale dump missing a new migration fails freshness check.
 * 4. Missing or malformed freshness header fails freshness check.
 * 5. Modified migration content without dump update fails freshness check.
 * 6. Generator script reproduces valid schema dumps.
 * 7. Negative control exits with code 1.
 *
 * Usage:
 *   npx tsx scripts/test-schema-dump-freshness.ts
 *   npx tsx scripts/test-schema-dump-freshness.ts --negative-control
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateSchemaDump,
  writeSchemaDump,
  checkSchemaDumpFreshness,
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_SCHEMA_DUMP_PATH,
} from "./lib/schema-dump";
import { runCheckSchemaDumpFreshness } from "./check-schema-dump-freshness";

// Negative control check
if (process.argv.includes("--negative-control")) {
  console.log("NEGATIVE CONTROL: Intentionally asserting failure (exit 1)");
  process.exit(1);
}

let passed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

console.log("\n=== Test Suite: Schema Dump Freshness & Generation ===\n");

// 1. Live repository checks
test("Live schema dump exists and passes freshness check", () => {
  assert.ok(fs.existsSync(DEFAULT_SCHEMA_DUMP_PATH), "schema.generated.sql must exist");
  const result = checkSchemaDumpFreshness(DEFAULT_SCHEMA_DUMP_PATH, DEFAULT_MIGRATIONS_DIR);
  assert.strictEqual(result.fresh, true, `Freshness check failed: ${result.reasons.join(", ")}`);
  assert.ok(result.expectedCount >= 70, `Expected at least 70 migrations, got ${result.expectedCount}`);
  assert.strictEqual(result.actualCount, result.expectedCount);
  assert.ok(result.dumpDate !== null, "Dump date must be present");
  assert.strictEqual(result.missingMigrations.length, 0);
});

test("runCheckSchemaDumpFreshness entrypoint returns true on current repo state", () => {
  const ok = runCheckSchemaDumpFreshness();
  assert.strictEqual(ok, true);
});

// 2. Synthetic fixture checks
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-freshness-test-"));

try {
  const fakeMigrationsDir = path.join(tempDir, "migrations");
  fs.mkdirSync(fakeMigrationsDir);

  fs.writeFileSync(path.join(fakeMigrationsDir, "20261001_initial.sql"), "CREATE TABLE users (id uuid);");
  fs.writeFileSync(path.join(fakeMigrationsDir, "20261002_add_roles.sql"), "ALTER TABLE users ADD COLUMN role text;");

  const fakeDumpPath = path.join(tempDir, "schema.generated.sql");

  test("generateSchemaDump generates valid content with dated header", () => {
    const content = generateSchemaDump({
      migrationsDir: fakeMigrationsDir,
      date: "2026-11-11",
    });

    assert.ok(content.includes("-- Freshness Header: Generated on 2026-11-11"));
    assert.ok(content.includes("-- Migrations Count: 2"));
    assert.ok(content.includes("-- Migration: 20261001_initial.sql"));
    assert.ok(content.includes("CREATE TABLE users (id uuid);"));
    assert.ok(content.includes("-- Migration: 20261002_add_roles.sql"));
    assert.ok(content.includes("ALTER TABLE users ADD COLUMN role text;"));
  });

  test("writeSchemaDump writes dump to disk and passes freshness", () => {
    writeSchemaDump(fakeDumpPath, {
      migrationsDir: fakeMigrationsDir,
      date: "2026-11-11",
    });

    assert.ok(fs.existsSync(fakeDumpPath));
    const result = checkSchemaDumpFreshness(fakeDumpPath, fakeMigrationsDir);
    assert.strictEqual(result.fresh, true);
    assert.strictEqual(result.expectedCount, 2);
    assert.strictEqual(result.actualCount, 2);
    assert.strictEqual(result.dumpDate, "2026-11-11");
  });

  test("Missing dump file fails freshness check", () => {
    const nonExistent = path.join(tempDir, "does-not-exist.sql");
    const result = checkSchemaDumpFreshness(nonExistent, fakeMigrationsDir);
    assert.strictEqual(result.fresh, false);
    assert.ok(result.reasons[0].includes("does not exist"));
  });

  test("Missing migrations directory fails freshness check", () => {
    const nonExistentDir = path.join(tempDir, "non-existent-migrations");
    const result = checkSchemaDumpFreshness(fakeDumpPath, nonExistentDir);
    assert.strictEqual(result.fresh, false);
    assert.ok(result.reasons[0].includes("directory does not exist"));
  });

  test("Missing dated freshness header fails freshness check", () => {
    const noHeaderDump = path.join(tempDir, "no-header.sql");
    fs.writeFileSync(noHeaderDump, "-- Plain SQL\nCREATE TABLE test();");
    const result = checkSchemaDumpFreshness(noHeaderDump, fakeMigrationsDir);
    assert.strictEqual(result.fresh, false);
    assert.ok(result.reasons.some((r) => r.includes("missing a dated freshness header")));
  });

  test("Adding a new migration without dump update fails freshness check", () => {
    // Add third migration
    const newMigration = path.join(fakeMigrationsDir, "20261003_new_table.sql");
    fs.writeFileSync(newMigration, "CREATE TABLE jobs (id uuid);");

    const result = checkSchemaDumpFreshness(fakeDumpPath, fakeMigrationsDir);
    assert.strictEqual(result.fresh, false);
    assert.strictEqual(result.expectedCount, 3);
    assert.strictEqual(result.actualCount, 2);
    assert.ok(result.missingMigrations.includes("20261003_new_table.sql"));
    assert.ok(result.reasons.some((r) => r.includes("Migrations count mismatch")));

    // Clean up third migration
    fs.unlinkSync(newMigration);
  });

  test("Modifying an existing migration without dump update fails freshness check", () => {
    // Modify 20261001_initial.sql
    const initialMigration = path.join(fakeMigrationsDir, "20261001_initial.sql");
    fs.writeFileSync(initialMigration, "CREATE TABLE users (id uuid, name text);");

    const result = checkSchemaDumpFreshness(fakeDumpPath, fakeMigrationsDir);
    assert.strictEqual(result.fresh, false);
    assert.ok(result.reasons.some((r) => r.includes("content does not match")));

    // Restore
    fs.writeFileSync(initialMigration, "CREATE TABLE users (id uuid);");
  });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\nAll ${passed} schema dump tests passed successfully.\n`);
