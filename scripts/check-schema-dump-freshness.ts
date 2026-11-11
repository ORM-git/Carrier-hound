/**
 * CI Verification script: Schema Dump Freshness Check.
 *
 * Verifies that supabase/schema.generated.sql is up to date with all
 * migrations in supabase/migrations/ and includes a dated freshness header.
 * Exits with code 1 if stale, missing migrations, or missing header.
 *
 * Usage:
 *   npx tsx scripts/check-schema-dump-freshness.ts
 */

import { checkSchemaDumpFreshness } from "./lib/schema-dump";

export function runCheckSchemaDumpFreshness(): boolean {
  const result = checkSchemaDumpFreshness();

  if (!result.fresh) {
    console.error("[SCHEMA-FRESHNESS] FAIL: Consolidated schema representation is stale or invalid:");
    for (const reason of result.reasons) {
      console.error(`  - ${reason}`);
    }
    console.error(
      "\nTo fix: run 'npx tsx scripts/generate-schema-dump.ts' and commit the updated supabase/schema.generated.sql."
    );
    return false;
  }

  console.log(
    `[SCHEMA-FRESHNESS] PASS: Schema dump is fresh (${result.expectedCount} migrations verified, dated ${result.dumpDate}).`
  );
  return true;
}

if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("check-schema-dump-freshness.ts")) {
  const success = runCheckSchemaDumpFreshness();
  if (!success) {
    process.exit(1);
  }
}
