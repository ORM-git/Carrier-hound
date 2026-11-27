import { describe, it, expect } from "vitest";
import {
  computeRankingInputCoverage,
  computeRecommendedRankingScore,
  RANKING_INPUT_CONFIDENCE_BANDS,
  RECOMMENDED_RANKING_WEIGHTS,
  type RecommendedRankingJobInput,
  type RecommendedRankingPreferences,
} from "../scoring";
import type { CandidateProfile } from "@/lib/resume/types";

const NOW = Date.parse("2026-11-26T00:00:00.000Z");
const FRESH = new Date(NOW).toISOString();

// Location falls back only when the job is not worldwide-remote and no preference is stated.
const job = (overrides: Partial<RecommendedRankingJobInput> = {}): RecommendedRankingJobInput => ({
  id: "j1",
  title: "Backend Engineer",
  company: "Acme",
  location: "Bengaluru, India",
  country: "IN",
  remote: false,
  category: "engineering",
  skills: ["Node.js", "PostgreSQL"],
  salary: "₹30L - ₹40L /yr",
  postedAt: FRESH,
  ...overrides,
});

const candidate: CandidateProfile = {
  name: "Test Person",
  email: "test@example.com",
  phone: "",
  location: "India",
  headline: "Backend Engineer",
  summary: "",
  skills: ["Node.js", "PostgreSQL", "TypeScript"],
  experience: [],
  education: [],
  certifications: [],
  confirmedAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const prefs: RecommendedRankingPreferences = { preferredCountryCode: "IN" };

const W = RECOMMENDED_RANKING_WEIGHTS;

describe("computeRankingInputCoverage", () => {
  it("(a) confirmed resume -> real fitScore; no or unconfirmed resume -> neutral 50", () => {
    const withResume = computeRankingInputCoverage(job(), candidate, prefs, NOW);
    const noResume = computeRankingInputCoverage(job(), null, prefs, NOW);
    const unconfirmed = computeRankingInputCoverage(job(), { ...candidate, confirmedAt: undefined }, prefs, NOW);

    expect(withResume.factors.fitScore.status).toBe("used-real-data");
    expect(noResume.factors.fitScore).toEqual({ value: 50, status: "used-neutral-fallback" });
    expect(unconfirmed.factors.fitScore).toEqual({ value: 50, status: "used-neutral-fallback" });
    expect(withResume.coverageRatio - noResume.coverageRatio).toBeCloseTo(W.fitScore, 10);
  });

  it("(b) missing postedAt -> recency falls back, coverage drops, score moves only via recency", () => {
    const dated = job();
    const undated = job({ postedAt: null });
    const a = computeRankingInputCoverage(dated, null, null, NOW);
    const b = computeRankingInputCoverage(undated, null, null, NOW);

    expect(a.factors.recency).toEqual({ value: 100, status: "used-real-data" });
    expect(b.factors.recency).toEqual({ value: 50, status: "used-neutral-fallback" });
    expect(a.coverageRatio - b.coverageRatio).toBeCloseTo(W.recency, 10);
    expect(b.factors.fitScore).toEqual(a.factors.fitScore);
    expect(b.factors.locationRemoteFit).toEqual(a.factors.locationRemoteFit);
    expect(b.factors.salaryListed).toEqual(a.factors.salaryListed);

    // fit 50, location 50, salary 100 -> 22.5 + 10 + 15 = 47.5, plus recency * 0.2.
    expect(computeRecommendedRankingScore(dated, null, null, NOW)).toBe(Math.round(47.5 + 100 * W.recency));
    expect(computeRecommendedRankingScore(undated, null, null, NOW)).toBe(Math.round(47.5 + 50 * W.recency));
  });

  it("(c) all-neutral input -> lowest band; all-real input -> highest band", () => {
    const neutral = computeRankingInputCoverage(job({ postedAt: undefined, salary: "" }), null, null, NOW);
    expect(neutral.factors.salaryListed).toEqual({ value: 0, status: "binary-absent" });
    expect(neutral.coverageRatio).toBe(0);
    expect(neutral.inputConfidence).toBe("low");

    const real = computeRankingInputCoverage(job(), candidate, prefs, NOW);
    expect(Object.values(real.factors).every((f) => f.status === "used-real-data")).toBe(true);
    expect(real.coverageRatio).toBe(1);
    expect(real.inputConfidence).toBe("high");
  });

  it("(c) salary absence is reported as binary-absent, never as a neutral fallback", () => {
    const r = computeRankingInputCoverage(job({ salary: "   " }), candidate, prefs, NOW);
    expect(r.factors.salaryListed.status).toBe("binary-absent");
    expect(r.coverageRatio).toBeCloseTo(1 - W.salaryListed, 10);
  });

  describe("(d) band boundaries, fixtures built exactly on each threshold", () => {
    // Factor sets -> coverage: fit=0.45, loc=0.2, recency=0.2, salary=0.15.
    const cases: Array<[string, RecommendedRankingJobInput, CandidateProfile | null, RecommendedRankingPreferences | null, number, string]> = [
      ["just below medium: location + recency", job({ salary: null }), null, prefs, 0.4, "low"],
      ["exactly medium: fit only", job({ salary: null, postedAt: null }), candidate, null, RANKING_INPUT_CONFIDENCE_BANDS.medium, "medium"],
      ["inside medium: fit + location", job({ salary: null, postedAt: null }), candidate, prefs, 0.65, "medium"],
      ["exactly high: fit + location + salary", job({ postedAt: null }), candidate, prefs, RANKING_INPUT_CONFIDENCE_BANDS.high, "high"],
    ];
    for (const [label, j, c, p, ratio, band] of cases) {
      it(label, () => {
        const r = computeRankingInputCoverage(j, c, p, NOW);
        expect(r.coverageRatio).toBe(ratio);
        expect(r.inputConfidence).toBe(band);
      });
    }

    it("removing an input can lower coverage without crossing a band", () => {
      const full = computeRankingInputCoverage(job({ postedAt: null }), candidate, prefs, NOW); // 0.8
      const lessSalary = computeRankingInputCoverage(job({ postedAt: null, salary: null }), candidate, prefs, NOW); // 0.65
      const lessLocation = computeRankingInputCoverage(job({ postedAt: null, salary: null }), candidate, null, NOW); // 0.45
      expect(lessSalary.coverageRatio).toBeLessThan(full.coverageRatio);
      expect(lessLocation.coverageRatio).toBeLessThan(lessSalary.coverageRatio);
      expect(lessSalary.inputConfidence).toBe("medium");
      expect(lessLocation.inputConfidence).toBe("medium");
    });
  });

  it("(e) negative control: an unparseable postedAt is treated as missing, not real", () => {
    const corrupt = computeRankingInputCoverage(job({ postedAt: "not-a-date" }), candidate, prefs, NOW);
    const missing = computeRankingInputCoverage(job({ postedAt: undefined }), candidate, prefs, NOW);
    expect(corrupt.factors.recency).toEqual({ value: 50, status: "used-neutral-fallback" });
    expect(corrupt).toEqual(missing);
  });

  it("worldwide-remote jobs use real job data for location even without a stated preference", () => {
    const r = computeRankingInputCoverage(job({ remote: true, remoteScope: "worldwide" }), null, null, NOW);
    expect(r.factors.locationRemoteFit).toEqual({ value: 100, status: "used-real-data" });
  });

  it("agrees with computeRecommendedRankingScore: the score is the weighted sum of the reported values", () => {
    for (const [c, p] of [[candidate, prefs], [null, null], [candidate, null]] as const) {
      const j = job({ postedAt: new Date(NOW - 40 * 3600 * 1000).toISOString() });
      const { factors } = computeRankingInputCoverage(j, c, p, NOW);
      const expected = Math.round(
        factors.fitScore.value * W.fitScore +
          factors.locationRemoteFit.value * W.locationRemoteFit +
          factors.recency.value * W.recency +
          factors.salaryListed.value * W.salaryListed
      );
      expect(computeRecommendedRankingScore(j, c, p, NOW)).toBe(expected);
    }
  });
});

describe("location evidence vs location value (repair)", () => {
  const loc = (j: RecommendedRankingJobInput, p: RecommendedRankingPreferences | null) => computeRankingInputCoverage(j, null, p, NOW).factors.locationRemoteFit;
  const bare = (overrides: Partial<RecommendedRankingJobInput> = {}): RecommendedRankingJobInput => ({ id: "j-bare", title: "Backend Engineer", ...overrides });

  it("regression: a job with only id/title and preferred IN is not real location coverage", () => {
    const r = computeRankingInputCoverage(bare(), null, { preferredCountryCode: "IN" }, NOW);
    expect(r.factors.locationRemoteFit).toEqual({ value: 30, status: "used-unusable-input" });
    expect(r.coverageRatio).toBe(0);
    expect(r.inputConfidence).toBe("low");
  });

  it("regression: invalid job country text is not real location coverage", () => {
    for (const country of ["India", "XX", "zz", "", "   ", "IND"]) {
      expect(loc(bare({ country }), { preferredCountryCode: "IN" }), JSON.stringify(country)).toEqual({ value: 30, status: "used-unusable-input" });
    }
  });

  it("an invalid preferred country cannot turn a mismatch into real data", () => {
    expect(loc(bare({ country: "US" }), { preferredCountryCode: "India" })).toEqual({ value: 30, status: "used-unusable-input" });
    expect(loc(bare({ country: "XX" }), { preferredCountryCode: "XX" })).toEqual({ value: 100, status: "used-unusable-input" });
  });

  it("a valid match and a valid known-country mismatch both count as real data", () => {
    expect(loc(bare({ country: "IN" }), { preferredCountryCode: "IN" })).toEqual({ value: 100, status: "used-real-data" });
    expect(loc(bare({ country: "in" }), { preferredCountryCode: "IN" })).toEqual({ value: 100, status: "used-real-data" });
    expect(loc(bare({ country: "US" }), { preferredCountryCode: "IN" })).toEqual({ value: 30, status: "used-real-data" });
  });

  it("no stated preference stays the neutral 50 fallback", () => {
    expect(loc(bare(), null)).toEqual({ value: 50, status: "used-neutral-fallback" });
    expect(loc(bare({ country: "US" }), { remotePreference: "onsite" })).toEqual({ value: 50, status: "used-neutral-fallback" });
  });

  it("partial remote fields: only observed remote data counts", () => {
    // remote flag alone, no scope/eligibility: treated as worldwide by the value, and the flag is observed
    expect(loc(bare({ remote: true }), { preferredCountryCode: "IN" })).toEqual({ value: 100, status: "used-real-data" });
    // explicit worldwide eligibility without a remote flag is observed too
    expect(loc(bare({ remoteEligibility: "worldwide" }), { preferredCountryCode: "IN" })).toEqual({ value: 100, status: "used-real-data" });
    // remote but country-restricted with no country: a candidate who wants remote gets the observed 70
    const restricted = bare({ remote: true, remoteScope: "remote", remoteEligibility: "country_restricted" });
    expect(loc(restricted, { preferredCountryCode: "IN", remotePreference: "remote" })).toEqual({ value: 70, status: "used-real-data" });
    // ... but for an onsite candidate the 30 comes from the missing country, not from observed data
    expect(loc(restricted, { preferredCountryCode: "IN", remotePreference: "onsite" })).toEqual({ value: 30, status: "used-unusable-input" });
    // a remote scope without the remote flag, and no country: nothing usable about location
    expect(loc(bare({ remoteScope: "remote" }), { preferredCountryCode: "IN", remotePreference: "remote" })).toEqual({ value: 30, status: "used-unusable-input" });
  });

  describe("coverage-band boundaries with unusable location", () => {
    const cases: Array<[string, RecommendedRankingJobInput, number, string]> = [
      ["valid mismatch keeps exactly high", job({ postedAt: null, country: "US" }), RANKING_INPUT_CONFIDENCE_BANDS.high, "high"],
      ["missing job country drops to medium", job({ postedAt: null, country: null }), 0.6, "medium"],
      ["invalid job country drops to medium", job({ postedAt: null, country: "India" }), 0.6, "medium"],
      ["missing country and no salary is exactly medium", job({ postedAt: null, country: undefined, salary: null }), RANKING_INPUT_CONFIDENCE_BANDS.medium, "medium"],
    ];
    for (const [label, j, ratio, band] of cases) {
      it(label, () => {
        const r = computeRankingInputCoverage(j, candidate, prefs, NOW);
        expect(r.coverageRatio).toBe(ratio);
        expect(r.inputConfidence).toBe(band);
      });
    }
    it("unusable location without a resume is just below medium", () => {
      const r = computeRankingInputCoverage(job({ country: null, salary: null }), null, prefs, NOW); // recency 0.2 only
      expect([r.coverageRatio, r.inputConfidence]).toEqual([0.2, "low"]);
    });
  });

  it("the numeric score is unchanged: the 30 still counts in the score, only the report status changes", () => {
    const j = bare();
    const r = computeRankingInputCoverage(j, null, { preferredCountryCode: "IN" }, NOW);
    // fit 50*0.45 + location 30*0.2 + recency 50*0.2 + salary 0 = 22.5 + 6 + 10 = 38.5 -> 39
    expect(computeRecommendedRankingScore(j, null, { preferredCountryCode: "IN" }, NOW)).toBe(39);
    expect(r.factors.locationRemoteFit.value).toBe(30);
  });
});
