import { describe, expect, it } from "vitest";
import { capJobsPerCompany } from "@/lib/jobs/capping";
import {
  canonicalBinding,
  tokenFingerprint,
  DEFAULT_TTL_MS,
  FeedSessionSecretError,
  MAX_MEMBERS,
  MAX_TOKEN_LENGTH,
  openFeedSession,
  orderSurvivors,
  readFeedPage,
  type SessionBinding,
} from "../feedSession";

// Row 69: stable browsing sessions. Synthetic data only; the secret below is a test value.
const SECRET = "test-only-feed-session-secret-0123456789abcdef";
const T0 = Date.UTC(2026, 10, 28, 9, 0, 0);
const binding: SessionBinding = {
  user: "u-1", tier: "free", sort: "recommended", pageSize: 5, scoreRevision: "r1", filters: ["country:IN", "remote:any"],
};
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

type Job = { id: string; company_id: string; score: number; posted_at: string | null; active: boolean };
const job = (n: number, score: number, company = `c${n}`, posted: string | null = `2026-11-${String((n % 27) + 1).padStart(2, "0")}T00:00:00Z`): Job =>
  ({ id: uuid(n), company_id: company, score, posted_at: posted, active: true });

/** What the recommended route does on every request today: rank the current pool, cap per company, keep order. */
function rankAndCap(world: Job[]): Job[] {
  const ranked = world.filter((j) => j.active).sort((a, b) =>
    b.score - a.score || (b.posted_at ?? "").localeCompare(a.posted_at ?? "") || (a.id < b.id ? 1 : -1));
  return capJobsPerCompany(ranked, 3, 30);
}
/** Old pagination: re-rank on each request, then slice by page number. */
const oldPage = (world: Job[], page: number, size: number) => rankAndCap(world).slice((page - 1) * size, page * size);

async function open(world: Job[], size = 5, b = binding, now = T0) {
  return openFeedSession({ orderedIds: rankAndCap(world).map((j) => j.id), binding: b, secret: SECRET, pageSize: size, now });
}
/** Serves page k the way a route must: verify, then load only those ids under current eligibility, in snapshot order. */
async function serve(world: Job[], token: string, size = 5, b = binding, now = T0 + 60_000) {
  const r = await readFeedPage({ token, binding: b, secret: SECRET, pageSize: size, now });
  if (!r.ok) return r;
  // `WHERE id IN (...)` returns rows in no particular order: hand them over reversed so order must come from the snapshot.
  const eligibleNow = world.filter((j) => j.active && r.ids.includes(j.id)).reverse();
  return { ...r, rows: orderSurvivors(r.ids, eligibleNow) };
}
async function browse(world: Job[], s: Awaited<ReturnType<typeof open>>, mutateBefore: (page: number) => void = () => {}) {
  const seen = s.firstPage.filter((id) => world.find((j) => j.id === id)?.active);
  for (let i = 0; i < s.continuation.length; i++) {
    mutateBefore(i + 2);
    const r = await serve(world, s.continuation[i]);
    if (!("rows" in r)) throw new Error(`page ${i + 2} rejected: ${r.reason}`);
    seen.push(...r.rows.map((j) => j.id));
  }
  return seen;
}

describe("old pagination bugs (negative controls)", () => {
  it("an insert between pages repeats a job on the next page", () => {
    const world = Array.from({ length: 12 }, (_, i) => job(i + 1, 100 - i));
    const p1 = oldPage(world, 1, 5).map((j) => j.id);
    world.push(job(99, 1000));                                       // new top job arrives
    const p2 = oldPage(world, 2, 5).map((j) => j.id);
    expect(p2.filter((id) => p1.includes(id))).toHaveLength(1);       // last of page 1 shown again
  });

  it("a rank change between pages skips a job entirely", () => {
    const world = Array.from({ length: 12 }, (_, i) => job(i + 1, 100 - i));
    const p1 = oldPage(world, 1, 5).map((j) => j.id);
    world[7].score = 1000;                                            // job 8 (was on page 2) jumps to the top
    const p2 = oldPage(world, 2, 5).map((j) => j.id);
    const shown = new Set([...p1, ...p2]);
    expect(Array.from({ length: 10 }, (_, i) => uuid(i + 1)).filter((id) => !shown.has(id))).toEqual([uuid(8)]);
  });

  it("deactivating a capped company's job pulls a deferred job forward and shifts every later page", () => {
    const world = [job(1, 100, "A"), job(2, 99, "A"), job(3, 98, "A"), job(4, 97, "A"), ...Array.from({ length: 30 }, (_, i) => job(10 + i, 90 - i))];
    const before = rankAndCap(world).map((j) => j.id);
    world[0].active = false;
    const after = rankAndCap(world).map((j) => j.id);
    expect(after.indexOf(uuid(4))).toBeLessThan(before.indexOf(uuid(4)));   // the 4th A job moved up into the top window
  });
});

