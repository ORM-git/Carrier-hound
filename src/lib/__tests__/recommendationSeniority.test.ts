import { describe, it, expect } from "vitest";
import { scoreJobRecommendation, rankJobsByRecommendation, seniorityFactorForMid, OnboardingAnswers } from "@/lib/jobs/recommendations";

const mid: OnboardingAnswers = {
  roles: ["Frontend Engineer"],
  experienceLevel: "mid",
  remotePreference: "remote",
  employmentTypes: ["full-time"],
};
const job = (id: string, title: string) => ({ id, title, remote: true, location: "Remote", job_type: "full-time", posted_at: new Date().toISOString() });

describe("seniority factor for mid-level preference", () => {
  it("derives the factor from title keywords", () => {
    for (const t of ["vp of engineering", "director, frontend", "head of frontend", "chief technology officer", "svp product"]) {
      expect(seniorityFactorForMid(t)).toBe(0);
    }
    expect(seniorityFactorForMid("staff frontend engineer")).toBe(0.5);
    expect(seniorityFactorForMid("principal frontend engineer")).toBe(0.5);
    expect(seniorityFactorForMid("staff accountant")).toBe(1);
    expect(seniorityFactorForMid("frontend engineer")).toBe(1);
    expect(seniorityFactorForMid("headless cms engineer")).toBe(1);
  });

  it("excludes VP/Director and strongly down-weights Staff/Principal for a mid seeker", () => {
    const onLevel = scoreJobRecommendation(job("a", "Frontend Engineer"), mid).score;
    expect(scoreJobRecommendation(job("b", "VP, Frontend Engineering"), mid).score).toBe(0);
    expect(scoreJobRecommendation(job("c", "Director of Frontend Engineering"), mid).score).toBe(0);
    const staff = scoreJobRecommendation(job("d", "Staff Frontend Engineer"), mid).score;
    expect(staff).toBeGreaterThan(0);
    expect(staff).toBeLessThanOrEqual(onLevel / 2);
  });

  it("ranks on-level jobs first and drops executive titles from the feed", () => {
    const ranked = rankJobsByRecommendation(
      [job("vp", "VP Frontend Engineering"), job("staff", "Staff Frontend Engineer"), job("mid", "Frontend Engineer")],
      mid
    );
    expect(ranked.map((j) => j.id)).toEqual(["mid", "staff"]);
  });

  it("leaves senior/lead preferences unchanged", () => {
    const lead: OnboardingAnswers = { ...mid, experienceLevel: "lead" };
    expect(scoreJobRecommendation(job("p", "Principal Frontend Engineer"), lead).score).toBeGreaterThan(50);
  });
});
