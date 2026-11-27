import { describe, expect, it } from "vitest";
import { applyLogoHidePolicy, hasEmployerLogoSource } from "../logoDisplayPolicy";

const jobs = [
  { id: "a", companyLogoUrl: "https://cdn.x/a.png" },
  { id: "b", logoUrl: "/logos/b.png" },
  { id: "c", companyDomain: "c.com" },
  { id: "d" },
  { id: "e", logoUrl: "  ", companyLogoUrl: null, companyDomain: " " },
  { id: "f", logoUrl: "javascript:x" },
];
const pro = { isPro: true, activeTab: "recommended", viewingHidden: false };

describe("logo hide policy (#44)", () => {
  it("source predicate", () => {
    expect(jobs.map(hasEmployerLogoSource)).toEqual([true, true, true, false, false, false]);
  });
  it("Pro feed hides jobs with no logo source, never mutates input", () => {
    const copy = [...jobs];
    expect(applyLogoHidePolicy(jobs, pro).map((j) => j.id)).toEqual(["a", "b", "c"]);
    expect(jobs).toEqual(copy);
  });
  it("Free/guest masked rows are untouched", () => {
    expect(applyLogoHidePolicy(jobs, { ...pro, isPro: false })).toHaveLength(6);
  });
  it("saved, liked, applied and hidden views are untouched", () => {
    for (const activeTab of ["saved", "liked", "applied"]) expect(applyLogoHidePolicy(jobs, { ...pro, activeTab })).toHaveLength(6);
    expect(applyLogoHidePolicy(jobs, { ...pro, viewingHidden: true })).toHaveLength(6);
  });
  it("jobs whose logo failed to load (unresolvedIds) are hidden on the Pro feed only", () => {
    const u = new Set(["a"]);
    expect(applyLogoHidePolicy(jobs, { ...pro, unresolvedIds: u }).map((j) => j.id)).toEqual(["b", "c"]);
    expect(applyLogoHidePolicy(jobs, { ...pro, isPro: false, unresolvedIds: u })).toHaveLength(6);
    expect(applyLogoHidePolicy(jobs, { ...pro, activeTab: "saved", unresolvedIds: u })).toHaveLength(6);
  });
  it("welcome count: no number is claimed once the policy has hidden anything", async () => {
    const { welcomeRecommendedCount } = await import("../logoDisplayPolicy");
    expect(welcomeRecommendedCount({ isDegraded: false, logoHidAny: false, totalCount: 584, loaded: 25 })).toBe(30);
    expect(welcomeRecommendedCount({ isDegraded: false, logoHidAny: false, totalCount: 0, loaded: 12 })).toBe(12);
    expect(welcomeRecommendedCount({ isDegraded: false, logoHidAny: true, totalCount: 584, loaded: 25 })).toBeNull();
    expect(welcomeRecommendedCount({ isDegraded: true, logoHidAny: false, totalCount: 584, loaded: 25 })).toBeNull();
  });
});
