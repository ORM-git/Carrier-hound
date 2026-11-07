/**
 * Offline static test for migration 20261107g_touch_updated_at_triggers.sql
 * (NOT APPLIED). Database sheet rows "Auto-touch updated_at trigger" and
 * "updated_at maintenance trigger". Checks the SQL text against the real DDL of
 * the tables it touches and against docs/db-triggers.md. Live trigger behavior is
 * unproven here (the SQL is never executed).
 * Run: npx tsx scripts/test-touch-updated-at.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const FILE = "20261107g_touch_updated_at_triggers.sql";
const sql = fs.readFileSync("supabase/migrations/" + FILE, "utf8");
const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const TABLES = ["candidate_profiles", "applications", "user_preferences", "resumes", "tailored_resumes"];

check("header: NOT APPLIED and record-migration command", /STATUS: NOT APPLIED/.test(sql) && /record-migration\.cjs 20261107g_touch_updated_at_triggers/.test(sql));
check("function: only touches updated_at when the caller did not change it", /IF NEW\.updated_at IS NOT DISTINCT FROM OLD\.updated_at THEN\s+NEW\.updated_at := now\(\);/.test(code) && /RETURN NEW;/.test(code));
check("function: pinned empty search_path, revoked, service_role only", /SET search_path = ''/.test(code) && /REVOKE ALL ON FUNCTION public\.touch_updated_at\(\) FROM PUBLIC, anon, authenticated/.test(code) && /GRANT EXECUTE ON FUNCTION public\.touch_updated_at\(\) TO service_role/.test(code));
check("function never raises or rejects a write", !/RAISE/i.test(code));

// Real DDL of each table: updated_at TIMESTAMPTZ exists in an earlier migration.
const others = fs.readdirSync("supabase/migrations").filter((n) => n.endsWith(".sql") && n < FILE);
const allSql = others.map((n) => fs.readFileSync("supabase/migrations/" + n, "utf8")).join("\n");
TABLES.forEach((t) => {
  const re = new RegExp("create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?" + t + "\\s*\\(([\\s\\S]*?)\\n\\);", "gi");
  let found = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(allSql)) !== null) {
    if (/^\s*updated_at\s+timestamptz/im.test(m[1])) found = true;
  }
  check(`${t}: updated_at TIMESTAMPTZ column exists in an earlier migration`, found);
  check(`${t}: BEFORE UPDATE trigger on the table using touch_updated_at()`, new RegExp("create trigger trg_touch_updated_at_" + t + "\\s+before update on public\\." + t + "\\s+for each row execute function public\\.touch_updated_at\\(\\)", "i").test(code) && new RegExp("DROP TRIGGER IF EXISTS trg_touch_updated_at_" + t + " ON public\\." + t + ";").test(code));
  check(`${t}: rollback drops the trigger`, new RegExp("--   DROP TRIGGER IF EXISTS trg_touch_updated_at_" + t + " ON public\\." + t + ";").test(sql));
});
const count = (code.match(/create trigger/gi) || []).length;
check("exactly the five listed tables get a trigger", count === TABLES.length);
check("billing and source-data tables are not touched", !/subscriptions|payment_orders|user_addon_credits|public\.jobs\b/i.test(code));
check("rollback drops the function", /--   DROP FUNCTION IF EXISTS public\.touch_updated_at\(\);/.test(sql));

// Trigger map doc (guard-enforced by src/lib/__tests__/dbTriggersDoc.test.ts).
const doc = fs.readFileSync("docs/db-triggers.md", "utf8");
TABLES.forEach((t) => {
  check(`doc maps trg_touch_updated_at_${t}`, doc.indexOf("trigger: trg_touch_updated_at_" + t + " | " + FILE + " | " + t) !== -1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
