/**
 * Offline static test for covering indexes (Database row "Covering indexes
 * (INCLUDE)"): migration 20261106n creates jobs_active_list_covering_idx, a
 * partial covering btree that lets the public jobs list (the hottest read,
 * src/lib/api/jobs.ts CARD_FIELDS, keyset on first_seen_at DESC, id DESC)
 * run as an index-only scan.
 * Run: npx tsx scripts/test-covering-index-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const migrationPath = "supabase/migrations/20261106n_covering_index_jobs_list.sql";
check("migration file exists", fs.existsSync(migrationPath));
const sql = fs.readFileSync(migrationPath, "utf8");

check(
  "migration marked NOT APPLIED with record command",
  sql.includes("STATUS: NOT APPLIED") &&
    sql.includes("record-migration.cjs 20261106n_covering_index_jobs_list")
);
check(
  "creates a partial covering index on jobs",
  /CREATE INDEX IF NOT EXISTS jobs_active_list_covering_idx\s+ON public\.jobs/i.test(sql) &&
    /INCLUDE\s*\(/i.test(sql) &&
    /WHERE status = 'active'/.test(sql)
);
check(
  "key columns match the app's keyset order (first_seen_at DESC, id DESC)",
  /ON public\.jobs \(first_seen_at DESC, id DESC\)/i.test(sql)
);
check(
  "predicate is status-only so the jobs_public view path can use it",
  !/WHERE is_active = true AND status = 'active'/.test(sql.replace(/\s+/g, " "))
);
check(
  "documents the jobs_public OR-predicate reason",
  /is_active = true OR status = 'active'/.test(sql)
);
check(
  "is_active is INCLUDE-covered (view WHERE references it)",
  /INCLUDE \(\s*is_active,/i.test(sql)
);

// Every column in the app's CARD_FIELDS select list must be a key column,
// the predicate column, or an INCLUDE column.
const apiSrc = fs.readFileSync("src/lib/api/jobs.ts", "utf8");
const cardMatch = apiSrc.match(/CARD_FIELDS\s*=\s*"([^"]+)"/);
check("CARD_FIELDS found in src/lib/api/jobs.ts", !!cardMatch);
const cardCols = cardMatch ? cardMatch[1].split(",").map((c) => c.trim()) : [];
const includeMatch = sql.match(/INCLUDE \(([^)]+)\)/i);
const includeCols = includeMatch
  ? includeMatch[1].split(",").map((c) => c.trim().toLowerCase())
  : [];
const covered = new Set([...includeCols, "id", "first_seen_at", "status"]);
const missing = cardCols.filter((c) => !covered.has(c.toLowerCase()));
check(
  "every CARD_FIELDS column is index-covered (index-only scan possible)",
  cardCols.length > 0 && missing.length === 0
);
if (missing.length) console.log("  uncovered: " + missing.join(", "));

check(
  "build lock documented, CONCURRENTLY intentionally not used",
  /CONCURRENTLY is intentionally not used/i.test(sql)
);
check("rollback documented", /ROLLBACK[\s\S]*DROP INDEX IF EXISTS public\.jobs_active_list_covering_idx/i.test(sql));

const health = fs.readFileSync("scripts/db-health.sql", "utf8");
check(
  "db-health has covering index review section",
  /15\. Covering index/.test(health) && health.includes("jobs_active_list_covering_idx")
);

const runner = fs.readFileSync("scripts/suite-runner.ts", "utf8");
check(
  "suite runner registers the policy test",
  runner.includes("scripts/test-covering-index-policy.ts")
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
