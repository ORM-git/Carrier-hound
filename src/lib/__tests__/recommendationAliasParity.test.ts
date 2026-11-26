import { describe, it, expect } from "vitest";
import { scoreJobRecommendation, type OnboardingAnswers } from "@/lib/jobs/recommendations";

const base: OnboardingAnswers = { roles: ["Frontend Engineer"], remotePreference: "remote", employmentTypes: ["full-time"] };
const NOW = new Date("2026-11-26T00:00:00Z").getTime();
const job = (title: string) => ({ id: "x", title, remote: true, location: "Remote", job_type: "full-time", posted_at: new Date("2026-11-20T00:00:00Z").toISOString() });
const score = (title: string, level?: string) => scoreJobRecommendation(job(title), { ...base, experienceLevel: level }, NOW);
const TITLES = ["Frontend Engineer", "Senior Frontend Engineer", "Junior Frontend Engineer", "Staff Frontend Engineer", "Director of Frontend Engineering"];

describe("a saved alias scores exactly like its canonical level (legacy single values included)", () => {
  const PAIRS: [string, string][] = [
    ["entry level", "entry"], ["Entry-Level", "entry"], ["junior", "entry"], ["staff", "lead"], ["Senior Level", "senior"],
    ["mid-level", "mid"], ["new grad", "intern"], ["executive", "director"],
  ];
  for (const [alias, canon] of PAIRS) {
    it(`${alias} == ${canon}`, () => {
      for (const t of TITLES) {
        const a = score(t, alias), c = score(t, canon);
        expect(a.score, t).toBe(c.score);
        expect(a.reasons, t).toEqual(c.reasons);
      }
    });
  }
  it("the Senior Frontend Engineer case the QA found: junior is not 68 while entry is 0", () => {
    expect(score("Senior Frontend Engineer", "junior").score).toBe(score("Senior Frontend Engineer", "entry").score);
  });
  it("unknown or empty values keep the no-signal behaviour", () => {
    for (const t of TITLES) {
      expect(score(t, "all").score).toBe(score(t, undefined).score);
      expect(score(t, "wizard").score).toBe(score(t, "").score);
    }
  });
});
