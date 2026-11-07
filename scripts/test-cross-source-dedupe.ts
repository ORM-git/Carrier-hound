/**
 * Offline test for Backend sheet rank 98 (dedup of ingested jobs).
 * Covers: scripts/utils/crossSourceDedupe.ts behavior (fake Supabase), the
 * scripts/ingest.ts wiring, and static checks on migration
 * 20261107a_jobs_role_dedupe.sql (NOT APPLIED; live SQL behavior is unproven
 * here - owner applies it and runs the dry-run function first).
 * Run: npx tsx scripts/test-cross-source-dedupe.ts
 */
import * as fs from "fs";
import { dropFeedJobsAlreadyCoveredByAts, roleDedupeKey } from "./utils/crossSourceDedupe";
import { slugify } from "./utils/sanitizer";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

interface Call { table: string; inList: string[]; eq: Array<[string, unknown]>; }

function fakeSupabase(rows: any[], opts: { error?: boolean; throws?: boolean } = {}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, inList: [], eq: [] };
      calls.push(call);
      const q: any = {
        select() { return q; },
        in(_col: string, list: string[]) { call.inList = list; return q; },
        eq(col: string, val: unknown) { call.eq.push([col, val]); return q; },
        then(resolve: any, reject: any) {
          if (opts.throws) return Promise.reject(new Error("boom")).then(resolve, reject);
          if (opts.error) return Promise.resolve({ data: null, error: { message: "col missing" } }).then(resolve, reject);
          const out = rows.filter((r) => call.inList.indexOf(r.company) !== -1);
          return Promise.resolve({ data: out, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client, calls };
}

async function main() {
  const dbRows = [
    { company: "Acme Inc", title: "Senior Engineer", country_code: "IN" },
    { company: "Globex", title: "Designer", country_code: null },
  ];
  const feed = [
    { company: "Acme, Inc", title: "Senior  Engineer", country_code: "IN", id: 1 }, // same role, punctuation/spacing differ
    { company: "Acme Inc", title: "Senior Engineer", country_code: "US", id: 2 },   // different country -> keep
    { company: "Globex", title: "Designer", country_code: undefined, id: 3 },        // 'any' vs 'any' -> drop
    { company: "Initech", title: "Analyst", country_code: "IN", id: 4 },             // no ATS row -> keep
  ];
  const { client, calls } = fakeSupabase(dbRows);
  const res = await dropFeedJobsAlreadyCoveredByAts(client, feed);
  check("covered feed jobs dropped", res.dropped === 2 && res.kept.map((j) => j.id).join(",") === "2,4");
  check("check ran", res.checked === true);
  check("query filters active + verified rows on jobs", calls.length === 1 && calls[0].table === "jobs" &&
    calls[0].eq.some(([c, v]) => c === "is_active" && v === true) && calls[0].eq.some(([c, v]) => c === "verified" && v === true));
  check("role key shape matches in-run key", roleDedupeKey({ company: "Acme, Inc", title: "Senior  Engineer", country_code: null }) === "acme-inc::senior-engineer::any");

  const many = [];
  for (let i = 0; i < 120; i++) many.push({ company: `C${i}`, title: "T", country_code: "IN" });
  const big = fakeSupabase([]);
  await dropFeedJobsAlreadyCoveredByAts(big.client, many);
  check("company lookups chunked by 50", big.calls.length === 3 && big.calls.every((c) => c.inList.length <= 50));

  const errClient = fakeSupabase([], { error: true });
  const e1 = await dropFeedJobsAlreadyCoveredByAts(errClient.client, feed);
  check("query error fails open (keeps everything)", e1.kept.length === 4 && e1.dropped === 0 && e1.checked === false);
  const thr = fakeSupabase([], { throws: true });
  const e2 = await dropFeedJobsAlreadyCoveredByAts(thr.client, feed);
  check("thrown error fails open", e2.kept.length === 4 && e2.dropped === 0);
  const e3 = await dropFeedJobsAlreadyCoveredByAts(null, feed);
  check("no client keeps everything", e3.kept.length === 4 && e3.checked === false);
  const e4 = await dropFeedJobsAlreadyCoveredByAts(client, []);
  check("empty input is a no-op", e4.kept.length === 0 && e4.dropped === 0);

  // ingest.ts wiring
  const ingest = fs.readFileSync("scripts/ingest.ts", "utf8");
  check("ingest imports the helper", ingest.includes("import { dropFeedJobsAlreadyCoveredByAts } from './utils/crossSourceDedupe';"));
  check(
    "ingest runs it only for live, non-ATS sources",
    /if \(supabase && !isDryRun && !isAtsSource\(source\.type\) && validJobs\.length > 0\) \{\s*const covered = await dropFeedJobsAlreadyCoveredByAts\(supabase, validJobs\);/.test(ingest)
  );
  check(
    "ingest keeps run counters consistent",
    ingest.includes("stats.skipped += covered.dropped;") && ingest.includes("totalAccumulatedJobs -= covered.dropped;")
  );
  check(
    "dedupe runs before stats.normalized is computed",
    ingest.indexOf("dropFeedJobsAlreadyCoveredByAts(supabase, validJobs)") < ingest.indexOf("stats.normalized = validJobs.length;")
  );

  // migration static checks
  const mp = "supabase/migrations/20261107a_jobs_role_dedupe.sql";
  check("migration exists", fs.existsSync(mp));
  const sql = fs.readFileSync(mp, "utf8");
  check("marked NOT APPLIED with record command", sql.includes("STATUS: NOT APPLIED") && sql.includes("record-migration.cjs 20261107a_jobs_role_dedupe"));
  check("role key mirrors board-ingest roleKey (unspecified fallback)", /coalesce\(nullif\(p_location, ''\), 'unspecified'\)/.test(sql));
  check("slug and role key functions are IMMUTABLE", (sql.match(/IMMUTABLE/g) || []).length >= 2);
  check("plain non-unique partial expression index", /CREATE INDEX IF NOT EXISTS jobs_role_key_active_idx[\s\S]*WHERE is_active IS TRUE;/.test(sql) && !/CREATE UNIQUE INDEX[^;]*jobs_role_key/.test(sql));
  check("view is security_invoker, service_role only", /jobs_duplicate_roles\s*WITH \(security_invoker = true\)/.test(sql) &&
    /REVOKE ALL ON public\.jobs_duplicate_roles FROM PUBLIC, anon, authenticated;/.test(sql) && /GRANT SELECT ON public\.jobs_duplicate_roles TO service_role;/.test(sql));
  const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.dedupe_jobs_by_role");
  const fnEnd = sql.indexOf("REVOKE ALL ON FUNCTION public.dedupe_jobs_by_role");
  const fn = sql.slice(fnStart, fnEnd);
  check("dedupe function defaults to dry run", /dedupe_jobs_by_role\(p_apply boolean DEFAULT false\)/.test(fn));
  check("dedupe function is SECURITY DEFINER with pinned search_path", /SECURITY DEFINER\s*SET search_path = public/.test(fn));
  check("dedupe function never deletes", !/DELETE\s+FROM/i.test(fn) && /SET is_active = false, status = 'expired'/.test(fn));
  check("status value is allowed by the jobs status CHECK", fs.readFileSync("supabase/schema.sql", "utf8").includes("check (status in ('active', 'expired'))"));
  check("keeper order is verified, earliest first_seen_at, id", /ORDER BY coalesce\(j\.verified, false\) DESC, j\.first_seen_at ASC NULLS LAST, j\.id/.test(fn));
  check("execute revoked from clients, granted to service_role", /REVOKE ALL ON FUNCTION public\.dedupe_jobs_by_role\(boolean\) FROM PUBLIC, anon, authenticated;/.test(sql) &&
    /GRANT EXECUTE ON FUNCTION public\.dedupe_jobs_by_role\(boolean\) TO service_role;/.test(sql));
  check("rollback documented", /ROLLBACK[\s\S]*DROP FUNCTION IF EXISTS public\.dedupe_jobs_by_role[\s\S]*DROP VIEW IF EXISTS public\.jobs_duplicate_roles[\s\S]*DROP INDEX IF EXISTS public\.jobs_role_key_active_idx/.test(sql));

  // JS model of the SQL slug regexes agrees with slugify on an ASCII corpus
  // (models the SQL regex semantics only; live Postgres behavior is unproven here).
  const sqlModel = (t: string | null) =>
    (t || "").toLowerCase().replace(/[^a-zA-Z0-9_\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
  const corpus = ["Senior Engineer", "  Acme, Inc.  ", "C++ / C# Dev", "data_scientist - ML", "--x--", "", "Remote (EU)", "R&D Lead"];
  check("SQL slug regexes mirror slugify on the ASCII corpus", corpus.every((c) => sqlModel(c) === slugify(c)));
  check("SQL uses the same character classes", sql.includes("'[^a-zA-Z0-9_[:space:]-]'") && sql.includes("'[[:space:]_-]+'"));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
