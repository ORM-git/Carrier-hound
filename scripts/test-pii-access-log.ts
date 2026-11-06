/**
 * Offline static test for the PII read audit (DB row: user data access audit):
 * every route that returns personal data to an admin (or exports a user's own
 * data) must write a fail-open 'pii_read' record to admin_audit_log.
 * Run: npx tsx scripts/test-pii-access-log.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const usersRoute = fs.readFileSync("src/app/api/admin/users/route.ts", "utf8");
const activityRoute = fs.readFileSync("src/app/api/admin/users/activity/route.ts", "utf8");
const earlyAccessRoute = fs.readFileSync("src/app/api/admin/early-access/route.ts", "utf8");
const exportHandler = fs.readFileSync("src/lib/account/exportHandler.ts", "utf8");
const health = fs.readFileSync("scripts/db-health.sql", "utf8");

for (const [name, src] of [
  ["admin users list", usersRoute],
  ["admin user activity", activityRoute],
  ["admin early-access list", earlyAccessRoute],
  ["account export", exportHandler],
] as const) {
  check(`${name}: imports logAdminAction`, src.includes('from "@/lib/admin/auditLog"'));
  check(`${name}: logs action pii_read`, src.includes('action: "pii_read"'));
  check(`${name}: passes the request for IP hashing`, src.includes("request: req"));
}

check("users list targets user_list", usersRoute.includes('targetType: "user_list"'));
check("activity targets the subject user", activityRoute.includes('targetType: "user"') && activityRoute.includes("targetId: userId"));
check("early-access targets early_access_list", earlyAccessRoute.includes('targetType: "early_access_list"'));
check("export targets self_data_export", exportHandler.includes('targetType: "self_data_export"'));
check("export logs the exporting user as actor", exportHandler.includes("adminUserId: userId"));
// Only inspect the pii_read call blocks (pre-existing mutation logs sanitize at runtime).
const piiBlocks = [usersRoute, activityRoute, earlyAccessRoute, exportHandler].flatMap((src) => {
  const blocks: string[] = [];
  const re = /logAdminAction\(\{[\s\S]*?\}\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[0].includes('"pii_read"')) blocks.push(m[0]);
  }
  return blocks;
});
check("all four pii_read call sites found", piiBlocks.length === 4);
check("no raw emails in pii_read metadata (counts/ids only)", !piiBlocks.some((b) => /email/i.test(b)));

check("db-health has a PII access review query", /pii access review/i.test(health));
check("db-health review filters action = 'pii_read'", health.includes("where action = 'pii_read'"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
