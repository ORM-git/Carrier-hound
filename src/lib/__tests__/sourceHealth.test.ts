import { describe, expect, it } from "vitest";
import { evaluateSourceHealth } from "@/lib/observability/sourceHealth";
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
  it("detects per-board volume collapse and reports degraded", () => {
    const runs = [
      {
        finished_at: "2026-11-06T11:00:00Z",
        status: "success",
        per_source_counts: {
          stripe: { new_canonical: 0, updated: 0, reopened: 0 },
          linear: 25,
        },
      },
      {
        finished_at: "2026-11-05T11:00:00Z",
        status: "success",
        per_source_counts: {
          stripe: { new_canonical: 5, updated: 45, reopened: 0 },
          linear: 24,
        },
      },
    ];
    const result = evaluateSourceHealth(runs, policy, now);
    expect(result.status).toBe("degraded");
    expect(result.reason).toContain("Per-board volume collapse detected");
    expect(result.reason).toContain("stripe");
    expect(result.collapsedBoards?.[0]?.board).toBe("stripe");
    expect(result.collapsedBoards?.[0]?.previousCount).toBe(50);
    expect(result.collapsedBoards?.[0]?.currentCount).toBe(0);
    expect(result.collapsedBoards?.[0]?.dropPercent).toBe(100);
  });
  it("passes volume check when counts are stable", () => {
    const runs = [
      {
        finished_at: "2026-11-06T11:00:00Z",
        status: "success",
        per_source_counts: {
          stripe: 48,
          linear: 25,
        },
      },
      {
        finished_at: "2026-11-05T11:00:00Z",
        status: "success",
        per_source_counts: {
          stripe: 50,
          linear: 24,
        },
      },
    ];
    const result = evaluateSourceHealth(runs, policy, now);
    expect(result.status).toBe("healthy");
  });
});
