/**
 * scoreCache store guards (checklist row 43). Test-only: asserts the CURRENT contract of
 * src/lib/matcher/scoreCache.ts, changes nothing.
 *
 * Existing coverage this file deliberately does NOT duplicate:
 * - matchScoreContract.test.ts: revision-keyed misses, snapshot invalidation on candidate/preference
 *   change, "no snapshot never stores; corrupt storage is ignored".
 * - scoreRecencyRevision.test.ts: revision determinism, boundary adoption, route stamping.
 * - scoreFreshDetailCache.test.ts: fresh authoritative detail score survives replacing a stale feed row.
 * - detailJobEntitlement.test.ts: detailJobForEntitlement Free/Pro transitions.
 *
 * What only THIS file pins:
 * - the MAX_ENTRIES (500) cap evicts oldest-inserted entries and a re-remembered key survives as newest;
 * - a job with no scoreRevision is never cached (entryKey fails closed);
 * - NaN / non-number scores are never stored;
 * - a throwing localStorage.setItem is swallowed (detail falls back to computed score);
 * - reconcileFeedWithDetail edge paths: same revision unchanged, detail without revision unchanged,
 *   non-finite detail score drops to null.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  rememberMatchScores,
  recallMatchScore,
  matchScoreSnapshot,
  reconcileFeedWithDetail,
} from "@/lib/matcher/scoreCache";

const mem = new Map<string, string>();
let throwOnSet = false;

beforeEach(() => {
  mem.clear();
  throwOnSet = false;
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (throwOnSet) throw new Error("storage full");
      mem.set(k, v);
    },
    removeItem: (k: string) => void mem.delete(k),
  };
});

const cand = {
  confirmedAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-20T00:00:00Z",
  skills: ["python"],
};
const snap = matchScoreSnapshot(cand, "prefs-v1")!;
const job = (id: string, rev = "r1", score: number | null = 80) => ({
  id,
  scoreRevision: rev,
  matchScore: score,
});

describe("scoreCache store: cap, revision keying and storage failure guards", () => {
  it("caps at 500 entries, evicting the oldest insertions first", () => {
    const jobs = Array.from({ length: 505 }, (_, i) => job(`j${i}`, "r1", 50 + (i % 40)));
    rememberMatchScores(snap, jobs);
    for (let i = 0; i < 5; i++) expect(recallMatchScore(snap, job(`j${i}`))).toBeNull();
    for (let i = 5; i < 505; i++)
      expect(recallMatchScore(snap, job(`j${i}`))).toBe(50 + (i % 40));
  });

  it("a re-remembered key (same id+revision, new score) updates and survives the cap as newest", () => {
    const jobs = Array.from({ length: 500 }, (_, i) => job(`j${i}`, "r1", 70));
    rememberMatchScores(snap, jobs);
    rememberMatchScores(snap, [job("j0", "r1", 99)]); // refresh j0: delete + re-insert
    rememberMatchScores(snap, [job("j500", "r1", 70)]); // pushes one past the cap
    expect(recallMatchScore(snap, job("j0"))).toBe(99); // refreshed entry survives
    expect(recallMatchScore(snap, job("j1"))).toBeNull(); // oldest untouched entry evicted
    expect(recallMatchScore(snap, job("j500"))).toBe(70);
  });

  it("a job with no scoreRevision is never cached", () => {
    rememberMatchScores(snap, [{ id: "j1", matchScore: 88 }]);
    expect(recallMatchScore(snap, { id: "j1" })).toBeNull();
    expect(mem.has("cm_match_scores")).toBe(false); // nothing was written at all
  });

  it("NaN and non-number scores are never stored", () => {
    rememberMatchScores(snap, [
      { id: "j1", scoreRevision: "r1", matchScore: Number.NaN },
      { id: "j2", scoreRevision: "r1", matchScore: "88" as any },
    ]);
    expect(recallMatchScore(snap, job("j1"))).toBeNull();
    expect(recallMatchScore(snap, job("j2"))).toBeNull();
    expect(mem.has("cm_match_scores")).toBe(false);
  });

  it("a throwing setItem is swallowed: remember does not throw and recall stays null", () => {
    throwOnSet = true;
    expect(() => rememberMatchScores(snap, [job("j1", "r1", 88)])).not.toThrow();
    expect(recallMatchScore(snap, job("j1"))).toBeNull();
  });

  it("entries are keyed by revision: the same job id under a new revision is a miss, never the old score", () => {
    rememberMatchScores(snap, [job("j1", "rev-old", 88)]);
    expect(recallMatchScore(snap, job("j1", "rev-new"))).toBeNull();
    expect(recallMatchScore(snap, job("j1", "rev-old"))).toBe(88);
  });
});

describe("reconcileFeedWithDetail edge paths", () => {
  const feedRow = (id: string, rev: string | null, score: number | null) => ({
    id,
    scoreRevision: rev,
    matchScore: score,
  });

  it("same revision returns the feed unchanged", () => {
    const feed = [feedRow("j1", "r1", 80)];
    const detail = feedRow("j1", "r1", 99);
    expect(reconcileFeedWithDetail(feed, detail)).toBe(feed);
  });

  it("detail without a scoreRevision returns the feed unchanged", () => {
    const feed = [feedRow("j1", "r1", 80)];
    const detail = feedRow("j1", null, 99);
    expect(reconcileFeedWithDetail(feed, detail)).toBe(feed);
  });

  it("detail id not in the feed returns the feed unchanged", () => {
    const feed = [feedRow("j1", "r1", 80)];
    const detail = feedRow("j2", "r2", 99);
    expect(reconcileFeedWithDetail(feed, detail)).toBe(feed);
  });

  it("newer detail revision with a null detail score drops the stale feed score to null", () => {
    const feed = [feedRow("j1", "r1", 80)];
    const detail = feedRow("j1", "r2", null);
    const next = reconcileFeedWithDetail(feed, detail);
    expect(next).not.toBe(feed);
    expect(next[0].scoreRevision).toBe("r2");
    expect(next[0].matchScore).toBeNull();
  });

  it("newer detail revision with a NaN detail score drops to null, never NaN", () => {
    const feed = [feedRow("j1", "r1", 80)];
    const detail = feedRow("j1", "r2", Number.NaN);
    const next = reconcileFeedWithDetail(feed, detail);
    expect(next[0].matchScore).toBeNull();
  });
});
