/**
 * Offline static test for the matview staleness metric (audit DB #17):
 * migration 20261106d + db-health section 6b.
 * Run: npx tsx scripts/test-matview-staleness.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const mig = fs.readFileSync("supabase/migrations/20261106d_matview_refresh_log.sql", "utf8");
const health = fs.readFileSync("scripts/db-health.sql", "utf8");

check("migration marked NOT APPLIED", mig.includes("NOT APPLIED"));
check("migration names record-migration command", mig.includes("record-migration.cjs 20261106d_matview_refresh_log"));
check("creates matview_refresh_log table", /create table if not exists public\.matview_refresh_log/i.test(mig));
check("log table RLS enabled", /alter table public\.matview_refresh_log enable row level security/i.test(mig));
check("client roles revoked", /revoke all on table public\.matview_refresh_log from anon, authenticated/i.test(mig));
check("service_role granted", /grant all on table public\.matview_refresh_log to service_role/i.test(mig));
check("refresh function keeps pinned search_path", mig.includes("set search_path = public, pg_temp"));
check("concurrent refresh preserved", /refresh materialized view concurrently public\.worldwide_company_counts/i.test(mig));
check("non-concurrent fallback preserved", /refresh materialized view public\.worldwide_company_counts/i.test(mig));
check("log insert only after successful refresh", mig.includes("if v_refreshed then"));
check("log insert is fail-open", /exception when others then\s*raise warning 'matview_refresh_log insert failed/i.test(mig));
check("execute granted to service_role only", /revoke all on function public\.refresh_worldwide_company_counts\(\) from public, anon, authenticated/i.test(mig) && /grant execute on function public\.refresh_worldwide_company_counts\(\) to service_role/i.test(mig));
check("rollback section present", mig.includes("Rollback:"));

check("db-health 6b queries the refresh log", /from public\.matview_refresh_log/i.test(health));
check("db-health 6b reports staleness interval", /now\(\) - max\(refreshed_at\) as staleness/i.test(health));
check("db-health 6b notes migration dependency", health.includes("requires migration 20261106d"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
