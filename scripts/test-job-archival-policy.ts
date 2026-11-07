/**
 * Offline static test for the job archival strategy (Database row
 * "Archival strategy"): migration 20261106l creates jobs_archive (RLS,
 * service-role only) plus archive_expired_jobs (dry-run-first, fail-open),
 * the weekly retention cron calls it and skips cleanly until applied, and
 * the review surfaces document it.
 * Run: npx tsx scripts/test-job-archival-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const migrationPath = "supabase/migrations/20261106l_job_archival.sql";
check("migration file exists", fs.existsSync(migrationPath));
const sql = fs.readFileSync(migrationPath, "utf8");

check(
  "migration marked NOT APPLIED with record command",
  sql.includes("STATUS: NOT APPLIED") &&
    sql.includes("record-migration.cjs 20261106l_job_archival")
);
check(
  "jobs_archive mirrors jobs shape",
  /CREATE TABLE IF NOT EXISTS public\.jobs_archive\s*\(\s*LIKE public\.jobs/i.test(sql)
);
check(
  "jobs_archive has archived_at marker",
  /ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/i.test(sql)
);
check(
  "jobs_archive RLS enabled, clients revoked, service-role only",
  /ALTER TABLE public\.jobs_archive ENABLE ROW LEVEL SECURITY/i.test(sql) &&
    /REVOKE ALL ON public\.jobs_archive FROM anon, authenticated/i.test(sql) &&
    !/GRANT .* ON public\.jobs_archive TO (anon|authenticated)/i.test(sql)
);
check(
  "archive function is dry-run-first (defaults TRUE)",
  /archive_expired_jobs\(\s*dry_run BOOLEAN DEFAULT TRUE/i.test(sql)
);
check(
  "archive function only moves inactive expired jobs",
  sql.includes("j.is_active = false") && sql.includes("j.status = 'expired'")
);
check(
  "archive function preserves description text",
  /LEFT JOIN public\.job_descriptions/i.test(sql)
);
check(
  "archive function is fail-open (WARNING, not abort)",
  /EXCEPTION WHEN OTHERS THEN\s*RAISE WARNING/i.test(sql)
);
check(
  "archive function execute revoked from clients",
  /REVOKE ALL ON FUNCTION public\.archive_expired_jobs/i.test(sql)
);
check("chosen-default threshold labeled", /chosen default/i.test(sql));
check("rollback documented", /ROLLBACK/i.test(sql));

const cron = fs.readFileSync("scripts/retention-cron.ts", "utf8");
check(
  "retention cron calls archive_expired_jobs",
  cron.includes('"archive_expired_jobs"')
);
check(
  "retention cron skips archival when migration missing",
  /not applied yet \(migration 20261106l/.test(cron)
);
check(
  "retention cron archival is fail-open (non-fatal)",
  cron.includes("non-fatal")
);

const classification = fs.readFileSync("docs/data-classification.md", "utf8");
check(
  "jobs_archive in data classification doc",
  classification.includes("`jobs_archive`")
);

const retentionDoc = fs.readFileSync("docs/retention-policy.md", "utf8");
check(
  "retention policy documents jobs archival",
  retentionDoc.includes("jobs_archive") && retentionDoc.includes("20261106l")
);

const dbHealth = fs.readFileSync("scripts/db-health.sql", "utf8");
check(
  "db-health has archival review section",
  dbHealth.includes("jobs_archive") && dbHealth.includes("job_archival")
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
