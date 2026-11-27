import { describe, it, expect } from "vitest";
import { evaluateSourceFreshness, evaluateSourceHealth, type IngestRunSnapshot } from "@/lib/observability/sourceHealth";

const REF = "2026-11-26T12:00:00.000Z";
const hoursBefore = (h: number) => new Date(Date.parse(REF) - h * 3600_000).toISOString();
const policy = { expectedSources: ["greenhouse-stripe", "lever-spotify", "workday-acme"], sourceStaleAfterHours: 12 };

// Shape written by scripts/ingest.ts: { [sourceId]: inserted+updated, coverage }.
const run = (h: number, counts: Record<string, unknown>, status = "success", shard_id = 0, cycle = `c-${h}`, expected_shards = 1): IngestRunSnapshot => ({
  started_at: hoursBefore(h + 0.5),
  finished_at: hoursBefore(h),
  status,
  per_source_counts: { ...counts, coverage: { cycle_id: cycle, shard_id, expected_shards } },
});

describe("evaluateSourceFreshness", () => {
  it("all expected sources fresh -> healthy", () => {
    const r = evaluateSourceFreshness([run(1, { "greenhouse-stripe": 4, "lever-spotify": 2, "workday-acme": 9 })], policy, REF);
    expect(r).toEqual({ status: "healthy", referenceTime: REF, staleSources: [], neverSeenSources: [], unknownSources: [], insufficientEvidenceSources: [] });
  });

  it("a successful run reporting 0 jobs for a source is still successful evidence", () => {
    const r = evaluateSourceFreshness([run(1, { "greenhouse-stripe": 0, "lever-spotify": 0, "workday-acme": 0 })], policy, REF);
    expect(r.status).toBe("healthy");
  });

  it("one stale source with the correct lastSuccessAt", () => {
    const r = evaluateSourceFreshness(
      [run(1, { "greenhouse-stripe": 3, "lever-spotify": 1 }), run(30, { "workday-acme": 5 }), run(40, { "workday-acme": 2 })],
      policy,
      REF,
    );
    expect(r.status).toBe("degraded");
    expect(r.staleSources).toEqual([{ source: "workday-acme", lastSuccessAt: hoursBefore(30) }]);
  });

  it("expected but never seen in any row", () => {
    const r = evaluateSourceFreshness([run(1, { "greenhouse-stripe": 3, "lever-spotify": 1 })], policy, REF);
    expect(r.neverSeenSources).toEqual(["workday-acme"]);
    expect(r.status).toBe("degraded");
  });

  it("unknown extra source is reported, not flagged", () => {
    const r = evaluateSourceFreshness([run(1, { "greenhouse-stripe": 3, "lever-spotify": 1, "workday-acme": 1, "ashby-newco": 7 })], policy, REF);
    expect(r.unknownSources).toEqual(["ashby-newco"]);
    expect(r.status).toBe("healthy");
  });

  it("rows missing per-source detail -> insufficient evidence, never success or failure", () => {
    const rows: IngestRunSnapshot[] = [
      { finished_at: hoursBefore(1), status: "success" },
      { finished_at: hoursBefore(2), status: "success", per_source_counts: { coverage: { cycle_id: "x", shard_id: 0, expected_shards: 1 } } },
    ];
    const r = evaluateSourceFreshness(rows, policy, REF);
    expect(r.status).toBe("insufficient_evidence");
    expect(r.insufficientEvidenceSources).toEqual(policy.expectedSources);
    expect(r.neverSeenSources).toEqual([]);
  });

  it("an old success followed by a detail-less row is insufficient, not stale", () => {
    const r = evaluateSourceFreshness([{ finished_at: hoursBefore(2), status: "success" }, run(30, { "greenhouse-stripe": 1, "lever-spotify": 1, "workday-acme": 1 })], policy, REF);
    expect(r.staleSources).toEqual([]);
    expect(r.insufficientEvidenceSources).toEqual(policy.expectedSources);
  });

  it("a source only in warning/failed rows is ambiguous (0 may be a failure) -> insufficient", () => {
    const r = evaluateSourceFreshness(
      [run(1, { "greenhouse-stripe": 2, "lever-spotify": 1 }, "success"), run(2, { "workday-acme": 0 }, "warning"), run(3, { "workday-acme": 0 }, "failed")],
      policy,
      REF,
    );
    expect(r.insufficientEvidenceSources).toEqual(["workday-acme"]);
    expect(r.status).toBe("insufficient_evidence");
  });

  it("invalid timestamps are insufficient evidence, never fresh", () => {
    const rows: IngestRunSnapshot[] = [
      { finished_at: "not-a-date", started_at: null, status: "success", per_source_counts: { "greenhouse-stripe": 3, "lever-spotify": 3, "workday-acme": 3 } },
    ];
    const r = evaluateSourceFreshness(rows, policy, REF);
    expect(r.status).toBe("insufficient_evidence");
    expect(r.insufficientEvidenceSources).toEqual(policy.expectedSources);
  });

  it("falls back to started_at when finished_at is absent", () => {
    const rows: IngestRunSnapshot[] = [{ started_at: hoursBefore(1), status: "success", per_source_counts: { "greenhouse-stripe": 1, "lever-spotify": 1, "workday-acme": 1 } }];
    expect(evaluateSourceFreshness(rows, policy, REF).status).toBe("healthy");
  });

  it("boundary: exactly sourceStaleAfterHours old is fresh; one ms older is stale", () => {
    const counts = { "greenhouse-stripe": 1, "lever-spotify": 1, "workday-acme": 1 };
    expect(evaluateSourceFreshness([run(12, counts)], policy, REF).status).toBe("healthy");
    const older: IngestRunSnapshot = { ...run(12, counts), finished_at: new Date(Date.parse(REF) - 12 * 3600_000 - 1).toISOString() };
    expect(evaluateSourceFreshness([older], policy, REF).staleSources.map((s) => s.source)).toEqual(policy.expectedSources);
  });

  it.each([undefined, null, []])("not_configured without expectedSources (%j): judges nothing", (expectedSources) => {
    const r = evaluateSourceFreshness([run(100, { anything: 1 })], { expectedSources: expectedSources as any, sourceStaleAfterHours: 12 }, REF);
    expect(r).toEqual({ status: "not_configured", referenceTime: REF, staleSources: [], neverSeenSources: [], unknownSources: [], insufficientEvidenceSources: [] });
  });

  it.each([["bad-ref", 12], [REF, 0], [REF, NaN]] as const)("invalid policy or referenceTime (%s, %s) -> invalid", (ref, hours) => {
    expect(evaluateSourceFreshness([], { expectedSources: ["a"], sourceStaleAfterHours: hours }, ref).status).toBe("invalid");
  });

  it("negative control: a green cycle set with a silently absent source is caught", () => {
    // Two complete 2-shard cycles, all success, but workday-acme vanished from the newer cycle.
    const rows = [
      run(1, { "greenhouse-stripe": 3 }, "success", 0, "c-new", 2),
      run(1, { "lever-spotify": 2 }, "success", 1, "c-new", 2),
      run(20, { "greenhouse-stripe": 3, "workday-acme": 4 }, "success", 0, "c-old", 2),
      run(20, { "lever-spotify": 2 }, "success", 1, "c-old", 2),
    ];
    const cycle = evaluateSourceHealth(rows, { maxFailuresInWindow: 1, staleAfterHours: 12 }, REF);
    expect(cycle.status).toBe("healthy"); // cycle-level health stays green
    const fresh = evaluateSourceFreshness(rows, policy, REF);
    expect(fresh.status).toBe("degraded");
    expect(fresh.staleSources).toEqual([{ source: "workday-acme", lastSuccessAt: hoursBefore(20) }]);
  });

  it("is pure: same input, same output; input rows are not mutated", () => {
    const rows = [run(1, { "greenhouse-stripe": 3 })];
    const snapshot = JSON.stringify(rows);
    expect(evaluateSourceFreshness(rows, policy, REF)).toEqual(evaluateSourceFreshness(rows, policy, REF));
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});
