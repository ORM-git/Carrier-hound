/**
 * Logical Backup Library (Database sheet: Logical backup prep).
 *
 * Prepares pg_dump exports of the production database for storage as
 * build artifacts with a 30-day retention policy.
 *
 * Security Requirements:
 * - Reads connection string exclusively from repository secret / environment.
 * - Fails with clear owner-facing instructions when secret is absent.
 * - NEVER prints or logs raw credentials, passwords, or connection strings.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

export interface BackupOptions {
  connectionString?: string;
  outputDir?: string;
  date?: string;
  dryRun?: boolean;
}

export interface BackupResult {
  success: boolean;
  outputPath?: string;
  fileName?: string;
  error?: string;
  ownerInstructionsNeeded?: boolean;
}

export const DEFAULT_OUTPUT_DIR = path.resolve("backups");
export const SECRET_ENV_KEY = "SUPABASE_DB_CONNECTION_STRING";
export const FALLBACK_ENV_KEY = "DATABASE_URL";

/**
 * Resolves connection string from environment without leaking it.
 */
export function resolveConnectionString(
  env: Record<string, string | undefined> = process.env
): { connectionString: string | null; source: string | null } {
  if (env[SECRET_ENV_KEY] && env[SECRET_ENV_KEY]!.trim().length > 0) {
    return { connectionString: env[SECRET_ENV_KEY]!.trim(), source: SECRET_ENV_KEY };
  }
  if (env[FALLBACK_ENV_KEY] && env[FALLBACK_ENV_KEY]!.trim().length > 0) {
    return { connectionString: env[FALLBACK_ENV_KEY]!.trim(), source: FALLBACK_ENV_KEY };
  }
  return { connectionString: null, source: null };
}

/**
 * Completely redacts sensitive credentials from any connection string or URI.
 */
export function maskConnectionString(raw: string): string {
  if (!raw) return "";

  // 1. Standard URI matching: protocol://user:pass@host:port/path
  const uriRegex = /^(postgres(?:ql)?:\/\/)([^:@\s]+)(?::([^@\s]+))?@([^\/\s?#]+)(.*)$/i;
  const match = raw.match(uriRegex);
  if (match) {
    const [, protocol, user, , hostPort, rest] = match;
    return `${protocol}${user}:****@${hostPort}${rest}`;
  }

  // 2. Keyword/value string (host=... password=...)
  if (/password\s*=/i.test(raw)) {
    return raw.replace(/password\s*=\s*['"]?[^'"\s]+['"]?/gi, "password=****");
  }

  // 3. Fallback: mask whole string if unrecognized format
  return "postgresql://****:****@****/****";
}

/**
 * Generates actionable owner setup instructions when secret is missing.
 */
export function getOwnerSecretSetupInstructions(): string {
  return [
    "================================================================================",
    "[DB-BACKUP] ERROR: Database connection string secret is not configured.",
    "================================================================================",
    "One-time owner action required:",
    "  1. Go to repository Settings > Secrets and variables > Actions",
    `  2. Click 'New repository secret'`,
    `  3. Secret Name: ${SECRET_ENV_KEY}`,
    "  4. Secret Value: postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres?sslmode=require",
    "  5. Save secret and re-run this workflow or await the scheduled weekly backup.",
    "================================================================================",
  ].join("\n");
}

/**
 * Builds safe pg_dump execution arguments.
 */
export function buildPgDumpConfig(options: BackupOptions = {}): {
  args: string[];
  outputPath: string;
  fileName: string;
} {
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const dateStr = options.date ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `careerhound-backup-${dateStr}.sql`;
  const outputPath = path.join(outputDir, fileName);

  const args: string[] = [
    "--schema=public",
    "--no-owner",
    "--no-privileges",
    "--clean",
    "--if-exists",
    `--file=${outputPath}`,
  ];

  return { args, outputPath, fileName };
}

/**
 * Executes or simulates database logical backup.
 */
export async function runDatabaseBackup(options: BackupOptions = {}): Promise<BackupResult> {
  const resolved = options.connectionString
    ? { connectionString: options.connectionString, source: "options" }
    : resolveConnectionString();

  if (!resolved.connectionString) {
    const instructions = getOwnerSecretSetupInstructions();
    console.error(instructions);
    return {
      success: false,
      error: "Missing required database connection string secret.",
      ownerInstructionsNeeded: true,
    };
  }

  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const { args, outputPath, fileName } = buildPgDumpConfig(options);

  console.log(`[DB-BACKUP] Preparing logical backup to: ${outputPath}`);
  console.log(`[DB-BACKUP] Target source: ${resolved.source}`);
  console.log(`[DB-BACKUP] Connection endpoint: ${maskConnectionString(resolved.connectionString)}`);

  if (options.dryRun) {
    console.log("[DB-BACKUP] Dry-run enabled: skipping pg_dump subprocess execution.");
    return {
      success: true,
      outputPath,
      fileName,
    };
  }

  // Attempt pg_dump execution
  return new Promise((resolve) => {
    // Append dbname argument
    const finalArgs = [...args, `--dbname=${resolved.connectionString}`];

    execFile("pg_dump", finalArgs, { env: { ...process.env } }, (err, stdout, stderr) => {
      if (err) {
        // Ensure connection string or passwords are never leaked in error output
        let sanitizedErr = `${err.message || ""}\n${stderr || ""}`;
        if (resolved.connectionString) {
          // Extract potential password from URI to scrub
          try {
            const parsed = new URL(resolved.connectionString);
            if (parsed.password) {
              sanitizedErr = sanitizedErr.split(parsed.password).join("****");
            }
          } catch {
            // Ignore parse errors, mask raw
            sanitizedErr = sanitizedErr.split(resolved.connectionString).join("****");
          }
        }
        console.error(`[DB-BACKUP] pg_dump failed: ${sanitizedErr.trim()}`);
        resolve({
          success: false,
          error: sanitizedErr.trim(),
        });
        return;
      }

      console.log(`[DB-BACKUP] Successfully generated logical backup: ${outputPath}`);
      resolve({
        success: true,
        outputPath,
        fileName,
      });
    });
  });
}
