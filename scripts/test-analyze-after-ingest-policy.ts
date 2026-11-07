/**
 * Offline static test for ANALYZE after bulk load (Database row "ANALYZE
 * after bulk load"): migration 20261106q creates analyze_after_ingest
 * (SECURITY DEFINER, pinned search_path, service-role only, fail-open)
 * covering the three tables ingestion rewrites, and scripts/ingest.ts
 * calls it once after a live run (skipped on --dry, fail-open skip until
 * the migration is applied).
 * Run: npx tsx scripts/test-analyze-after-ingest-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const migrationPath = "supabase/migrations/20261106q_analyze_after_ingest.sql";
check("migration file exists", fs.existsSync(migrationPath));
const sql = fs.readFileSync(migrationPath, "utf8");

check(
  "migration marked NOT APPLIED with record command",
  sql.includes("STATUS: NOT APPLIED") &&
    sql.includes("record-migration.cjs 20261106q_analyze_after_ingest")
);
check(
  "function is SECURITY DEFINER with pinned search_path (house rule 20261106p)",
  /CREATE OR REPLACE FUNCTION public\.analyze_after_ingest\(\)[\s\S]*SECURITY DEFINER\s*SET search_path = public/i.test(sql)
);
check(
  "analyzes the three tables ingestion rewrites",
  /ANALYZE public\.jobs;/.test(sql) &&
    /ANALYZE public\.job_descriptions;/.test(sql) &&
    /ANALYZE public\.companies;/.test(sql)
);
check(
  "fail-open (WARNING, not abort)",
  /EXCEPTION WHEN OTHERS THEN\s*RAISE WARNING 'analyze_after_ingest failed/i.test(sql)
);
check(
  "execute revoked from clients, granted to service_role only",
  /REVOKE ALL ON FUNCTION public\.analyze_after_ingest\(\) FROM PUBLIC, anon, authenticated;/i.test(sql) &&
    /GRANT EXECUTE ON FUNCTION public\.analyze_after_ingest\(\) TO service_role;/i.test(sql)
);
check("rollback documented", /ROLLBACK[\s\S]*DROP FUNCTION IF EXISTS public\.analyze_after_ingest/i.test(sql));

const ingest = fs.readFileSync("scripts/ingest.ts", "utf8");
check(
  "ingest calls analyze_after_ingest via rpc",
  ingest.includes("supabase.rpc('analyze_after_ingest')")
);
check(
  "call is guarded to live runs (not --dry)",
  /if \(supabase && !isDryRun\) \{\s*try \{\s*const \{ error: analyzeError \}/.test(ingest)
);
check(
  "ingest skips ANALYZE cleanly until migration applied",
  /not applied yet \(migration 20261106q/.test(ingest)
);
check(
  "ingest ANALYZE failure is non-fatal",
  /Post-ingest ANALYZE RPC error \(non-fatal\)/.test(ingest)
);

const runner = fs.readFileSync("scripts/suite-runner.ts", "utf8");
check(
  "suite runner registers the policy test",
  runner.includes("scripts/test-analyze-after-ingest-policy.ts")
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
