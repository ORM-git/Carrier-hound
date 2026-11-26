// For You with a resume (direct jobs_public path): eligible results must continue past the first 250 raw rows.
// FIXTURE jobs_public (fixtures/fakeJobsPublic.ts); controlled fixtures, not live captures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const proFetch = vi.hoisted(() => ({ status: 200, calls: [] as string[][] }));
vi.mock("@/lib/supabase/client", async () => {
  const { table } = await import("./fixtures/fakeJobsPublic");
  return {
    createClient: () => ({
      auth: { getSession: async () => ({ data: { session: { access_token: "fixture-token" } } }) },
      from: () => table(),
    }),
  };
});

import { getLiveJobs, capJobsPerCompany, type GetJobsResult } from "@/lib/jobs/service";
import { rankJobsByRecommendation, answersFromCandidate } from "@/lib/jobs/recommendations";
import * as F from "./fixtures/fakeJobsPublic";
const { db, cmp, job, junior, senior, rows251, CANDIDATE, PREFS } = F;

const fetchPage = (page: number, cursor?: string | null, extra: Record<string, unknown> = {}) =>
  getLiveJobs({ sortBy: "match", page, pageSize: 25, candidate: CANDIDATE, preferences: PREFS, cursor: cursor ?? undefined, ...extra });

// Follow the transport contract the jobs page uses: send nextCursor until hasNextPage is false.
async function walk(maxPages = 20) {
  const pages: GetJobsResult[] = [];
  let cursor: string | null = null;
  for (let p = 1; p <= maxPages; p++) {
    const res = await fetchPage(p, cursor);
    pages.push(res);
    if (!res.hasNextPage) break;
    cursor = res.nextCursor ?? null;
  }
  return pages;
}
const ids = (pages: GetJobsResult[]) => pages.flatMap((p) => p.jobs.map((j) => j.id));

