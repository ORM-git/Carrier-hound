/**
 * Offline static test for the Zero-downtime Migrations row
 * (Reliability): enforce the expand/contract discipline in
 * docs/zero-downtime-migrations.md against the REAL migration DDL.
 * After stripping comments, no migration may execute data-destroying
 * DDL (DROP TABLE / DROP COLUMN / TRUNCATE / RENAME COLUMN /
 * SET DATA TYPE / RENAME TO). Rollback sections quote such statements
 * in comments and stay allowed; contract steps, if ever needed, require
 * a deliberate change to this suite.
 * Run: npx tsx scripts/test-migration-discipline.ts
 */
import * as fs from "fs";
import * as path from "path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const DIR = "supabase/migrations";
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
check("migrations directory is non-empty", files.length >= 56);

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
  { label: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { label: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/i },
  { label: "TRUNCATE", re: /\bTRUNCATE\b/i },
  { label: "RENAME COLUMN", re: /\bRENAME\s+COLUMN\b/i },
  { label: "RENAME TO (table)", re: /\bALTER\s+TABLE\b[^;]*\bRENAME\s+TO\b/i },
  { label: "SET DATA TYPE", re: /\bSET\s+DATA\s+TYPE\b/i },
];

const violations: string[] = [];
for (const file of files) {
  const stripped = stripComments(fs.readFileSync(path.join(DIR, file), "utf8"));
  for (const { label, re } of FORBIDDEN) {
    if (re.test(stripped)) violations.push(`${file}: executable ${label}`);
  }
}
if (violations.length > 0) {
  for (const v of violations) console.log(`VIOLATION ${v}`);
}
check("no migration executes data-destroying DDL (expand/contract)", violations.length === 0);

const docPath = "docs/zero-downtime-migrations.md";
check("discipline doc exists", fs.existsSync(docPath));
if (fs.existsSync(docPath)) {
  const doc = fs.readFileSync(docPath, "utf8");
  check("doc covers expand and contract", /## Expand/.test(doc) && /## Contract/.test(doc));
  check("doc covers NOT VALID constraint phasing", /NOT VALID/.test(doc) && /VALIDATE CONSTRAINT/.test(doc));
  check("doc covers CONCURRENTLY index builds", /CONCURRENTLY/.test(doc));
  check("doc covers apply-and-record flow", /record-migration\.cjs/.test(doc));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
