/**
 * Static checks for Backend sheet rank 12: capacity headroom analysis.
 * Run: npx tsx scripts/test-capacity-headroom-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const doc = fs.readFileSync("docs/capacity-headroom.md", "utf8");
const script = fs.readFileSync("scripts/report-capacity-headroom.ts", "utf8");
const workflow = fs.readFileSync(".github/workflows/capacity-report-cron.yml", "utf8");

check("marked INTERNAL", doc.includes("INTERNAL"));
check("cites Supabase disk/egress docs", doc.includes("supabase.com/docs/guides/platform/manage-your-usage/disk-size") && doc.includes("manage-your-usage/egress"));
check("cites Groq rate-limit docs", doc.includes("console.groq.com/docs/rate-limits"));
check("records published limits (8 GB disk, 250 GB egress, 5 GB free)", doc.includes("8 GB") && doc.includes("250 GB") && doc.includes("5 GB"));
check("plan tier deferred to owner, nothing invented", doc.includes("Owner to confirm") && !doc.includes("Owner-confirmed"));
check("chosen defaults labeled (threshold, cadence, horizon)", (doc.match(/chosen default/g) || []).length >= 2);
check("owner steps for dashboard-only metrics", doc.includes("Owner steps") && doc.includes("dashboard"));
check("script reads Groq limits from response headers, no hardcoded numbers", script.includes("x-ratelimit-limit-requests") && !/const\s+(GROQ|RPM|TPM|RPD)_?LIMIT/i.test(script));
check("script threshold labeled chosen default", script.includes("WARN_FRACTION") && script.includes("Chosen default"));
check("script covers the hot tables", ["jobs", "web_vitals", "failed_events", "ingest_runs"].every((t) => script.includes(`"${t}"`)));
check("script exit codes: 1 breach, 2 env missing", script.includes("process.exit(2)") && script.includes("? 0 : 1"));
check("workflow scheduled weekly and dispatches the script", workflow.includes("cron:") && workflow.includes("report-capacity-headroom.ts"));
check("workflow uses the existing secrets", workflow.includes("SUPABASE_SERVICE_ROLE_KEY") && workflow.includes("GROQ_API_KEY") && workflow.includes("NEXT_PUBLIC_SUPABASE_URL"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
