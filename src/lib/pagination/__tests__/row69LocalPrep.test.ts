// LOCAL PREP ONLY (row 69). Fixture and source-compiled proof, not canonical: no real Postgres, PostgREST or host.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { applyBaseVisibility, applySearchFilters, type SearchFilterCtx } from "@/lib/jobs/searchFilters";
import { recorder, type FilterNode } from "@/lib/jobs/captureFilters";
import { capJobsPerCompany } from "@/lib/jobs/capping";
import { callLogBuilder, teeQuery } from "../readScan";
import { captureOrder, pageIds, pageCount, replayPage, RECOMMENDED_POOL_LIMIT } from "../snapshotReplay";
import { captureMultiword, MULTIWORD_POOL_LIMIT, rankMultiword } from "../multiwordRelevance";
import { isStable, liveFallback, snapshotPage, UNSTABLE_NOTICE } from "../stabilityFallback";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
let seed = 11;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

// ---------------------------------------------------------------------------------------------------------------------
// 1. Read-scan: capture never changes which rows the filters select
// ---------------------------------------------------------------------------------------------------------------------
const base: SearchFilterCtx = { category: "", remoteOnly: false, countryCodeParam: "", locationParam: "", jobTypeParam: "", levelParam: "",
  experienceParam: "", workModelParam: "", dateParam: "", feedConstraints: { excludedTitles: [], includedCompanies: [], excludedCompanies: [], datePosted: null },
  requiredYears: null, companyParam: "", salaryMinParam: "", sourceTypeParam: "", hasServiceKey: true, cleanQuery: "" };
const CASES: Array<Partial<SearchFilterCtx>> = [
  {}, { category: "tech" }, { category: "internships" }, { category: "design" }, { remoteOnly: true }, { countryCodeParam: "IN" }, { countryCodeParam: "ZZ" },
  { locationParam: "remote" }, { locationParam: "Austin" }, { jobTypeParam: "internship" }, { levelParam: "senior" }, { experienceParam: "3-5" },
  { experienceParam: "1-3" }, { workModelParam: "hybrid" }, { companyParam: "acme" }, { salaryMinParam: "60000" }, { sourceTypeParam: "ats" },
  { cleanQuery: "engineer" }, { cleanQuery: "data engineer" }, { cleanQuery: "engineer", hasServiceKey: false }, { requiredYears: { min: 2, max: 5 } },
  { category: "tech", workModelParam: "remote", companyParam: "acme", salaryMinParam: "50000", cleanQuery: "data engineer", requiredYears: { min: 1, max: 6 } },
];
const ROWS = Array.from({ length: 300 }, (_, i) => ({
  id: uuid(i + 1), title: ["Senior Data Engineer", "Junior Analyst", "Engineer", "Intern", "Staff Engineer", "Designer"][rnd(6)],
  company: ["Acme", "Globex", null][rnd(3)], location: ["Remote", "Austin, TX", "Hybrid - NYC", null][rnd(4)], category: ["engineering", "data", null, "design"][rnd(4)],
  remote: [true, false, null][rnd(3)], remote_scope: [null, "hybrid", "remote"][rnd(3)], job_type: [null, "internship", "full-time"][rnd(3)],
  country_code: [null, "IN", "US"][rnd(3)], source_type: [null, "ats", "direct"][rnd(3)], source: [null, "greenhouse board"][rnd(2)],
  salary_min: rnd(2) ? null : 40000 + rnd(5) * 10000, description: ["data pipelines", null][rnd(2)], min_experience_years: rnd(2) ? null : rnd(6),
  max_experience_years: rnd(2) ? null : 3 + rnd(6), posted_at: new Date(Date.UTC(2026, 10, 1 + rnd(25))).toISOString(), is_active: rnd(8) > 0, status: "active", company_slug: null,
}));
// SQL three-valued AST oracle (same semantics as the capture test's oracle); imatch is not used by these cases.
const like = (pat: string) => new RegExp("^" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "is");
const ev = (n: any, r: any): boolean | null => {
  if (n.and) { let u = false; for (const x of n.and) { const v = ev(x, r); if (v === false) return false; if (v === null) u = true; } return u ? null : true; }
  if (n.or) { let u = false; for (const x of n.or) { const v = ev(x, r); if (v === true) return true; if (v === null) u = true; } return u ? null : false; }
  const c = r[n.col];
  if (n.op === "is_null") { const v = c === null || c === undefined; return n.not ? !v : v; }
  if (c === null || c === undefined) return null;
  let v: boolean;
  if (n.op === "eq") v = String(c) === String(n.val); else if (n.op === "neq") v = String(c) !== String(n.val);
  else if (n.op === "ilike") v = like(String(n.val)).test(String(c));
  else if (n.op === "gte") v = n.col === "posted_at" ? Date.parse(c) >= Date.parse(String(n.val)) : Number(c) >= Number(n.val);
  else if (n.op === "lte") v = Number(c) <= Number(n.val); else if (n.op === "lt") v = Number(c) < Number(n.val);
  else throw new Error("oracle cannot evaluate " + n.op);
  return n.not ? !v : v;
};
const selected = (ast: FilterNode) => ROWS.filter((r) => ev(ast, r) === true).map((r) => r.id);
const hasImatch = (n: any): boolean => (n.and || n.or) ? (n.and || n.or).some(hasImatch) : n.op === "imatch";
const astFromCalls = (calls: Array<{ method: string; args: unknown[] }>) => { const rec = recorder(); for (const c of calls) (rec.q as any)[c.method](...c.args); return rec.ast(); };

