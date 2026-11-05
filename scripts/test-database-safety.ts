/**
 * scripts/test-database-safety.ts
 *
 * Verification suite for database safety migration and migration record script:
 * 1. Structural and syntactical verification of supabase/migrations/20261105c_database_safety.sql:
 *    - schema_migrations table definition with all required fields
 *    - RLS enabled with deny-all on public/anon/authenticated, service_role only
 *    - Role-level timeouts (15s statement, 5s lock, 60s idle session) on authenticator, anon, authenticated
 *    - Explicit exclusion of service_role from timeouts (cron/admin safety)
 *    - pg_stat_statements extension creation
 *    - Rollback instruction block at top
 *    - Verify query block at bottom
 * 2. record-migration.cjs helper functions & CLI tests:
 *    - Checksum calculation against crypto sha256
 *    - Migration file resolution and basename extraction
 *    - CLI argument parsing
 *    - Dry-run simulation mode without network/DB calls
 *    - Upsert contract verification with mock Supabase client
 * 3. Negative controls:
 *    - Missing arguments exit with code 1
 *    - Non-existent migration files exit with code 1
 *    - Subprocess execution of test runner with --negative-control exits with code 1
 */

import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";

// Negative control check: fail immediately if --negative-control flag is passed
if (process.argv.includes("--negative-control")) {
  console.error("Deliberate negative control failure triggered.");
  process.exit(1);
}

const {
  DEFAULT_MIGRATIONS_DIR,
  computeFileChecksum,
  resolveMigrationFile,
  parseArgs,
  recordMigration,
} = require("./record-migration.cjs");

const MIGRATION_PATH = path.resolve(__dirname, "../supabase/migrations/20261105c_database_safety.sql");

