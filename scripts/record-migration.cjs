/**
 * scripts/record-migration.cjs
 *
 * Records a manually applied migration into the public.schema_migrations table.
 *
 * Usage:
 *   node scripts/record-migration.cjs 20261105c_database_safety.sql
 *   node scripts/record-migration.cjs --file 20261105c_database_safety.sql --dry-run
 *   node scripts/record-migration.cjs 20261105c_database_safety.sql --applied-by "deploy-bot"
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Optional dotenv loading for local runs
try {
  const dotenv = require("dotenv");
  const envLocal = path.resolve(__dirname, "../.env.local");
  const envRoot = path.resolve(__dirname, "../.env");
  if (fs.existsSync(envLocal)) {
    dotenv.config({ path: envLocal });
  } else if (fs.existsSync(envRoot)) {
    dotenv.config({ path: envRoot });
  }
} catch {
  // dotenv is optional in environments where env is already provided
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "../supabase/migrations");

/**
 * Computes the SHA-256 hex checksum of a file.
 * @param {string} filePath
 * @returns {string}
 */
function computeFileChecksum(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found for checksum: ${filePath}`);
  }
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Validates and resolves the migration file in the migrations directory.
 * @param {string} filenameInput
 * @param {string} [migrationsDir]
 * @returns {{ filename: string, fullPath: string }}
 */
function resolveMigrationFile(filenameInput, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  if (!filenameInput || typeof filenameInput !== "string" || !filenameInput.trim()) {
    throw new Error("Missing migration filename argument.");
  }

  const basename = path.basename(filenameInput.trim());
  const fullPath = path.resolve(migrationsDir, basename);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Migration file not found at ${fullPath}`);
  }

  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${fullPath}`);
  }

  return { filename: basename, fullPath };
}

/**
 * Parses CLI arguments.
 * @param {string[]} argv
 * @returns {{ filename?: string, dryRun: boolean, appliedBy?: string, help: boolean }}
 */
function parseArgs(argv = process.argv.slice(2)) {
  let filename = undefined;
  let dryRun = false;
  let appliedBy = undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--dry-run" || arg === "--dry" || arg === "-n") {
      dryRun = true;
    } else if (arg === "--file" || arg === "-f") {
      i++;
      filename = argv[i];
    } else if (arg.startsWith("--file=")) {
      filename = arg.slice("--file=".length);
    } else if (arg === "--applied-by") {
      i++;
      appliedBy = argv[i];
    } else if (arg.startsWith("--applied-by=")) {
      appliedBy = arg.slice("--applied-by=".length);
    } else if (!arg.startsWith("-") && !filename) {
      filename = arg;
    }
  }

  return { filename, dryRun, appliedBy, help };
}

/**
 * Records migration in schema_migrations table (or performs dry-run).
 * @param {object} options
 * @param {string} options.filename
 * @param {string} [options.migrationsDir]
 * @param {string} [options.appliedBy]
 * @param {boolean} [options.dryRun]
 * @param {any} [options.client] Optional Supabase client instance (for testing/mocking)
 */
async function recordMigration(options = {}) {
  const {
    filename: filenameInput,
    migrationsDir = DEFAULT_MIGRATIONS_DIR,
    dryRun = false,
    appliedBy: explicitAppliedBy,
    client: customClient,
  } = options;

  const { filename, fullPath } = resolveMigrationFile(filenameInput, migrationsDir);
  const checksum = computeFileChecksum(fullPath);
  const appliedBy =
    explicitAppliedBy ||
    process.env.MIGRATION_APPLIED_BY ||
    process.env.USER ||
    process.env.USERNAME ||
    "manual";
  const appliedAt = new Date().toISOString();

  const record = {
    filename,
    applied_at: appliedAt,
    applied_by: appliedBy,
    checksum,
  };

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      record,
    };
  }

  // Live DB upsert requires Supabase service role client
  let supabase = customClient;
  if (!supabase) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error(
        "Missing required Supabase credentials (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Use --dry-run for offline verification."
      );
    }

    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
  }

  const { data, error } = await supabase
    .from("schema_migrations")
    .upsert(
      {
        filename: record.filename,
        applied_at: record.applied_at,
        applied_by: record.applied_by,
        checksum: record.checksum,
      },
      { onConflict: "filename" }
    )
    .select();

  if (error) {
    throw new Error(`Failed to record migration in schema_migrations: ${error.message}`);
  }

  return {
    success: true,
    dryRun: false,
    record,
    data,
  };
}

// CLI Execution entrypoint
if (require.main === module) {
  (async () => {
    const parsed = parseArgs(process.argv.slice(2));

    if (parsed.help) {
      console.log(`Usage: node scripts/record-migration.cjs <filename> [options]

Arguments:
  <filename>          Name or path of migration SQL file (e.g., 20261105c_database_safety.sql)

Options:
  --file, -f <name>   Explicit migration file name
  --dry-run, --dry    Simulate without writing to database
  --applied-by <name> User or service recording the migration (defaults to env or 'manual')
  --help, -h          Show this help text
`);
      process.exit(0);
    }

    if (!parsed.filename) {
      console.error("[MIGRATION RECORD ERROR] No migration file specified. Provide filename as an argument.");
      console.error("Example: node scripts/record-migration.cjs 20261105c_database_safety.sql --dry-run");
      process.exit(1);
    }

    try {
      const result = await recordMigration({
        filename: parsed.filename,
        dryRun: parsed.dryRun,
        appliedBy: parsed.appliedBy,
      });

      if (result.dryRun) {
        console.log(`[DRY-RUN] Migration record simulation successful:`);
        console.log(JSON.stringify(result.record, null, 2));
      } else {
        console.log(
          `[MIGRATION RECORD] Successfully recorded migration: ${result.record.filename} (checksum: ${result.record.checksum}, applied_by: ${result.record.applied_by})`
        );
      }
      process.exit(0);
    } catch (err) {
      console.error(`[MIGRATION RECORD ERROR] ${err.message}`);
      process.exit(1);
    }
  })();
}

module.exports = {
  DEFAULT_MIGRATIONS_DIR,
  computeFileChecksum,
  resolveMigrationFile,
  parseArgs,
  recordMigration,
};
