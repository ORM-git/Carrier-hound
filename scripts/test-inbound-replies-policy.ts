/**
 * Static checks for Backend sheet rank 14: inbound reply handling.
 * Run: npx tsx scripts/test-inbound-replies-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const doc = fs.readFileSync("docs/inbound-replies.md", "utf8");
const script = fs.readFileSync("scripts/poll-inbound-replies.ts", "utf8");
const migration = fs.readFileSync("supabase/migrations/20261106j_inbound_replies.sql", "utf8");
const workflow = fs.readFileSync(".github/workflows/inbound-poll-cron.yml", "utf8");

check("doc marked INTERNAL", doc.includes("INTERNAL"));
check("migration NOT APPLIED with record command", migration.includes("NOT APPLIED") && migration.includes("record-migration.cjs 20261106j_inbound_replies"));
check("migration has rollback", migration.includes("Rollback:") && migration.includes("DROP TABLE IF EXISTS public.inbound_replies"));
check("message_id unique dedupe key", migration.includes("message_id    text not null unique"));
check("RLS enabled, service-role only", migration.includes("enable row level security") && !migration.includes("create policy"));
check("poller gated off by default", script.includes('INBOUND_POLL_ENABLED !== "true"') && workflow.includes("INBOUND_POLL_ENABLED"));
check("403 scope gap handled as not-yet-activated", script.includes("listRes.status === 403") && script.includes("gmail.readonly"));
check("poller dedupes before insert", script.includes("maybeSingle") && script.includes("message_id"));
check("inserts fail-open", script.includes("fail-open"));
check("bounce/unsubscribe deferred to their own rows", doc.includes("38/39") && !script.includes("List-Unsubscribe-Post"));
check("owner steps: scope re-consent + migration", doc.includes("gmail.readonly") && doc.includes("owner") && doc.includes("record-migration.cjs"));
check("chosen defaults labeled", (doc.match(/chosen default/g) || []).length >= 1 && script.includes("MAX_MESSAGES_PER_RUN"));
check("workflow scheduled and uses existing secrets", workflow.includes("cron:") && workflow.includes("GMAIL_REFRESH_TOKEN") && workflow.includes("SUPABASE_SERVICE_ROLE_KEY"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
