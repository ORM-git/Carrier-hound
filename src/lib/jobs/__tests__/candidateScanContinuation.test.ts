// For You with a resume (direct jobs_public path): eligible results must continue past the first 250 raw rows.
// FIXTURE jobs_public (fixtures/fakeJobsPublic.ts); controlled fixtures, not live captures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const proFetch = vi.hoisted(() => ({ status: 200, calls: [] as string[][] }));
vi.mock("@/lib/supabase/client", async () => {
  const { table, getSession } = await import("./fixtures/fakeJobsPublic");
  return {
    createClient: () => ({
      auth: { getSession },
      from: () => table(),
    }),
  };
});

import { getLiveJobs, capJobsPerCompany, CURSOR_RESET_ERROR, type GetJobsResult } from "@/lib/jobs/service";
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

  const expectReset = (res: GetJobsResult) =>
    expect([res.error, res.jobs.length, res.hasNextPage, res.nextCursor]).toEqual([CURSOR_RESET_ERROR, 0, false, null]);

  it("page 2 with a cursor from a different query resets: no rows skipped by page arithmetic, nothing read", async () => {
    db.rows = rows251();
    const p1 = await fetchPage(1);
    const reads = db.queries;
    expectReset(await fetchPage(2, p1.nextCursor, { remoteOnly: true }));
    expect(db.queries).toBe(reads);
    // The caller restarts the new query at page 1, which starts at the top of the stream.
    expect((await fetchPage(1, null, { remoteOnly: true })).jobs.map((j) => j.id)).toEqual(p1.jobs.map((j) => j.id));
  });

  it("a tier change invalidates the continuation in the service itself (Free cursor on Pro, and back)", async () => {
    db.rows = rows251();
    expectReset(await fetchPage(2, (await fetchPage(1)).nextCursor, { isPro: true }));
    expectReset(await fetchPage(2, (await fetchPage(1, null, { isPro: true })).nextCursor));
  });

  it("a viewer or session change invalidates the continuation; a token refresh does not", async () => {
    db.rows = rows251();
    const p1 = await fetchPage(1);
    db.session = { ...db.session, access_token: "refreshed-token" };
    expect((await fetchPage(2, p1.nextCursor)).jobs.map((j) => j.id)).toEqual([junior(251).id]);
    db.session = { access_token: "t", user: { id: "viewer-a", last_sign_in_at: "2026-11-26T09:00:00Z" } };
    expectReset(await fetchPage(2, p1.nextCursor));
    db.session = { access_token: "t", user: { id: "viewer-b", last_sign_in_at: "2026-11-25T08:00:00Z" } };
    expectReset(await fetchPage(2, p1.nextCursor));
    db.session = null;
    expectReset(await fetchPage(2, p1.nextCursor));
  });

  it("the cursor carries no token or user id", async () => {
    db.rows = rows251();
    const { nextCursor } = await fetchPage(1);
    const decodedKey = Buffer.from(nextCursor!.split(".")[6], "base64").toString();
    for (const secret of ["fixture-token", "viewer-a"]) {
      expect(nextCursor).not.toContain(secret);
      expect(decodedKey).not.toContain(secret);
    }
  });

  it("tampered, foreign and expired cursors reset; none reaches the database", async () => {
    db.rows = Array.from({ length: 30 }, (_, k) => junior(k + 1));
    const parts = (await fetchPage(1)).nextCursor!.split(".");
    const reads = db.queries;
    for (const bad of [
      "cs1.x.0.m.0.0.eyJbIjoiKSJ9",
      "not-a-scan-cursor",
      [...parts.slice(0, 6), "WyIpOyBkcm9wIiwiMSJd"].join("."),
      [...parts.slice(0, 4), "-1", ...parts.slice(5)].join("."),
      [parts[0], parts[1], String(Date.now() - 7 * 3600_000), ...parts.slice(3)].join("."),
    ]) expectReset(await fetchPage(2, bad));
    expect(db.queries).toBe(reads);
  });

  it("a window key that cannot round-trip fails closed: retryable error, never a null cursor with more", async () => {
    // Non-UUID id on the last row of a full window: no safe keyset exists past it.
    db.rows = [...Array.from({ length: 249 }, (_, k) => senior(k + 1)), { ...senior(250), id: "not-a-uuid" }, junior(251)];
    const res = await fetchPage(1);
    expect([res.isDegraded, res.error, res.hasNextPage, res.nextCursor]).toEqual([true, "degraded", false, null]);
  });

  it("the date window is frozen at cursor creation: a later request scans the same window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      db.rows = rows251();
      const row251At = Date.parse(junior(251).posted_at!);
      // Page 1 at a time whose 24h window still holds row 251.
      vi.setSystemTime(row251At + 23 * 3600_000);
      const p1 = await fetchPage(1, null, { datePosted: "24h" });
      expect(p1.hasNextPage).toBe(true);
      // Two hours later a recomputed 24h cutoff would exclude row 251; only the frozen cutoff still reaches it.
      vi.setSystemTime(row251At + 25 * 3600_000);
      const p2 = await fetchPage(2, p1.nextCursor, { datePosted: "24h" });
      expect(p2.jobs.map((j) => j.id)).toEqual([junior(251).id]);
      expect((await fetchPage(1, null, { datePosted: "24h" })).totalCount).toBe(25); // fresh query: new window
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort mid-scan, then retry from the last good cursor: same rows, no duplicates, no cursor loss", async () => {
    db.rows = [...rows251(), ...Array.from({ length: 600 }, (_, k) => senior(k + 252)), junior(852)];
    const p1 = await fetchPage(1);
    const reference = await fetchPage(2, p1.nextCursor);
    const ctl = new AbortController();
    const start = db.queries;
    db.onQuery = (n) => { if (n === start + 1) ctl.abort(); };
    expect((await fetchPage(2, p1.nextCursor, { signal: ctl.signal })).isDegraded).toBe(true);
    db.onQuery = null;
    const retried = await fetchPage(2, p1.nextCursor);
    expect(retried.jobs.map((j) => j.id)).toEqual(reference.jobs.map((j) => j.id));
    expect(retried.nextCursor).toBe(reference.nextCursor);
    const all = [...p1.jobs, ...retried.jobs].map((j) => j.id);
    expect(new Set(all).size).toBe(all.length);
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
