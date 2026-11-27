import { describe, it, expect } from "vitest";
import { computeRankingInputCoverage, type RecommendedRankingJobInput } from "../scoring";

// Reporting-only checks for country validity. The location VALUE (equality and the 30/50/70/100 branches)
// must not change with padding or case handling; only the status reported for it is under test here.
const NOW = Date.parse("2026-11-26T00:00:00.000Z");
const bare = (country?: string | null): RecommendedRankingJobInput => ({ id: "j", title: "Backend Engineer", country });
const loc = (jobCountry: string | null | undefined, preferred: string) =>
  computeRankingInputCoverage(bare(jobCountry), null, { preferredCountryCode: preferred }, NOW).factors.locationRemoteFit;

const UNUSABLE_30 = { value: 30, status: "used-unusable-input" };
const REAL_30 = { value: 30, status: "used-real-data" };

describe("country-validity reporting is symmetric and leaves the value alone", () => {
  it("padded vs unpadded stays 30 (never 100), and is unusable whichever side is padded", () => {
    expect(loc(" US", "IN")).toEqual(UNUSABLE_30);
    expect(loc("US", " IN")).toEqual(UNUSABLE_30);
    expect(loc("US ", "IN")).toEqual(UNUSABLE_30);
    expect(loc("IN ", "IN")).toEqual(UNUSABLE_30);
    expect(loc("IN", " IN")).toEqual(UNUSABLE_30);
    expect(loc(" IN", "IN")).toEqual(UNUSABLE_30);
  });

  it("equally padded values still compare equal for the value, and report unusable", () => {
    expect(loc(" IN", " IN")).toEqual({ value: 100, status: "used-unusable-input" });
    expect(loc("IN ", " IN")).toEqual(UNUSABLE_30);
  });

  it("reversed valid inputs behave the same", () => {
    expect(loc("US", "IN")).toEqual(REAL_30);
    expect(loc("IN", "US")).toEqual(REAL_30);
    expect(loc("in", "US")).toEqual(REAL_30);
    expect(loc("us", "IN")).toEqual(REAL_30);
  });

  it("unknown codes are unusable on either side; matching unknowns keep value 100", () => {
    expect(loc("XX", "IN")).toEqual(UNUSABLE_30);
    expect(loc("IN", "XX")).toEqual(UNUSABLE_30);
    expect(loc("ZZ", "US")).toEqual(UNUSABLE_30);
    expect(loc("US", "ZZ")).toEqual(UNUSABLE_30);
    expect(loc("XX", "XX")).toEqual({ value: 100, status: "used-unusable-input" });
  });

  it("blanks: a blank job country is unusable; no preferred country is the neutral 50", () => {
    expect(loc("", "IN")).toEqual(UNUSABLE_30);
    expect(loc("   ", "IN")).toEqual(UNUSABLE_30);
    expect(loc(null, "IN")).toEqual(UNUSABLE_30);
    expect(loc("IN", "")).toEqual({ value: 50, status: "used-neutral-fallback" });
    expect(loc("", "")).toEqual({ value: 50, status: "used-neutral-fallback" });
    // a whitespace-only preferred country is still "stated" for the value (truthy), and not a usable code
    expect(loc("IN", "   ")).toEqual(UNUSABLE_30);
    expect(loc("   ", "   ")).toEqual({ value: 100, status: "used-unusable-input" });
  });

  it("swapping job and preferred country never changes the reported status (non-empty, unequal values)", () => {
    const values = ["IN", "US", "in", " IN", "US ", " us ", "XX", "India", "   ", "ZZ"];
    for (const a of values) {
      for (const b of values) {
        if (a.toUpperCase() === b.toUpperCase()) continue;
        const forward = loc(a, b);
        const reverse = loc(b, a);
        expect(forward.value, `${JSON.stringify([a, b])} value`).toBe(30);
        expect(reverse.value, `${JSON.stringify([b, a])} value`).toBe(30);
        expect(forward.status, `${JSON.stringify([a, b])} vs reversed`).toBe(reverse.status);
      }
    }
  });
});
