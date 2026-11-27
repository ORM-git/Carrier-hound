// @vitest-environment jsdom
// Page-level downgrade guard: the detail job the jobs page renders must never carry a stale Pro score into a Free,
// guest or downgraded session (selected-job state, feed score and remembered score all covered).
import { beforeEach, describe, expect, it } from "vitest";
import { detailJobForEntitlement, matchScoreSnapshot, rememberMatchScores, recallMatchScore } from "@/lib/matcher/scoreCache";

const cand = { confirmedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" } as any;
const snap = matchScoreSnapshot(cand, "p1");
const sel = { id: "j1", title: "T", matchScore: 87, scoreRevision: "r1" };
const feed = [{ id: "j1", matchScore: 91, scoreRevision: "r1" }];

beforeEach(() => { localStorage.clear(); });

describe("detailJobForEntitlement", () => {
  it("Free/guest: stale selected-job score is nulled", () => {
    expect(detailJobForEntitlement(sel, [], false, snap)!.matchScore).toBeNull();
  });
  it("Free/guest: a feed score for the same revision is not applied", () => {
    expect(detailJobForEntitlement({ ...sel, matchScore: null }, feed, false, snap)!.matchScore).toBeNull();
  });
  it("Free/guest: a remembered Pro score is not recalled", () => {
    rememberMatchScores(snap, [{ id: "j1", matchScore: 77, scoreRevision: "r1" } as any]);
    const j = { id: "j1", title: "T", matchScore: null, scoreRevision: "r1" };
    expect(recallMatchScore(snap, j as any)).toBe(77); // precondition: the cache really holds it
    expect(detailJobForEntitlement(j, [], false, snap)!.matchScore).toBeNull();
  });
  it("Pro -> Free transition on the same selected job drops the score; Free -> Pro restores feed/remembered", () => {
    expect(detailJobForEntitlement(sel, feed, true, snap)!.matchScore).toBe(91);
    expect(detailJobForEntitlement(sel, feed, false, snap)!.matchScore).toBeNull();
    expect(detailJobForEntitlement(sel, feed, true, snap)!.matchScore).toBe(91);
  });
  it("Pro positive control: selected score kept, remembered used when absent, null job stays null", () => {
    expect(detailJobForEntitlement(sel, [], true, snap)!.matchScore).toBe(87);
    rememberMatchScores(snap, [{ id: "j2", matchScore: 66, scoreRevision: "r2" } as any]);
    expect(detailJobForEntitlement({ id: "j2", title: "T", matchScore: null, scoreRevision: "r2" }, [], true, snap)!.matchScore).toBe(66);
    expect(detailJobForEntitlement(null, feed, true, snap)).toBeNull();
  });
});
