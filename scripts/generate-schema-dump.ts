/**
 * CLI script to regenerate supabase/schema.generated.sql from all migration files.
 *
 * Usage:
 *   npx tsx scripts/generate-schema-dump.ts
 */

import { writeSchemaDump, DEFAULT_SCHEMA_DUMP_PATH } from "./lib/schema-dump";

export function runGenerateSchemaDump(dumpPath = DEFAULT_SCHEMA_DUMP_PATH): void {
  const date = new Date().toISOString().slice(0, 10);
  writeSchemaDump(dumpPath, { date });
  console.log(`[SCHEMA-DUMP] Successfully regenerated ${dumpPath} (dated: ${date})`);
}

if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("generate-schema-dump.ts")) {
  runGenerateSchemaDump();
}
