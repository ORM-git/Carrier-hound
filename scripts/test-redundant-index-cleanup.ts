/**
 * Offline static test for the redundant index cleanup
 * (Database row "Redundant index cleanup").
 * Run: npx tsx scripts/test-redundant-index-cleanup.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const mig = fs.readFileSync("supabase/migrations/20261106g_drop_redundant_subscriptions_index.sql", "utf8");

check("migration marked NOT APPLIED", mig.includes("NOT APPLIED"));
check("migration names record-migration command", mig.includes("record-migration.cjs 20261106g_drop_redundant_subscriptions_index"));
check("drops the redundant plain index", /drop index if exists public\.idx_subscriptions_user_id;/i.test(mig));
check("does not drop the unique constraint index", !/drop index[^;]*idx_subscriptions_user_id_unique/i.test(mig) && !/drop constraint/i.test(mig));
check("names the duplicating constraint", mig.includes("subscriptions_user_unique"));
check("rollback recreates the index", /create index if not exists idx_subscriptions_user_id on public\.subscriptions\(user_id\)/i.test(mig));

// Nothing in app code may depend on the dropped index by name
const srcFiles: string[] = [];
function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory() && e.name !== "node_modules") walk(p);
    else if (e.isFile() && p.endsWith(".ts")) srcFiles.push(p);
  }
}
walk("src");
const referencing = srcFiles.filter((f) => fs.readFileSync(f, "utf8").includes("idx_subscriptions_user_id"));
check("no app code references the dropped index", referencing.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
