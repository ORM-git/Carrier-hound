/**
 * Static checks for BE#3: log retention / central logs doc.
 * Run: npx tsx scripts/test-log-retention-doc.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const doc = fs.readFileSync("docs/log-retention.md", "utf8");

check("marked INTERNAL", doc.includes("INTERNAL"));
check("covers Cloudflare Pages production logs", doc.includes("Cloudflare Pages (production)"));
check("scopes Netlify to preview/legacy only", doc.includes("Netlify (preview/legacy functions)"));
check("has explicit owner steps (dashboard-bound)", doc.includes("Owner steps"));
check("names Sentry as central error log", doc.includes("Sentry") && doc.includes("sentryErrorReporter.ts"));
for (const t of ["cron_run_logs", "admin_audit_log", "failed_events", "gmail_send_log", "page_views"]) {
  check(`tracks ${t}`, doc.includes(t));
}
check("aligns with the DPDP retention policy", doc.includes("docs/retention-policy.md"));
check("forbids PII in logs", doc.includes("No PII"));
check("defers format to BE#27 instead of duplicating", doc.includes("BE#27"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
