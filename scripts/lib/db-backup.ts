/**
 * Logical Backup Library (Database sheet: Logical backup prep).
 *
 * Prepares pg_dump exports of the production database for storage as
 * build artifacts with a 30-day retention policy.
 *
 * Security Requirements:
 * - Reads connection string exclusively from repository secret / environment.
 * - Fails with clear owner-facing instructions when secret is absent.
 * - Enforces schema-only dump (--schema-only) so zero row data or user PII is exported.
 * - NEVER prints or logs raw credentials, passwords, or connection strings.
 * - Masks URI query params (?password=...) and keyword-form strings in all outputs and subprocess errors.
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
 * Helper to mask sensitive query parameters (e.g. ?password=, &token=) in a URL or query string.
 */
function maskQueryParams(pathAndQuery: string): string {
  return pathAndQuery.replace(
    /([?&](?:password|pwd|secret|key|apikey|token|auth)=)([^&#\s]*)/gi,
    "$1****"
  );
}

/**
 * Completely redacts sensitive credentials from any connection string, URI, or keyword string.
 * Masks:
 * 1. URI user:password@host authority
 * 2. URI query parameters (?password=..., &token=...)
 * 3. Keyword-value pairs (password=..., password='...')
 */
export function maskConnectionString(raw: string): string {
  if (!raw || typeof raw !== "string") return "";

  let result = raw;

  // 1. Standard URI matching: protocol://user:pass@host:port/path?query
  const uriRegex = /^(postgres(?:ql)?:\/\/)([^:@\s]+)(?::([^@\s]+))?@([^\/\s?#]+)(.*)$/i;
  const match = result.match(uriRegex);
  if (match) {
    const [, protocol, user, , hostPort, rest] = match;
    const maskedRest = maskQueryParams(rest);
    return `${protocol}${user}:****@${hostPort}${maskedRest}`;
  }

  // 1b. URI without user:password auth but with query params: protocol://host:port/path?query
  const uriNoAuthRegex = /^(postgres(?:ql)?:\/\/)([^\/\s?#]+)(.*)$/i;
  const matchNoAuth = result.match(uriNoAuthRegex);
  if (matchNoAuth) {
    const [, protocol, hostPort, rest] = matchNoAuth;
    return `${protocol}${hostPort}${maskQueryParams(rest)}`;
  }

  // 2. Keyword/value string (host=... password=... or password='...')
  if (/password\s*=/i.test(result)) {
    result = result.replace(
      /(password\s*=\s*)(?:'[^']*'|"[^"]*"|[^\s;]+)/gi,
      "password=****"
    );
  }

  // 3. Mask any remaining query parameters
  result = maskQueryParams(result);

  // 4. Fallback: mask whole string if unrecognized format and contains password-like tokens that weren't masked
  if (!result.includes("****") && /password|secret/i.test(result)) {
    return "postgresql://****:****@****/****";
  }

  return result;
}

/**
 * Extracts all raw secret tokens from a connection string so they can be scrubbed
 * from error messages or subprocess stderr.
 */
export function extractSecretsToScrub(connStr: string): string[] {
  if (!connStr || typeof connStr !== "string") return [];
  const secrets = new Set<string>();
  secrets.add(connStr);

  // 1. Password from URI: :password@
  const uriPassMatch = connStr.match(/:\/\/([^:@\s]+):([^@\s]+)@/);
  if (uriPassMatch && uriPassMatch[2]) {
    secrets.add(uriPassMatch[2]);
  }

  // 2. Keyword password: password=xyz, password='xyz', password="xyz"
  const kwPassMatch = connStr.match(/password\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s;]+))/i);
  if (kwPassMatch) {
    const val = kwPassMatch[1] || kwPassMatch[2] || kwPassMatch[3];
    if (val) secrets.add(val);
  }

  // 3. Query params: ?password=xyz or &password=xyz
  const queryMatches = connStr.matchAll(/[?&](?:password|pwd|secret|key|apikey|token|auth)=([^&#\s]+)/gi);
  for (const qm of queryMatches) {
    if (qm[1]) {
      secrets.add(qm[1]);
      try {
        secrets.add(decodeURIComponent(qm[1]));
      } catch {
        // ignore
      }
    }
  }

  // Filter out short/empty tokens
  return Array.from(secrets).filter((s) => s.length >= 3);
}

/**
 * Scrubs all connection string variants, passwords, query parameters,
 * and keyword values from text (such as subprocess error messages or logs).
 */
export function scrubSensitiveSecrets(text: string, secrets: string[] = []): string {
  if (!text) return "";
  let sanitized = text;

  // Mask URI authority passwords: postgresql://...:...@...
  sanitized = sanitized.replace(
    /(postgres(?:ql)?:\/\/[^:@\s]+:)([^@\s]+)(@)/gi,
    "$1****$3"
  );

  // Mask URI query params: ?password=..., &token=...
  sanitized = sanitized.replace(
    /([?&](?:password|pwd|secret|key|apikey|token|auth)=)([^&#\s\n'"]+)/gi,
    "$1****"
  );

  // Mask keyword password=...
  sanitized = sanitized.replace(
    /(password\s*=\s*)(?:'[^']*'|"[^"]*"|[^\s;,'"\\)]+)/gi,
    "$1****"
  );

  // Explicitly replace every extracted secret token
  for (const secret of secrets) {
    if (secret && secret.length >= 3) {
      sanitized = sanitized.split(secret).join("****");
    }
  }

  return sanitized;
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
 * Enforces --schema-only so no table rows or user PII are exported.
 */
export function buildPgDumpConfig(options: BackupOptions = {}): {
  args: string[];
  outputPath: string;
  fileName: string;
} {
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const dateStr = options.date ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `careerhound-schema-backup-${dateStr}.sql`;
  const outputPath = path.join(outputDir, fileName);

  const args: string[] = [
    "--schema=public",
    "--schema-only", // Safe design: schema DDL only, zero user data/rows exported
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
  const secretsToScrub = extractSecretsToScrub(resolved.connectionString);

  console.log(`[DB-BACKUP] Preparing schema-only logical backup to: ${outputPath}`);
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
    const finalArgs = [...args, `--dbname=${resolved.connectionString}`];

    execFile("pg_dump", finalArgs, { env: { ...process.env } }, (err, stdout, stderr) => {
      if (err) {
        // Scrub all connection strings, passwords, and query parameters from error message and stderr
        const rawErrText = `${err.message || ""}\n${stderr || ""}`;
        const sanitizedErr = scrubSensitiveSecrets(rawErrText, secretsToScrub);

        console.error(`[DB-BACKUP] pg_dump failed: ${sanitizedErr.trim()}`);
        resolve({
          success: false,
          error: sanitizedErr.trim(),
        });
        return;
      }

      console.log(`[DB-BACKUP] Successfully generated schema-only logical backup: ${outputPath}`);
      resolve({
        success: true,
        outputPath,
        fileName,
      });
    });
  });
}
