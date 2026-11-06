/**
 * Static checks for BE#8: error budget policy lives in docs/slo.md, keeps the
 * existing SLO table intact, and defines burn rates + freeze rule.
 * Run: npx tsx scripts/test-error-budget-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const doc = fs.readFileSync("docs/slo.md", "utf8");

check("policy section exists", doc.includes("Error budget policy (BE#8)"));
check("keeps the 0.5% monthly budget", doc.includes("0.5% of monthly uptime"));
check("defines a fast-burn rule (14.4x / 1h)", doc.includes("14.4x") && doc.includes("1 hour"));
check("defines a slow-burn rule (6x / 6h)", doc.includes("6x") && doc.includes("6 hours"));
check("defines the freeze rule when budget is exhausted", /feature work on the affected surface\s+pauses/.test(doc));
check("names measurement sources", doc.includes("UptimeRobot") && doc.includes("web_vitals") && doc.includes("cron_run_logs"));
check("keeps existing SLO rows intact", doc.includes("Site availability (careermonke.com)") && doc.includes("Daily digest delivery"));
check("marks alerting automation as an owner-side step", /owner-side monitor\s+configuration/.test(doc));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
