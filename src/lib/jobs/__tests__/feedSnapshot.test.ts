// Unit checks for the full-corpus snapshot prototype (src/lib/jobs/feedSnapshot.ts). FIXTURE data only.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyRecommendedFilters } from "@/lib/jobs/recommendedRequest";
import {
  decodeSnapshotCursor, encodeSnapshotCursor, readAllCandidates, serveSnapshotPage, memorySnapshotStore, buildOnce, SnapshotBusyError, freezeCorpus, readFrozenCandidates, FROZEN_COLUMNS, SnapshotUnavailableError, snapshotIdentity,
  SnapshotTooLargeError, SNAPSHOT_MAX_ROWS, supabaseSnapshotStore, type FeedSnapshot,
} from "@/lib/jobs/feedSnapshot";

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const snap = (n: number): FeedSnapshot => ({ id: uuid(0), identity: "x", jobIds: Array.from({ length: n }, (_, i) => uuid(i + 1)), corpusMark: null, builtAt: 0, expiresAt: 1 });

describe("feed snapshot prototype", () => {
  it("cursor: round-trips, and anything else is refused", () => {
    expect(decodeSnapshotCursor(encodeSnapshotCursor(uuid(7), 50))).toEqual({ id: uuid(7), position: 50 });
    for (const bad of [null, "", "fs1.not-a-uuid.0", `fs1.${uuid(1)}.-1`, `fs1.${uuid(1)}.1e3`, `cs1.${uuid(1)}.0`, `fs1.${uuid(1)}.0.extra`]) {
      expect(decodeSnapshotCursor(bad)).toBeNull();
    }
  });

  it("identity: stable for equal inputs, different for any changed part", async () => {
    const a = await snapshotIdentity(["u1", "epoch", false, [["roles", "x"]]]);
    expect(await snapshotIdentity(["u1", "epoch", false, [["roles", "x"]]])).toBe(a);
    for (const other of [["u2", "epoch", false, [["roles", "x"]]], ["u1", "epoch2", false, [["roles", "x"]]], ["u1", "epoch", true, [["roles", "x"]]], ["u1", "epoch", false, [["roles", "y"]]]]) {
      expect(await snapshotIdentity(other)).not.toBe(a);
    }
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("build read: follows the keyset through every batch, no cap below the hard bound", async () => {
    const all = Array.from({ length: 2500 }, (_, i) => ({ id: uuid(5000 - i), posted_at: new Date(Date.UTC(2026, 10, 25) - i * 1000).toISOString() }));
    const rows = await readAllCandidates(() => fakeQuery(all));
    expect(rows.map((r) => r.id)).toEqual(all.map((r) => r.id));
  });

  it("build probe 1: a row already read whose posted_at moves behind the old boundary is NOT returned twice", async () => {
    reads = 0;
    const all = Array.from({ length: 1001 }, (_, i) => ({ id: uuid(5000 - i), posted_at: new Date(Date.UTC(2026, 10, 25) - i * 1000).toISOString() }));
    const rows = await readAllCandidates(() => fakeQuery(all, (n) => { if (n === 1) all[0].posted_at = "2020-01-01T00:00:00.000Z"; }));
    const got = rows.map((r) => r.id);
    expect(new Set(got).size).toBe(got.length);
    expect(got.sort()).toEqual(all.map((r) => r.id).sort());
  });

  it("build probe 2: an unread row whose posted_at moves ahead of the old boundary is NOT skipped", async () => {
    reads = 0;
    const all = Array.from({ length: 1001 }, (_, i) => ({ id: uuid(5000 - i), posted_at: new Date(Date.UTC(2026, 10, 25) - i * 1000).toISOString() }));
    const rows = await readAllCandidates(() => fakeQuery(all, (n) => { if (n === 1) all[1000].posted_at = "2030-01-01T00:00:00.000Z"; }));
    expect(rows.map((r) => r.id).sort()).toEqual(all.map((r) => r.id).sort());
  });

  it("build read: above the hard bound it FAILS loudly instead of truncating", async () => {
    const huge = Array.from({ length: SNAPSHOT_MAX_ROWS + 1 }, (_, i) => ({ id: uuid(900000 - i), posted_at: null }));
    await expect(readAllCandidates(() => fakeQuery(huge))).rejects.toBeInstanceOf(SnapshotTooLargeError);
  });

  it("serve: omitted IDs consume positions, the page refills from the next valid ones, rounds are bounded", async () => {
    const s = snap(200);
    const gone = new Set(s.jobIds.slice(0, 30));
    const hydrate = async (ids: string[]) => ids.filter((id) => !gone.has(id)).map((id) => ({ id }));
    const p = await serveSnapshotPage(s, 0, 25, hydrate);
    expect(p.rows.map((r) => r.id)).toEqual(s.jobIds.slice(30, 55));
    expect(p.position).toBe(55);
    // Everything removed: 4 bounded rounds, a short page and a continuation, never a false end.
    const empty = await serveSnapshotPage(s, 0, 25, async () => []);
    expect([empty.rows.length, empty.position, empty.done]).toEqual([0, 100, false]);
    expect((await serveSnapshotPage(s, 190, 25, hydrate)).done).toBe(true);
  });

  it("memory store is bounded by TOTAL stored IDs: oldest evicted first, the newest is always kept", async () => {
    const st = memorySnapshotStore(25);
    for (let i = 1; i <= 5; i++) await st.put({ ...snap(10), id: uuid(i), expiresAt: 9e15 });
    expect(st.size()).toBe(2); // 2 x 10 IDs fit in 25
    expect(await st.get(uuid(1))).toBeNull();
    expect(await st.get(uuid(5))).not.toBeNull();
    const tiny = memorySnapshotStore(5);
    await expect(tiny.put({ ...snap(10), id: uuid(9), expiresAt: 9e15 })).rejects.toBeInstanceOf(SnapshotUnavailableError); // a single oversize snapshot is rejected, not kept past the bound
    expect(await tiny.get(uuid(9))).toBeNull();
    expect(st.size()).toBe(2);
  });

  it("frozen columns: every column the request builder, ranking and the capture predicate read is in FROZEN_COLUMNS, and the proposed SQL uses exactly that list", () => {
    const seen = new Set<string>();
    const note = (clause: string) => { for (const m of Array.from(clause.matchAll(/(?:^|[,(])(?:not\.)?([a-z_]+)\.(?:not\.)?(?:eq|neq|ilike|imatch|is|in|gte|lt|cs)\b/g))) seen.add(m[1]); };
    const rec: any = new Proxy({}, { get: (_t, prop: string) => (...args: any[]) => {
      if (prop === "or") note(String(args[0]));
      else if (typeof args[0] === "string" && /^[a-z_]+$/.test(args[0])) seen.add(args[0]);
      return rec;
    } });
    const params = [
      "category=trending", "category=tech", "category=ai", "category=data", "category=engineering", "category=internships", "category=remote", "category=fresher",
      "category=operations", "category=cyber-security", "category=customer-support", "category=legal", "category=healthcare", "category=other",
      "remoteOnly=true", "country_code=IN", "country_code=US", "location=Berlin", "location=remote", "jobType=full-time,contract,internship",
      "level=entry,senior,lead,mid,intern", "experience=3-5", "experience=1-3", "experience=senior", "experience=lead", "workModel=remote,hybrid,onsite",
      "datePosted=7d", "salaryMin=50000", "sourceType=ats", "sourceType=direct", "sourceType=aggregator", "sourceType=custom", "company=acme", "q=react",
      "excludeTitle=intern&includeCompany=Acme&excludeCompany=Evil",
    ];
    const answers: any = { roles: ["Frontend Developer"], locations: ["India", "United States"], country: "India", countryCode: "IN", employmentTypes: ["full-time"], experienceLevel: "senior",
      resumeProfile: { skills: ["React", "TypeScript"], titles: ["Frontend Engineer"], headline: "Frontend" } };
    for (const p of params) applyRecommendedFilters(rec, new URLSearchParams(p), answers, true, Date.now());
    const frozen = new Set<string>(FROZEN_COLUMNS);
    expect(Array.from(seen).filter((c) => !frozen.has(c))).toEqual([]);
    expect(seen.size).toBeGreaterThan(12); // the recorder really saw the filters
    // selectCols (ranking/capping/Free card) as written in the request module, service-key branch (+ resume columns).
    const src = fs.readFileSync(path.resolve(__dirname, "../recommendedRequest.ts"), "utf8");
    const sel = /hasServiceKey\s*\?\s*"([^"]+)"\s*\+\s*\(hasResume \? "([^"]+)"/.exec(src)!;
    for (const c of (sel[1] + sel[2]).split(",").map((x) => x.trim())) expect(frozen.has(c), `selectCols column ${c}`).toBe(true);
    // capture predicate columns
    for (const c of ["status", "is_active", "source_type"]) expect(frozen.has(c)).toBe(true);
    const sql = fs.readFileSync(path.resolve(__dirname, "../../../../docs/proposed/feed_corpus_frozen.NOT_APPLIED.sql"), "utf8");
    expect(/-- frozen columns: (.*)/.exec(sql)![1]).toBe(FROZEN_COLUMNS.join(", "));
    expect(sql.split(FROZEN_COLUMNS.map((c) => `j.${c}`).join(", ")).length - 1).toBe(2); // create table + insert select
    expect(sql).toMatch(/set search_path = ''/);
    expect(sql).toMatch(/revoke all on public\.feed_corpus_epochs, public\.feed_corpus_frozen from public, anon, authenticated/);
    expect(sql).toMatch(/source_type <> 'jobspy'/);
  });

  it("freezeCorpus: validates parameters and returned metadata, maps the DB cap, enforces the caller's stricter bound on a reused epoch", async () => {
    const meta = (o: any = {}) => ({ rpc: async () => ({ data: [{ out_epoch: uuid(1), out_frozen_at: "2026-11-26T00:00:00Z", out_row_count: 3, out_corpus_mark: "2026-11-25T00:00:00Z", ...o }], error: null }) });
    expect(await freezeCorpus(meta())).toEqual({ epoch: uuid(1), frozenAt: "2026-11-26T00:00:00.000Z", rowCount: 3, corpusMark: "2026-11-25T00:00:00Z" });
    await expect(freezeCorpus({ rpc: async () => ({ data: null, error: { code: "54000", message: "snapshot_too_large" } }) })).rejects.toBeInstanceOf(SnapshotTooLargeError);
    await expect(freezeCorpus({ rpc: async () => ({ data: null, error: { code: "PGRST202", message: "missing" } }) })).rejects.toBeInstanceOf(SnapshotUnavailableError);
    await expect(freezeCorpus({ rpc: async () => ({ data: [], error: null }) })).rejects.toBeInstanceOf(SnapshotUnavailableError);
    for (const bad of [{ out_row_count: -1 }, { out_row_count: 1.5 }, { out_frozen_at: "not a date" }, { out_epoch: "x" }, { out_corpus_mark: "garbage" }]) {
      await expect(freezeCorpus(meta(bad))).rejects.toBeInstanceOf(SnapshotUnavailableError);
    }
    await expect(freezeCorpus(meta({ out_row_count: 50 }), 10)).rejects.toBeInstanceOf(SnapshotTooLargeError); // reused epoch over a stricter caller bound
    for (const args of [[0], [-5], [1.5], [NaN], [Infinity], [10, 0], [10, 100, 50]] as any[]) {
      let called = false;
      await expect(freezeCorpus({ rpc: async () => { called = true; return { data: null, error: null }; } }, ...args)).rejects.toBeInstanceOf(SnapshotUnavailableError);
      expect(called).toBe(false); // refused before any RPC
    }
  });

  it("buildOnce: same identity shares one build, distinct builds are bounded, the slot is released on failure", async () => {
    const gate: { open: () => void } = { open: () => {} };
    const wait = new Promise<void>((r) => { gate.open = r; });
    const b = async (): Promise<FeedSnapshot> => { await wait; return snap(1); };
    const p1 = buildOnce("a", b, 2), p1b = buildOnce("a", b, 2);
    expect(p1b).toBe(p1);
    const p2 = buildOnce("b", b, 2);
    await expect(buildOnce("c", b, 2)).rejects.toBeInstanceOf(SnapshotBusyError);
    gate.open(); await Promise.all([p1, p2]);
    await expect(buildOnce("d", async () => { throw new Error("boom"); }, 2)).rejects.toThrow("boom");
    await expect(buildOnce("e", async () => snap(1), 2)).resolves.toBeTruthy(); // nothing leaked
  });

  it("readFrozenCandidates: a purged epoch (row gone after the read) fails closed; a present epoch returns every row", async () => {
    const all = Array.from({ length: 1500 }, (_, i) => ({ id: uuid(9000 - i), posted_at: null }));
    const admin = (present: boolean) => ({ from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: present ? [{ epoch: uuid(1) }] : [], error: null }) }) }) }) });
    expect((await readFrozenCandidates(admin(true), uuid(1), () => fakeQuery(all))).length).toBe(1500);
    await expect(readFrozenCandidates(admin(false), uuid(1), () => fakeQuery(all))).rejects.toBeInstanceOf(SnapshotUnavailableError);
  });

  it("durable store writes through the admission RPC, never a bare insert; 53400 is busy, not eviction", async () => {
    const calls: any[] = [];
    const admin = { rpc: async (n: string, a: any) => (calls.push([n, a]), { error: null }) };
    await supabaseSnapshotStore(admin).put({ ...snap(3), corpusMark: "2026-11-26T00:00:00Z", epochId: uuid(5), frozenAt: "2026-11-26T00:00:00Z", builtAt: 0, expiresAt: 21600000 });
    expect(calls[0][0]).toBe("put_feed_snapshot");
    expect(Object.keys(calls[0][1]).sort()).toEqual(["p_built_at", "p_corpus_mark", "p_epoch_id", "p_expires_at", "p_frozen_at", "p_id", "p_identity", "p_job_ids", "p_max_snapshots", "p_max_total_ids", "p_salary_filter"]);
    const full = { rpc: async () => ({ error: { code: "53400", message: "snapshot_store_full" } }) };
    await expect(supabaseSnapshotStore(full).put({ ...snap(1), builtAt: 0, expiresAt: 1 })).rejects.toBeInstanceOf(SnapshotBusyError);
    const other = { rpc: async () => ({ error: { code: "XX000", message: "boom" } }) };
    await expect(supabaseSnapshotStore(other).put({ ...snap(1), builtAt: 0, expiresAt: 1 })).rejects.not.toBeInstanceOf(SnapshotBusyError);
  });

  it("readAllCandidates refuses a batch below 1 before any read (an outer LIMIT 0 would skip the salary RPC's validation)", async () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      let calls = 0;
      await expect(readAllCandidates(() => { calls++; return fakeQuery([]); }, bad)).rejects.toBeInstanceOf(SnapshotUnavailableError);
      expect(calls).toBe(0);
    }
  });

  it("durable store persists the HELD salary filter and reads it back (FX + exact thresholds survive a store round trip)", async () => {
    const salary = { minAnnualSalary: 100000, currency: "USD", rates: { USD: 1 }, fxSource: "static_fallback", fxFetchedAt: null, thresholds: [{ currency: "USD", period: "yearly", num: "100000", den: "1" }] };
    const calls: any[] = [];
    await supabaseSnapshotStore({ rpc: async (_n: string, a: any) => (calls.push(a), { error: null }) }).put({ ...snap(1), salary, builtAt: 0, expiresAt: 1 });
    expect(calls[0].p_salary_filter).toEqual(salary);
    const row = { id: uuid(1), identity: "i", job_ids: [uuid(2)], corpus_mark: null, epoch_id: null, frozen_at: null, salary_filter: salary, built_at: "2026-11-26T00:00:00Z", expires_at: "2026-11-26T06:00:00Z" };
    const admin = { from: () => ({ select: (cols: string) => { expect(cols).toContain("salary_filter"); return { eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }; } }) };
    expect((await supabaseSnapshotStore(admin).get(uuid(1)))!.salary).toEqual(salary);
    const sql = fs.readFileSync(path.join(process.cwd(), "docs/proposed/feed_snapshots_durable.NOT_APPLIED.sql"), "utf8");
    expect(sql).toMatch(/add column if not exists salary_filter jsonb/);
    expect(sql).toMatch(/p_salary_filter jsonb/);
  });

  it("memory store bounds the NUMBER of entries too (empty snapshots), evicting oldest", async () => {
    const st = memorySnapshotStore(1000, 3);
    for (let i = 1; i <= 6; i++) await st.put({ ...snap(0), id: uuid(i), expiresAt: 9e15 });
    expect(st.size()).toBe(3);
    expect(await st.get(uuid(1))).toBeNull();
    expect(await st.get(uuid(6))).not.toBeNull();
  });

  it("freezeCorpus sends aggregate bounds, maps 53400 to busy, rejects total < rows", async () => {
    const calls: any[] = [];
    const ok = { out_epoch: uuid(1), out_frozen_at: "2026-11-26T00:00:00Z", out_row_count: 2, out_corpus_mark: null };
    await freezeCorpus({ rpc: async (_n: string, a: any) => (calls.push(a), { data: [ok], error: null }) });
    expect(calls[0]).toMatchObject({ p_max_total_rows: expect.any(Number), p_max_epochs: expect.any(Number) });
    await expect(freezeCorpus({ rpc: async () => ({ data: null, error: { code: "53400", message: "frozen_store_full" } }) })).rejects.toBeInstanceOf(SnapshotBusyError);
    await expect(freezeCorpus({ rpc: async () => ({ data: [ok], error: null }) }, 100, 60, 3600, 99, 5)).rejects.toBeInstanceOf(SnapshotUnavailableError);
  });

  it("durable store refuses an over-bound snapshot before writing; proposed SQL declares every written column and the same bound", async () => {
    const writes: any[] = [];
    const admin = { rpc: async (_n: string, row: any) => (writes.push(row), { error: null }) };
    const big = { ...snap(1), jobIds: new Array(SNAPSHOT_MAX_ROWS + 1).fill("x"), corpusMark: null as any, builtAt: 0, expiresAt: 1 };
    await expect(supabaseSnapshotStore(admin).put(big)).rejects.toBeInstanceOf(SnapshotUnavailableError);
    expect(writes).toHaveLength(0);
    const sql = fs.readFileSync(path.join(process.cwd(), "docs/proposed/feed_snapshots_durable.NOT_APPLIED.sql"), "utf8");
    for (const c of ["id", "identity", "job_ids", "corpus_mark", "epoch_id", "frozen_at", "built_at", "expires_at"]) expect(sql).toMatch(new RegExp(`\\b${c}\\b`));
    expect(sql).toContain("put_feed_snapshot");
    expect(sql).toContain(`cardinality(job_ids) <= ${SNAPSHOT_MAX_ROWS}`);
    expect(sql).toMatch(/NOT APPLIED/);
  });
});

/** Minimal builder over mutable rows: filters `id < x`, orders by id desc, limits. `onRead` runs after each read (mid-build mutation). */
function fakeQuery(all: any[], onRead?: (n: number) => void) {
  let pred: (r: any) => boolean = () => true;
  let limit = Infinity;
  const q: any = {
    lt(_c: string, id: string) { const p = pred; pred = (r) => p(r) && r.id < id; return q; },
    order() { return q; },
    limit(n: number) { limit = n; return q; },
    then(res: any) {
      const data = [...all].filter(pred).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit);
      reads++;
      onRead?.(reads);
      return Promise.resolve({ data, error: null }).then(res);
    },
  };
  return q;
}
let reads = 0;
