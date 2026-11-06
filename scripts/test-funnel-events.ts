/**
 * Offline static test for funnel tracking (Backend row "Funnel Tracking"):
 * storage migration 20261106e + /api/track funnel branch + health query.
 * Run: npx tsx scripts/test-funnel-events.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const mig = fs.readFileSync("supabase/migrations/20261106e_funnel_events.sql", "utf8");
const route = fs.readFileSync("src/app/api/track/route.ts", "utf8");
const health = fs.readFileSync("scripts/db-health.sql", "utf8");

const EXPECTED_EVENTS = [
  "signup_started",
  "signup_completed",
  "onboarding_started",
  "onboarding_completed",
  "apply_started",
  "apply_completed",
];

check("migration marked NOT APPLIED", mig.includes("NOT APPLIED"));
check("migration names record-migration command", mig.includes("record-migration.cjs 20261106e_funnel_events"));
check("creates funnel_events table", /create table if not exists public\.funnel_events/i.test(mig));
check("RLS enabled", /alter table public\.funnel_events enable row level security/i.test(mig));
check("client roles revoked", /revoke all on table public\.funnel_events from anon, authenticated/i.test(mig));
check("service_role granted", /grant all on table public\.funnel_events to service_role/i.test(mig));
check("user_id FK set null on delete", /user_id uuid references auth\.users\(id\) on delete set null/i.test(mig));
check("rollback present", mig.includes("drop table if exists public.funnel_events"));

// Allowlist parity between migration CHECK and route Set
const migEvents = [...mig.matchAll(/'(signup|onboarding|apply)_(started|completed)'/g)].map((m) => m[0].slice(1, -1));
const migUnique = [...new Set(migEvents)].sort();
check("migration CHECK lists exactly the 6 funnel stages", JSON.stringify(migUnique) === JSON.stringify([...EXPECTED_EVENTS].sort()));
for (const ev of EXPECTED_EVENTS) {
  check(`route allowlist contains ${ev}`, route.includes(`"${ev}"`));
}

check("route has a funnel eventType branch", route.includes('eventType === "funnel"'));
check("route validates event against the allowlist", route.includes("ALLOWED_FUNNEL_EVENTS.has(funnelEvent)"));
check("route derives actor from session, not body", route.includes("await getSessionUserId(req)"));
check("route hashes the IP", route.includes("sha256Hex16(`${ipForHash}_careermonke_salt`)"));
check("route caps metadata size", route.includes("MAX_FUNNEL_METADATA_BYTES"));
check("route tolerates missing table (PGRST205)", /PGRST205/.test(route));
check("route inserts via service role client", route.includes('from("funnel_events").insert'));

check("db-health has a funnel review query", /funnel review/i.test(health));
check("db-health funnel query reads funnel_events", /from public\.funnel_events/i.test(health));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
