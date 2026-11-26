import { describe, expect, it } from "vitest";
import { PREFERRED_SKILLS_MAX, PREFERRED_SKILL_POINTS, rankJobsByRecommendation, scoreJobRecommendation, type OnboardingAnswers } from "../recommendations";

const now = Date.parse("2026-11-26T00:00:00Z");
const mk = (id: string, title: string, skills: string[] | undefined, extra: Record<string, unknown> = {}) => ({
  id, title, company: "Acme", location: "Remote", remote: true, remote_scope: "worldwide", job_type: "full-time",
  category: "engineering", country_code: "US", skills, posted_at: "2026-11-25T00:00:00Z", ...extra,
}) as any;
const base: OnboardingAnswers = { roles: ["Frontend Engineer"], experienceLevel: "mid", remotePreference: "remote", categories: ["engineering"] };

describe("preferred skills: ranking only, small bounded cap", () => {
  const jobs = [
    mk("a", "Frontend Engineer", ["Vue"]),
    mk("b", "Frontend Engineer", ["React", " TypeScript "]),
    mk("c", "Frontend Engineer", ["React Native"]),
    mk("d", "Frontend Engineer", undefined),
  ];
  it("empty or absent preferred list scores byte-identically to today", () => {
    for (const j of jobs) {
      const s0 = scoreJobRecommendation(j, base, now);
      for (const pref of [undefined, [], ["", "  "]]) {
        const s1 = scoreJobRecommendation(j, { ...base, preferredSkills: pref as any }, now);
        expect(s1.score).toBe(s0.score);
        expect(s1.reasons).toEqual(s0.reasons);
        expect(s1.breakdown.preferredSkillsScore).toBeUndefined();
      }
    }
    const r0 = rankJobsByRecommendation(jobs, base, now).map((j: any) => [j.id, j.matchScore]);
    const r1 = rankJobsByRecommendation(jobs, { ...base, preferredSkills: [] }, now).map((j: any) => [j.id, j.matchScore]);
    expect(r1).toEqual(r0);
  });
  it("exact key match adds a bounded bonus; React does not match React Native; unknown skills add nothing", () => {
    const pref = { ...base, preferredSkills: ["react", "TypeScript"] };
    const b = scoreJobRecommendation(jobs[1], pref, now), b0 = scoreJobRecommendation(jobs[1], base, now);
    expect(b.breakdown.preferredSkillsScore).toBe(2 * PREFERRED_SKILL_POINTS);
    expect(b.score).toBeCloseTo(Math.min(100, b0.score + 4), 5);
    expect(scoreJobRecommendation(jobs[2], pref, now).breakdown.preferredSkillsScore).toBe(0);
    expect(scoreJobRecommendation(jobs[3], pref, now).score).toBe(scoreJobRecommendation(jobs[3], base, now).score);
  });
  it("the bonus is capped", () => {
    const many = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const s = scoreJobRecommendation(mk("x", "Frontend Engineer", many), { ...base, preferredSkills: many }, now);
    expect(s.breakdown.preferredSkillsScore).toBe(PREFERRED_SKILLS_MAX);
  });
  it("never qualifies a job the base answers reject, and never hides one", () => {
    const wrong = mk("w", "Warehouse Associate", ["React"], { category: "operations" });
    const without = rankJobsByRecommendation([wrong, ...jobs], base, now).map((j: any) => j.id);
    const withPref = rankJobsByRecommendation([wrong, ...jobs], { ...base, preferredSkills: ["react"] }, now).map((j: any) => j.id);
    expect(withPref.includes("w")).toBe(without.includes("w"));
    expect([...withPref].sort()).toEqual([...without].sort());
  });
  it("example: a matching job moves above an otherwise equal one that won the tie-break before", async () => {
    const pair = [mk("z", "Frontend Engineer", ["Vue"]), mk("b", "Frontend Engineer", ["React", " TypeScript "])];
    const order = (a: OnboardingAnswers) => rankJobsByRecommendation(pair, a, now).map((j: any) => j.id);
    expect(order(base)).toEqual(["z", "b"]);
    expect(order({ ...base, preferredSkills: ["react"] })).toEqual(["b", "z"]);
  });
});
