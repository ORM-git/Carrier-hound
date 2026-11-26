import { describe, expect, it } from "vitest";
import { rankJobsByRecommendation } from "../recommendations";
import { capJobsPerCompany } from "../capping";
import {
  CORPUS_BATCH,
  decodeSnapshotCursor,
  encodeSnapshotCursor,
  loadFullCorpus,
  MemorySnapshotStore,
  rankFullCorpus,
  resolveSnapshot,
  servePage,
  SNAPSHOT_TTL_MS,
  snapshotIdentity,
  SnapshotTooLargeError,
} from "../rankedSnapshot";

const NOW = Date.parse("2026-11-26T09:00:00Z");
const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const answers = { roles: ["Frontend Engineer"], experienceLevel: "mid", remotePreference: "any", employmentTypes: [], locations: [] };

function corpus(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: uid(i),
    // Newest first; all weak except one strong match placed at the second-to-last raw position.
    title: i === n - 2 ? "Frontend Engineer" : i % 3 === 0 ? "Frontend Support Specialist" : "Office Manager",
    company: `Co ${i % 40}`,
    company_id: `co-${i % 40}`,
    location: "Remote",
    remote: true,
    job_type: "full-time",
    posted_at: new Date(NOW - i * 3600e3).toISOString(),
    category: "engineering",
  }));
}

describe("full-corpus order parity", () => {
  it("equals rankJobsByRecommendation + capJobsPerCompany on identical complete input; a strong match at raw position N-1 outranks rows 1-25", async () => {
    const rows = corpus(2600); // 3 keyset batches
    const byIdDesc = [...rows].sort((a, b) => b.id.localeCompare(a.id));
    const loaded = await loadFullCorpus(async (after, limit) => byIdDesc.filter((r) => !after || r.id < after).slice(0, limit), 10_000);
    expect(loaded).toHaveLength(2600);
    const snap = rankFullCorpus(loaded, answers, true, NOW);
    const expected = capJobsPerCompany(rankJobsByRecommendation(rows, answers, NOW).filter((j) => (j.matchScore ?? 0) > 0), 3, 30).map((j) => j.id);
    expect(snap.jobIds).toEqual(expected);
    expect(snap.jobIds[0]).toBe(uid(2598));
    expect(snap.jobIds.slice(1, 26)).not.toContain(uid(2598));
  });

  it("never silently truncates: past the bound it throws with the scanned count", async () => {
    const rows = corpus(CORPUS_BATCH * 2 + 5);
    await expect(loadFullCorpus(async (after, limit) => rows.filter((r) => !after || r.id < after).slice(0, limit), CORPUS_BATCH)).rejects.toBeInstanceOf(SnapshotTooLargeError);
  });
});

describe("serve-time eligibility over immutable ids", () => {
  const snapshot = { jobIds: Array.from({ length: 30 }, (_, i) => uid(i)) };
  const live = () => new Set(snapshot.jobIds);
  const loader = (valid: Set<string>, calls?: string[][]) => async (ids: string[]) => {
    calls?.push(ids);
    return ids.filter((id) => valid.has(id)).reverse().map((id) => ({ id })); // DB order is arbitrary
  };

  it("pages walk positions in snapshot order with zero duplicates", async () => {
    const valid = live();
    const p1 = await servePage(snapshot, 0, 10, loader(valid));
    const p2 = await servePage(snapshot, p1.nextPosition, 10, loader(valid));
    const p3 = await servePage(snapshot, p2.nextPosition, 10, loader(valid));
    const all = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
    expect(all).toEqual(snapshot.jobIds);
    expect(p3.hasNextPage).toBe(false);
  });

  it("delete + update-out-of-eligibility + insert between page 1 and page 2: removed ids omitted (positions consumed), page refilled, no duplicates, no resurrection, no unintended omission", async () => {
    const valid = live();
    const p1 = await servePage(snapshot, 0, 10, loader(valid));
    valid.delete(uid(10)); // deleted
    valid.delete(uid(12)); // updated so it no longer passes the filters
    valid.add(uid(999)); // inserted after build: not in the snapshot, never appears
    const p2 = await servePage(snapshot, p1.nextPosition, 10, loader(valid));
    expect(p2.rows.map((r) => r.id)).toEqual([11, 13, 14, 15, 16, 17, 18, 19, 20, 21].map(uid));
    expect(p2.omitted).toBe(2);
    expect(p2.nextPosition).toBe(22);
    valid.add(uid(10)); // came back after its position was consumed: not resurrected
    const p3 = await servePage(snapshot, p2.nextPosition, 10, loader(valid));
    const seen = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(uid(10));
    expect(seen).not.toContain(uid(999));
    // Every still-valid stored id was served exactly once.
    expect(seen.sort()).toEqual(snapshot.jobIds.filter((id) => id !== uid(10) && id !== uid(12)).sort());
  });

  it("bounded work: an all-removed stretch returns a short page with hasNextPage, never a premature end", async () => {
    const valid = new Set([uid(29)]);
    const calls: string[][] = [];
    const p = await servePage(snapshot, 0, 2, loader(valid, calls), 2);
    expect(p.rows).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(p.hasNextPage).toBe(true);
    const rest = await servePage(snapshot, p.nextPosition, 2, loader(valid), 10);
    expect(rest.rows.map((r) => r.id)).toEqual([uid(29)]);
    expect(rest.hasNextPage).toBe(false);
  });
});

