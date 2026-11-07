/**
 * Offline static test for migration 20261107h_table_comments.sql (NOT APPLIED).
 * Database sheet row "COMMENT ON documentation". Checks that every commented table
 * is created by an earlier migration and that every comment text comes from
 * docs/data-classification.md (no invented wording). The SQL is never executed.
 * Run: npx tsx scripts/test-table-comments.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const FILE = "20261107h_table_comments.sql";
const sql = fs.readFileSync("supabase/migrations/" + FILE, "utf8");
const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

check("header: NOT APPLIED and record-migration command", /STATUS: NOT APPLIED/.test(sql) && /record-migration\.cjs 20261107h_table_comments/.test(sql));
check("rollback block present", /ROLLBACK/.test(sql) && /COMMENT ON TABLE public\.<table> IS NULL/.test(sql));
check("absent tables are skipped, not fatal (to_regclass guard)", /IF to_regclass\('public\.' \|\| r\.tbl\) IS NOT NULL THEN/.test(code));
check("comment text is bound with %I and %L (no string splicing)", /format\('COMMENT ON TABLE public\.%I IS %L', r\.tbl, r\.descr\)/.test(code));
check("only COMMENT statements: no DDL or data change", !/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE|TRUNCATE)\b/.test(code.replace(/\bEXECUTE\b/g, "")));

const pairs: { t: string; d: string }[] = [];
const re = /^\s*\('([a-z_]+)', '([^']+)'\),?\s*$/gm;
let m: RegExpExecArray | null;
while ((m = re.exec(code)) !== null) pairs.push({ t: m[1], d: m[2] });
check("pairs parsed (18 tables)", pairs.length === 18);

const names = fs.readdirSync("supabase/migrations").filter((n) => n.endsWith(".sql") && n < FILE);
const allSql = names.map((n) => fs.readFileSync("supabase/migrations/" + n, "utf8")).join("\n");
const doc = fs.readFileSync("docs/data-classification.md", "utf8").replace(/`/g, "");
const seen: Record<string, number> = {};
pairs.forEach((p) => {
  seen[p.t] = (seen[p.t] || 0) + 1;
  check(`${p.t}: created by an earlier migration`, new RegExp("create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?" + p.t + "\\b", "i").test(allSql));
  check(`${p.t}: comment text is in docs/data-classification.md`, doc.indexOf(p.d) !== -1);
  check(`${p.t}: table is named in docs/data-classification.md`, doc.indexOf(p.t) !== -1);
  check(`${p.t}: no existing COMMENT ON in earlier migrations`, !new RegExp("comment\\s+on\\s+table\\s+(?:public\\.)?" + p.t + "\\b", "i").test(allSql));
});
let dup = false;
Object.keys(seen).forEach((k) => { if (seen[k] > 1) dup = true; });
check("each table is commented once", !dup);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
