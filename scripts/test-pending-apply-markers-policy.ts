/**
 * Offline static test for pending-apply markers (Database row "Pending-apply
 * markers"): a migration whose header says NOT APPLIED / PENDING APPLICATION
 * must carry a self-referencing record command so the pending state is
 * machine-actionable, and scripts/list-pending-migrations.cjs must agree with
 * an independent scan. Before this PR, 5 marked migrations
 * (20261016_lock_job_descriptions, 20261016_worldwide_company_counts,
 * 20261101_lock_page_views_insert, 20261101_lock_scraper_metadata,
 * 20261106b_early_access_attribution) had no record command at all.
 * Run: npx tsx scripts/test-pending-apply-markers-policy.ts
 */
import * as fs from "fs";
import { execFileSync } from "child_process";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const DIR = "supabase/migrations";
const HEADER_LINES = 20;
const MARKER = /--\s*Status:\s*(NOT APPLIED|PENDING APPLICATION)/i;
const APPLIED = /--\s*Status:\s*APPLIED/i;
const RECORD_RE = /record-migration\.cjs\s+([A-Za-z0-9_]+)/;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
check("migrations directory is non-empty", files.length >= 56);

// record-migration.cjs is the tool every marker points at.
check("scripts/record-migration.cjs exists", fs.existsSync("scripts/record-migration.cjs"));
check("scripts/list-pending-migrations.cjs exists", fs.existsSync("scripts/list-pending-migrations.cjs"));

// Independent scan.
const pending: string[] = [];
const malformed: string[] = [];
const appliedMarked: string[] = [];
for (const f of files) {
  const id = f.replace(/\.sql$/, "");
  const header = fs.readFileSync(`${DIR}/${f}`, "utf8").split("\n").slice(0, HEADER_LINES).join("\n");
  if (APPLIED.test(header)) { appliedMarked.push(id); continue; }
  if (!MARKER.test(header)) continue;
  pending.push(id);
  const r = header.match(RECORD_RE);
  if (!r || r[1] !== id) malformed.push(id);
}
check("pending migrations exist to track (sanity)", pending.length >= 15);
check(
  "every marked migration has a self-referencing record command",
  malformed.length === 0
);
if (malformed.length) console.log("  malformed: " + malformed.join(", "));

// The scanner script must exit 0 and agree with the independent scan.
let out = "";
let exitOk = true;
try {
  out = execFileSync("node", ["scripts/list-pending-migrations.cjs"], { encoding: "utf8" });
} catch (e: any) {
  exitOk = false;
  out = (e.stdout || "") + (e.stderr || "");
}
check("list-pending-migrations.cjs exits 0", exitOk);
check(
  "scanner output agrees with the independent scan",
  pending.every((id) => out.includes(id)) &&
    pending.filter((id) => out.includes(`record: node scripts/record-migration.cjs ${id}`)).length === pending.length
);

// Anchors against real files.
check(
  "anchor: house canonical form in 20261106n (STATUS: NOT APPLIED + record line)",
  fs.readFileSync(`${DIR}/20261106n_covering_index_jobs_list.sql`, "utf8").includes(
    "node scripts/record-migration.cjs 20261106n_covering_index_jobs_list"
  )
);
check(
  "anchor: 20261020_rate_limits keeps its APPLIED marker and is not listed pending",
  appliedMarked.includes("20261020_rate_limits") && !pending.includes("20261020_rate_limits")
);

// The 5 migrations this PR fixed: all must now carry their record command.
const FIXED = [
  "20261016_lock_job_descriptions", "20261016_worldwide_company_counts",
  "20261101_lock_page_views_insert", "20261101_lock_scraper_metadata",
  "20261106b_early_access_attribution",
];
const stillBad = FIXED.filter((id) => {
  const header = fs.readFileSync(`${DIR}/${id}.sql`, "utf8").split("\n").slice(0, HEADER_LINES).join("\n");
  const r = header.match(RECORD_RE);
  return !r || r[1] !== id;
});
check(`all ${FIXED.length} previously malformed markers now carry self-referencing record commands`, stillBad.length === 0);
if (stillBad.length) console.log("  still bad: " + stillBad.join(", "));

console.log(`\n${passed} passed, ${failed} failed (${files.length} migrations scanned, ${pending.length} pending)`);
process.exit(failed ? 1 : 0);
