/**
 * Offline static test for the slow-query review surface
 * (DB row "Slow-query log"): pg_stat_statements enabled by migration
 * 20261105c + a top-queries review query in db-health.sql.
 * Run: npx tsx scripts/test-slow-query-review.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const safety = fs.readFileSync("supabase/migrations/20261105c_database_safety.sql", "utf8");
const health = fs.readFileSync("scripts/db-health.sql", "utf8");

check("20261105c enables pg_stat_statements", /create extension if not exists pg_stat_statements/i.test(safety));
check("db-health has a slow-query section", /slow queries/i.test(health));
check("review query reads pg_stat_statements", /from pg_stat_statements/i.test(health));
check("review query reports mean and max timings", health.includes("mean_exec_time") && health.includes("max_exec_time"));
check("review query orders by total time", /order by total_exec_time desc/i.test(health));
check("review query excludes itself", health.includes("not ilike '%pg_stat_statements%'"));
check("log_min_duration limitation documented", health.includes("log_min_duration_statement"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
