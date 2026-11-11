import { describe, expect, it } from "vitest";
import { evaluateSourceHealth, IngestRunSnapshot } from "@/lib/observability/sourceHealth";
const policy = { maxFailuresInWindow: 1, staleAfterHours: 24 };
const now = "2026-11-06T12:00:00.000Z";
describe("source health classification", () => {
  it("reports healthy for a recent success", () => {
    const result = evaluateSourceHealth([{ finished_at: "2026-11-06T10:00:00Z", status: "success" }], policy, now);
    expect(result.status).toBe("healthy");
    expect(result.lastSuccessAt).toBe("2026-11-06T10:00:00.000Z");
  });
  it("reports stale success as degraded", () => {
    const result = evaluateSourceHealth([{ finished_at: "2026-11-04T09:00:00Z", status: "success" }], policy, now);
    expect(result.status).toBe("degraded");
    expect(result.reason).toContain("older than 24h");
  });
  it("reports latest failed/warning after success as degraded", () => {
    const result = evaluateSourceHealth([
      { finished_at: "2026-11-06T09:00:00Z", status: "success" },
      { finished_at: "2026-11-06T10:00:00Z", status: "warning" },
    ], policy, now);
    expect(result.status).toBe("degraded");
    expect(result.lastFailureAt).toBe("2026-11-06T10:00:00.000Z");
  });
  it("reports no_data, never silently healthy, on empty evidence", () => {
    expect(evaluateSourceHealth([], policy, now)).toEqual({ status: "no_data" });
  });
  it("validates the runs argument before touching it", () => {
    const result = evaluateSourceHealth(null as any, policy, now);
    expect(result).toEqual({ status: "invalid", reason: "runs must be an array." });
  });
  it("fails safely on malformed timestamps and policy", () => {
    expect(evaluateSourceHealth([{ finished_at: "bad", status: "success" }], policy, now).status).toBe("invalid");
    expect(evaluateSourceHealth([{ finished_at: now, status: "success" }], { maxFailuresInWindow: 0, staleAfterHours: 24 }, now).status).toBe("invalid");
    expect(evaluateSourceHealth([{ finished_at: now, status: "success" }], policy, "bad").status).toBe("invalid");
  });

  describe("cycle-aware sharded health", () => {
    it("reports healthy when all expected shards in a cycle are present and successful", () => {
      const runs: IngestRunSnapshot[] = [0, 1, 2, 3, 4, 5].map((shard_id) => ({
        finished_at: "2026-11-06T11:00:00Z",
        status: "success",
        coverage: { cycle_id: "cycle-101", shard_id, expected_shards: 6 },
      }));
      const result = evaluateSourceHealth(runs, policy, now);
      expect(result.status).toBe("healthy");
      expect(result.lastSuccessAt).toBe("2026-11-06T11:00:00.000Z");
    });

    it("reports degraded when a cycle is incomplete (missing expected shards)", () => {
      const runs: IngestRunSnapshot[] = [0, 1, 2, 3].map((shard_id) => ({
        finished_at: "2026-11-06T11:00:00Z",
        status: "success",
        coverage: { cycle_id: "cycle-102", shard_id, expected_shards: 6 },
      }));
      const result = evaluateSourceHealth(runs, policy, now);
      expect(result.status).toBe("degraded");
      expect(result.reason).toContain("incomplete");
      expect(result.reason).toContain("expected 6 shards, received 4");
    });

    it("reports degraded when any shard in the cycle fails", () => {
      const runs: IngestRunSnapshot[] = [0, 1, 2, 3, 4, 5].map((shard_id) => ({
        finished_at: "2026-11-06T11:00:00Z",
        status: shard_id === 3 ? "failed" : "success",
        coverage: { cycle_id: "cycle-103", shard_id, expected_shards: 6 },
      }));
      const result = evaluateSourceHealth(runs, policy, now);
      expect(result.status).toBe("degraded");
      expect(result.reason).toContain("failing shard(s): 3");
    });

    it("extracts coverage metadata from per_source_counts.coverage when top-level coverage is absent", () => {
      const runs: IngestRunSnapshot[] = [0, 1].map((shard_id) => ({
        finished_at: "2026-11-06T11:00:00Z",
        status: "success",
        per_source_counts: {
          stripe: 5,
          coverage: { cycle_id: "cycle-psc", shard_id, expected_shards: 2 },
        },
      }));
      const result = evaluateSourceHealth(runs, policy, now);
      expect(result.status).toBe("healthy");
      expect(result.lastSuccessAt).toBe("2026-11-06T11:00:00.000Z");
    });

    it("allows a successful retry of a previously failed shard in the same cycle", () => {
      const runs: IngestRunSnapshot[] = [
        { finished_at: "2026-11-06T11:00:00Z", status: "success", coverage: { cycle_id: "c-retry", shard_id: 0, expected_shards: 2 } },
        { finished_at: "2026-11-06T11:00:00Z", status: "failed", coverage: { cycle_id: "c-retry", shard_id: 1, expected_shards: 2 } },
        { finished_at: "2026-11-06T11:05:00Z", status: "success", coverage: { cycle_id: "c-retry", shard_id: 1, expected_shards: 2 } },
      ];
      const result = evaluateSourceHealth(runs, policy, now);
      expect(result.status).toBe("healthy");
      expect(result.lastSuccessAt).toBe("2026-11-06T11:05:00.000Z");
    });
  });
});