describe("1. read-scan: capturing the filter code does not change the live query or its rows", () => {
  it("for every filter case the live builder receives the identical calls, and the captured AST selects the same rows", () => {
    let nonEmpty = 0;
    for (const patch of CASES) {
      const direct = callLogBuilder();
      applySearchFilters(applyBaseVisibility(direct.q), { ...base, ...patch });
      const live = callLogBuilder();
      const tee = teeQuery(live.q);
      applySearchFilters(applyBaseVisibility(tee.q), { ...base, ...patch });
      expect(live.calls()).toEqual(direct.calls());                       // live query untouched by capture
      expect(tee.calls()).toEqual(direct.calls());                        // capture saw exactly those calls
      if (hasImatch(tee.ast())) continue;                                 // regex terms are evaluated by SQL only (capture test)
      const rowsByCapture = selected(tee.ast());
      expect(rowsByCapture).toEqual(selected(astFromCalls(direct.calls()))); // same eligibility result
      if (rowsByCapture.length) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(10);                                 // the cases really select rows
  });

  it("an argument mutated by the caller after the call cannot rewrite the captured log", () => {
    const live = callLogBuilder();
    const tee = teeQuery(live.q);
    const values = ["engineering", "data"];
    tee.q.in("category", values);
    values.push("design");
    expect(tee.calls()[0].args).toEqual(["category", ["engineering", "data"]]);
  });

  it("fails closed: a method capture cannot represent throws before the live builder is called", () => {
    const live = callLogBuilder();
    const tee = teeQuery(live.q);
    expect(() => tee.q.textSearch("title", "x")).toThrow(/unsupported query method/);
    expect(live.calls()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Frozen multiword relevance (200 rows), frozen clock
// ---------------------------------------------------------------------------------------------------------------------
describe("2. frozen multiword relevance", () => {
  afterEach(() => { vi.useRealTimers(); });
  type Job = { id: string; title: string; company: string | null; category: string | null; description: string | null; posted_at: string | null; created_at: string; active: boolean };
  const world = (): Job[] => Array.from({ length: 260 }, (_, i) => ({
    id: uuid(i + 1), title: ["Data Engineer", "Senior Data Engineer", "Engineer", "Data Analyst", "Platform Engineer"][i % 5],
    company: ["Acme", "Data Engineer Co", null][i % 3], category: i % 7 === 0 ? "data engineer" : "engineering",
    description: i % 4 === 0 ? "data engineer role" : null, posted_at: i % 11 === 0 ? null : new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
    created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), active: true,
  }));
  // What the route fetches for the query: the 200 newest matching active rows (posted_at desc nulls last, id desc).
  const fetch200 = (w: Job[]) => w.filter((j) => j.active).sort((a, b) =>
    (a.posted_at === b.posted_at ? 0 : a.posted_at === null ? 1 : b.posted_at === null ? -1 : a.posted_at < b.posted_at ? 1 : -1) || (a.id < b.id ? 1 : -1)).slice(0, 200);
  const Q = "data engineer";

  it("the module's ranking is the route's inline ranking, verbatim (source-compiled)", () => {
    const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/jobs/search/route.ts"), "utf8");
    const mod = fs.readFileSync(path.join(process.cwd(), "src/lib/pagination/multiwordRelevance.ts"), "utf8");
    const block = (raw: string, sortVar: string) => {
      const src = raw.replace(/\r\n/g, "\n");                           // working copies may be CRLF
      const a = src.indexOf("const lowerQuery = cleanQuery.toLowerCase();");
      const b = src.indexOf("return timeB - timeA;\n        });", a);
      if (a < 0 || b < 0) throw new Error("ranking block not found");
      return src.slice(a, b).replace(new RegExp(`\\b${sortVar}\\.sort\\(`), "X.sort(").replace(/\s+/g, " ").trim();
    };
    expect(block(mod, "sorted").length).toBeGreaterThan(500);
    expect(block(mod, "sorted")).toBe(block(route, "rows"));
  });

  it("page N replays page 1's frozen 200-row order exactly, while data changes between pages", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 28, 9, 0, 0)));        // frozen clock
    const w = world();
    const snap = captureMultiword(fetch200(w), Q);
    expect(snap.ids).toHaveLength(MULTIWORD_POOL_LIMIT);
    expect(snap.ids).toEqual(rankMultiword(fetch200(w), Q).map((j) => j.id));
    const size = 25;
    const dropped = new Set<string>();
    const seen: string[] = [];
    for (let page = 1; page <= pageCount(snap, size); page++) {
      if (page > 1) {
        w.push({ ...w[0], id: uuid(5000 + page), title: "Data Engineer", posted_at: new Date(Date.UTC(2026, 11, page)).toISOString(), active: true }); // newer + top relevance
        const unserved = snap.ids.slice((page - 1) * size);
        const boost = w.find((j) => j.id === unserved[unserved.length - 1])!; boost.title = "Data Engineer data engineer"; // relevance jump
        const gone = w.find((j) => j.id === unserved[0])!; gone.active = false; dropped.add(gone.id);
        vi.advanceTimersByTime(60_000);
      }
      const current = w.filter((j) => j.active && pageIds(snap, page, size).includes(j.id)).reverse(); // no order from the "DB"
      seen.push(...replayPage(snap, page, size, current).map((j) => j.id));
    }
    expect(seen).toEqual(snap.ids.filter((id) => !dropped.has(id)));
  });

  it("negative control: the current route behaviour (re-fetch 200, re-rank, slice each page) does not keep that order", () => {
    const w = world();
    const first = rankMultiword(fetch200(w), Q).map((j) => j.id);
    const seen: string[] = [];
    for (let page = 1; page <= 8; page++) {
      if (page > 1) w.push({ ...w[0], id: uuid(6000 + page), title: "Data Engineer", posted_at: new Date(Date.UTC(2026, 11, page)).toISOString(), active: true });
      seen.push(...rankMultiword(fetch200(w), Q).slice((page - 1) * 25, page * 25).map((j) => j.id));
    }
    expect(seen).not.toEqual(first);
  });

  it("refuses more than 200 fetched rows", () => {
    expect(() => captureMultiword(world().slice(0, 201), Q)).toThrow(/200/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Recommended pool capture (ranked rows in, up to 1000)
// ---------------------------------------------------------------------------------------------------------------------
describe("3. recommended pool capture", () => {
  type Job = { id: string; company_id: string; score: number; active: boolean };
  // Stand-in ranker for the fixture only (the real ranking is #897's and is NOT edited or imported here): score desc,
  // id desc, then the real per-company cap. The module takes the ranked rows as input either way.
  const rankAndCap = (w: Job[]) => capJobsPerCompany(w.filter((j) => j.active).sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : -1)), 3, 30);
  const world = (n: number): Job[] => Array.from({ length: n }, (_, i) => ({ id: uuid(i + 1), company_id: `c${i % 40}`, score: 1000 - (i % 97), active: true }));

  it("page N equals page 1's snapshot after inserts, rank changes and inactivation", () => {
    const w = world(1000);
    const snap = captureOrder(rankAndCap(w), RECOMMENDED_POOL_LIMIT);
    expect(snap.ids).toHaveLength(1000);
    const size = 25;
    const dropped = new Set<string>();
    const seen: string[] = [];
    for (let page = 1; page <= pageCount(snap, size); page++) {
      if (page > 1) {
        w.push({ id: uuid(9000 + page), company_id: "new", score: 5000, active: true });                // new top job
        const unserved = snap.ids.slice((page - 1) * size);
        w.find((j) => j.id === unserved[unserved.length - 1])!.score = 4000;                            // rank change
        if (unserved.length > 1) { const g = w.find((j) => j.id === unserved[1])!; g.active = false; dropped.add(g.id); } // inactivation
      }
      const current = w.filter((j) => j.active && pageIds(snap, page, size).includes(j.id)).reverse();
      seen.push(...replayPage(snap, page, size, current).map((j) => j.id));
    }
    expect(seen).toEqual(snap.ids.filter((id) => !dropped.has(id)));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("negative control: re-ranking and slicing per page (today's route) repeats or skips", () => {
    const w = world(300);
    const first = rankAndCap(w).map((j) => j.id);
    const seen: string[] = [];
    for (let page = 1; page <= 12; page++) {
      if (page > 1) w.push({ id: uuid(9500 + page), company_id: "new", score: 5000, active: true });
      seen.push(...rankAndCap(w).slice((page - 1) * 25, page * 25).map((j) => j.id));
    }
    expect(seen).not.toEqual(first);
    expect(new Set(seen).size).toBeLessThan(seen.length);                                             // repeats
  });

  it("bounds and caller-bug guards", () => {
    expect(() => captureOrder(world(1001), RECOMMENDED_POOL_LIMIT)).toThrow(/1000/);
    expect(() => captureOrder([{ id: uuid(1) }, { id: uuid(1) }], 10)).toThrow(/unique/);
    expect(() => replayPage(captureOrder([{ id: uuid(1) }], 10), 0, 25, [])).toThrow(/page/);
    expect(replayPage(captureOrder([{ id: uuid(1) }], 10), 5, 25, [{ id: uuid(1) }])).toEqual([]);   // past the end: empty
    expect(replayPage(captureOrder([{ id: uuid(1) }], 10), 1, 25, [{ id: uuid(2) }])).toEqual([]);   // never outside the snapshot
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Non-capture fallback never claims stability
// ---------------------------------------------------------------------------------------------------------------------
describe("4. non-capture fallback", () => {
  it("returns the current rows unchanged and says explicitly that the order is not stable", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    const p = liveFallback(rows, "capture_unavailable");
    expect(p.rows).toBe(rows);
    expect(p).toMatchObject({ kind: "live", stable: false, reason: "capture_unavailable", notice: UNSTABLE_NOTICE });
    expect(p.notice).toMatch(/not stable/);
    expect(isStable(p)).toBe(false);
    for (const reason of ["capture_rejected", "host_not_wired"] as const) expect(isStable(liveFallback(rows, reason))).toBe(false);
  });
  it("only a snapshot page is stable; a live page with a forged flag is still not", () => {
    expect(isStable(snapshotPage([{ id: "a" }]))).toBe(true);
    expect(isStable({ kind: "live", stable: true, reason: "host_not_wired", rows: [] } as any)).toBe(false);
  });
});
