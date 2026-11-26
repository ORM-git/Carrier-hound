/**
 * READ-ONLY Phase 0 measurement for the full-corpus recommended feed (PR: snapshot prototype).
 * Uses ONLY the public anon key against the jobs_public view: head:true counts and paged reads of the narrow
 * rank columns the route already selects. No writes, no service-role key.
 *
 *   npx tsx scripts/measure-feed-corpus.ts            (reads NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY from .env.local)
 *
 * Prints, per representative profile: prefiltered row count, rows fetched, eligible (matchScore > 0) count,
 * fetch time, rank+cap time and heap delta. Nothing identifying a user is read or printed.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { buildRelevancePrefilter, rankJobsByRecommendation, type OnboardingAnswers } from "../src/lib/jobs/recommendations";
import { capJobsPerCompany } from "../src/lib/jobs/capping";
import { VISIBLE_SOURCE_FILTER } from "../src/lib/jobs/sourcePolicy";

for (const line of readFileSync(process.argv[2] || ".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
// The anon route's own candidate columns (route.ts selectCols, jobs_public branch).
const COLS = "id, title, location, remote, remote_scope, remote_eligibility, job_type, first_seen_at, last_seen_at, posted_at, created_at, status, is_active, category, country, country_code";

const PROFILES: Record<string, OnboardingAnswers> = {
  "software engineer, entry, IN": { roles: ["Software Engineer"], experienceLevel: "entry", countryCode: "IN", locations: ["India"] },
  "software engineer, mid, any": { roles: ["Software Engineer"], experienceLevel: "mid" },
  "data analyst, entry, IN": { roles: ["Data Analyst"], experienceLevel: "entry", countryCode: "IN", locations: ["India"] },
  "product manager, senior, US": { roles: ["Product Manager"], experienceLevel: "senior", countryCode: "US", locations: ["United States"] },
  "account executive, mid, any": { roles: ["Account Executive"], experienceLevel: "mid" },
  "registered nurse, any": { roles: ["Registered Nurse"] },
};

const base = () => db.from("jobs_public").select(COLS, { count: "exact", head: true }).or(VISIBLE_SOURCE_FILTER).eq("status", "active");

async function timed<T>(f: () => Promise<T>) {
  const t = performance.now();
  const r = await f();
  return [r, Math.round(performance.now() - t)] as const;
}

async function main() {
  const [all, allMs] = await timed(async () => base());
  console.log(JSON.stringify({ corpus: "all active visible (jobs_public)", count: all.count, error: all.error?.message ?? null, countMs: allMs }));
  for (const [name, answers] of Object.entries(PROFILES)) {
    const pre = buildRelevancePrefilter(answers)!;
    const [c, countMs] = await timed(async () => base().or(pre.orClause));
    if (c.error) { console.log(JSON.stringify({ name, error: c.error.message, countMs })); continue; }
    // Full read of the prefiltered set in 1000-row keyset-free ranges (read-only; same order as the route).
    const rows: any[] = [];
    const [, fetchMs] = await timed(async () => {
      for (let from = 0; from < (c.count ?? 0); from += 1000) {
        const r = await db.from("jobs_public").select(COLS).or(VISIBLE_SOURCE_FILTER).eq("status", "active").or(pre.orClause)
          .order("posted_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).range(from, from + 999);
        if (r.error) throw new Error(r.error.message);
        rows.push(...(r.data || []));
        if ((r.data || []).length < 1000) break;
      }
    });
    const heap0 = process.memoryUsage().heapUsed;
    const [ranked, rankMs] = await timed(async () => capJobsPerCompany(rankJobsByRecommendation(rows, answers, Date.now()).filter((j: any) => (j.matchScore ?? 0) > 0), 3, 30));
    const heapMb = Math.round(((process.memoryUsage().heapUsed - heap0) / 1048576) * 10) / 10;
    console.log(JSON.stringify({ name, prefiltered: c.count, fetched: rows.length, eligible: ranked.length, countMs, fetchMs, rankMs, rankHeapDeltaMb: heapMb, fetchPages: Math.ceil(rows.length / 1000) }));
  }
}
main().catch((e) => { console.error(e?.message || e); process.exit(1); });