const realFetch = globalThis.fetch;
beforeEach(() => {
  F.resetDb();
  proFetch.status = 200;
  proFetch.calls = [];
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith("/api/jobs/pro")) {
      const reqIds: string[] = JSON.parse(init.body).ids;
      proFetch.calls.push(reqIds);
      if (proFetch.status !== 200) return new Response("{}", { status: proFetch.status });
      return new Response(JSON.stringify({ jobs: reqIds.map((id) => ({ id, company: "Acme", apply_url: "https://acme.example/apply" })) }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as any;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("candidate scan continues past the first 250 raw rows", () => {
  it("the unchanged ranker accepts 26 of the 251-row input (premise)", () => {
    const rows = rows251();
    expect(rankJobsByRecommendation(rows, answersFromCandidate(CANDIDATE, PREFS), Date.now())).toHaveLength(26);
  });

  it("251-row counterexample: page 1 has 25 plus a continuation, page 2 has row 251 then an honest end", async () => {
    db.rows = rows251();
    const p1 = await fetchPage(1);
    expect(p1.jobs).toHaveLength(25);
    expect(p1.hasNextPage).toBe(true);
    expect(p1.nextCursor).toMatch(/^cs1\./);
    expect(p1.totalCountPartial).toBe(true);
    const p2 = await fetchPage(2, p1.nextCursor);
    expect(p2.jobs.map((j) => j.id)).toEqual([junior(251).id]);
    expect(p2.hasNextPage).toBe(false);
    expect(p2.nextCursor).toBeNull();
    expect(p2.totalCount).toBe(26);
    expect(p2.totalCountPartial).toBe(false);
  });

  it("finds an eligible row 501 behind an all-ineligible intermediate window", async () => {
    db.rows = [...Array.from({ length: 500 }, (_, k) => (k < 25 ? junior(k + 1) : senior(k + 1))), junior(501)];
    const pages = await walk();
    expect(ids(pages)).toContain(junior(501).id);
    expect(new Set(ids(pages)).size).toBe(26);
    expect(pages.at(-1)!.hasNextPage).toBe(false);
  });

  it("empty-eligible windows do not end the feed; the scan budget ends with a usable partial continuation", async () => {
    // 1000 ineligible rows (the whole per-request budget), then one eligible row.
    db.rows = [...Array.from({ length: 1000 }, (_, k) => senior(k + 1)), junior(1001)];
    const p1 = await fetchPage(1);
    expect(p1.jobs).toEqual([]);
    expect(p1.hasNextPage).toBe(true);
    expect(p1.totalCountPartial).toBe(true);
    expect(db.queries).toBe(4);
    const p2 = await fetchPage(2, p1.nextCursor);
    expect(p2.jobs.map((j) => j.id)).toEqual([junior(1001).id]);
    expect(p2.hasNextPage).toBe(false);
  });

  it("exactly 25 at the genuine database end: no continuation, exact count", async () => {
    db.rows = Array.from({ length: 25 }, (_, k) => junior(k + 1));
    const p1 = await fetchPage(1);
    expect([p1.jobs.length, p1.hasNextPage, p1.nextCursor, p1.totalCount, p1.totalCountPartial]).toEqual([25, false, null, 25, false]);
  });

  it("exactly 250 raw rows (a full window) at the database end is not mistaken for more", async () => {
    db.rows = Array.from({ length: 250 }, (_, k) => (k < 25 ? junior(k + 1) : senior(k + 1)));
    const p1 = await fetchPage(1);
    expect([p1.jobs.length, p1.hasNextPage, p1.totalCount, p1.totalCountPartial]).toEqual([25, false, 25, false]);
  });

  it("tied timestamps across the window boundary: id breaks ties, nothing skipped or repeated", async () => {
    const T = "2026-11-20T10:00:00.000Z";
    db.rows = Array.from({ length: 600 }, (_, k) => job(k + 1, k % 10 === 0 ? "Junior Software Engineer" : "Senior Software Engineer", T));
    const pages = await walk();
    const all = ids(pages);
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
    expect(pages.at(-1)!.hasNextPage).toBe(false);
  });

  it("null posted_at rows sort last and are still reached", async () => {
    db.rows = [...Array.from({ length: 260 }, (_, k) => senior(k + 1)), job(261, "Junior Software Engineer", null), job(262, "Junior Software Engineer", null)];
    expect(new Set(ids(await walk())).size).toBe(2);
  });

  it("duplicate ids in a window are shown once and do not hide later rows", async () => {
    const dup = junior(1);
    db.rows = [...Array.from({ length: 30 }, () => ({ ...dup })), ...Array.from({ length: 240 }, (_, k) => senior(k + 2)), junior(300)];
    const all = ids(await walk());
    expect(all.filter((id) => id === dup.id)).toHaveLength(1);
    expect(all).toContain(junior(300).id);
  });

  it("page arithmetic without a cursor reaches the same rows (legacy callers)", async () => {
    db.rows = Array.from({ length: 60 }, (_, k) => junior(k + 1));
    const viaCursor = ids(await walk());
    const viaPages = ids([await fetchPage(1), await fetchPage(2), await fetchPage(3)]);
    expect(viaPages).toEqual(viaCursor);
  });

  it("ranking on an identical complete input (<= one window) is unchanged", async () => {
    db.rows = Array.from({ length: 120 }, (_, k) => (k % 3 === 0 ? junior(k + 1) : k % 3 === 1 ? job(k + 1, "Software Engineer") : senior(k + 1)));
    const scoredAt = Date.now();
    const expected = capJobsPerCompany(rankJobsByRecommendation([...db.rows].sort(cmp), answersFromCandidate(CANDIDATE, PREFS), scoredAt), 3, 30).map((r: any) => r.id);
    const all = ids(await walk());
    expect(all).toEqual(expected);
  });
});

describe("continuation safety", () => {
  it("a failed scan is a retryable error and the same cursor still works afterwards", async () => {
    db.rows = rows251();
    const p1 = await fetchPage(1);
    db.failAt = db.queries + 1;
    const failed = await fetchPage(2, p1.nextCursor);
    expect([failed.isDegraded, failed.jobs.length, failed.hasNextPage]).toEqual([true, 0, false]);
    const retried = await fetchPage(2, p1.nextCursor);
    expect(retried.jobs.map((j) => j.id)).toEqual([junior(251).id]);
  });

  it("a failure on a later window of the same request is also an error, never a short honest end", async () => {
    db.rows = [...Array.from({ length: 500 }, (_, k) => senior(k + 1)), junior(501)];
    db.failAt = 2;
    const res = await fetchPage(1);
    expect([res.isDegraded, res.hasNextPage]).toEqual([true, false]);
  });

  it("an abort between windows stops the scan without a result to apply", async () => {
    db.rows = [...Array.from({ length: 1000 }, (_, k) => senior(k + 1)), junior(1001)];
    const ctl = new AbortController();
    db.onQuery = (n) => { if (n === 1) ctl.abort(); };
    const res = await fetchPage(1, null, { signal: ctl.signal });
    expect(db.queries).toBe(1);
    expect(res.isDegraded).toBe(true);
  });

  it("a cursor from a different query (filter change) is ignored and the scan restarts from page arithmetic", async () => {
    db.rows = rows251();
    const p1 = await fetchPage(1);
    const other = await fetchPage(1, p1.nextCursor, { remoteOnly: true });
    expect(other.jobs.map((j) => j.id)).toEqual(p1.jobs.map((j) => j.id));
  });

  it("a tampered cursor is ignored, never sent to the database", async () => {
    db.rows = Array.from({ length: 30 }, (_, k) => junior(k + 1));
    const res = await fetchPage(1, "cs1.x.0.0.m.0.eyJbIjoiKSJ9");
    expect(res.jobs).toHaveLength(25);
  });

  it("Free: masked rows, no unlock call; Pro: page-2 rows unlocked by the batch call", async () => {
    db.rows = rows251();
    const free1 = await fetchPage(1);
    const free2 = await fetchPage(2, free1.nextCursor);
    expect(proFetch.calls).toEqual([]);
    expect(free2.jobs[0]).toMatchObject({ company: "Verified Employer", applyUrl: "" });
    const pro1 = await fetchPage(1, null, { isPro: true });
    const pro2 = await fetchPage(2, pro1.nextCursor, { isPro: true });
    expect(proFetch.calls.at(-1)).toEqual([junior(251).id]);
    expect(pro2.jobs[0]).toMatchObject({ company: "Acme", applyUrl: "https://acme.example/apply" });
  });

  it("Pro unlock fails closed on page 2: masked fields stay masked", async () => {
    db.rows = rows251();
    const pro1 = await fetchPage(1, null, { isPro: true });
    proFetch.status = 403;
    const pro2 = await fetchPage(2, pro1.nextCursor, { isPro: true });
    expect(pro2.jobs[0]).toMatchObject({ company: "Verified Employer", applyUrl: "", description: "" });
    expect(pro2.jobs[0].proUnlockError?.status).toBe(403);
  });
});
