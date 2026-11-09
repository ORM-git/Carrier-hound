import { describe, it, expect } from "vitest";
import { parseStatsResponse, parseGlobeStats, parseTickerResponse } from "../api/clientSchemas";

describe("parseStatsResponse", () => {
  it("maps a well-formed payload", () => {
    expect(parseStatsResponse({ activeJobs: 10, companies: 4, jobsToday: 2, updatedAt: "x" })).toEqual({
      activeJobs: 10, companies: 4, jobsToday: 2, totalJobs: 10, companiesScanned: 4, updatedAt: "x",
    });
  });
  it("falls back to totalJobs / companiesScanned", () => {
    const r = parseStatsResponse({ totalJobs: 7, companiesScanned: 3 });
    expect(r?.activeJobs).toBe(7);
    expect(r?.companies).toBe(3);
    expect(r?.jobsToday).toBe(0);
  });
  it("turns wrong types into null", () => {
    expect(parseStatsResponse({ activeJobs: "999", companies: {}, jobsToday: null, updatedAt: 5 })).toEqual({
      activeJobs: null, companies: null, jobsToday: 0, totalJobs: null, companiesScanned: null, updatedAt: undefined,
    });
  });
  it("rejects non-object payloads", () => {
    expect(parseStatsResponse(null)).toBeNull();
    expect(parseStatsResponse("oops")).toBeNull();
    expect(parseStatsResponse([1, 2])).toBeNull();
  });
});

describe("parseGlobeStats", () => {
  it("keeps absent counts null", () => {
    expect(parseGlobeStats({})).toEqual({ jobsToday: 0, totalJobs: null, companiesScanned: null });
    expect(parseGlobeStats({ totalJobs: 5, companiesScanned: 2, jobsToday: 1 })).toEqual({
      jobsToday: 1, totalJobs: 5, companiesScanned: 2,
    });
  });
  it("rejects non-objects", () => {
    expect(parseGlobeStats(undefined)).toBeNull();
  });
});

describe("parseTickerResponse", () => {
  const good = { company: "A", title: "T", posted_at: "2026-01-01", logo_url: null };
  it("accepts array and {jobs}", () => {
    expect(parseTickerResponse([good])).toEqual([good]);
    expect(parseTickerResponse({ jobs: [good] })).toEqual([good]);
  });
  it("drops malformed items", () => {
    const out = parseTickerResponse([good, { company: 1 }, null, "x", { ...good, title: "U" }]);
    expect(out.map((j) => j.title)).toEqual(["T", "U"]);
  });
  it("missing logo_url -> null", () => {
    const { logo_url: _l, ...noLogo } = good;
    expect(parseTickerResponse([noLogo])[0].logo_url).toBeNull();
  });
  it("junk -> []", () => {
    expect(parseTickerResponse(null)).toEqual([]);
    expect(parseTickerResponse({ jobs: "no" })).toEqual([]);
  });
});
