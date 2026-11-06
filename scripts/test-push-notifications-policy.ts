/**
 * Static checks for Backend sheet rank 13: push notification scaffolding.
 * Run: npx tsx scripts/test-push-notifications-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const doc = fs.readFileSync("docs/push-notifications.md", "utf8");
const adapter = fs.readFileSync("src/lib/notifications/webPush.ts", "utf8");
const migration = fs.readFileSync("supabase/migrations/20261106e_push_subscriptions.sql", "utf8");

check("doc marked INTERNAL", doc.includes("INTERNAL"));
check("migration NOT APPLIED with record command", migration.includes("NOT APPLIED") && migration.includes("record-migration.cjs 20261106e_push_subscriptions"));
check("migration has rollback", migration.includes("Rollback:") && migration.includes("DROP TABLE IF EXISTS public.push_subscriptions"));
check("migration stores the Web Push keys", migration.includes("endpoint") && migration.includes("p256dh") && migration.includes("auth") && migration.includes("endpoint    text not null unique"));
check("migration enables RLS with owner policies", migration.includes("enable row level security") && (migration.match(/create policy/g) || []).length >= 4);
check("adapter defines the provider contract", adapter.includes("interface PushProvider") && adapter.includes("PushMessage") && adapter.includes("PushSendResult"));
check("adapter is env-gated to noop", adapter.includes("NoopPushProvider") && adapter.includes("WEB_PUSH_VAPID_PUBLIC_KEY"));
check("adapter has no network sends", !adapter.includes("fetch("));
check("no new npm dependency claimed", doc.includes("web-push") && doc.includes("owner"));
check("doc keeps UI + provider as owner decisions", doc.includes("owner decisions") && doc.includes("VAPID"));
check("no user-facing copy", !doc.includes("notification text") && !adapter.includes("You have"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
