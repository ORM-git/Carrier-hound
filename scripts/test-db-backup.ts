/**
 * Offline test suite for Database Logical Backup (Database sheet: Logical backup prep).
 *
 * Verifies that:
 * 1. Connection string resolution handles secrets and fallbacks.
 * 2. Connection string masking completely hides credentials (no leaks).
 * 3. Missing secret outputs clear, actionable owner setup instructions.
 * 4. pg_dump execution arguments are secure and properly configured.
 * 5. Dry-run execution generates valid backup artifacts without leaks.
 * 6. The GitHub workflow file defines weekly cron, secret mapping, and 30-day artifact retention.
 * 7. Negative control exits with code 1.
 *
 * Usage:
 *   npx tsx scripts/test-db-backup.ts
 *   npx tsx scripts/test-db-backup.ts --negative-control
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveConnectionString,
  maskConnectionString,
  getOwnerSecretSetupInstructions,
  buildPgDumpConfig,
  runDatabaseBackup,
  SECRET_ENV_KEY,
  FALLBACK_ENV_KEY,
  DEFAULT_OUTPUT_DIR,
} from "./lib/db-backup";

// Negative control check
if (process.argv.includes("--negative-control")) {
  console.log("NEGATIVE CONTROL: Intentionally asserting failure (exit 1)");
  process.exit(1);
}

let passed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function runAllTests() {
  console.log("\n=== Test Suite: Database Logical Backup Prep ===\n");

  // 1. Connection string resolution
  await test("resolveConnectionString returns null when no environment keys are set", () => {
    const res = resolveConnectionString({});
    assert.strictEqual(res.connectionString, null);
    assert.strictEqual(res.source, null);
  });

  await test("resolveConnectionString detects primary SUPABASE_DB_CONNECTION_STRING secret", () => {
    const res = resolveConnectionString({
      [SECRET_ENV_KEY]: "postgresql://postgres:secret123@db.sample.supabase.co:5432/postgres",
    });
    assert.strictEqual(res.source, SECRET_ENV_KEY);
    assert.strictEqual(res.connectionString, "postgresql://postgres:secret123@db.sample.supabase.co:5432/postgres");
  });

  await test("resolveConnectionString falls back to DATABASE_URL if primary is absent", () => {
    const res = resolveConnectionString({
      [FALLBACK_ENV_KEY]: "postgresql://postgres:fallback123@db.sample.supabase.co:5432/postgres",
    });
    assert.strictEqual(res.source, FALLBACK_ENV_KEY);
    assert.strictEqual(res.connectionString, "postgresql://postgres:fallback123@db.sample.supabase.co:5432/postgres");
  });

  // 2. Secret Redaction & Masking
  await test("maskConnectionString thoroughly redacts passwords and secrets from URIs", () => {
    const raw = "postgresql://postgres:super_secret_pw99@db.abcdefghijkl.supabase.co:5432/postgres?sslmode=require";
    const masked = maskConnectionString(raw);

    assert.ok(!masked.includes("super_secret_pw99"), "Raw password MUST NEVER appear in masked string");
    assert.ok(masked.includes("****"), "Masked string must contain asterisks");
    assert.ok(masked.includes("db.abcdefghijkl.supabase.co"), "Host should remain identifiable");
    assert.ok(masked.startsWith("postgresql://postgres:****@"), "Should format correctly");
  });

  await test("maskConnectionString redacts keyword/value connection strings", () => {
    const raw = "host=db.abcdefghijkl.supabase.co user=postgres password=my_top_secret_pass port=5432";
    const masked = maskConnectionString(raw);

    assert.ok(!masked.includes("my_top_secret_pass"), "Raw password must not appear");
    assert.ok(masked.includes("password=****"), "Password parameter must be masked");
  });

  // 3. Owner Setup Instructions
  await test("getOwnerSecretSetupInstructions contains clear, actionable steps", () => {
    const instructions = getOwnerSecretSetupInstructions();

    assert.ok(instructions.includes("One-time owner action required"));
    assert.ok(instructions.includes("SUPABASE_DB_CONNECTION_STRING"));
    assert.ok(instructions.includes("Settings > Secrets and variables > Actions"));
    assert.ok(instructions.includes("postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres"));
  });

  // 4. pg_dump Config Builder
  await test("buildPgDumpConfig includes required security flags and output destination", () => {
    const { args, outputPath, fileName } = buildPgDumpConfig({
      date: "2026-11-11T02-15-00",
      outputDir: DEFAULT_OUTPUT_DIR,
    });

    assert.ok(args.includes("--schema=public"), "Must restrict to public schema");
    assert.ok(args.includes("--no-owner"), "Must omit owner assignments");
    assert.ok(args.includes("--no-privileges"), "Must omit privilege grants");
    assert.ok(args.includes("--clean"), "Must include clean table directives");
    assert.ok(args.includes("--if-exists"), "Must use if-exists directives");
    assert.ok(fileName.startsWith("careerhound-backup-2026-11-11T02-15-00.sql"));
    assert.ok(outputPath.endsWith(fileName));
  });

  // 5. Execution behavior: absent secret
  await test("runDatabaseBackup fails gracefully when secret is absent", async () => {
    // Intercept console.error to ensure no uncaught crash
    let capturedErr = "";
    const origError = console.error;
    console.error = (msg: unknown) => {
      capturedErr += String(msg) + "\n";
    };

    try {
      const result = await runDatabaseBackup({
        connectionString: undefined,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.ownerInstructionsNeeded, true);
      assert.ok(capturedErr.includes("One-time owner action required"));
      assert.ok(capturedErr.includes("SUPABASE_DB_CONNECTION_STRING"));
    } finally {
      console.error = origError;
    }
  });

  // 6. Execution behavior: dry-run with secret does not leak credentials
  await test("runDatabaseBackup dryRun succeeds and never prints secret password", async () => {
    const sensitiveSecret = "my_super_confidential_pw_42";
    const fakeConn = `postgresql://postgres:${sensitiveSecret}@db.xyz.supabase.co:5432/postgres`;

    let capturedLogs = "";
    const origLog = console.log;
    console.log = (msg: unknown) => {
      capturedLogs += String(msg) + "\n";
    };

    try {
      const result = await runDatabaseBackup({
        connectionString: fakeConn,
        dryRun: true,
      });

      assert.strictEqual(result.success, true);
      assert.ok(result.outputPath !== undefined);
      // Assert sensitiveSecret NEVER appears anywhere in captured output
      assert.strictEqual(
        capturedLogs.includes(sensitiveSecret),
        false,
        "CRITICAL SECURITY: Sensitive password leaked into console.log!"
      );
      assert.ok(capturedLogs.includes("****"), "Must show masked endpoint");
    } finally {
      console.log = origLog;
    }
  });

  // 7. Workflow YAML configuration verification
  await test("Workflow .github/workflows/db-backup.yml has valid structure, secret mapping, and retention", () => {
    const workflowPath = path.resolve(".github/workflows/db-backup.yml");
    assert.ok(fs.existsSync(workflowPath), "db-backup.yml must exist");

    const yaml = fs.readFileSync(workflowPath, "utf8");

    // Cron schedule
    assert.ok(yaml.includes("cron: '15 2 * * 0'"), "Must define weekly cron schedule");
    assert.ok(yaml.includes("workflow_dispatch:"), "Must allow manual triggering");

    // Permissions
    assert.ok(yaml.includes("contents: read"), "Must specify read permissions");

    // Secret mapping
    assert.ok(
      yaml.includes("SUPABASE_DB_CONNECTION_STRING: ${{ secrets.SUPABASE_DB_CONNECTION_STRING }}"),
      "Must map repository secret SUPABASE_DB_CONNECTION_STRING"
    );

    // Script execution
    assert.ok(yaml.includes("npx tsx scripts/run-db-backup.ts"), "Must run backup script");

    // Artifact retention
    assert.ok(yaml.includes("uses: actions/upload-artifact@v4"), "Must use upload-artifact v4");
    assert.ok(yaml.includes("retention-days: 30"), "Must configure 30-day artifact retention");
    assert.ok(yaml.includes("path: backups/"), "Must upload from backups/ path");
  });

  console.log(`\nAll ${passed} logical backup tests passed successfully.\n`);
}

runAllTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
