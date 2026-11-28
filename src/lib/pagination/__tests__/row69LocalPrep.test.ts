// LOCAL PREP ONLY (row 69). Fixture and source-compiled proof, not canonical: no real Postgres, PostgREST or host.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { applyBaseVisibility, applySearchFilters, type SearchFilterCtx } from "@/lib/jobs/searchFilters";
import { recorder, type FilterNode } from "@/lib/jobs/captureFilters";
import { capJobsPerCompany } from "@/lib/jobs/capping";
import { callLogBuilder, teeQuery } from "../readScan";
import { captureOrder, MAX_PAGE_SIZE, MAX_REFILL_WINDOWS, nextPage, RECOMMENDED_POOL_LIMIT, verifySnapshot, type Snapshot } from "../snapshotReplay";
import { captureMultiword, MULTIWORD_POOL_LIMIT, rankMultiword } from "../multiwordRelevance";
import { isStable, liveFallback, snapshotPage, UNSTABLE_NOTICE } from "../stabilityFallback";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
let seed = 11;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

// ---------------------------------------------------------------------------------------------------------------------
// 1. Read-scan tee: same calls, same rows, and the live result is reachable
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
// SQL three-valued AST oracle; imatch (regex) is evaluated only by SQL in the capture test.
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
const hasImatch = (n: any): boolean => (n.and || n.or) ? (n.and || n.or).some(hasImatch) : n.op === "imatch";
const selected = (ast: FilterNode) => ROWS.filter((r) => ev(ast, r) === true).map((r) => r.id);
const astFromCalls = (calls: Array<{ method: string; args: unknown[] }>) => { const rec = recorder(); for (const c of calls) (rec.q as any)[c.method](...c.args); return rec.ast(); };
/** Fake live builder: immutable chain (like postgrest-js), awaitable, resolves to the rows its own calls select. */
function evaluatingBuilder(calls: Array<{ method: string; args: unknown[] }> = []): any {
  return new Proxy({}, {
    get: (_t, prop) => {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then") return (res: any, rej: any) => Promise.resolve({ data: ROWS.filter((r) => ev(astFromCalls(calls), r) === true), error: null }).then(res, rej);
      return (...args: unknown[]) => evaluatingBuilder([...calls, { method: prop, args: JSON.parse(JSON.stringify(args)) }]);
    },
  });
}

