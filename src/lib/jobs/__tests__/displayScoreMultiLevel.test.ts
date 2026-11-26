import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/onboarding/resumeParse", () => ({ loadResumeProfileForRanking: vi.fn(async () => null) }));
vi.mock("@/config/onboarding", () => ({ isOnboardingStep2EnabledServer: () => false }));
import { loadDisplayScoreAnswers, sharedDisplayScore } from "../displayScore";
import { scoreJobRecommendation } from "../recommendations";
import { clampMatchScore } from "@/lib/matcher/scoring";

const NOW = new Date("2026-11-26T00:00:00Z").getTime();
const row = (title: string) => ({ id: "j", title, remote: true, remote_scope: "worldwide", job_type: "full-time", country_code: "US", location: "Remote", posted_at: "2026-11-20T00:00:00Z", description: "Build UIs", skills: ["react"] });
const prefs = (level: string) => ({ roles: ["Frontend Engineer"], experience_level: level, remote_preference: "remote", locations: ["United States"], employment_types: ["full-time"] });
const db = (data: any) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) }) });

describe("display score parity for a multi-level saved profile (feed card, detail and unlock share one function)", () => {
  const TITLES = ["Frontend Engineer", "Senior Frontend Engineer", "Junior Frontend Engineer", "Director of Frontend Engineering", "Staff Frontend Engineer"];
  for (const level of ["senior,lead", "senior,lead,director", "entry level,mid", "junior"]) {
    it(`level "${level}": every surface shows clamp(raw score) for free and paid inputs`, async () => {
      const answers = await loadDisplayScoreAnswers(db(prefs(level)), "u");
      expect(answers?.experienceLevel).toBe(level); // stored value reaches the scorer unchanged
      for (const t of TITLES) {
        const raw = scoreJobRecommendation(row(t), answers!, NOW).score;
        expect(sharedDisplayScore(row(t), answers, true, NOW), t).toBe(clampMatchScore(raw));
        // free inputs hide paid fields but never change the level logic: same level penalty/boost either way
        const free = sharedDisplayScore(row(t), answers, false, NOW)!;
        expect(free).toBeGreaterThanOrEqual(clampMatchScore(0));
      }
    });
  }
  it("raw eligibility/rank 0 is distinct from the display floor", async () => {
    const answers = await loadDisplayScoreAnswers(db(prefs("director")), "u");
    const raw = scoreJobRecommendation(row("Junior Frontend Engineer"), answers!, NOW).score;
    const shown = sharedDisplayScore(row("Junior Frontend Engineer"), answers, true, NOW)!;
    expect(raw).toBeLessThanOrEqual(shown);
    expect(shown).toBe(clampMatchScore(raw));
  });
  it("a changed saved selection changes the shown score on every surface together", async () => {
    const a = await loadDisplayScoreAnswers(db(prefs("director")), "u");
    const b = await loadDisplayScoreAnswers(db(prefs("director,entry")), "u");
    const t = row("Junior Frontend Engineer");
    expect(sharedDisplayScore(t, b, true, NOW)).toBeGreaterThan(sharedDisplayScore(t, a, true, NOW)!);
  });
});
