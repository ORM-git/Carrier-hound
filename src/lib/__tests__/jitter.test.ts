import { describe, it, expect } from "vitest";
import { withJitter } from "../reliability/jitter";

describe("withJitter", () => {
  it("pins the lower bound when rand() = 0", () => {
    expect(withJitter(1000, { rand: () => 0 })).toBe(800);
  });

  it("approaches but never exceeds the upper bound", () => {
    const nearOne = () => 0.9999999999;
    const value = withJitter(1000, { rand: nearOne });
    expect(value).toBeGreaterThanOrEqual(800);
    expect(value).toBeLessThanOrEqual(1200);
  });

  it("returns the exact base when rand() = 0.5", () => {
    expect(withJitter(1000, { rand: () => 0.5 })).toBe(1000);
  });

  it("honors a custom fraction", () => {
    expect(withJitter(2000, { fraction: 0.1, rand: () => 0 })).toBe(1800);
  });

  it("stays inside ±20% bounds over many default samples", () => {
    for (let i = 0; i < 10000; i++) {
      const value = withJitter(1500);
      expect(value).toBeGreaterThanOrEqual(1200);
      expect(value).toBeLessThanOrEqual(1800);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("rejects a negative or non-finite base", () => {
    expect(() => withJitter(-1)).toThrow(RangeError);
    expect(() => withJitter(Number.NaN)).toThrow(RangeError);
  });

  it("rejects an out-of-range fraction", () => {
    expect(() => withJitter(100, { fraction: 1 })).toThrow(RangeError);
    expect(() => withJitter(100, { fraction: -0.5 })).toThrow(RangeError);
  });
});
