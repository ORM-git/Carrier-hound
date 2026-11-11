/**
 * Offline test suite for Database Logical Backup (Database sheet: Logical backup prep).
 *
 * Verifies that:
 * 1. Connection string resolution handles secrets and fallbacks.
 * 2. Connection string masking completely hides credentials from URIs, query params (?password=...), and keyword strings.
 * 3. scrubSensitiveSecrets scrubs passwords and query parameters from error strings.
 * 4. Missing secret outputs clear, actionable owner setup instructions.
 * 5. pg_dump execution arguments enforce safe schema-only dump (--schema-only) with no row data.
 * 6. Real subprocess error handling (dryRun: false) executes and scrubs synthetic secrets from errors and logs.
 * 7. Dry-run execution generates valid backup metadata without leaks.
 * 8. The GitHub workflow file defines weekly cron, secret mapping, and 30-day schema artifact retention.
 * 9. Negative control exits with code 1.
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
  extractSecretsToScrub,
  scrubSensitiveSecrets,
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

  // 2. Secret Redaction & Masking (URIs and Query Parameters)
  await test("maskConnectionString redacts passwords in URI authority", () => {
    const raw = "postgresql://postgres:super_secret_pw99@db.abcdefghijkl.supabase.co:5432/postgres?sslmode=require";
    const masked = maskConnectionString(raw);

    assert.ok(!masked.includes("super_secret_pw99"), "Raw password MUST NEVER appear in masked string");
    assert.ok(masked.includes("****"), "Masked string must contain asterisks");
    assert.ok(masked.includes("db.abcdefghijkl.supabase.co"), "Host should remain identifiable");
    assert.ok(masked.startsWith("postgresql://postgres:****@"), "Should format correctly");
  });

  await test("maskConnectionString redacts query parameters (?password=..., &token=...)", () => {
    const rawWithQueryPw =
      "postgresql://postgres:auth_pw@db.abcdefghijkl.supabase.co:5432/postgres?password=query_secret_param&token=secret_token&sslmode=require";
    const masked = maskConnectionString(rawWithQueryPw);

    assert.ok(!masked.includes("query_secret_param"), "Query param password must be masked");
    assert.ok(!masked.includes("secret_token"), "Query param token must be masked");
    assert.ok(!masked.includes("auth_pw"), "Auth password must be masked");
    assert.ok(masked.includes("?password=****"), "Must show ?password=****");
    assert.ok(masked.includes("&token=****"), "Must show &token=****");
    assert.ok(masked.includes("sslmode=require"), "Non-sensitive params remain");
  });

  await test("maskConnectionString redacts keyword/value connection strings", () => {
    const raw = "host=db.abcdefghijkl.supabase.co user=postgres password=my_top_secret_pass port=5432";
    const masked = maskConnectionString(raw);

    assert.ok(!masked.includes("my_top_secret_pass"), "Raw password must not appear");
    assert.ok(masked.includes("password=****"), "Password parameter must be masked");
  });

  await test("maskConnectionString redacts quoted keyword/value connection strings", () => {
    const rawSingle = "host=db.com user=postgres password='single_quoted_secret' port=5432";
    assert.ok(!maskConnectionString(rawSingle).includes("single_quoted_secret"));
    assert.ok(maskConnectionString(rawSingle).includes("password=****"));

    const rawDouble = 'host=db.com user=postgres password="double_quoted_secret" port=5432';
    assert.ok(!maskConnectionString(rawDouble).includes("double_quoted_secret"));
    assert.ok(maskConnectionString(rawDouble).includes("password=****"));
  });

  // 3. Subprocess Secret Scrubbing
  await test("scrubSensitiveSecrets scrubs URI and keyword credentials from error outputs", () => {
    const syntheticPw = "very_sensitive_db_password_XYZ";
    const syntheticQueryPw = "very_sensitive_query_param_ABC";
    const conn = `postgresql://postgres:${syntheticPw}@db.sample.co:5432/postgres?password=${syntheticQueryPw}`;
    const secrets = extractSecretsToScrub(conn);

    const rawError = [
      `pg_dump: error: connection to server at "db.sample.co", port 5432 failed: password authentication failed for user "postgres" with password="${syntheticPw}"`,
      `FATAL: could not connect to ${conn}`,
      `Details: query param password was ${syntheticQueryPw}`,
    ].join("\n");

    const scrubbed = scrubSensitiveSecrets(rawError, secrets);

    assert.ok(!scrubbed.includes(syntheticPw), "Synthetic password must be scrubbed from error output");
    assert.ok(!scrubbed.includes(syntheticQueryPw), "Synthetic query password must be scrubbed from error output");
    assert.ok(!scrubbed.includes(conn), "Full raw connection string must be scrubbed");
    assert.ok(scrubbed.includes("****"), "Scrubbed error must contain asterisks placeholder");
  });

  // 4. Owner Setup Instructions
  await test("getOwnerSecretSetupInstructions contains clear, actionable steps", () => {
    const instructions = getOwnerSecretSetupInstructions();

    assert.ok(instructions.includes("One-time owner action required"));
    assert.ok(instructions.includes("SUPABASE_DB_CONNECTION_STRING"));
    assert.ok(instructions.includes("Settings > Secrets and variables > Actions"));
    assert.ok(instructions.includes("postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres"));
  });

  // 5. pg_dump Config Builder: Enforces Schema-Only Dump
  await test("buildPgDumpConfig includes required security flags and enforces --schema-only", () => {
    const { args, outputPath, fileName } = buildPgDumpConfig({
      date: "2026-11-11T02-15-00",
      outputDir: DEFAULT_OUTPUT_DIR,
    });

    assert.ok(args.includes("--schema=public"), "Must restrict to public schema");
    assert.ok(args.includes("--schema-only"), "Must enforce --schema-only to prevent table row data exports");
    assert.ok(args.includes("--no-owner"), "Must omit owner assignments");
    assert.ok(args.includes("--no-privileges"), "Must omit privilege grants");
    assert.ok(args.includes("--clean"), "Must include clean table directives");
    assert.ok(args.includes("--if-exists"), "Must use if-exists directives");
    assert.ok(fileName.startsWith("careerhound-schema-backup-2026-11-11T02-15-00.sql"));
    assert.ok(outputPath.endsWith(fileName));
  });

  // 6. Execution behavior: absent secret
  await test("runDatabaseBackup fails gracefully when secret is absent", async () => {
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

  // 7. Real error-handling tests (subprocess execution, NOT just dry-run)
  await test("runDatabaseBackup real subprocess failure (URI format) never leaks synthetic secret", async () => {
    const syntheticUriSecret = "synthetic_super_secret_uri_pw_999";
    const syntheticQuerySecret = "synthetic_query_pw_888";
    const fakeUriConn = `postgresql://postgres:${syntheticUriSecret}@127.0.0.1:1/postgres?password=${syntheticQuerySecret}`;

    let capturedLogs = "";
    let capturedErrors = "";
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg: unknown) => {
      capturedLogs += String(msg) + "\n";
    };
    console.error = (msg: unknown) => {
      capturedErrors += String(msg) + "\n";
    };

    try {
      // Execute with dryRun: false to test the real subprocess execution & error scrub path
      const result = await runDatabaseBackup({
        connectionString: fakeUriConn,
        dryRun: false,
      });

      assert.strictEqual(result.success, false, "Subprocess execution to invalid port must fail");
      assert.ok(result.error !== undefined, "Result must contain error message");

      // Verify synthetic secrets NEVER appear in result.error
      assert.ok(
        !result.error!.includes(syntheticUriSecret),
        "CRITICAL SECURITY: Synthetic URI password leaked into result.error!"
      );
      assert.ok(
        !result.error!.includes(syntheticQuerySecret),
        "CRITICAL SECURITY: Synthetic query password leaked into result.error!"
      );

      // Verify synthetic secrets NEVER appear in captured logs
      assert.ok(
        !capturedLogs.includes(syntheticUriSecret),
        "CRITICAL SECURITY: Synthetic URI password leaked into console.log!"
      );
      assert.ok(
        !capturedLogs.includes(syntheticQuerySecret),
        "CRITICAL SECURITY: Synthetic query password leaked into console.log!"
      );
      assert.ok(
        !capturedErrors.includes(syntheticUriSecret),
        "CRITICAL SECURITY: Synthetic URI password leaked into console.error!"
      );
      assert.ok(
        !capturedErrors.includes(syntheticQuerySecret),
        "CRITICAL SECURITY: Synthetic query password leaked into console.error!"
      );
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  await test("runDatabaseBackup real subprocess failure (keyword format) never leaks synthetic secret", async () => {
    const syntheticKwSecret = "synthetic_keyword_secret_pass_777";
    const fakeKwConn = `host=127.0.0.1 port=1 user=postgres password=${syntheticKwSecret} dbname=postgres`;

    let capturedLogs = "";
    let capturedErrors = "";
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg: unknown) => {
      capturedLogs += String(msg) + "\n";
    };
    console.error = (msg: unknown) => {
      capturedErrors += String(msg) + "\n";
    };

    try {
      const result = await runDatabaseBackup({
        connectionString: fakeKwConn,
        dryRun: false,
      });

      assert.strictEqual(result.success, false, "Subprocess execution to invalid port must fail");
      assert.ok(result.error !== undefined, "Result must contain error message");

      // Verify synthetic keyword secret NEVER appears in result.error
      assert.ok(
        !result.error!.includes(syntheticKwSecret),
        "CRITICAL SECURITY: Synthetic keyword password leaked into result.error!"
      );

      // Verify synthetic keyword secret NEVER appears in captured logs
      assert.ok(
        !capturedLogs.includes(syntheticKwSecret),
        "CRITICAL SECURITY: Synthetic keyword password leaked into console.log!"
      );
      assert.ok(
        !capturedErrors.includes(syntheticKwSecret),
        "CRITICAL SECURITY: Synthetic keyword password leaked into console.error!"
      );
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  // 8. Execution behavior: dry-run with secret does not leak credentials
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

  // 9. Workflow YAML configuration verification
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

    // Artifact retention and schema naming
    assert.ok(yaml.includes("uses: actions/upload-artifact@v4"), "Must use upload-artifact v4");
    assert.ok(yaml.includes("retention-days: 30"), "Must configure 30-day artifact retention");
    assert.ok(yaml.includes("name: db-schema-backup-"), "Must name artifact db-schema-backup");
    assert.ok(yaml.includes("path: backups/"), "Must upload from backups/ path");
  });

  console.log(`\nAll ${passed} logical backup tests passed successfully.\n`);
}

runAllTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
