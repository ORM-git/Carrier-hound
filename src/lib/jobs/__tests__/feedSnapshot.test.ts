// Unit checks for the full-corpus snapshot prototype (src/lib/jobs/feedSnapshot.ts). FIXTURE data only.
import { describe, expect, it } from "vitest";
import {
  decodeSnapshotCursor, encodeSnapshotCursor, readAllCandidates, serveSnapshotPage, snapshotIdentity,
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

  it("durable store writes only identity, ordered IDs and timestamps (no job content)", async () => {
    const writes: any[] = [];
    const admin = { from: (t: string) => ({ insert: async (row: any) => (writes.push([t, row]), { error: null }) }) };
    await supabaseSnapshotStore(admin).put({ ...snap(3), corpusMark: "2026-11-26T00:00:00Z", builtAt: 0, expiresAt: 21600000 });
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("feed_snapshots");
    expect(Object.keys(writes[0][1]).sort()).toEqual(["built_at", "corpus_mark", "expires_at", "id", "identity", "job_ids"]);
  });
});

/** Minimal keyset-aware builder over sorted rows (posted_at desc nulls last, id desc). */
function fakeQuery(all: any[]) {
  let pred: (r: any) => boolean = () => true;
  let limit = Infinity;
  const q: any = {
    or(clause: string) {
      const m = clause.match(/^posted_at\.lt\.([^,]+),and\(posted_at\.eq\.([^,]+),id\.lt\.([^)]+)\),posted_at\.is\.null$/)!;
      pred = (r) => r.posted_at === null || r.posted_at < m[1] || (r.posted_at === m[2] && r.id < m[3]);
      return q;
    },
    is() { return q; },
    lt(_c: string, id: string) { const p = pred; pred = (r) => p(r) && r.posted_at === null && r.id < id; return q; },
    order() { return q; },
    limit(n: number) { limit = n; return q; },
    then(res: any) { return Promise.resolve({ data: all.filter(pred).slice(0, limit), error: null }).then(res); },
  };
  return q;
}
