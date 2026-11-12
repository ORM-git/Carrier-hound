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
    it("reports healthy for complete cycle when all expected shards are present and successful", () => {
      const runs: IngestRunSnapshot[] = [0, 1, 2, 3, 4, 5].map((shard_id) => ({
        started_at: "2026-11-06T10:45:00Z",
        finished_at: "2026-11-06T11:00:00Z",
        status: "success",
        coverage: { cycle_id: "cycle-complete", shard_id, expected_shards: 6 },
      }));
      const result = evaluateSourceHealth(runs, { maxFailuresInWindow: 1, staleAfterHours: 4 }, "2026-11-06T11:15:00.000Z");
      expect(result.status).toBe("healthy");
      expect(result.lastSuccessAt).toBe("2026-11-06T11:00:00.000Z");
    });

    it("treats an incomplete cycle inside its deadline window as in-progress and evaluates last completed cycle", () => {
      // Prior completed cycle (cycle-prev) finished 2 hours ago (healthy)
      const prevRuns: IngestRunSnapshot[] = [0, 1, 2, 3, 4, 5].map((shard_id) => ({
        started_at: "2026-11-06T09:45:00Z",
        finished_at: "2026-11-06T10:00:00Z",
        status: "success",
        coverage: { cycle_id: "cycle-prev", shard_id, expected_shards: 6 },
      }));

      // Current cycle (cycle-current) just finished shard 0 and 1 10 minutes ago (15m elapsed from start, well within 90m deadline)
      const currentRuns: IngestRunSnapshot[] = [0, 1].map((shard_id) => ({
        started_at: "2026-11-06T11:45:00Z",
        finished_at: "2026-11-06T11:50:00Z",
        status: "success",
        coverage: { cycle_id: "cycle-current", shard_id, expected_shards: 6 },
      }));

      // now is 12:00:00 (15 min after current cycle started, within allowed window)
      const result = evaluateSourceHealth([...prevRuns, ...currentRuns], { maxFailuresInWindow: 1, staleAfterHours: 4, cycleDeadlineMinutes: 90 }, now);
      expect(result.status).toBe("healthy");
      // Evaluated the last COMPLETED cycle (cycle-prev at 10:00), not marking degraded as soon as shard 0/1 finish
      expect(result.lastSuccessAt).toBe("2026-11-06T10:00:00.000Z");
    });

    it("reports healthy when the only cycle in evidence is currently in-progress without failures", () => {
      const currentRuns: IngestRunSnapshot[] = [0, 1].map((shard_id) => ({
        started_at: "2026-11-06T11:45:00Z",
        finished_at: "2026-11-06T11:50:00Z",
        status: "success",
        coverage: { cycle_id: "cycle-only-inprogress", shard_id, expected_shards: 6 },
      }));

      const result = evaluateSourceHealth(currentRuns, { maxFailuresInWindow: 1, staleAfterHours: 4, cycleDeadlineMinutes: 90 }, now);
      expect(result.status).toBe("healthy");
      expect(result.lastSuccessAt).toBe("2026-11-06T11:50:00.000Z");
    });

    it("reports degraded when an incomplete cycle exceeds its deadline window (overdue)", () => {
      // Cycle started at 09:00, shards 0 and 1 finished at 09:15, but remaining shards never arrived
      // With deadline 90 minutes, at 12:00 it is 180 minutes old (> 90m deadline)
      const runs: IngestRunSnapshot[] = [0, 1].map((shard_id) => ({
        started_at: "2026-11-06T09:00:00Z",
        finished_at: "2026-11-06T09:15:00Z",
        status: "success",
        coverage: { cycle_id: "cycle-overdue", shard_id, expected_shards: 6 },
      }));

      const result = evaluateSourceHealth(runs, { maxFailuresInWindow: 1, staleAfterHours: 4, cycleDeadlineMinutes: 90 }, now);
      expect(result.status).toBe("degraded");
      expect(result.reason).toContain("overdue");
      expect(result.reason).toContain("incomplete: expected 6 shards, received 2");
      expect(result.lastFailureAt).toBe("2026-11-06T09:15:00.000Z");
    });

    it("enforces 4-hour cadence staleness: healthy at 3h, degraded at 5h", () => {
      const policy4h = { maxFailuresInWindow: 1, staleAfterHours: 4 };

      // 3 hours old success (from 09:00 to 12:00) -> healthy
      const runsRecent: IngestRunSnapshot[] = [0, 1, 2, 3, 4, 5].map((shard_id) => ({
        finished_at: "2026-11-06T09:00:00Z",
        status: "success",
        coverage: { cycle_id: "cycle-3h", shard_id, expected_shards: 6 },
      }));
      const resRecent = evaluateSourceHealth(runsRecent, policy4h, now);
      expect(resRecent.status).toBe("healthy");

      // 5 hours old success (from 07:00 to 12:00) -> degraded
      const runsStale: IngestRunSnapshot[] = [0, 1, 2, 3, 4, 5].map((shard_id) => ({
        finished_at: "2026-11-06T07:00:00Z",
        status: "success",
        coverage: { cycle_id: "cycle-5h", shard_id, expected_shards: 6 },
      }));
      const resStale = evaluateSourceHealth(runsStale, policy4h, now);
      expect(resStale.status).toBe("degraded");
      expect(resStale.reason).toContain("older than 4h");
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
