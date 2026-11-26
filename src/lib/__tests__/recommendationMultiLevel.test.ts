import { describe, it, expect } from "vitest";
import { scoreJobRecommendation, rankJobsByRecommendation, type OnboardingAnswers } from "@/lib/jobs/recommendations";

const base: OnboardingAnswers = { roles: ["Frontend Engineer"], remotePreference: "remote", employmentTypes: ["full-time"] };
const job = (id: string, title: string, job_type = "full-time") => ({ id, title, remote: true, location: "Remote", job_type, posted_at: new Date("2026-11-20T00:00:00Z").toISOString() });
const NOW = new Date("2026-11-26T00:00:00Z").getTime();
const score = (j: ReturnType<typeof job>, level?: string) =>
  scoreJobRecommendation(j, { ...base, experienceLevel: level }, NOW).score;

const TITLES = [
  "Frontend Engineer",
  "Senior Frontend Engineer",
  "Junior Frontend Engineer",
  "Staff Frontend Engineer",
  "Associate Frontend Engineer",
  "Director of Frontend Engineering",
  "Associate Director, Frontend",
  "Head of Frontend",
  "VP Frontend Engineering",
];

describe("saved multi-level experience: the scorer reads levels through the shared parser", () => {
  it("a single saved level scores exactly as before (comma-free legacy value, or a one-item list)", () => {
    for (const lvl of ["intern", "entry", "mid", "senior", "lead"]) {
      for (const t of TITLES) {
        const j = job("x", t);
        expect(score(j, `${lvl},`)).toBe(score(j, lvl));
        expect(score(j, ` ${lvl.toUpperCase()} `)).toBe(score(j, lvl));
      }
    }
  });

  it("several levels: a job gets the best score among the selected levels (any match counts)", () => {
    const pairs: string[][] = [["entry", "senior"], ["mid", "senior"], ["entry", "mid", "lead"], ["senior", "director"], ["mid", "director"]];
    for (const levels of pairs) {
      for (const t of TITLES) {
        const j = job("x", t);
        const expected = Math.max(...levels.map((l) => score(j, l)));
        expect(score(j, levels.join(","))).toBe(expected);
      }
    }
  });

  it("entry,senior: both an entry job and a senior job fit; the single-level seekers each zero out the other", () => {
    const entry = job("e", "Junior Frontend Engineer");
    const senior = job("s", "Senior Frontend Engineer");
    expect(score(senior, "entry")).toBe(0);
    expect(score(entry, "senior")).toBe(0);
    expect(score(entry, "entry,senior")).toBeGreaterThan(0);
    expect(score(senior, "entry,senior")).toBeGreaterThan(0);
  });

  it("none, 'all' or all six levels carry no level signal (same as no saved level)", () => {
    for (const t of TITLES) {
      const j = job("x", t);
      const none = score(j, undefined);
      expect(score(j, "all")).toBe(none);
      expect(score(j, "intern,entry,mid,senior,lead,director")).toBe(none);
      expect(score(j, "bogus,,")).toBe(none);
    }
  });

  it("ranking agrees with per-job scores for a multi-level seeker", () => {
    const jobs = TITLES.map((t, i) => job(`j${i}`, t));
    const answers = { ...base, experienceLevel: "entry,senior" };
    const ranked = rankJobsByRecommendation(jobs, answers);
    for (const r of ranked) {
      const direct = scoreJobRecommendation(jobs.find((j) => j.id === r.id)!, answers).score;
      expect(direct).toBeGreaterThan(0); // ranking keeps only jobs with a positive score
    }
  });
});

describe("director / executive seeker", () => {
  it("scores director titles above lead/senior and generic roles, and never zeroes 'Associate Director'", () => {
    const d = score(job("d", "Director of Frontend Engineering"), "director");
    const sen = score(job("s", "Senior Frontend Engineer"), "director");
    const mid = score(job("m", "Frontend Engineer"), "director");
    expect(d).toBeGreaterThan(sen);
    expect(sen).toBeGreaterThan(mid);
    expect(score(job("a", "Associate Director, Frontend"), "director")).toBeGreaterThan(0);
  });

  it("zeroes plain entry/junior roles for a director seeker (hard seniority filter, like senior/lead)", () => {
    expect(score(job("j", "Junior Frontend Engineer"), "director")).toBe(0);
  });

  it("an entry seeker still never matches a director-titled job", () => {
    expect(score(job("d", "Head of Frontend"), "entry")).toBe(0);
  });
});
