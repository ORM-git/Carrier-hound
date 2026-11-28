import { describe, it, expect } from "vitest";
import { experienceBucketsFor, experienceTextMatches, jobMatchesExperience, leanProListFields } from "@/lib/jobs/leanList";

describe("lean Pro list helpers", () => {
  it("keeps the exact rules of the old client Experience filter", () => {
    expect(experienceTextMatches("1-3 Years", "Junior dev")).toBe(true);
    expect(experienceTextMatches("3-5 Years", "Senior lead")).toBe(false);
    expect(experienceTextMatches("3-5 Years", "Platform engineer")).toBe(true);
    expect(experienceTextMatches("5+ Years", "x 5 years y")).toBe(true);
    expect(experienceTextMatches("8+ Years", "Principal")).toBe(true);
    expect(experienceTextMatches("anything else", "x")).toBe(true);
  });
  it("lean rows use the buckets, full rows use the text, an unknown bucket never filters", () => {
    const full = { title: "Engineer", description: "Senior with 5+ years", skills: ["Go"] };
    const lean = { title: "Engineer", skills: ["Go"], ...leanProListFields(full) };
    expect(lean.description).toBe("");
    expect(lean.lean).toBe(true);
    for (const b of ["1-3 Years", "3-5 Years", "5+ Years", "8+ Years"]) expect(jobMatchesExperience(lean, b)).toBe(jobMatchesExperience(full, b));
    expect(jobMatchesExperience(lean, "weird")).toBe(true);
    expect(experienceBucketsFor(full)).toEqual(["5+ Years"]);
  });
  it("a lean row without buckets (older cache) falls back to the text and never throws", () => {
    expect(jobMatchesExperience({ title: "Junior", description: "", lean: true }, "1-3 Years")).toBe(true);
  });
});
