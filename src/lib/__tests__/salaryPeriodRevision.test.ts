import { readFileSync } from "fs";
import { beforeEach, describe, expect, it } from "vitest";
import { scoreInputRevision } from "@/lib/matcher/scoring";
import { matchScoreSnapshot, recallMatchScore, reconcileFeedWithDetail, rememberMatchScores } from "@/lib/matcher/scoreCache";
import { scoreJobRecommendation, withFeedScore, type OnboardingAnswers } from "@/lib/jobs/recommendations";
import { sharedDisplayScore } from "@/lib/jobs/displayScore";
import type { CandidateProfile } from "@/lib/resume/types";

const NOW = Date.parse("2026-11-25T00:00:00Z"); // fixed reference instant for revisions

// Regression: the salary filter in scoreJobRecommendation reads jobs.salary_period, so a period-only change can flip a
// Pro score; the paid score-input revision must change with it or a stale cached / feed score is reused.
const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

// Same job id, amounts, currency and candidate preferences throughout; only salary_period varies.
const base = {
  id: "j1",
  title: "Frontend Engineer",
  location: "Remote",
  remote: true,
  remote_scope: "worldwide",
  remote_eligibility: null,
  job_type: "full-time",
  category: "software",
  country_code: "US",
  posted_at: "2026-11-20T00:00:00Z",
  description: "React TypeScript",
  skills: ["React"],
  salary_text: null,
  salary_min: 4000,
  salary_max: 5000,
  currency: "USD",
};
const answers: OnboardingAnswers = { roles: ["Frontend Engineer"], minSalary: 50000, salaryCurrency: "USD" };
// Current rules: yearly 5000 < 50000 -> excluded; monthly 60000 / hourly 10.4M -> pass; null/blank -> implicit
// (5000 < 25000 -> x12) pass; an explicit but unrecognised period ("weekly") is taken as-is -> excluded.
const PERIODS = ["yearly", "monthly", "hourly", null, "", "weekly"] as const;
const withPeriod = (p: (typeof PERIODS)[number]) => ({ ...base, salary_period: p });

describe("salary_period is a paid score input", () => {
  it("a period-only change that changes eligibility/score also changes the paid revision", () => {
    const rows = PERIODS.map(withPeriod);
    const scores = rows.map((r) => scoreJobRecommendation(r, answers).score);
    // The fixture really exercises the gap: the period alone flips eligibility
    expect(scores[0]).toBe(0);
    expect(scores[1]).toBeGreaterThan(0);
    expect(scores[2]).toBeGreaterThan(0);
    expect(scores[3]).toBeGreaterThan(0);
    expect(scores[5]).toBe(0);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        if (scores[i] !== scores[j]) {
          expect(scoreInputRevision(rows[i], true, NOW), `${PERIODS[i]} vs ${PERIODS[j]}`).not.toBe(scoreInputRevision(rows[j], true, NOW));
        }
      }
    }
    // Same displayed (shared) score path the Pro routes stamp next to the revision
    expect(sharedDisplayScore(withPeriod("yearly"), answers)).not.toBe(sharedDisplayScore(withPeriod("monthly"), answers));
  });

  it("is stable for identical inputs and ignores unrelated extra columns", () => {
    expect(scoreInputRevision(withPeriod("monthly"), true, NOW)).toBe(scoreInputRevision({ ...withPeriod("monthly") }, true, NOW));
    expect(scoreInputRevision({ ...withPeriod("monthly"), apply_url: "x", logo_url: "y" }, true, NOW)).toBe(
      scoreInputRevision(withPeriod("monthly"), true, NOW)
    );
  });

  it("Free stays isolated: free score and free revision ignore the period", () => {
    const free = PERIODS.map((p) => scoreInputRevision(withPeriod(p), false, NOW));
    expect(new Set(free).size).toBe(1);
    const freeScores = PERIODS.map((p) => sharedDisplayScore(withPeriod(p), answers, false));
    expect(new Set(freeScores).size).toBe(1);
  });

  it("a cached localStorage or feed score from the old period is rejected after a period-only update", () => {
    const cand = {
      name: "A", email: "", phone: "", headline: "Engineer", summary: "", skills: ["React"], experience: [], education: [],
      certifications: [], confirmedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z",
    } as CandidateProfile;
    const snap = matchScoreSnapshot(cand, "p1");
    const live = (p: (typeof PERIODS)[number], matchScore?: number | null) => ({
      id: "j1", scoreRevision: scoreInputRevision(withPeriod(p), true, NOW), matchScore,
    });
    const oldScore = sharedDisplayScore(withPeriod("monthly"), answers)!;
    rememberMatchScores(snap, [live("monthly", oldScore)]);
    expect(recallMatchScore(snap, live("monthly"))).toBe(oldScore);
    expect(recallMatchScore(snap, live("yearly"))).toBeNull();

    const feed = [live("monthly", oldScore)];
    expect(withFeedScore(live("yearly"), feed).matchScore).toBeUndefined();
    expect(withFeedScore(live("monthly"), feed).matchScore).toBe(oldScore);
    // A detail fetch after the update drops the stale feed score; an unknown revision is never adopted
    expect(reconcileFeedWithDetail(feed, live("yearly", 10))[0].matchScore).toBeNull();
    expect(withFeedScore({ id: "j1", scoreRevision: null, matchScore: undefined }, feed).matchScore).toBeUndefined();
  });

  it("list and detail give the same revision for the same row", () => {
    // Every Pro select feeding scoreInputRevision(..., true, NOW) returns salary_period (explicitly or via "*")
    const recommended = readFileSync("src/app/api/jobs/recommended/route.ts", "utf8");
    const pro = readFileSync("src/app/api/jobs/pro/route.ts", "utf8");
    const search = readFileSync("src/app/api/jobs/search/route.ts", "utf8");
    expect(recommended).toMatch(/"id, title, company, company_id,[^"]*salary_max, salary_period,/);
    for (const sel of pro.match(/\.select\("[^"]*"\)/g) || []) if (sel.includes("salary_min")) expect(sel).toContain("salary_period");
    expect(search).toMatch(/\(isPro && hasServiceKey\)\s*\?\s*"\*, companies/);
    // Same row object (list) and a re-read of it (detail, different key order) hash identically
    const listRow = withPeriod("hourly");
    const detailRow = Object.fromEntries(Object.entries(listRow).reverse());
    expect(scoreInputRevision(detailRow, true, NOW)).toBe(scoreInputRevision(listRow, true, NOW));
  });
});
