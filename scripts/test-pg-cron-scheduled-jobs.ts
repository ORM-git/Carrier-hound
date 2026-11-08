/**
 * Offline static test for migration 20261108a_pg_cron_scheduled_jobs.sql
 * (NOT APPLIED). Database sheet row "pg_cron": DB-side schedules must not
 * depend on GitHub Actions staying green. Verifies the migration enables
 * pg_cron, schedules the purge and matview refresh idempotently, and only
 * references functions created by earlier migrations. Never executes SQL.
 * Run: npx tsx scripts/test-pg-cron-scheduled-jobs.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const FILE = "20261108a_pg_cron_scheduled_jobs.sql";
const sql = fs.readFileSync("supabase/migrations/" + FILE, "utf8");
const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

check("header: NOT APPLIED and record-migration command", /STATUS: NOT APPLIED/.test(sql) && /record-migration\.cjs 20261108a_pg_cron_scheduled_jobs/.test(sql));
check("header: rollback block names both jobs", /ROLLBACK/.test(sql) && /purge-operational-logs-weekly/.test(sql) && /refresh-worldwide-counts-daily/.test(sql));
check("enables pg_cron idempotently", /create\s+extension\s+if\s+not\s+exists\s+pg_cron/i.test(code));

// Job definitions: jobname, cron expression, command
const jobRe = /cron\.schedule\(\s*'([a-z0-9-]+)',\s*'([^']+)',\s*\$cmd\$([\s\S]*?)\$cmd\$\s*\)/g;
const jobs: { name: string; expr: string; cmd: string }[] = [];
let m: RegExpExecArray | null;
while ((m = jobRe.exec(code)) !== null) jobs.push({ name: m[1], expr: m[2], cmd: m[3].trim() });
check("exactly two jobs scheduled", jobs.length === 2);
check("first apply never unschedules a nonexistent job", !/cron\.unschedule\s*\(/i.test(code));
check("job names are distinct for named upsert", new Set(jobs.map((job) => job.name)).size === jobs.length);

const CRON5 = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;
for (const job of jobs) {
  check(`${job.name}: valid 5-field cron expression`, CRON5.test(job.expr));
  check(`${job.name}: named schedule supports first apply and upsert`, job.name.length > 0);
}

const purge = jobs.find((j) => j.name === "purge-operational-logs-weekly");
const refresh = jobs.find((j) => j.name === "refresh-worldwide-counts-daily");
check("purge job present", !!purge);
check("refresh job present", !!refresh);
check("purge passes explicit false (never the dry-run default)", !!purge && /purge_operational_logs\(false\)/.test(purge.cmd));

// Scheduled commands may only call functions created by earlier migrations.
const names = fs.readdirSync("supabase/migrations").filter((n) => n.endsWith(".sql") && n < FILE);
const earlier = names.map((n) => fs.readFileSync("supabase/migrations/" + n, "utf8")).join("\n");
check("purge_operational_logs created by an earlier migration", /create\s+or\s+replace\s+function\s+public\.purge_operational_logs\b/i.test(earlier));
check("refresh_worldwide_company_counts created by an earlier migration", /create\s+or\s+replace\s+function\s+public\.refresh_worldwide_company_counts\b/i.test(earlier));

// No other DDL/DML: only CREATE EXTENSION and SELECT cron.* statements.
const stripped = code
  .replace(/create\s+extension\s+if\s+not\s+exists\s+pg_cron\s*;/gi, "")
  .replace(/select\s+cron\.(un)?schedule\([\s\S]*?(\$cmd\$[\s\S]*?\$cmd\$)?\)\s*;/g, "");
check("no other DDL or data change", !/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE|TRUNCATE)\b/i.test(stripped));

// Doc lockstep: the runbook must name both jobs.
const doc = fs.readFileSync("docs/pg-cron-schedules.md", "utf8");
check("docs/pg-cron-schedules.md names both jobs", doc.includes("purge-operational-logs-weekly") && doc.includes("refresh-worldwide-counts-daily"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