describe("1. read-scan tee", () => {
  it("for every filter case the live builder receives the identical calls, and the captured AST selects the same rows", () => {
    let nonEmpty = 0;
    for (const patch of CASES) {
      const direct = callLogBuilder();
      applySearchFilters(applyBaseVisibility(direct.q), { ...base, ...patch });
      const live = callLogBuilder();
      const tee = teeQuery(live.q);
      applySearchFilters(applyBaseVisibility(tee.q), { ...base, ...patch });
      expect(live.calls()).toEqual(direct.calls());
      expect(tee.calls()).toEqual(direct.calls());
      if (hasImatch(tee.ast())) continue;
      const rowsByCapture = selected(tee.ast());
      expect(rowsByCapture).toEqual(selected(astFromCalls(direct.calls())));
      if (rowsByCapture.length) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(10);
  });

  it("awaiting the tee'd query returns exactly the rows the untouched query returns (await and run())", async () => {
    let compared = 0;
    for (const patch of CASES) {
      if (hasImatch(teeOf(patch).ast())) continue;                              // regex terms: SQL-only (capture test)
      const untouched = await applySearchFilters(applyBaseVisibility(evaluatingBuilder()), { ...base, ...patch });
      const t1 = teeOf(patch);
      expect(await t1.q).toEqual(untouched);                                    // `await query` as route code does
      const t2 = teeOf(patch);
      expect(await t2.run()).toEqual(untouched);
      const { data } = (await teeOf(patch).q) as any;
      expect(data.map((r: any) => r.id)).toEqual(selected(teeOf(patch).ast())); // live rows = captured AST's rows
      compared++;
    }
    expect(compared).toBeGreaterThan(15);
    function teeOf(p: Partial<SearchFilterCtx>) { const t = teeQuery(evaluatingBuilder()); applySearchFilters(applyBaseVisibility(t.q), { ...base, ...p }); return t; }
  });

  it("then/symbols are not builder calls; an argument mutated after the call cannot rewrite the log", async () => {
    const live = callLogBuilder();
    const tee = teeQuery(live.q);
    expect(typeof (tee.q as any)[Symbol.iterator]).toBe("undefined");
    const values = ["engineering", "data"];
    tee.q.in("category", values);
    values.push("design");
    expect(tee.calls()).toEqual([{ method: "in", args: ["category", ["engineering", "data"]] }]);
    expect(live.calls()).toHaveLength(1);
  });

  it("fails closed: a method capture cannot represent throws before the live builder is called", () => {
    const live = callLogBuilder();
    const tee = teeQuery(live.q);
    expect(() => tee.q.textSearch("title", "x")).toThrow(/unsupported query method/);
    expect(live.calls()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. nextPage: position cursor, holes, refill, untrusted rows, bounds
// ---------------------------------------------------------------------------------------------------------------------
type Row = { id: string; v?: number };
const snapOf = (n: number, binding?: any) => captureOrder(Array.from({ length: n }, (_, i) => ({ id: uuid(i + 1) })), Math.max(n, 1), binding);
/** fetchEligible over a mutable "database": returns only rows that still exist and are eligible, in no particular order. */
const dbOf = (ids: readonly string[]) => {
  const rows = new Map(ids.map((id) => [id, { id, eligible: true }]));
  return {
    rows,
    calls: [] as string[][],
    fetch(ids: string[]) { this.calls.push(ids); return ids.map((id) => rows.get(id)).filter((r): r is { id: string; eligible: boolean } => !!r && r.eligible).reverse(); },
  };
};
/** Serves every page; `between(cursor)` mutates the data before each page after the first. Asserts the paging rules per page. */
async function serveAll<T extends { id: string }>(s: Snapshot, size: number, fetch: (ids: string[]) => readonly T[] | Promise<readonly T[]>, between: (cursor: number) => void = () => {}) {
  const seen: string[] = [];
  const pages: number[] = [];
  let cursor = 0;
  for (let n = 0; n < 2000; n++) {
    if (n > 0) between(cursor);
    const p = await nextPage(s, cursor, size, fetch);
    expect(p.total).toBe(s.ids.length);
    expect(p.cursor).toBeGreaterThanOrEqual(cursor);
    if (p.rows.length < size) expect(["snapshot_end", "refill_bound"]).toContain(p.end);    // short only at the end or the bound
    if (p.end === "refill_bound") expect(p.hasMore).toBe(true);
    expect(p.hasMore).toBe(p.cursor < s.ids.length);                                   // from the position, not survivors
    seen.push(...p.rows.map((r) => r.id));
    pages.push(p.rows.length);
    cursor = p.cursor;
    if (!p.hasMore) break;
  }
  return { seen, pages };
}

describe("2. nextPage over a frozen snapshot", () => {
  it("deletions before, inside and after the current position: no skip, no repeat, full pages", async () => {
    const s = snapOf(103);
    const db = dbOf(s.ids);
    const removedUnserved = new Set<string>();
    const remove = (id: string, cursor: number) => { db.rows.delete(id); if (s.ids.indexOf(id) >= cursor) removedUnserved.add(id); };
    const { seen, pages } = await serveAll(s, 10, (ids) => db.fetch(ids), (cursor) => {
      if (cursor >= 2) remove(s.ids[cursor - 2], cursor);                                // before: already served
      if (cursor < s.ids.length) remove(s.ids[cursor], cursor);                          // at the position (next window)
      if (cursor + 5 < s.ids.length) remove(s.ids[cursor + 5], cursor);                  // inside the next window
      if (cursor + 40 < s.ids.length) db.rows.get(s.ids[cursor + 40])!.eligible = false, removedUnserved.add(s.ids[cursor + 40]); // after: ineligible
    });
    expect(seen).toEqual(s.ids.filter((id) => !removedUnserved.has(id)));
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages.slice(0, -1).every((n) => n === 10)).toBe(true);                       // holes are refilled
  });

  it("never trusts caller rows: unrequested ids, duplicates and other-window rows are ignored; order is the snapshot's", async () => {
    const s = snapOf(30);
    const outsider = uuid(999);
    const p = await nextPage<Row>(s, 0, 5, (ids) => [{ id: outsider }, { id: ids[3], v: 1 }, { id: s.ids[20] }, { id: ids[0], v: 1 }, { id: ids[3], v: 2 }, { id: ids[1] }]);
    expect(p.rows.map((r) => r.id)).toEqual([s.ids[0], s.ids[1], s.ids[3]].concat(p.rows.slice(3).map((r) => r.id)));
    expect(p.rows.find((r) => r.id === s.ids[3])!.v).toBe(1);                          // first copy wins
    expect(p.rows.some((r) => r.id === outsider || r.id === s.ids[20])).toBe(false);
    expect(p.rows.every((r) => s.ids.indexOf(r.id) < p.cursor)).toBe(true);
  });

  it("refill is bounded per call and the short page says refill_bound; the next call continues without loss", async () => {
    const s = snapOf(200);
    const db = dbOf(s.ids);
    for (const id of s.ids.slice(0, 10 * MAX_REFILL_WINDOWS)) db.rows.delete(id);    // the first 8 windows are all gone
    const p1 = await nextPage(s, 0, 10, (ids) => db.fetch(ids));
    expect(p1).toMatchObject({ rows: [], cursor: 10 * MAX_REFILL_WINDOWS, hasMore: true, end: "refill_bound" });
    expect(db.calls).toHaveLength(MAX_REFILL_WINDOWS);
    const p2 = await nextPage(s, p1.cursor, 10, (ids) => db.fetch(ids));
    expect(p2.rows.map((r) => r.id)).toEqual(s.ids.slice(80, 90));
    expect(p2.end).toBe("filled");
  });

  it("end of snapshot: short final page, then an empty page at the end position", async () => {
    const s = snapOf(23);
    const db = dbOf(s.ids);
    const a = await nextPage(s, 20, 10, (ids) => db.fetch(ids));
    expect(a).toMatchObject({ cursor: 23, hasMore: false, end: "snapshot_end", total: 23 });
    expect(a.rows).toHaveLength(3);
    expect(await nextPage(s, 23, 10, (ids) => db.fetch(ids))).toMatchObject({ rows: [], cursor: 23, hasMore: false, end: "snapshot_end" });
  });

  it("bounds: page size, cursor range, the eligibility callback is required", async () => {
    const s = snapOf(10);
    const f = (ids: string[]) => ids.map((id) => ({ id }));
    await expect(nextPage(s, 0, 0, f)).rejects.toThrow(/pageSize/);
    await expect(nextPage(s, 0, MAX_PAGE_SIZE + 1, f)).rejects.toThrow(/pageSize/);
    await expect(nextPage(s, -1, 5, f)).rejects.toThrow(/cursor/);
    await expect(nextPage(s, 11, 5, f)).rejects.toThrow(/cursor/);
    await expect(nextPage(s, 1.5, 5, f)).rejects.toThrow(/cursor/);
    await expect(nextPage(s, 0, 5, undefined as any)).rejects.toThrow(/fetchEligible/);
    expect((await nextPage(s, 0, MAX_PAGE_SIZE, f)).rows).toHaveLength(10);
  });
});

describe("snapshot binding (pure data check, no key, no storage)", () => {
  it("rejects a snapshot for another owner, tier or query; accepts the matching one", () => {
    const s = snapOf(3, { owner: "u-1", tier: "free", queryHash: "q1" });
    expect(verifySnapshot(s, { owner: "u-1", tier: "free", queryHash: "q1" })).toEqual({ ok: true });
    expect(verifySnapshot(s, { owner: "u-2", tier: "free", queryHash: "q1" })).toEqual({ ok: false, reason: "owner_mismatch" });
    expect(verifySnapshot(s, { owner: null, tier: "free", queryHash: "q1" })).toEqual({ ok: false, reason: "owner_mismatch" });
    expect(verifySnapshot(s, { owner: "u-1", tier: "pro", queryHash: "q1" })).toEqual({ ok: false, reason: "tier_mismatch" });
    expect(verifySnapshot(s, { owner: "u-1", tier: "free", queryHash: "q2" })).toEqual({ ok: false, reason: "query_mismatch" });
    expect(verifySnapshot(snapOf(3), { owner: "u-1" })).toEqual({ ok: false, reason: "owner_mismatch" });      // unbound never passes
    expect(verifySnapshot(snapOf(3, { owner: null, tier: "guest" }), { owner: null, tier: "guest" })).toEqual({ ok: true });
    expect(Object.isFrozen(s) && Object.isFrozen(s.binding)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Contract: frozen 200-row multiword snapshot and 1000-row pool under mutation
// ---------------------------------------------------------------------------------------------------------------------
type Job = { id: string; title: string; company: string | null; company_id: string; category: string | null; description: string | null;
  posted_at: string | null; created_at: string; active: boolean; score: number };
const worldOf = (n: number): Job[] => Array.from({ length: n }, (_, i) => ({
  id: uuid(i + 1), title: ["Data Engineer", "Senior Data Engineer", "Engineer", "Data Analyst", "Platform Engineer"][i % 5],
  company: ["Acme", "Data Engineer Co", null][i % 3], company_id: `c${i % 40}`, category: i % 7 === 0 ? "data engineer" : "engineering",
  description: i % 4 === 0 ? "data engineer role" : null, posted_at: i % 11 === 0 ? null : new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
  created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), active: true, score: 1000 - (i % 97),
}));
const Q = "data engineer";
// The route's multiword fetch: the 200 newest matching active rows (posted_at desc nulls last, id desc).
const fetch200 = (w: Job[]) => w.filter((j) => j.active).sort((a, b) =>
  (a.posted_at === b.posted_at ? 0 : a.posted_at === null ? 1 : b.posted_at === null ? -1 : a.posted_at < b.posted_at ? 1 : -1) || (a.id < b.id ? 1 : -1)).slice(0, 200);
// Stand-in recommended ranker for the fixture only (the real ranking is not edited or imported): score desc, id desc, real cap.
const rankAndCap = (w: Job[]) => capJobsPerCompany(w.filter((j) => j.active).sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : -1)), 3, 30);
/** Eligibility callback over the mutable world: only rows that still exist and are active. */
const eligibleIn = (w: Job[]) => (ids: string[]) => w.filter((j) => j.active && ids.includes(j.id)).reverse();
/** Deletes, expires, reorders and inserts between pages; returns the ids removed before they were served. */
function mutator(w: Job[], s: Snapshot) {
  const unservedRemoved = new Set<string>();
  let k = 0;
  const run = (cursor: number) => {
    k++;
    const unserved = s.ids.slice(cursor);
    if (unserved.length > 3) {
      const del = w.findIndex((j) => j.id === unserved[1]); unservedRemoved.add(w[del].id); w.splice(del, 1);         // delete
      const exp = w.find((j) => j.id === unserved[unserved.length - 1])!; exp.active = false; unservedRemoved.add(exp.id); // expire
      const re = w.find((j) => j.id === unserved[2])!; re.score += 10_000; re.title = "Data Engineer data engineer";       // reorder
    }
    w.push({ ...w[0], id: uuid(50_000 + k), title: "Data Engineer", posted_at: new Date(Date.UTC(2026, 11, 1, 0, 0, k)).toISOString(), active: true, score: 99_999 }); // newer
    if (cursor >= 1) { const served = w.find((j) => j.id === s.ids[cursor - 1]); if (served) served.active = false; } // already served: stays served
  };
  return { run, unservedRemoved };
}
/** The design this replaces: page-index windows (page N = ids[(N-1)*size, N*size)), filtered by eligibility. */
async function pageIndexServe(s: Snapshot, size: number, fetch: (ids: string[]) => readonly { id: string }[], between: (cursor: number) => void) {
  const pages: string[][] = [];
  for (let page = 1; (page - 1) * size < s.ids.length; page++) {
    if (page > 1) between((page - 1) * size);
    const window = s.ids.slice((page - 1) * size, page * size);
    const got = new Set(fetch(window).map((r) => r.id));
    pages.push(window.filter((id) => got.has(id)));
  }
  return pages;
}

describe("3. contract: frozen membership and order under mutation", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("the multiword ranking is the route's inline ranking, verbatim (source-compiled)", () => {
    const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/jobs/search/route.ts"), "utf8");
    const mod = fs.readFileSync(path.join(process.cwd(), "src/lib/pagination/multiwordRelevance.ts"), "utf8");
    const block = (raw: string, sortVar: string) => {
      const src = raw.replace(/\r\n/g, "\n");
      const a = src.indexOf("const lowerQuery = cleanQuery.toLowerCase();");
      const b = src.indexOf("return timeB - timeA;\n        });", a);
      if (a < 0 || b < 0) throw new Error("ranking block not found");
      return src.slice(a, b).replace(new RegExp(`\\b${sortVar}\\.sort\\(`), "X.sort(").replace(/\s+/g, " ").trim();
    };
    expect(block(mod, "sorted").length).toBeGreaterThan(500);
    expect(block(mod, "sorted")).toBe(block(route, "rows"));
  });

  it("multiword: 200-row snapshot, served across all pages = original order minus ineligible, no repeat (frozen clock)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 28, 9, 0, 0)));
    const w = worldOf(260);
    const s = captureMultiword(fetch200(w), Q);
    expect(s.ids).toHaveLength(MULTIWORD_POOL_LIMIT);
    expect(s.ids).toEqual(rankMultiword(fetch200(w), Q).map((j) => j.id));
    const m = mutator(w, s);
    const { seen } = await serveAll(s, 25, eligibleIn(w), (c) => { m.run(c); vi.advanceTimersByTime(60_000); });
    expect(m.unservedRemoved.size).toBeGreaterThan(5);
    expect(seen).toEqual(s.ids.filter((id) => !m.unservedRemoved.has(id)));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("recommended: 1000-row pool, same guarantee", async () => {
    const w = worldOf(1000);
    const s = captureOrder(rankAndCap(w), RECOMMENDED_POOL_LIMIT);
    expect(s.ids).toHaveLength(1000);
    const m = mutator(w, s);
    const { seen } = await serveAll(s, 25, eligibleIn(w), m.run);
    expect(seen).toEqual(s.ids.filter((id) => !m.unservedRemoved.has(id)));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("negative control: page-index windows under the same mutations serve short pages mid-snapshot", async () => {
    const w = worldOf(1000);
    const s = captureOrder(rankAndCap(w), RECOMMENDED_POOL_LIMIT);
    const m = mutator(w, s);
    const pages = await pageIndexServe(s, 25, eligibleIn(w), m.run);
    expect(pages.slice(0, -1).some((p) => p.length < 25)).toBe(true);                 // violates "short only at end/bound"
  });

  it("negative control: today's behaviour (re-rank, slice per page) repeats or reorders", () => {
    const w = worldOf(300);
    const first = rankAndCap(w).map((j) => j.id);
    const seen: string[] = [];
    for (let page = 1; page <= 12; page++) {
      if (page > 1) w.push({ ...w[0], id: uuid(70_000 + page), score: 99_999 });
      seen.push(...rankAndCap(w).slice((page - 1) * 25, page * 25).map((j) => j.id));
    }
    expect(seen).not.toEqual(first);
    expect(new Set(seen).size).toBeLessThan(seen.length);
  });

  it("capture bounds: more than 200 multiword or 1000 pool rows is refused", () => {
    expect(() => captureMultiword(worldOf(201), Q)).toThrow(/200/);
    expect(() => captureOrder(worldOf(1001), RECOMMENDED_POOL_LIMIT)).toThrow(/1000/);
    expect(() => captureOrder([{ id: uuid(1) }, { id: uuid(1) }], 10)).toThrow(/unique/);
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
