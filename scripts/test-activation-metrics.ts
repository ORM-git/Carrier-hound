/**
 * Offline static test for the activation/retention health queries
 * (Backend row "Activation / Retention Metrics").
 * Run: npx tsx scripts/test-activation-metrics.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const health = fs.readFileSync("scripts/db-health.sql", "utf8");

check("has an activation / retention section", /activation \/ retention/i.test(health));
check("DAU metric present", health.includes("DAU (avg, last 14d)"));
check("WAU metric present", health.includes("WAU (avg, last 8w)"));
check("MAU metric present", health.includes("MAU (last 30d)"));
check("activity counted from page_views", /from public\.page_views/i.test(health));
check("anonymous traffic excluded from active-user counts", health.includes("user_id is not null"));
check("week-1 cohort retention query present", health.includes("week1_retention_pct"));
check("cohorts come from auth.users signups", /from auth\.users/i.test(health));
check("only mature cohorts measured", health.includes("interval '1 week'"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
