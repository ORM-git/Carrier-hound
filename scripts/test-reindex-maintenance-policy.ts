/**
 * Offline static test for REINDEX maintenance (Database row "REINDEX
 * maintenance"): migration 20261106m creates reindex_bloated_indexes
 * (dry-run-first, per-index failure isolation, fail-open, service-role
 * only), the weekly retention cron calls it and skips cleanly until
 * applied, and db-health.sql documents the review surface.
 * Run: npx tsx scripts/test-reindex-maintenance-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const migrationPath = "supabase/migrations/20261106m_reindex_maintenance.sql";
check("migration file exists", fs.existsSync(migrationPath));
const sql = fs.readFileSync(migrationPath, "utf8");

check(
  "migration marked NOT APPLIED with record command",
  sql.includes("STATUS: NOT APPLIED") &&
    sql.includes("record-migration.cjs 20261106m_reindex_maintenance")
);
check(
  "function is dry-run-first (dry_run DEFAULT TRUE)",
  /reindex_bloated_indexes\(\s*min_size_mb INTEGER DEFAULT 50,\s*dry_run BOOLEAN DEFAULT TRUE/i.test(sql)
);
check(
  "size threshold compares bytes against min_size_mb",
  /pg_relation_size\(i\.oid\) >= min_size_mb \* 1024 \* 1024/.test(sql)
);
check(
  "scoped to public schema user tables and matviews only",
  sql.includes("n.nspname = 'public'") && /t\.relkind IN \('r', 'm'\)/.test(sql)
);
check(
  "executes plain REINDEX per index via format()",
  /EXECUTE format\('REINDEX INDEX %I\.%I'/.test(sql)
);
check(
  "documents why REINDEX CONCURRENTLY is not used",
  /CONCURRENTLY\) cannot run/i.test(sql)
);
check(
  "per-index failure isolated (nested exception, action failed)",
  /BEGIN\s*EXECUTE format\('REINDEX INDEX/.test(sql) &&
    /action := 'failed'/.test(sql)
);
check(
  "fail-open outer handler (WARNING, not abort)",
  /EXCEPTION WHEN OTHERS THEN\s*RAISE WARNING 'reindex_bloated_indexes failed/i.test(sql)
);
check(
  "execute revoked from PUBLIC/anon/authenticated, granted to service_role only",
  /REVOKE ALL ON FUNCTION public\.reindex_bloated_indexes\(INTEGER, BOOLEAN\) FROM PUBLIC, anon, authenticated/i.test(sql) &&
    /GRANT EXECUTE ON FUNCTION public\.reindex_bloated_indexes\(INTEGER, BOOLEAN\) TO service_role/i.test(sql) &&
    !/GRANT .*ON FUNCTION public\.reindex_bloated_indexes.* TO (anon|authenticated)/i.test(sql)
);
check("chosen-default threshold labeled", /chosen default/i.test(sql));
check("rollback documented", /ROLLBACK[\s\S]*DROP FUNCTION IF EXISTS public\.reindex_bloated_indexes/i.test(sql));

const cron = fs.readFileSync("scripts/retention-cron.ts", "utf8");
check(
  "retention cron calls reindex_bloated_indexes",
  cron.includes('"reindex_bloated_indexes"')
);
check(
  "retention cron skips reindex when migration missing",
  /not applied yet \(migration 20261106m/.test(cron)
);
check(
  "retention cron reindex is fail-open (non-fatal)",
  /Index maintenance RPC error \(non-fatal\)/.test(cron)
);
check(
  "retention cron logs reindex_maintenance to cron_run_logs",
  cron.includes('job_type: "reindex_maintenance"')
);

const health = fs.readFileSync("scripts/db-health.sql", "utf8");
check(
  "db-health has index maintenance review section",
  /14\. Index maintenance/.test(health) && health.includes("pg_stat_user_indexes")
);

const runner = fs.readFileSync("scripts/suite-runner.ts", "utf8");
check(
  "suite runner registers the policy test",
  runner.includes("scripts/test-reindex-maintenance-policy.ts")
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