describe("stable feed session", () => {
  it("keeps the complete ordered surviving membership across inserts, rank changes, ties and deactivation", async () => {
    const world = [
      ...Array.from({ length: 20 }, (_, i) => job(i + 1, 100 - i)),
      job(40, 50), job(41, 50), job(42, 50),                          // ties
      job(43, 49, "c43", null), job(44, 49, "c44", null),              // null dates
    ];
    const s = await open(world);
    const order = rankAndCap(world).map((j) => j.id);
    expect(s.total).toBe(25);
    expect(s.firstPage).toEqual(order.slice(0, 5));
    const removed = new Set<string>();
    const seen = await browse(world, s, (page) => {
      world.push(job(100 + page, 1000 + page));                        // new arrivals with top scores
      // About to serve page `page`: members order[(page-1)*5 ..] are unserved. Rank change hits the first of them,
      // inactivation the last not yet removed (indices 24, 23, 22, 21), so the two never coincide.
      world.find((j) => j.id === order[(page - 1) * 5])!.score = 2000;
      const gone = world.find((j) => j.id === order[order.length - 1 - (page - 2)])!;
      gone.active = false;                                             // inactivation of an unserved member
      removed.add(gone.id);
      if (page === 2) world.find((j) => j.id === order[2])!.score = -5; // rank change of an already-shown member
    });
    expect(removed.size).toBe(4);
    expect(seen).toEqual(order.filter((id) => !removed.has(id)));       // exact order, nothing new, nothing skipped
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("company caps stay as page 1 fixed them when a capped job drops out", async () => {
    const world = [job(1, 100, "A"), job(2, 99, "A"), job(3, 98, "A"), job(4, 97, "A"), ...Array.from({ length: 30 }, (_, i) => job(10 + i, 90 - i))];
    const order = rankAndCap(world).map((j) => j.id);
    const s = await open(world);
    const deferredA = order.indexOf(uuid(4));
    expect(deferredA).toBeGreaterThanOrEqual(30);                       // cap deferred the 4th A job past the top window
    // Drop an unserved top-window member: the old algorithm would now pull the deferred A job forward (control above).
    const victim = order[12];
    const seen = await browse(world, s, (page) => { if (page === 2) world.find((j) => j.id === victim)!.active = false; });
    expect(seen).toEqual(order.filter((id) => id !== victim));
    expect(seen.indexOf(uuid(4))).toBe(deferredA - 1);                  // only the dropped member is missing ahead of it
  });

  it("an all-inactive page is empty but the session continues; the final page is short", async () => {
    const world = Array.from({ length: 13 }, (_, i) => job(i + 1, 100 - i));
    const s = await open(world);
    expect(s.pageCount).toBe(3);
    for (const j of world.slice(5, 10)) j.active = false;              // every member of page 2
    const p2 = await serve(world, s.continuation[0]);
    const p3 = await serve(world, s.continuation[1]);
    expect("rows" in p2 && p2.rows).toEqual([]);
    expect("rows" in p2 && p2.page < p2.pageCount).toBe(true);          // more pages after an empty one
    expect("rows" in p3 && p3.rows.map((j) => j.id)).toEqual(world.slice(10).map((j) => j.id));
  });

  it("empty and single-page sessions issue no continuation", async () => {
    expect((await open([])).continuation).toEqual([]);
    const one = await open([job(1, 1), job(2, 2)]);
    expect(one).toMatchObject({ pageCount: 1, total: 2, continuation: [] });
  });

  it("retries and concurrent reads of one continuation return the same page (stateless, any worker)", async () => {
    const world = Array.from({ length: 12 }, (_, i) => job(i + 1, 100 - i));
    const s = await open(world);
    const [a, b, c] = await Promise.all([serve(world, s.continuation[0]), serve(world, s.continuation[0]), serve(world, s.continuation[0])]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("rows outside the page's ids are never returned, even if the eligibility query over-returns", () => {
    const rows = [job(1, 1), job(2, 1), job(3, 1), job(2, 9)];
    expect(orderSurvivors([uuid(3), uuid(2)], rows).map((r) => [r.id, r.score])).toEqual([[uuid(3), 1], [uuid(2), 1]]);
  });
});

describe("continuation rejection", () => {
  const world = Array.from({ length: 12 }, (_, i) => job(i + 1, 100 - i));
  const read = (token: unknown, over: Partial<{ binding: SessionBinding; pageSize: number; now: number; secret: string }> = {}) =>
    readFeedPage({ token, binding: over.binding ?? binding, secret: over.secret ?? SECRET, pageSize: over.pageSize ?? 5, now: over.now ?? T0 + 1000 });

  it("binds to user, tier, filters, sort, revision and page size", async () => {
    const t = (await open(world)).continuation[0];
    const changes: SessionBinding[] = [{ user: "u-2" }, { tier: "pro" }, { filters: ["country:US", "remote:any"] }, { sort: "newest" },
      { scoreRevision: "r2" }, { pageSize: 10 }];
    for (const change of changes) {
      expect(await read(t, { binding: { ...binding, ...change } })).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await read(t, { secret: SECRET + "x" })).toEqual({ ok: false, reason: "invalid" });
    expect((await read(t)).ok).toBe(true);
  });

  it("rejects tampered ids, page index, issue time and swapped MACs", async () => {
    const [t2, t3] = (await open(world)).continuation;
    const p = t2.split(".");
    const swap = (i: number, v: string) => { const q = [...p]; q[i] = v; return q.join("."); };
    // fields: 0 version, 1 issued, 2 page, 3 count, 4 size, 5 capped, 6 ids, 7 MAC
    for (const forged of [swap(2, "3"), swap(1, (T0 + 5).toString(36)), swap(6, t3.split(".")[6]), swap(7, t3.split(".")[7]),
      swap(3, "9"), swap(5, "1")]) {
      expect(await read(forged)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("rejects expired and future-dated continuations, after verifying the MAC", async () => {
    const t = (await open(world)).continuation[0];
    expect(await read(t, { now: T0 + DEFAULT_TTL_MS + 1 })).toEqual({ ok: false, reason: "expired" });
    expect(await read(t, { now: T0 - 2 * 60_000 })).toEqual({ ok: false, reason: "expired" });
    expect((await read(t, { now: T0 + DEFAULT_TTL_MS })).ok).toBe(true);
  });

  it("rejects malformed and oversized input without throwing", async () => {
    for (const bad of [undefined, null, 7, "", "fs1", "fs1.a.b.c.d.e.f", "fs2.1.2.2.5.AAAA.BBBB", "x".repeat(MAX_TOKEN_LENGTH + 1),
      "fs1.zz.2.2.5.%%%%.AAAA"]) {
      const r = await read(bad);
      expect(r.ok).toBe(false);
    }
    expect(await read("x".repeat(MAX_TOKEN_LENGTH + 1))).toEqual({ ok: false, reason: "oversized" });
  });

  it("fails closed without a real secret and refuses caller bugs", async () => {
    await expect(openFeedSession({ orderedIds: [uuid(1)], binding, secret: "short", pageSize: 5, now: T0 })).rejects.toBeInstanceOf(FeedSessionSecretError);
    await expect(read("fs1.a.2.2.5.0.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", { secret: "" })).rejects.toBeInstanceOf(FeedSessionSecretError);
    await expect(openFeedSession({ orderedIds: [uuid(1), uuid(1)], binding, secret: SECRET, pageSize: 5, now: T0 })).rejects.toThrow("unique");
    await expect(openFeedSession({ orderedIds: ["not-a-uuid"], binding, secret: SECRET, pageSize: 5, now: T0 })).rejects.toThrow("UUID");
    await expect(openFeedSession({ orderedIds: Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => uuid(i + 1)), binding, secret: SECRET, pageSize: 5, now: T0 }))
      .rejects.toThrow(String(MAX_MEMBERS));
    await expect(openFeedSession({ orderedIds: [], binding, secret: SECRET, pageSize: 101, now: T0 })).rejects.toThrow("pageSize");
  });

  it("tokens are bounded and carry no binding values", async () => {
    const ids = Array.from({ length: MAX_MEMBERS }, (_, i) => uuid(i + 1));
    const s = await openFeedSession({ orderedIds: ids, binding: { ...binding, user: "someone@example.com" }, secret: SECRET, pageSize: 100, now: T0 });
    expect(s.continuation).toHaveLength(9);
    for (const t of s.continuation) {
      expect(t.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
      expect(t).not.toMatch(/someone|example|free|country/);
    }
    expect(s.continuation.join("").length).toBeLessThan(25_000);        // whole 1000-id session, all pages
  });

  it("a capped session says so on every continuation, under the MAC", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => uuid(i + 1));
    const capped = await openFeedSession({ orderedIds: ids, binding, secret: SECRET, pageSize: 5, now: T0, moreBeyondCap: true });
    const plain = await openFeedSession({ orderedIds: ids, binding, secret: SECRET, pageSize: 5, now: T0 });
    expect(capped.capped && !plain.capped).toBe(true);
    const last = await read(capped.continuation[1]);
    expect(last.ok && last.capped && last.page === last.pageCount).toBe(true);
    expect((await read(plain.continuation[1])).ok && !(await read(plain.continuation[1]) as any).capped).toBe(true);
  });

  it("tokenFingerprint is short, stable and does not contain the token's id bytes", async () => {
    const t = (await open(world)).continuation[0];
    const f = await tokenFingerprint(t);
    expect(f).toMatch(/^[0-9a-f]{12}$/);
    expect(await tokenFingerprint(t)).toBe(f);
    expect(t.includes(f)).toBe(false);
  });

  it("canonical binding ignores key order but not array order", () => {
    expect(canonicalBinding({ a: 1, b: [1, 2] })).toBe(canonicalBinding({ b: [1, 2], a: 1 }));
    expect(canonicalBinding({ a: 1, b: [1, 2] })).not.toBe(canonicalBinding({ a: 1, b: [2, 1] }));
  });
});