describe("resolveSnapshot: invalidation, staleness and TTL", () => {
  const build = (ids: string[]) => async () => ({ jobIds: ids, scores: ids.map(() => 1), eligibleRows: ids.length });
  const idA = () => snapshotIdentity({ viewerKey: "u1", sessionEpoch: "s1", filterIdentity: "{}", tier: "free", answersIdentity: "{}" });

  it("identity covers viewer, session, filters, tier and answers", async () => {
    const base = { viewerKey: "u1", sessionEpoch: "s1", filterIdentity: "{}", tier: "free" as const, answersIdentity: "{}" };
    const a = await snapshotIdentity(base);
    for (const change of [{ viewerKey: "u2" }, { sessionEpoch: "s2" }, { filterIdentity: '{"jobType":"contract"}' }, { tier: "pro" as const }, { answersIdentity: '{"roles":["x"]}' }]) {
      expect(await snapshotIdentity({ ...base, ...change })).not.toBe(a);
    }
    expect(await snapshotIdentity(base)).toBe(a);
  });

  it("builds once, reuses for the same identity, and resets a cursor from another identity (filter/tier/session change)", async () => {
    const store = new MemorySnapshotStore();
    const first = await resolveSnapshot({ store, identity: await idA(), cursor: null, ingestEpoch: "e1", now: NOW, build: build([uid(1), uid(2)]) });
    expect(first).toMatchObject({ kind: "serve", built: true });
    const again = await resolveSnapshot({ store, identity: await idA(), cursor: null, ingestEpoch: "e1", now: NOW + 1, build: build([]) });
    expect(again).toMatchObject({ kind: "serve", built: false });
    const cursor = encodeSnapshotCursor((first as any).snapshot.id, 1);
    const other = await snapshotIdentity({ viewerKey: "u1", sessionEpoch: "s1", filterIdentity: "{}", tier: "pro", answersIdentity: "{}" });
    expect(await resolveSnapshot({ store, identity: other, cursor, ingestEpoch: "e1", now: NOW + 2, build: build([]) })).toEqual({ kind: "cursor_reset" });
    expect(await resolveSnapshot({ store, identity: await idA(), cursor: "rf1.garbage", ingestEpoch: "e1", now: NOW + 2, build: build([]) })).toEqual({ kind: "cursor_reset" });
  });

  it("new ingest cycle: issued cursors keep walking the old snapshot (marked stale); the next cursor-less request rebuilds", async () => {
    const store = new MemorySnapshotStore();
    const first: any = await resolveSnapshot({ store, identity: await idA(), cursor: null, ingestEpoch: "e1", now: NOW, build: build([uid(1), uid(2)]) });
    const cursor = encodeSnapshotCursor(first.snapshot.id, 1);
    const cont: any = await resolveSnapshot({ store, identity: await idA(), cursor, ingestEpoch: "e2", now: NOW + 5, build: build([]) });
    expect(cont).toMatchObject({ kind: "serve", stale: true, built: false, position: 1 });
    expect(cont.snapshot.id).toBe(first.snapshot.id);
    const fresh: any = await resolveSnapshot({ store, identity: await idA(), cursor: null, ingestEpoch: "e2", now: NOW + 6, build: build([uid(3)]) });
    expect(fresh).toMatchObject({ built: true, stale: false });
    expect(fresh.snapshot.jobIds).toEqual([uid(3)]);
  });

  it("TTL: expired snapshots are deleted and their cursors reset", async () => {
    const store = new MemorySnapshotStore();
    const first: any = await resolveSnapshot({ store, identity: await idA(), cursor: null, ingestEpoch: "e1", now: NOW, build: build([uid(1)]) });
    expect(store.size).toBe(1);
    const later = NOW + SNAPSHOT_TTL_MS + 1;
    const r = await resolveSnapshot({ store, identity: await idA(), cursor: encodeSnapshotCursor(first.snapshot.id, 0), ingestEpoch: "e1", now: later, build: build([]) });
    expect(r).toEqual({ kind: "cursor_reset" });
    expect(store.size).toBe(0);
  });

  it("cursor round-trip and strict decoding", () => {
    const id = "0b5a1c3e-1111-4222-8333-944455556666";
    expect(decodeSnapshotCursor(encodeSnapshotCursor(id, 42))).toEqual({ snapshotId: id, position: 42 });
    for (const bad of ["", "cs1.x", `rf1.${id}`, `rf1.${id}.-1`, `rf1.${id}.1.2`, `rf1.not-a-uuid.3`]) expect(decodeSnapshotCursor(bad)).toBeNull();
  });
});
