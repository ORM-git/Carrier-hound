import { describe, it, expect } from "vitest";
import { percentile, evaluateSlo } from "@/lib/observability/slo";

describe("percentile (nearest-rank)", () => {
  it("computes nearest-rank percentiles on unsorted samples", () => {
    const s = [500, 100, 900, 300, 700, 200, 800, 400, 600, 1000];
    expect(percentile(s, 50)).toBe(500);
    expect(percentile(s, 75)).toBe(800);
    expect(percentile(s, 95)).toBe(1000);
    expect(percentile(s, 100)).toBe(1000);
  });

  it("handles single sample and empty input", () => {
    expect(percentile([42], 75)).toBe(42);
    expect(percentile([], 75)).toBeNull();
  });

  it("rejects out-of-range percentiles", () => {
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe("evaluateSlo", () => {
  const target = [{ percentile: 75, maxMs: 800 }];

  it("reports ok when the p75 is within target", () => {
    const r = evaluateSlo([100, 200, 300, 400], target);
    expect(r.status).toBe("ok");
    expect(r.breaches).toEqual([]);
    expect(r.sampleCount).toBe(4);
    expect(r.percentiles.p75).toBe(400);
  });

  it("reports breach with actual values when the target is exceeded", () => {
    const r = evaluateSlo([100, 200, 900, 950], target);
    expect(r.status).toBe("breach");
    expect(r.breaches).toEqual([{ percentile: 75, maxMs: 800, actualMs: 950 }]);
  });

  it("reports no_data on empty or fully-invalid samples", () => {
    expect(evaluateSlo([], target).status).toBe("no_data");
    expect(evaluateSlo([NaN, -5], target).status).toBe("no_data");
  });

  it("drops invalid samples instead of skewing the percentile", () => {
    const r = evaluateSlo([100, NaN, 200, -1, 300], target);
    expect(r.sampleCount).toBe(3);
  });
});