async function runDatabaseSafetyTests() {
  console.log("\n================================================================================");
  console.log("RUNNING DATABASE SAFETY & MIGRATION RECORD VERIFICATION SUITE");
  console.log("================================================================================\n");

  // --------------------------------------------------------------------------
  // TEST 1: Migration File Existence and SQL Structure
  // --------------------------------------------------------------------------
  console.log("Test 1: Migration SQL file presence and structure...");
  {
    assert.ok(fs.existsSync(MIGRATION_PATH), `Migration file must exist at ${MIGRATION_PATH}`);
    const sql = fs.readFileSync(MIGRATION_PATH, "utf-8");

    // 1. Rollback block at the top
    assert.ok(
      sql.includes("ROLLBACK INSTRUCTIONS"),
      "Migration must contain a ROLLBACK INSTRUCTIONS block"
    );
    assert.ok(
      sql.indexOf("ROLLBACK INSTRUCTIONS") < sql.indexOf("create table if not exists public.schema_migrations"),
      "Rollback block must precede the migration DDL"
    );
    assert.ok(sql.includes("alter role authenticator reset statement_timeout"), "Rollback must include authenticator timeout reset");
    assert.ok(sql.includes("alter role anon reset statement_timeout"), "Rollback must include anon timeout reset");
    assert.ok(sql.includes("alter role authenticated reset statement_timeout"), "Rollback must include authenticated timeout reset");
    assert.ok(sql.includes("drop table if exists public.schema_migrations"), "Rollback must include dropping schema_migrations table");

    // 2. schema_migrations table with columns
    assert.ok(
      sql.includes("create table if not exists public.schema_migrations"),
      "Migration must create schema_migrations table"
    );
    assert.ok(/filename\s+text\s+primary\s+key/i.test(sql), "Must have 'filename text primary key'");
    assert.ok(/applied_at\s+timestamptz/i.test(sql), "Must have 'applied_at timestamptz'");
    assert.ok(/applied_by\s+text/i.test(sql), "Must have 'applied_by text'");
    assert.ok(/checksum\s+text/i.test(sql), "Must have 'checksum text'");

    // 3. RLS and permissions: service_role only
    assert.ok(
      /alter table public\.schema_migrations enable row level security;/i.test(sql),
      "Must enable Row Level Security on schema_migrations"
    );
    assert.ok(
      /revoke all on public\.schema_migrations from public, anon, authenticated;/i.test(sql),
      "Must revoke permissions from public, anon, authenticated"
    );
    assert.ok(
      /grant all on public\.schema_migrations to service_role;/i.test(sql),
      "Must grant all permissions to service_role"
    );

    // 4. Role-level timeouts: 15s statement, 5s lock, 60s idle session
    const roles = ["authenticator", "anon", "authenticated"];
    for (const role of roles) {
      assert.ok(
        new RegExp(`alter\\s+role\\s+${role}\\s+set\\s+statement_timeout\\s*=\\s*'15s';`, "i").test(sql),
        `Must set statement_timeout = '15s' for ${role}`
      );
      assert.ok(
        new RegExp(`alter\\s+role\\s+${role}\\s+set\\s+lock_timeout\\s*=\\s*'5s';`, "i").test(sql),
        `Must set lock_timeout = '5s' for ${role}`
      );
      assert.ok(
        new RegExp(`alter\\s+role\\s+${role}\\s+set\\s+idle_in_transaction_session_timeout\\s*=\\s*'60s';`, "i").test(sql),
        `Must set idle_in_transaction_session_timeout = '60s' for ${role}`
      );
    }

    // 5. service_role excluded from timeouts
    assert.ok(
      !/alter\s+role\s+service_role\s+set/i.test(sql),
      "service_role MUST be excluded from timeouts to prevent cutting off background/cron tasks"
    );

    // 6. pg_stat_statements extension
    assert.ok(
      /create\s+extension\s+if\s+not\s+exists\s+pg_stat_statements;/i.test(sql),
      "Must enable pg_stat_statements extension"
    );

    // 7. Verify queries block at the bottom
    assert.ok(
      sql.includes("VERIFY QUERIES"),
      "Migration must contain a VERIFY QUERIES block at the bottom"
    );
    assert.ok(sql.includes("pg_tables"), "Verify queries must inspect pg_tables");
    assert.ok(sql.includes("pg_roles"), "Verify queries must inspect pg_roles");
    assert.ok(sql.includes("pg_extension"), "Verify queries must inspect pg_extension");

    console.log("  -> [PASS-LOCAL] Migration SQL structure and security requirements verified.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 2: record-migration.cjs Unit Functions
  // --------------------------------------------------------------------------
  console.log("Test 2: record-migration.cjs function units (args, checksum, resolution)...");
  {
    // A: Argument Parsing
    const parsed1 = parseArgs(["my_migration.sql", "--dry-run"]);
    assert.strictEqual(parsed1.filename, "my_migration.sql");
    assert.strictEqual(parsed1.dryRun, true);
    assert.strictEqual(parsed1.appliedBy, undefined);

    const parsed2 = parseArgs(["--file", "foo.sql", "--applied-by", "ci-bot"]);
    assert.strictEqual(parsed2.filename, "foo.sql");
    assert.strictEqual(parsed2.dryRun, false);
    assert.strictEqual(parsed2.appliedBy, "ci-bot");

    const parsed3 = parseArgs(["--file=bar.sql", "--applied-by=admin", "-n"]);
    assert.strictEqual(parsed3.filename, "bar.sql");
    assert.strictEqual(parsed3.dryRun, true);
    assert.strictEqual(parsed3.appliedBy, "admin");

    const parsed4 = parseArgs(["--help"]);
    assert.strictEqual(parsed4.help, true);

    // B: Checksum calculation
    const expectedHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(MIGRATION_PATH))
      .digest("hex");
    const computedHash = computeFileChecksum(MIGRATION_PATH);
    assert.strictEqual(computedHash, expectedHash, "Checksum must match SHA-256 of file");
    assert.strictEqual(computedHash.length, 64, "SHA-256 hash length must be 64 characters");

    // Checksum on missing file throws
    assert.throws(
      () => computeFileChecksum(path.resolve(__dirname, "does_not_exist.sql")),
      /File not found for checksum/
    );

    // C: Resolve migration file
    const resolved = resolveMigrationFile("20261105c_database_safety.sql");
    assert.strictEqual(resolved.filename, "20261105c_database_safety.sql");
    assert.strictEqual(resolved.fullPath, MIGRATION_PATH);

    // Strips path prefix if user provides full or relative path
    const resolvedSub = resolveMigrationFile("supabase/migrations/20261105c_database_safety.sql");
    assert.strictEqual(resolvedSub.filename, "20261105c_database_safety.sql");

    // Missing file throws
    assert.throws(
      () => resolveMigrationFile("non_existent_migration.sql"),
      /Migration file not found/
    );

    // Empty input throws
    assert.throws(
      () => resolveMigrationFile(""),
      /Missing migration filename/
    );

    console.log("  -> [PASS-LOCAL] record-migration helper units passed.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 3: Dry-Run Mode and Mock Supabase Client Upsert
  // --------------------------------------------------------------------------
  console.log("Test 3: Dry-run mode and Supabase upsert verification...");
  {
    // A: Dry-run mode returns record object without DB client
    const dryRunResult = await recordMigration({
      filename: "20261105c_database_safety.sql",
      dryRun: true,
      appliedBy: "test_runner",
    });

    assert.strictEqual(dryRunResult.success, true);
    assert.strictEqual(dryRunResult.dryRun, true);
    assert.strictEqual(dryRunResult.record.filename, "20261105c_database_safety.sql");
    assert.strictEqual(dryRunResult.record.applied_by, "test_runner");
    assert.strictEqual(typeof dryRunResult.record.checksum, "string");
    assert.strictEqual(dryRunResult.record.checksum.length, 64);
    assert.ok(dryRunResult.record.applied_at, "applied_at timestamp must be populated");

    // B: Execution with Mock Supabase client
    let upsertPayload: any = null;
    let upsertOptions: any = null;
    let tableQueried: string | null = null;

    const mockSupabase = {
      from: (table: string) => {
        tableQueried = table;
        return {
          upsert: (payload: any, options: any) => {
            upsertPayload = payload;
            upsertOptions = options;
            return {
              select: () => Promise.resolve({ data: [payload], error: null }),
            };
          },
        };
      },
    };

    const mockResult = await recordMigration({
      filename: "20261105c_database_safety.sql",
      dryRun: false,
      appliedBy: "migration_admin",
      client: mockSupabase,
    });

    assert.strictEqual(mockResult.success, true);
    assert.strictEqual(mockResult.dryRun, false);
    assert.strictEqual(tableQueried, "schema_migrations");
    assert.strictEqual(upsertPayload.filename, "20261105c_database_safety.sql");
    assert.strictEqual(upsertPayload.applied_by, "migration_admin");
    assert.strictEqual(upsertPayload.checksum, dryRunResult.record.checksum);
    assert.deepStrictEqual(upsertOptions, { onConflict: "filename" });

    // C: Failure handling when client returns an error
    const failingMockSupabase = {
      from: () => ({
        upsert: () => ({
          select: () => Promise.resolve({ data: null, error: { message: "permission denied for table schema_migrations" } }),
        }),
      }),
    };

    await assert.rejects(
      async () => {
        await recordMigration({
          filename: "20261105c_database_safety.sql",
          dryRun: false,
          appliedBy: "unauthorized_user",
          client: failingMockSupabase,
        });
      },
      /Failed to record migration in schema_migrations: permission denied/
    );

    console.log("  -> [PASS-LOCAL] Dry-run and mock client database recording verified.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 4: Negative Control Subprocesses (Proving Non-Zero Exit)
  // --------------------------------------------------------------------------
  console.log("Test 4: Negative control subprocess execution (non-zero exits)...");
  {
    // A: Runner negative control flag
    const testRunnerNeg = spawnSync("npx", ["tsx", "scripts/test-database-safety.ts", "--negative-control"], {
      stdio: "pipe",
      shell: true,
      encoding: "utf-8",
    });
    assert.strictEqual(
      testRunnerNeg.status,
      1,
      "test-database-safety.ts --negative-control must exit with status 1"
    );

    // B: record-migration.cjs missing file
    const missingFileNeg = spawnSync(
      "node",
      ["scripts/record-migration.cjs", "non_existent_2026.sql", "--dry-run"],
      {
        stdio: "pipe",
        shell: true,
        encoding: "utf-8",
      }
    );
    assert.strictEqual(
      missingFileNeg.status,
      1,
      "record-migration.cjs with non-existent file must exit with status 1"
    );
    assert.ok(
      missingFileNeg.stderr.includes("Migration file not found"),
      "Error output must state migration file was not found"
    );

    // C: record-migration.cjs with no arguments
    const noArgsNeg = spawnSync("node", ["scripts/record-migration.cjs"], {
      stdio: "pipe",
      shell: true,
      encoding: "utf-8",
    });
    assert.strictEqual(
      noArgsNeg.status,
      1,
      "record-migration.cjs without arguments must exit with status 1"
    );
    assert.ok(
      noArgsNeg.stderr.includes("No migration file specified"),
      "Error output must state no migration file specified"
    );

    // D: Positive CLI run with dry-run exits with status 0
    const dryRunPos = spawnSync(
      "node",
      ["scripts/record-migration.cjs", "20261105c_database_safety.sql", "--dry-run"],
      {
        stdio: "pipe",
        shell: true,
        encoding: "utf-8",
      }
    );
    assert.strictEqual(
      dryRunPos.status,
      0,
      "record-migration.cjs --dry-run must exit with status 0"
    );
    assert.ok(
      dryRunPos.stdout.includes("[DRY-RUN] Migration record simulation successful:"),
      "Output must contain dry-run success message"
    );

    console.log("  -> [PASS-LOCAL] Negative controls and CLI exit codes verified.\n");
  }

  console.log("--------------------------------------------------------------------------------");
  console.log("ALL DATABASE SAFETY AND MIGRATION RECORD TESTS PASSED [PASS-LOCAL]");
  console.log("--------------------------------------------------------------------------------\n");
}

runDatabaseSafetyTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
