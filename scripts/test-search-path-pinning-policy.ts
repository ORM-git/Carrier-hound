/**
 * Offline static test for SECURITY DEFINER search_path pinning (Database
 * row "SECURITY DEFINER search_path pinning"): migration 20261106p pins
 * search_path = public on every public SECURITY DEFINER function
 * (dynamically, so overload variants are not missed), documents the 10
 * known unpinned payment/AI RPCs, and every NEW migration after 20261106p
 * must pin search_path inline on any SECURITY DEFINER function it defines.
 * Run: npx tsx scripts/test-search-path-pinning-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const migrationPath = "supabase/migrations/20261106p_security_definer_search_path.sql";
check("migration file exists", fs.existsSync(migrationPath));
const sql = fs.readFileSync(migrationPath, "utf8");

check(
  "migration marked NOT APPLIED with record command",
  sql.includes("STATUS: NOT APPLIED") &&
    sql.includes("record-migration.cjs 20261106p_security_definer_search_path")
);
check(
  "pins dynamically over pg_proc (catches overloads)",
  /FOR f IN[\s\S]*pg_proc[\s\S]*prosecdef[\s\S]*LOOP/.test(sql) &&
    /pg_get_function_identity_arguments/.test(sql)
);
check(
  "sets search_path = public via ALTER FUNCTION",
  /ALTER FUNCTION public\.%I\(%s\) SET search_path = public/.test(sql)
);
check(
  "scoped to the public schema",
  /n\.nspname = 'public'/.test(sql)
);
check(
  "documents all 10 known unpinned payment/AI function names",
  ["fulfil_payment_order", "consume_addon_set", "consume_plan_set",
   "consume_user_set", "refund_plan_or_addon_set", "record_plan_usage_result",
   "ai_global_budget_reserve", "ai_global_budget_settle",
   "ai_concurrency_acquire", "ai_concurrency_release"]
    .every((n) => sql.includes(n))
);
check(
  "post-check verification query included (expect zero rows)",
  /proconfig IS NULL OR NOT p\.proconfig::text LIKE '%search_path%'/.test(sql)
);
check("rollback documented", /ROLLBACK[\s\S]*RESET search_path/i.test(sql));

// Forward-looking rule: any migration newer than 20261106p that defines a
// SECURITY DEFINER function must pin search_path inside the same function.
const files = fs.readdirSync("supabase/migrations").filter(
  (f) => f > "20261106p_security_definer_search_path.sql" && f.endsWith(".sql")
);
let violations: string[] = [];
for (const f of files) {
  const src = fs.readFileSync(`supabase/migrations/${f}`, "utf8");
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_0-9]+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const block = src.slice(m.index, m.index + 4000);
    const end = block.indexOf("$$;");
    const body = end === -1 ? block : block.slice(0, end);
    if (/security\s+definer/i.test(body) && !/set\s+search_path/i.test(body)) {
      violations.push(`${f}: ${m[1]}`);
    }
  }
}
check(
  "all SECURITY DEFINER functions in newer migrations pin search_path inline",
  violations.length === 0
);
if (violations.length) console.log("  unpinned: " + violations.join(", "));

const health = fs.readFileSync("scripts/db-health.sql", "utf8");
check(
  "db-health has unpinned-function review section",
  /17\. SECURITY DEFINER search_path pinning/.test(health) && health.includes("prosecdef")
);

const runner = fs.readFileSync("scripts/suite-runner.ts", "utf8");
check(
  "suite runner registers the policy test",
  runner.includes("scripts/test-search-path-pinning-policy.ts")
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
