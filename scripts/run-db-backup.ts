/**
 * Database Logical Backup Runner (Database sheet: Logical backup prep).
 *
 * Invokes pg_dump with hardened flags, saving a consolidated public schema
 * and data snapshot for artifact archival.
 *
 * Usage:
 *   npx tsx scripts/run-db-backup.ts
 *   npx tsx scripts/run-db-backup.ts --dry-run
 */

import { runDatabaseBackup } from "./lib/db-backup";

export async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const result = await runDatabaseBackup({ dryRun });

  if (!result.success) {
    process.exit(1);
  }
}

if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("run-db-backup.ts")) {
  main().catch((err) => {
    console.error("[DB-BACKUP] Fatal error:", err);
    process.exit(1);
  });
}
