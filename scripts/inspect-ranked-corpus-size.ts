/**
 * READ-ONLY Phase 0 measurement for the ranked-feed prototype: eligible-row counts (head:true, no rows read)
 * for representative profile/filter combinations, using the SAME eligibility + relevance prefilter as the build.
 * Run: npx tsx scripts/inspect-ranked-corpus-size.ts   (reads .env.local; no writes)
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { buildRelevancePrefilter, type OnboardingAnswers } from "../src/lib/jobs/recommendations";
import { VISIBLE_SOURCE_FILTER } from "../src/lib/jobs/sourcePolicy";
import { jobTypeOrClause, workModelOrClause } from "../src/lib/jobs/jobFilters";

dotenv.config({ path: ".env.local" });
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_READONLY_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)!, { auth: { persistSession: false } });

const PROFILES: Array<[string, OnboardingAnswers, { jobType?: string; workModel?: string }]> = [
  ["guest / no answers", {}, {}],
  ["Frontend Engineer", { roles: ["Frontend Engineer"] }, {}],
  ["Software Engineer", { roles: ["Software Engineer"] }, {}],
  ["Data Analyst", { roles: ["Data Analyst"] }, {}],
  ["Product Manager", { roles: ["Product Manager"] }, {}],
  ["Software Engineer + remote", { roles: ["Software Engineer"] }, { workModel: "remote" }],
  ["Software Engineer + internship", { roles: ["Software Engineer"] }, { jobType: "internship" }],
  ["categories engineering", { categories: ["engineering"] }, {}],
];

async function main() {
  for (const [label, answers, f] of PROFILES) {
    let q: any = db.from("jobs").select("id", { count: "exact", head: true }).or(VISIBLE_SOURCE_FILTER).eq("status", "active").eq("is_active", true);
    const pre = buildRelevancePrefilter(answers);
    if (pre) q = q.or(pre.orClause);
    const jt = jobTypeOrClause(f.jobType);
    if (jt) q = q.or(jt);
    const wm = workModelOrClause(f.workModel);
    if (wm) q = q.or(wm);
    const t0 = Date.now();
    const { count, error } = await q;
    console.log(JSON.stringify({ label, eligibleRows: error ? null : count, error: error?.message ?? null, countMs: Date.now() - t0 }));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
